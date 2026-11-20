import { SettingsService } from '../settings/settings.service';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { resolveBranch } from '../common/branch';
import { Errors } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { offerDiscount } from '../offers/offer-math';
import { OffersService } from '../offers/offers.service';
import { PlansService } from '../plans/plans.service';
import { ApproveDiscountDto, CreateDiscountRequestDto, RejectDiscountDto } from './discounts.dto';

const STATUSES = ['pending', 'approved', 'rejected', 'used', 'expired', 'cancelled'];

/**
 * طلبات الخصم اليدوي (القسم 4 و5): الكاشير يرسل الطلب بدون مبلغ، والمدير/المالك يدخل المبلغ ويوافق أو يرفض،
 * وبعدها الكاشير يطبقه على الوصل (مرة وحدة، payments.discount_request_id فريد). الطلب صالح لنفس يوم العمل بس.
 * لقطة السلة تنحفظ وقت الطلب (السعر الأصلي)، والمبلغ ما يتجاوزها.
 */
@Injectable()
export class DiscountsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly plans: PlansService, private readonly settings: SettingsService) {}

  async create(actor: AuthUser, dto: CreateDiscountRequestDto, ip: string | null) {
    if (!!dto.consultation_id === !!dto.session_ids?.length) throw Errors.badRequest('CONSULTATION_OR_SESSIONS', 'حدد كشفية أو جلسات (واحد منهم بس)');
    return this.db.tx(async (q) => {
      let customerId: number; let branchId: number; let visitId: number | null; let items: { name: string; price: number; list_price?: number; offer_percent?: number | null; offer_discount?: number; ref: object }[]; let kind: 'consultation' | 'sessions';
      if (dto.consultation_id) {
        kind = 'consultation';
        const c = (await q.query(
          `select c.id, c.status, c.branch_id, c.customer_id, c.visit_id, c.kind, v.status as visit_status, v.visit_date = clinic_today() as is_today
             from consultations c join visits v on v.id = c.visit_id where c.id = $1 for update of c`, [dto.consultation_id])).rows[0];
        if (!c || (actor.role !== 'owner' && Number(c.branch_id) !== actor.branchId)) throw Errors.notFound('الكشفية');
        if (c.status !== 'awaiting_payment' || !['booked', 'arrived'].includes(c.visit_status)) throw Errors.conflict('NOT_PAYABLE', 'الكشفية ما تنقبل دفع حالياً');
        if (!c.is_today) throw Errors.conflict('NOT_TODAY', 'الخصم يطلب بيوم الدفع');
        if (c.kind === 'free_followup') throw Errors.conflict('FREE_FOLLOWUP', 'المراجعة المجانية ما تحتاج خصم');
        let sessionsOnlyFee: number | null = null;
        if (c.kind === 'sessions_only') {
          sessionsOnlyFee = await this.settings.effective<number>(q, Number(c.branch_id), 'consultation.sessions_only_fee');
          if (sessionsOnlyFee <= 0) throw Errors.conflict('FREE_CONSULTATION', 'كشفية «جلسات فقط» مجانية: ما تحتاج خصم');
        }
        branchId = Number(c.branch_id); customerId = Number(c.customer_id); visitId = Number(c.visit_id);
        const svc = (await q.query(`select id, name_ar from services where branch_id = $1 and kind = 'consultation' and is_active`, [branchId])).rows[0];
        if (!svc) throw Errors.conflict('CONSULTATION_NOT_CONFIGURED', 'الكشفية غير مفعلة');
        const price = sessionsOnlyFee !== null ? { price: sessionsOnlyFee } : (await q.query(`select price from service_prices where service_id = $1 and effective_from <= clock_timestamp() order by effective_from desc limit 1`, [svc.id])).rows[0];
        if (!price) throw Errors.conflict('CONSULTATION_NOT_CONFIGURED', 'ما أكو سعر للكشفية');
        items = [{ name: sessionsOnlyFee !== null ? `${svc.name_ar} (جلسات فقط)` : svc.name_ar, price: Number(price.price), ref: { consultation_id: Number(c.id) } }];
      } else {
        kind = 'sessions';
        const ids = [...new Set(dto.session_ids!)].sort((a, b) => a - b);
        const rows = (await q.query(`select s.id, s.status, s.branch_id, s.customer_id, s.visit_id, s.plan_item_id, s.scheduled_date = clinic_today() as is_today from treatment_sessions s where s.id = any($1::bigint[]) order by s.id for update of s`, [ids])).rows;
        if (rows.length !== ids.length || (actor.role !== 'owner' && rows.some((r) => Number(r.branch_id) !== actor.branchId))) throw Errors.notFound('الجلسة');
        if (new Set(rows.map((r) => Number(r.customer_id))).size !== 1) throw Errors.badRequest('MIXED_CUSTOMERS', 'الجلسات لازم لنفس الزبون');
        for (const r of rows) {
          if (r.status !== 'booked') throw Errors.conflict('SESSION_NOT_PAYABLE', 'الجلسة مو محجوزة أو مدفوعة مسبقاً');
          if (!r.is_today) throw Errors.conflict('NOT_TODAY', 'الخصم يطلب بيوم الدفع');
        }
        const vids = [...new Set(rows.map((r) => Number(r.visit_id)))];
        branchId = Number(rows[0].branch_id); customerId = Number(rows[0].customer_id); visitId = vids.length === 1 ? vids[0] : null;
        items = [];
        for (const r of rows) {
          const { svc, quote } = await this.plans.quotePlanItem(q, Number(r.plan_item_id));
          const offer = await OffersService.activeFor(q, branchId, svc.id);     // السلة بعد العرض: المدير يوافق على المبلغ القابل للدفع
          const off = offer ? offerDiscount(quote.list_price, offer.percent) : 0;
          items.push({ name: svc.name_ar, price: quote.list_price - off, list_price: quote.list_price, offer_percent: offer ? Number(offer.percent) : null, offer_discount: off, ref: { session_id: Number(r.id) } });
        }
      }
      const gross = items.reduce((a, i) => a + i.price, 0);
      if (gross <= 0) throw Errors.conflict('NOTHING_TO_DISCOUNT', 'المبلغ صفر: ما أكو شي ينخصم');
      const active = (await q.query(`select id, status from discount_requests where customer_id = $1 and branch_id = $2 and status in ('pending','approved') and (requested_at at time zone 'Asia/Baghdad')::date = clinic_today() order by id limit 1`, [customerId, branchId])).rows[0];
      if (active) throw Errors.conflictWith('REQUEST_EXISTS', 'أكو طلب خصم فعال لهذا الزبون اليوم', { request_id: Number(active.id), status: active.status });
      const note = dto.note?.trim() || null;
      const r = (await q.query(
        `insert into discount_requests (branch_id, customer_id, visit_id, basket, requested_by) values ($1,$2,$3,$4,$5) returning id`,
        [branchId, customerId, visitId, JSON.stringify({ kind, gross, items, note }), actor.id])).rows[0];
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'discount.request', entityType: 'discount_request', entityId: Number(r.id), after: { kind, gross, customer_id: customerId }, ip });
      return this.viewQ(q, Number(r.id));
    });
  }

  async approve(actor: AuthUser, id: number, dto: ApproveDiscountDto, ip: string | null) {
    return this.db.tx(async (q) => {
      const d = await this.lock(q, actor, id);
      this.assertPending(d);
      const gross = Number(d.basket.gross);
      if (dto.amount > gross) throw Errors.conflictWith('DISCOUNT_TOO_LARGE', 'الخصم أكبر من مبلغ السلة', { gross });
      const note = dto.note?.trim() || null;
      await q.query(`update discount_requests set status = 'approved', amount = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1`, [id, dto.amount, actor.id, note]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(d.branch_id), action: 'discount.approve', entityType: 'discount_request', entityId: id, reason: note ?? undefined, after: { amount: dto.amount, gross }, ip });
      return this.viewQ(q, id);
    });
  }

  async reject(actor: AuthUser, id: number, dto: RejectDiscountDto, ip: string | null) {
    const note = dto.note.trim();
    if (note.length < 3) throw Errors.badRequest('NOTE_REQUIRED', 'اكتب سبب الرفض');
    return this.db.tx(async (q) => {
      const d = await this.lock(q, actor, id);
      this.assertPending(d);
      await q.query(`update discount_requests set status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 where id = $1`, [id, actor.id, note]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(d.branch_id), action: 'discount.reject', entityType: 'discount_request', entityId: id, reason: note, ip });
      return this.viewQ(q, id);
    });
  }

  /** الكاشير يلغي طلبه (معلّق أو موافق عليه وما استخدمه) */
  async cancel(actor: AuthUser, id: number, ip: string | null) {
    return this.db.tx(async (q) => {
      const d = await this.lock(q, actor, id);
      if (Number(d.requested_by) !== actor.id && actor.role === 'cashier') throw Errors.notFound('الطلب');
      if (d.stale && ['pending', 'approved'].includes(d.status)) throw Errors.conflict('REQUEST_EXPIRED', 'الطلب من يوم سابق وانتهى');
      const cur = d.status;
      if (!['pending', 'approved'].includes(cur)) throw Errors.conflict('NOT_CANCELLABLE', cur === 'used' ? 'الطلب انستخدم' : 'الطلب ما ينلغي بحالته');
      await q.query(`update discount_requests set status = 'cancelled' where id = $1`, [id]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(d.branch_id), action: 'discount.cancel', entityType: 'discount_request', entityId: id, before: { status: cur }, ip });
      return this.viewQ(q, id);
    });
  }

  async list(actor: AuthUser, p: { status?: string; branchId?: number }) {
    if (p.status && !STATUSES.includes(p.status)) throw Errors.badRequest('INVALID_STATUS', 'حالة غير معروفة');
    const branchId = await resolveBranch(this.db, actor, p.branchId);
    await this.db.tx(async (q) => { await this.sweep(q, branchId); });
    const { rows } = await this.db.query(
      `select d.id from discount_requests d where d.branch_id = $1 and ($2::text is null or d.status = $2) and ($3::bigint is null or d.requested_by = $3) order by d.id desc limit 200`,
      [branchId, p.status ?? null, actor.role === 'cashier' ? actor.id : null]);
    const out = [];
    for (const r of rows) out.push(await this.viewQ(this.db, Number(r.id)));
    return { requests: out };
  }

  async get(actor: AuthUser, id: number) {
    const h = (await this.db.query(`select branch_id, requested_by from discount_requests where id = $1`, [id])).rows[0];
    if (!h || (actor.role !== 'owner' && Number(h.branch_id) !== actor.branchId) || (actor.role === 'cashier' && Number(h.requested_by) !== actor.id)) throw Errors.notFound('الطلب');
    await this.db.tx(async (q) => { await this.sweep(q, Number(h.branch_id)); });
    return this.viewQ(this.db, id);
  }

  /** المهمة المجدولة: كل طلب من يوم سابق (معلّق أو موافق عليه ما استخدم) ينتهي */
  async sweepAll(branchId?: number): Promise<number> {
    const r = await this.db.query(`update discount_requests set status = 'expired' where status in ('pending','approved') and (requested_at at time zone 'Asia/Baghdad')::date < clinic_today() and ($1::bigint is null or branch_id = $1)`, [branchId ?? null]);
    return r.rowCount ?? 0;
  }

  // ================================================================ داخلي
  /** طلب من يوم سابق: ينتهي (pending/approved ما استخدم) */
  private async sweep(q: Queryable, branchId: number) {
    await q.query(`update discount_requests set status = 'expired' where branch_id = $1 and status in ('pending','approved') and (requested_at at time zone 'Asia/Baghdad')::date < clinic_today()`, [branchId]);
  }

  private async lock(q: Queryable, actor: AuthUser, id: number) {
    const d = (await q.query(`select *, ((requested_at at time zone 'Asia/Baghdad')::date < clinic_today()) as stale from discount_requests where id = $1 for update`, [id])).rows[0];
    if (!d || (actor.role !== 'owner' && Number(d.branch_id) !== actor.branchId)) throw Errors.notFound('الطلب');
    return d;
  }
  private assertPending(d: any) {
    if (d.status !== 'pending') throw Errors.conflict('NOT_PENDING', d.status === 'approved' ? 'الطلب موافق عليه مسبقاً' : d.status === 'rejected' ? 'الطلب مرفوض مسبقاً' : d.status === 'used' ? 'الطلب انستخدم' : 'الطلب ما يقبل قرار بحالته');
    if (d.stale) throw Errors.conflict('REQUEST_EXPIRED', 'الطلب من يوم سابق وانتهى: الكاشير يرسل طلب جديد');
  }

  private async viewQ(q: Queryable, id: number) {
    const r = (await q.query(
      `select d.*, cu.full_name, cu.public_code, ru.full_name as requester, du.full_name as decider from discount_requests d join customers cu on cu.id = d.customer_id
         join users ru on ru.id = d.requested_by left join users du on du.id = d.decided_by where d.id = $1`, [id])).rows[0];
    return {
      id: Number(r.id), status: r.status, branch_id: Number(r.branch_id), visit_id: r.visit_id === null ? null : Number(r.visit_id),
      customer: { id: Number(r.customer_id), full_name: r.full_name, public_code: r.public_code },
      basket: r.basket, amount: r.amount === null ? null : Number(r.amount),
      requested_by: { id: Number(r.requested_by), name: r.requester }, requested_at: r.requested_at,
      decided_by: r.decided_by === null ? null : { id: Number(r.decided_by), name: r.decider }, decided_at: r.decided_at, decision_note: r.decision_note,
    };
  }
}
