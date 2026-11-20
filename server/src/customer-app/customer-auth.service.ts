import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { sha256 } from '../auth/token.service';
import { Errors } from '../common/errors';
import { APP_CONFIG, AppConfig } from '../config/config';
import { newPublicCode } from '../customers/customers.service';
import { DbService, Queryable } from '../db/db.service';
import { OtpService } from './otp.service';
import { VerifyOtpDto } from './customer-app.dto';

const cleanName = (s: string) => s.replace(/\s+/g, ' ').trim();

export interface CustomerTokens { access_token: string; refresh_token: string; token_type: 'Bearer'; expires_in: number }

/**
 * دخول الزبون: رمز تأكيد التلفون فقط (بدون كلمة سر). رقم جديد = تسجيل (ينشأ ملف source=app)، رقم عنده ملف من الكاشير = يُربط بنفس الملف (النقاط والسجل يبقون)،
 * وحساب محذوف من التطبيق يرجع يتفعل. توكن الوصول قصير، وتوكن التجديد يدور (إعادة استخدامه تلغي كل الأجهزة).
 */
@Injectable()
export class CustomerAuthService {
  constructor(
    private readonly db: DbService, private readonly otp: OtpService, private readonly jwt: JwtService, private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async verify(dto: VerifyOtpDto, ip: string | null) {
    const { phone, requestId } = await this.otp.check(dto.phone, dto.code);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.db.tx(async (q) => {
          await this.otp.consume(q, requestId);                                       // آخر شي ينكتب: فشل التسجيل (اسم ناقص...) يرجع الرمز صالح
          let c = (await q.query(`select id, branch_id, full_name, app_registered_at, app_deleted_at from customers where phone = $1 and status = 'active' for update`, [phone])).rows[0];
          let isNew = false; let claimed = false;
          if (!c) {
            const name = cleanName(dto.full_name ?? '');
            if (name.length < 2) throw Errors.badRequest('NAME_REQUIRED', 'اكتب اسمك للتسجيل');
            const branchId = await this.pickBranch(q, dto.branch_id);
            c = (await q.query(
              `insert into customers (branch_id, public_code, phone, full_name, source, app_registered_at) values ($1,$2,$3,$4,'app',now()) returning id, branch_id, full_name, app_registered_at, app_deleted_at`,
              [branchId, newPublicCode(), phone, name])).rows[0];
            isNew = true;
          } else if (!c.app_registered_at || c.app_deleted_at) {
            await q.query(`update customers set app_registered_at = coalesce(app_registered_at, now()), app_deleted_at = null, updated_at = now() where id = $1`, [c.id]);
            claimed = true;
          }
          const id = Number(c.id);
          const tokens = await this.issue(q, id, dto.device);
          await this.audit.log(q, { actorRole: 'customer', branchId: Number(c.branch_id), action: isNew ? 'customer.app_register' : claimed ? 'customer.app_claim' : 'customer.app_login', entityType: 'customer', entityId: id, ip });
          return { ...tokens, customer: await this.profileQ(q, id), is_new: isNew };
        });
      } catch (e: any) {
        if (e?.code === '23505' && String(e.constraint).includes('public_code')) continue;
        if (e?.code === '23505' && String(e.constraint) === 'customers_phone_uq') continue;        // سباق تسجيل نفس الرقم: نعيد فنلقى الملف
        throw e;
      }
    }
    throw Errors.conflict('REGISTRATION_FAILED', 'تعذر التسجيل، حاول مرة ثانية');
  }

  async refresh(refreshToken: string, ip: string | null): Promise<CustomerTokens> {
    const hash = sha256(refreshToken);
    const out = await this.db.tx(async (q) => {
      const t = (await q.query(
        `select t.id, t.customer_id, t.revoked_at, t.expires_at < now() as expired, t.device, c.status, c.app_deleted_at, c.app_registered_at, c.branch_id
           from refresh_tokens t join customers c on c.id = t.customer_id where t.token_hash = $1 and t.customer_id is not null for update of t`, [hash])).rows[0];
      if (!t) return { error: true };
      if (t.revoked_at) {                                                            // إعادة استخدام توكن مدوّر = سرقة محتملة: نلغي كل أجهزة الزبون
        await q.query(`update refresh_tokens set revoked_at = now() where customer_id = $1 and revoked_at is null`, [t.customer_id]);
        await this.audit.log(q, { actorRole: 'customer', branchId: Number(t.branch_id), action: 'customer.refresh_reuse_detected', entityType: 'customer', entityId: Number(t.customer_id), ip });
        return { error: true };
      }
      if (t.expired || t.status !== 'active' || t.app_deleted_at || !t.app_registered_at) return { error: true };
      await q.query(`update refresh_tokens set revoked_at = now() where id = $1`, [t.id]);
      return { tokens: await this.issue(q, Number(t.customer_id), t.device ?? undefined) };
    });
    if (out.error || !out.tokens) throw Errors.unauthorized();
    return out.tokens;
  }

  async logout(customerId: number, refreshToken: string | undefined) {
    if (refreshToken) await this.db.query(`update refresh_tokens set revoked_at = now() where token_hash = $1 and customer_id = $2 and revoked_at is null`, [sha256(refreshToken), customerId]);
    else await this.db.query(`update refresh_tokens set revoked_at = now() where customer_id = $1 and revoked_at is null`, [customerId]);
  }

  /** حذف الحساب (شرط Apple): يلغي دخول التطبيق والأجهزة والتوكنات. السجل العلاجي والمالي يبقى عند العيادة. */
  async deleteAccount(customerId: number, ip: string | null) {
    await this.db.tx(async (q) => {
      const c = (await q.query(`select branch_id from customers where id = $1 for update`, [customerId])).rows[0];
      await q.query(`update customers set app_deleted_at = now(), updated_at = now() where id = $1`, [customerId]);
      await q.query(`update refresh_tokens set revoked_at = now() where customer_id = $1 and revoked_at is null`, [customerId]);
      await q.query(`update customer_devices set is_active = false where customer_id = $1`, [customerId]);
      await q.query(`update notifications set status = 'cancelled' where customer_id = $1 and status = 'pending'`, [customerId]);
      await this.audit.log(q, { actorRole: 'customer', branchId: Number(c.branch_id), action: 'customer.app_delete', entityType: 'customer', entityId: customerId, ip });
    });
    return { deleted: true };
  }

  // ================================================================ داخلي
  private async pickBranch(q: Queryable, requested?: number): Promise<number> {
    if (requested !== undefined) {
      const b = (await q.query(`select id from branches where id = $1 and is_active`, [requested])).rows[0];
      if (!b) throw Errors.badRequest('BRANCH_NOT_FOUND', 'الفرع غير موجود');
      return Number(b.id);
    }
    const { rows } = await q.query(`select id from branches where is_active order by id`);
    if (rows.length !== 1) throw Errors.badRequest('BRANCH_REQUIRED', 'اختر الفرع');
    return Number(rows[0].id);
  }

  async issue(q: Queryable, customerId: number, device?: string): Promise<CustomerTokens> {
    const access = await this.jwt.signAsync({ typ: 'customer', sub: customerId, role: 'customer' }, { expiresIn: this.cfg.accessTtlSeconds });
    const refresh = randomBytes(32).toString('base64url');
    await q.query(`insert into refresh_tokens (customer_id, token_hash, device, expires_at) values ($1,$2,$3, now() + make_interval(days => $4))`, [customerId, sha256(refresh), device?.slice(0, 200) ?? null, this.cfg.refreshTtlDays]);
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: this.cfg.accessTtlSeconds };
  }

  async profileQ(q: Queryable, id: number) {
    const r = (await q.query(`select c.id, c.branch_id, c.public_code, c.phone, c.full_name, c.gender, c.birth_date::text as birth_date, c.points_balance, c.notify_offers, b.name as branch_name from customers c join branches b on b.id = c.branch_id where c.id = $1`, [id])).rows[0];
    return { id: Number(r.id), branch: { id: Number(r.branch_id), name: r.branch_name }, public_code: r.public_code, phone: r.phone, full_name: r.full_name, gender: r.gender, birth_date: r.birth_date, points_balance: Number(r.points_balance), notify_offers: r.notify_offers };
  }
}
