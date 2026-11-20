import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { Errors } from '../common/errors';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService, Queryable } from '../db/db.service';
import { normalizePhone } from '../customers/phone';

/** إرسال رمز التأكيد برسالة. النسخة الأولى تسجل بس، وربط مزود الرسائل (له كلفة لكل رسالة) يتم عند التنصيب بنفس الواجهة. */
export interface OtpSender { send(phone: string, code: string): Promise<void> }
export const OTP_SENDER = Symbol('OTP_SENDER');
export class LogOtpSender implements OtpSender {
  readonly sent: { phone: string; code: string }[] = [];
  async send(phone: string, code: string): Promise<void> {
    this.sent.push({ phone, code }); if (this.sent.length > 500) this.sent.shift();
    // للتجربة اليدوية بس: يطبع الرمز بسجل الخادم. يتجاهل بالإنتاج حتى لو انفعّل بالغلط.
    if (process.env.OTP_DEV_LOG === '1' && process.env.NODE_ENV !== 'production') new Logger('OtpDev').warn(`OTP ${phone}: ${code}`);
  }
}

export const OTP_TTL_SECONDS = 300;
export const OTP_RESEND_SECONDS = 60;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_PER_HOUR = 5;

/**
 * رمز تأكيد التلفون (القسم 4 تطبيق الزبون). 6 أرقام، صالح 5 دقايق، 5 محاولات، بالساعة أقصى 5 طلبات لكل رقم، وفاصل 60 ثانية.
 * الرمز ينحفظ مجزّأ (hash) بملح من سر السيرفر ولا ينرجع بالرد. الرد ما يكشف إذا الرقم مسجل أو لا.
 */
@Injectable()
export class OtpService {
  constructor(private readonly db: DbService, @Inject(APP_CONFIG) private readonly cfg: AppConfig, @Inject(OTP_SENDER) private readonly sender: OtpSender) {}

  private hash(phone: string, code: string): string { return createHash('sha256').update(`${phone}:${code}:${this.cfg.jwtSecret}`).digest('hex'); }

  async request(rawPhone: string) {
    const phone = normalizePhone(rawPhone);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.tx(async (q) => {
      await q.query(`select pg_advisory_xact_lock(hashtext($1))`, [`otp:${phone}`]);                // يسلسل طلبات نفس الرقم (فاصل/حد ساعة بدون سباق)
      const recent = (await q.query(
        `select count(*) filter (where created_at > now() - interval '1 hour')::int as hour, extract(epoch from now() - max(created_at))::float as since from otp_requests where phone = $1`, [phone])).rows[0];
      if (recent.since !== null && recent.since < OTP_RESEND_SECONDS) throw Errors.conflictWith('OTP_TOO_SOON', 'انتظر شوي قبل ما تطلب رمز جديد', { retry_after: Math.ceil(OTP_RESEND_SECONDS - recent.since) });
      if (Number(recent.hour) >= OTP_MAX_PER_HOUR) throw Errors.conflict('OTP_LIMIT', 'طلبات كثيرة: جرب بعد ساعة');
      const c = (await q.query(`select id, app_registered_at, app_deleted_at from customers where phone = $1 and status = 'active'`, [phone])).rows[0];
      await q.query(`update otp_requests set consumed_at = now() where phone = $1 and consumed_at is null`, [phone]);        // الرمز القديم يبطل
      await q.query(
        `insert into otp_requests (phone, purpose, customer_id, code_hash, expires_at) values ($1,$2,$3,$4, now() + make_interval(secs => $5))`,
        [phone, c && c.app_registered_at && !c.app_deleted_at ? 'login' : 'register', c?.id ?? null, this.hash(phone, code), OTP_TTL_SECONDS]);
    });
    await this.sender.send(phone, code);
    return { sent: true, expires_in: OTP_TTL_SECONDS, resend_after: OTP_RESEND_SECONDS };
  }

  /**
   * يتحقق من الرمز بدون ما يستهلكه (الفشل يعدّ محاولة). الاستهلاك يصير بنفس معاملة إنشاء الجلسة (consume)، فإذا طلعنا
   * بخطأ بعدها (مثلاً الاسم ناقص للتسجيل) يبقى الرمز صالح. أي فشل 400 INVALID_CODE برقم المحاولات الباقية.
   */
  async check(rawPhone: string, code: string): Promise<{ phone: string; requestId: number }> {
    const phone = normalizePhone(rawPhone);
    // الفشل لازم ينحفظ (عدّاد المحاولات) فنرجع النتيجة من المعاملة ونرمي الخطأ بعد ما تنتهي
    const out = await this.db.tx(async (q): Promise<{ ok: true; id: number } | { ok: false; left: number; msg: string }> => {
      await q.query(`select pg_advisory_xact_lock(hashtext($1))`, [`otp:${phone}`]);
      const r = (await q.query(`select id, code_hash, attempts from otp_requests where phone = $1 and consumed_at is null and expires_at > now() order by id desc limit 1 for update`, [phone])).rows[0];
      if (!r) return { ok: false, left: 0, msg: 'الرمز غير صحيح أو منتهي: اطلب رمز جديد' };
      const a = Buffer.from(this.hash(phone, code)); const b = Buffer.from(r.code_hash);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        const left = Math.max(OTP_MAX_ATTEMPTS - (r.attempts + 1), 0);
        await q.query(`update otp_requests set attempts = attempts + 1, consumed_at = case when attempts + 1 >= $2 then now() else null end where id = $1`, [r.id, OTP_MAX_ATTEMPTS]);
        return { ok: false, left, msg: left > 0 ? 'الرمز غير صحيح' : 'محاولات كثيرة: اطلب رمز جديد' };
      }
      return { ok: true, id: Number(r.id) };
    });
    if (!out.ok) throw new HttpException({ code: 'INVALID_CODE', message: out.msg, attempts_left: out.left }, 400);
    return { phone, requestId: out.id };
  }

  /** يستهلك الرمز ذرياً: اثنين يستخدمون نفس الرمز بنفس اللحظة، واحد بس ينجح */
  async consume(q: Queryable, requestId: number): Promise<void> {
    const r = await q.query(`update otp_requests set consumed_at = now() where id = $1 and consumed_at is null and expires_at > now() returning id`, [requestId]);
    if (!r.rowCount) throw new HttpException({ code: 'INVALID_CODE', message: 'الرمز انستخدم أو انتهى: اطلب رمز جديد', attempts_left: 0 }, 400);
  }
}
