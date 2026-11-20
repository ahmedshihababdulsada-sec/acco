import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { resolveBranch } from '../common/branch';
import { Errors } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { assertDate } from '../schedule/schedule.service';
import { CancelOfferDto, CreateOfferDto, UpdateOfferDto } from './offers.dto';

export const DEFAULT_NOTIFY_TITLE = 'عرض جديد';
export const DEFAULT_NOTIFY_BODY = 'عندنا عرض جديد، افتح التطبيق وشوف التفاصيل';
const STATE_SQL = `case when o.status = 'cancelled' then 'cancelled' when o.end_date < clinic_today() then 'ended' when o.start_date > clinic_today() then 'scheduled' else 'active' end`;
const MAX_DAYS = 366;

export interface ActiveOffer { id: number; title: string; percent: string }

/**
 * العروض (القسم 13): خصم بالنسبة على خدمة (مو الكشفية) من تاريخ إلى تاريخ، ينطبق تلقائياً على الجلسات اللي تندفع ضمن المدة.
 * عرض واحد فعال لكل خدمة (يمنعه قيد التداخل بالقاعدة). الحالة مشتقة من التواريخ (و«ملغى» مخزّنة). المجدول بس ينعدل، والفعال ينلغى.
 */
@Injectable()
export class OffersService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** العرض الفعال اليوم لخدمة (يستخدمه الدفع وطلبات الخصم) */
  static async activeFor(q: Queryable, branchId: number, serviceId: number): Promise<ActiveOffer | null> {
    const r = (await q.query(
      `select id, title, percent::text as percent from offers where branch_id = $1 and service_id = $2 and status <> 'cancelled' and start_date <= clinic_today() and end_date >= clinic_today()`, [branchId, serviceId])).rows[0];
    return r ? { id: Number(r.id), title: r.title, percent: r.percent } : null;
  }

  async create(actor: AuthUser, dto: CreateOfferDto, ip: string | null) {
    const branchId = await resolveBranch(this.db, actor, dto.branch_id);
    assertDate(dto.start_date, 'تاريخ البداية'); assertDate(dto.end_date, 'تاريخ النهاية');
    const title = dto.title.trim();
    if (title.length < 2) throw Errors.badRequest('TITLE_REQUIRED', 'اكتب عنوان العرض');
    return this.db.tx(async (q) => {
      const today = await this.today(q);
      this.checkDates(today, dto.start_date, dto.end_date);
      const svc = await this.service(q, branchId, dto.service_id);
      const n = this.notifyFields({ audience: dto.notify_audience ?? 'all', serviceId: dto.notify_service_id, title: dto.notify_title, body: dto.notify_body, at: dto.notify_at }, dto.start_date, dto.end_date, today);
      if (n.audience === 'did_service') await this.service(q, branchId, n.serviceId!);
      const r = (await this.insert(q, `insert into offers (branch_id, service_id, title, percent, start_date, end_date, notify_audience, notify_service_id, notify_title, notify_body, notify_at, created_by)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`, [branchId, svc.id, title, String(dto.percent), dto.start_date, dto.end_date, n.audience, n.serviceId, n.title, n.body, n.at, actor.id])).rows[0];
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'offer.create', entityType: 'offer', entityId: Number(r.id), after: { service_id: svc.id, percent: dto.percent, start_date: dto.start_date, end_date: dto.end_date }, ip });
      return this.viewQ(q, Number(r.id), [svc.name_ar]);
    });
  }

  async update(actor: AuthUser, id: number, dto: UpdateOfferDto, ip: string | null) {
    return this.db.tx(async (q) => {
      const o = await this.lock(q, actor, id);
      if (Number(o.version) !== dto.expected_version) throw Errors.conflictWith('VERSION_CONFLICT', 'العرض تغيّر: حدّث الصفحة', { current_version: Number(o.version) });
      const today = await this.today(q);
      if (o.status === 'cancelled') throw Errors.conflict('OFFER_CANCELLED', 'العرض ملغى');
      if (o.start_date <= today) throw Errors.conflict('OFFER_STARTED', 'العرض بدا: ما ينعدل (تگدر تلغيه)');
      const start = dto.start_date ?? o.start_date; const end = dto.end_date ?? o.end_date;
      if (dto.start_date) assertDate(dto.start_date, 'تاريخ البداية'); if (dto.end_date) assertDate(dto.end_date, 'تاريخ النهاية');
      this.checkDates(today, start, end);
      const title = dto.title !== undefined ? dto.title.trim() : o.title;
      if (title.length < 2) throw Errors.badRequest('TITLE_REQUIRED', 'اكتب عنوان العرض');
      const startChanged = dto.start_date !== undefined && dto.start_date !== o.start_date;
      const n = this.notifyFields({
        audience: dto.notify_audience ?? o.notify_audience, serviceId: dto.notify_service_id ?? (o.notify_service_id === null ? undefined : Number(o.notify_service_id)),
        title: dto.notify_title ?? o.notify_title ?? undefined, body: dto.notify_body ?? o.notify_body ?? undefined, at: dto.notify_at ?? (startChanged ? undefined : o.notify_at ?? undefined),
      }, start, end, today);
      if (n.audience === 'did_service') await this.service(q, Number(o.branch_id), n.serviceId!);
      const percent = dto.percent !== undefined ? String(dto.percent) : o.percent;
      await this.insert(q, `update offers set title = $2, percent = $3, start_date = $4, end_date = $5, notify_audience = $6, notify_service_id = $7, notify_title = $8, notify_body = $9, notify_at = $10, version = version + 1 where id = $1`,
        [id, title, percent, start, end, n.audience, n.serviceId, n.title, n.body, n.at]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(o.branch_id), action: 'offer.update', entityType: 'offer', entityId: id,
        before: { title: o.title, percent: o.percent, start_date: o.start_date, end_date: o.end_date }, after: { title, percent, start_date: start, end_date: end }, ip });
      return this.viewQ(q, id, [(await this.service(q, Number(o.branch_id), Number(o.service_id))).name_ar]);
    });
  }

  /** إلغاء عرض (مجدول أو فعال): يوقف التطبيق على الوصولات الجديدة من هسه، وإشعاره المعلّق ينلغي. الوصولات القديمة تبقى. */
  async cancel(actor: AuthUser, id: number, dto: CancelOfferDto, ip: string | null) {
    const reason = dto.reason.trim();
    if (reason.length < 3) throw Errors.badRequest('REASON_REQUIRED', 'اكتب سبب الإلغاء');
    return this.db.tx(async (q) => {
      const o = await this.lock(q, actor, id);
      const today = await this.today(q);
      if (o.status === 'cancelled') throw Errors.conflict('OFFER_CANCELLED', 'العرض ملغى مسبقاً');
      if (o.end_date < today) throw Errors.conflict('OFFER_ENDED', 'العرض انتهى');
      await q.query(`update offers set status = 'cancelled', version = version + 1 where id = $1`, [id]);
      await q.query(`update notifications set status = 'cancelled' where offer_id = $1 and status = 'pending'`, [id]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(o.branch_id), action: 'offer.cancel', entityType: 'offer', entityId: id, reason, ip });
      return this.viewQ(q, id, []);
    });
  }

  async list(actor: AuthUser, p: { state?: string; branchId?: number }) {
    if (p.state && !['scheduled', 'active', 'ended', 'cancelled'].includes(p.state)) throw Errors.badRequest('INVALID_STATE', 'حالة غير معروفة');
    const branchId = await resolveBranch(this.db, actor, p.branchId);
    const { rows } = await this.db.query(`select o.id from offers o where o.branch_id = $1 and ($2::text is null or ${STATE_SQL} = $2) order by o.start_date desc, o.id desc limit 300`, [branchId, p.state ?? null]);
    const out = []; for (const r of rows) out.push(await this.viewQ(this.db, Number(r.id), []));
    return { offers: out };
  }

  async get(actor: AuthUser, id: number) {
    const h = (await this.db.query(`select branch_id from offers where id = $1`, [id])).rows[0];
    if (!h || (actor.role !== 'owner' && Number(h.branch_id) !== actor.branchId)) throw Errors.notFound('العرض');
    return this.viewQ(this.db, id, []);
  }

  /** العروض الفعالة اليوم (للكاشير: معاينة السعر) */
  async active(actor: AuthUser, requestedBranch?: number) {
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    const { rows } = await this.db.query(
      `select o.id, o.title, o.percent::text as percent, o.service_id, o.end_date::text as end_date, s.name_ar from offers o join services s on s.id = o.service_id
        where o.branch_id = $1 and o.status <> 'cancelled' and o.start_date <= clinic_today() and o.end_date >= clinic_today() order by s.name_ar`, [branchId]);
    return { offers: rows.map((r) => ({ id: Number(r.id), title: r.title, percent: Number(r.percent), service: { id: Number(r.service_id), name: r.name_ar }, end_date: r.end_date })) };
  }

  // ================================================================ داخلي
  private async today(q: Queryable): Promise<string> { return (await q.query(`select clinic_today()::text as d`)).rows[0].d; }

  private checkDates(today: string, start: string, end: string) {
    if (start < today) throw Errors.badRequest('START_IN_PAST', 'العرض ما يبدا بتاريخ مضى');
    if (end < start) throw Errors.badRequest('END_BEFORE_START', 'نهاية العرض قبل بدايته');
    const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000 + 1;
    if (days > MAX_DAYS) throw Errors.badRequest('OFFER_TOO_LONG', 'مدة العرض أطول من سنة');
  }

  private notifyFields(i: { audience: string; serviceId?: number; title?: string; body?: string; at?: string }, start: string, end: string, today: string) {
    if (i.audience === 'did_service' && !i.serviceId) throw Errors.badRequest('NOTIFY_SERVICE_REQUIRED', 'حدد الخدمة اللي الفئة سوتها');
    if (i.audience !== 'did_service' && i.serviceId) throw Errors.badRequest('NOTIFY_SERVICE_NOT_ALLOWED', 'الخدمة تنحدد لفئة «سوّوا الخدمة» بس');
    const at = i.audience === 'none' ? null : i.at ?? start;
    if (at !== null) {
      assertDate(at, 'تاريخ الإشعار');
      if (at < today) throw Errors.badRequest('NOTIFY_IN_PAST', 'تاريخ الإشعار مضى');
      if (at > end) throw Errors.badRequest('NOTIFY_AFTER_END', 'تاريخ الإشعار بعد انتهاء العرض');
    }
    return { audience: i.audience, serviceId: i.audience === 'did_service' ? i.serviceId! : null, title: i.title?.trim() || null, body: i.body?.trim() || null, at };
  }

  private async service(q: Queryable, branchId: number, id: number) {
    const s = (await q.query(`select id, name_ar, kind, is_active from services where id = $1 and branch_id = $2`, [id, branchId])).rows[0];
    if (!s) throw Errors.badRequest('SERVICE_NOT_FOUND', 'الخدمة غير موجودة بالفرع');
    if (s.kind === 'consultation') throw Errors.badRequest('CONSULTATION_NO_OFFER', 'العروض على خدمات الجلسات، مو الكشفية');
    return { id: Number(s.id), name_ar: s.name_ar as string };
  }

  private async lock(q: Queryable, actor: AuthUser, id: number) {
    const o = (await q.query(`select *, start_date::text as sd, end_date::text as ed, notify_at::text as na from offers where id = $1 for update`, [id])).rows[0];
    if (!o || (actor.role !== 'owner' && Number(o.branch_id) !== actor.branchId)) throw Errors.notFound('العرض');
    return { ...o, start_date: o.sd as string, end_date: o.ed as string, notify_at: o.na as string | null };
  }

  /** يحوّل خرق قيد التداخل (عرضين لنفس الخدمة بتواريخ متقاطعة) لرد واضح */
  private async insert(q: Queryable, sql: string, params: unknown[]) {
    try { return await q.query(sql, params); } catch (e: any) {
      if (e?.code === '23P01') throw Errors.conflict('OFFER_OVERLAP', 'أكو عرض ثاني لنفس الخدمة يتقاطع بتواريخه');
      throw e;
    }
  }

  private async viewQ(q: Queryable, id: number, serviceNames: string[]) {
    const o = (await q.query(
      `select o.*, o.start_date::text as sd, o.end_date::text as ed, o.notify_at::text as na, ${STATE_SQL} as state, s.name_ar as service_name, ns.name_ar as notify_service_name, u.full_name as creator
         from offers o join services s on s.id = o.service_id left join services ns on ns.id = o.notify_service_id join users u on u.id = o.created_by where o.id = $1`, [id])).rows[0];
    const custom = [o.notify_title, o.notify_body].filter(Boolean).join(' ');
    const names = [...new Set([o.service_name as string, ...serviceNames])];
    const warnings = names.some((n) => n && custom.toLowerCase().includes(n.toLowerCase())) ? ['NOTIFICATION_MENTIONS_SERVICE'] : [];
    return {
      id: Number(o.id), branch_id: Number(o.branch_id), service: { id: Number(o.service_id), name: o.service_name }, title: o.title, percent: Number(o.percent),
      start_date: o.sd, end_date: o.ed, state: o.state, version: Number(o.version),
      notify: { audience: o.notify_audience, service: o.notify_service_id === null ? null : { id: Number(o.notify_service_id), name: o.notify_service_name }, title: o.notify_title ?? DEFAULT_NOTIFY_TITLE, body: o.notify_body ?? DEFAULT_NOTIFY_BODY, at: o.na, sent_at: o.notification_sent_at },
      created_by: { id: Number(o.created_by), name: o.creator }, created_at: o.created_at, warnings,
    };
  }
}
