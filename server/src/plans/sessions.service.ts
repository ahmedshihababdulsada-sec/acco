import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { BookingsService, customerWho, staffWho, Who } from '../bookings/bookings.service';
import { Errors } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { assertDate } from '../schedule/schedule.service';
import { offerDiscount } from '../offers/offer-math';
import { OffersService } from '../offers/offers.service';
import { PlansService } from './plans.service';
import { BookSessionDto, MoveSessionDto } from './sessions.dto';

const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const MAX_AHEAD = 366;

/** معاينة النقل: الحساب كامل ثم تراجع (rollback) والنتيجة ترجع من هذا الاستثناء */
class PreviewResult { constructor(readonly result: unknown) {} }

interface SessionRow { id: number; branch_id: number; customer_id: number; plan_item_id: number; seq_no: number; status: string; visit_id: number | null; d: string | null; interval_days: number; plan_status: string }

/**
 * إدارة مواعيد الجلسات (القسم 5 ج، 5 هـ، 5 ز): نقل جلسة (قبل الدفع وبعده)، حجز جلسة فاتت أو محررة، وقوائم المتابعة.
 * قاعدة أقل فرق: الجلسة ما تنقدم أقرب من (تاريخ اللي قبلها + الفرق). والجلسات غير المدفوعة اللي بعدها تنعاد جدولتها تلقائياً.
 * ترتيب الأقفال: الزيارة القديمة ← الجلسة ← يوم/زيارة الهدف.
 */
@Injectable()
export class SessionsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly bookings: BookingsService, private readonly plans: PlansService) {}

  async move(actor: AuthUser, id: number, dto: MoveSessionDto, ip: string | null) {
    assertDate(dto.date);
    return this.moveImpl(staffWho(actor), id, dto.date, dto.reason?.trim() || null, ip, false, false);
  }

  /**
   * الزبون ينقل جلسته (غير المدفوعة بس، حتى بنفس اليوم) من التطبيق. preview=true: نفس الحساب بالضبط بدون حفظ، حتى يشوف كل التواريخ
   * اللي راح تتغير قبل ما يأكد (القسم 4).
   */
  async moveForCustomer(c: { id: number; branchId: number }, id: number, date: string, ip: string | null, preview = false) {
    assertDate(date);
    return this.moveImpl(customerWho(c), id, date, null, ip, true, preview);
  }

  private async moveImpl(who: Who, id: number, date: string, reason: string | null, ip: string | null, selfService: boolean, preview: boolean) {
    const dto = { date, reason };
    try {
      return await this.moveTx(who, id, dto, ip, selfService, preview);
    } catch (e) {
      if (e instanceof PreviewResult) return e.result;
      throw e;
    }
  }

  private async moveTx(who: Who, id: number, dto: { date: string; reason: string | null }, ip: string | null, selfService: boolean, preview: boolean) {
    return this.db.tx(async (q) => {
      const s = await this.lock(q, who, id);
      if (selfService && s.status === 'paid') throw Errors.conflict('NOT_MOVABLE', 'الجلسة مدفوعة: راجع العيادة لتغيير موعدها');
      if (!['booked', 'paid'].includes(s.status)) throw Errors.conflict('NOT_MOVABLE', s.status === 'awaiting_booking' ? 'الجلسة تنتظر حجز: احجزها' : 'الجلسة ما تنتقل بحالتها');
      if (s.plan_status !== 'active') throw Errors.conflict('PLAN_NOT_ACTIVE', 'الخطة موقوفة');
      const today = await this.today(q);
      if (dto.date < today) throw Errors.badRequest('DATE_IN_PAST', 'ما تنقل لتاريخ مضى');
      if (dto.date > addDays(today, MAX_AHEAD)) throw Errors.badRequest('DATE_TOO_FAR', 'التاريخ بعيد');
      if (dto.date === s.d) throw Errors.badRequest('SAME_DATE', 'نفس موعد الجلسة الحالي');
      await this.assertGap(q, s, dto.date);
      const before = new Map((await q.query(`select id, scheduled_date::text as d, seq_no from treatment_sessions where plan_item_id = $1 and status in ('booked','paid')`, [s.plan_item_id])).rows.map((x) => [Number(x.id), { d: x.d as string, seq: x.seq_no as number }]));
      const r = await this.bookings.reserveExactDay(q, s.branch_id, s.customer_id, dto.date, who.userId);
      if (r === 'closed') throw Errors.conflictWith('CLINIC_CLOSED', 'العيادة ما تداوم بهذا اليوم', { next_available_date: await this.bookings.suggestDayAfter(q, s.branch_id, s.customer_id, dto.date) });
      if (r === 'stopped') throw Errors.conflictWith('DAY_STOPPED', 'الحجز موقوف لهذا اليوم', { next_available_date: await this.bookings.suggestDayAfter(q, s.branch_id, s.customer_id, dto.date) });
      if (r === 'full') throw Errors.conflictWith('DAY_FULL', 'اليوم ممتلئ', { next_available_date: await this.bookings.suggestDayAfter(q, s.branch_id, s.customer_id, dto.date) });
      const oldVisit = s.visit_id; const oldDate = s.d;
      await q.query(`update treatment_sessions set visit_id = $2, scheduled_date = $3, version = version + 1 where id = $1`, [id, r.visitId, r.date]);
      await q.query(`insert into booking_events (visit_id, treatment_session_id, event, from_date, to_date, to_seq, actor_user_id, actor_customer_id, reason) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [r.visitId, id, selfService ? 'postponed_by_customer' : 'moved_by_cashier', oldDate, r.date, r.seqNo, who.userId, who.customerId, dto.reason]);
      if (oldVisit !== null && oldVisit !== r.visitId) await this.bookings.cancelVisitIfEmpty(q, oldVisit, 'نقل الجلسة', who.userId);
      const cascaded = await this.cascade(q, who, s, r.date);
      await this.audit.log(q, { actorUserId: who.userId, actorRole: who.role, branchId: s.branch_id, action: 'session.move', entityType: 'treatment_session', entityId: id, reason: dto.reason ?? undefined,
        before: { date: oldDate }, after: { date: r.date, cascaded: cascaded.map((c) => c.id) }, ip });
      const changes = [{ session_id: id, seq_no: before.get(id)?.seq ?? s.seq_no, from: oldDate, to: r.date }, ...cascaded.map((c) => ({ session_id: c.id, seq_no: before.get(c.id)?.seq ?? 0, from: before.get(c.id)?.d ?? null, to: c.scheduled_date }))];
      const result = { ...(await this.viewQ(q, id)), cascaded, changes };
      if (preview) throw new PreviewResult(result);                                                  // نفس الحساب كامل ثم نلغيه
      return result;
    });
  }

  /** حجز جلسة «تنتظر حجز» (فاتت أو تحررت): أقرب يوم صالح من التاريخ، وبعدها جلسات الخطة المحررة اللي بعدها تنحجز تلقائياً بالفرق. */
  async book(actor: AuthUser, id: number, dto: BookSessionDto, ip: string | null) {
    assertDate(dto.date);
    return this.db.tx(async (q) => {
      const s = await this.lock(q, staffWho(actor), id);
      if (s.status !== 'awaiting_booking') throw Errors.conflict('NOT_AWAITING', s.status === 'booked' || s.status === 'paid' ? 'الجلسة محجوزة: استخدم النقل' : 'الجلسة ما تنحجز بحالتها');
      if (s.plan_status !== 'active') throw Errors.conflict('PLAN_NOT_ACTIVE', 'الخطة موقوفة');
      const today = await this.today(q);
      if (dto.date < today) throw Errors.badRequest('DATE_IN_PAST', 'ما ينحجز بتاريخ مضى');
      if (dto.date > addDays(today, MAX_AHEAD)) throw Errors.badRequest('DATE_TOO_FAR', 'التاريخ بعيد');
      const prev = (await q.query(`select id, status from treatment_sessions where plan_item_id = $1 and seq_no < $2 and status <> 'cancelled' order by seq_no desc limit 1`, [s.plan_item_id, s.seq_no])).rows[0];
      if (prev && prev.status === 'awaiting_booking') throw Errors.conflictWith('PREVIOUS_NOT_BOOKED', 'احجز الجلسة اللي قبلها أول', { session_id: Number(prev.id) });
      await this.assertGap(q, s, dto.date);
      const r = await this.bookings.reserveDayForSession(q, s.branch_id, s.customer_id, dto.date, actor.id);
      if (!r) throw Errors.conflict('NO_DAY', 'ما لگينا يوم مناسب');
      await q.query(`update treatment_sessions set status = 'booked', visit_id = $2, scheduled_date = $3, version = version + 1 where id = $1`, [id, r.visitId, r.date]);
      await q.query(`insert into booking_events (visit_id, treatment_session_id, event, to_date, to_seq, actor_user_id) values ($1,$2,'booked',$3,$4,$5)`, [r.visitId, id, r.date, r.seqNo, actor.id]);
      // الجلسات اللي بعدها (المحررة) تنحجز من جديد بالفرق
      const rebooked: { id: number; scheduled_date: string }[] = [];
      let prevDate = r.date;
      const later = (await q.query(`select id from treatment_sessions where plan_item_id = $1 and seq_no > $2 and status = 'awaiting_booking' order by seq_no for update`, [s.plan_item_id, s.seq_no])).rows;
      for (const l of later) {
        const rr = await this.bookings.reserveDayForSession(q, s.branch_id, s.customer_id, addDays(prevDate, s.interval_days), actor.id);
        if (!rr) throw Errors.conflict('NO_DAY', 'ما لگينا يوم مناسب للجلسات اللي بعدها');
        await q.query(`update treatment_sessions set status = 'booked', visit_id = $2, scheduled_date = $3, version = version + 1 where id = $1`, [l.id, rr.visitId, rr.date]);
        await q.query(`insert into booking_events (visit_id, treatment_session_id, event, to_date, to_seq, actor_user_id, reason) values ($1,$2,'booked',$3,$4,$5,'إعادة حجز تلقائي بعد حجز جلسة قبلها')`, [rr.visitId, l.id, rr.date, rr.seqNo, actor.id]);
        rebooked.push({ id: Number(l.id), scheduled_date: rr.date }); prevDate = rr.date;
      }
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: s.branch_id, action: 'session.book', entityType: 'treatment_session', entityId: id, after: { date: r.date, rebooked: rebooked.map((x) => x.id) }, ip });
      return { ...(await this.viewQ(q, id)), requested_date: dto.date, moved_from_requested: r.date !== dto.date, rebooked };
    });
  }

  /** جلسات الزبون للكاشير: الحالة والموعد وهل تندفع اليوم، وسعرها التقديري بسعر اليوم. */
  async customerSessions(actor: AuthUser, customerId: number) {
    const c = (await this.db.query(`select id from customers where id = $1`, [customerId])).rows[0];
    if (!c) throw Errors.notFound('الزبون');
    const today = await this.today(this.db);
    const { rows } = await this.db.query(
      `select s.id, s.seq_no, s.status, s.scheduled_date::text as d, s.doctor_planned_date::text as planned, s.plan_item_id, s.branch_id, i.plan_id, sv.name_ar as service_name, i.sessions_count, v.status as visit_status
         from treatment_sessions s join plan_items i on i.id = s.plan_item_id join services sv on sv.id = i.service_id left join visits v on v.id = s.visit_id
        where s.customer_id = $1 and ($2::bigint is null or s.branch_id = $2) and s.status <> 'cancelled' order by i.plan_id, i.sort_order, i.id, s.seq_no`, [customerId, actor.role === 'owner' ? null : actor.branchId]);
    const out = [];
    for (const r of rows) {
      let estimate: number | null = null; let afterOffer: number | null = null; let offerPercent: number | null = null;
      if (['booked', 'awaiting_booking'].includes(r.status)) {
        try {
          const qt = await this.plans.quotePlanItem(this.db, Number(r.plan_item_id));
          estimate = qt.quote.list_price; afterOffer = estimate;
          const offer = await OffersService.activeFor(this.db, Number(r.branch_id), qt.svc.id);   // العرض الفعال اليوم (التقدير بسعر اليوم)
          if (offer) { offerPercent = Number(offer.percent); afterOffer = estimate - offerDiscount(estimate, offer.percent); }
        } catch { estimate = null; afterOffer = null; }
      }
      out.push({ id: Number(r.id), plan_id: Number(r.plan_id), service_name: r.service_name, seq_no: r.seq_no, of: Number(r.sessions_count), status: r.status, scheduled_date: r.d, planned_date: r.planned,
        payable_today: r.status === 'booked' && r.d === today && ['booked', 'arrived'].includes(r.visit_status), estimate_price: estimate, estimate_after_offer: afterOffer, offer_percent: offerPercent });
    }
    return { customer_id: customerId, today, sessions: out };
  }

  /** قوائم المتابعة (القسم 5 ز): مدفوعة وما تنفذت (فات يومها)، وجلسات تنتظر حجز (فاتت أو تحررت). */
  async followUp(actor: AuthUser, requestedBranch?: number) {
    const branchId = actor.role === 'owner' ? requestedBranch ?? null : actor.branchId;
    const base = `select s.id, s.seq_no, s.status, s.scheduled_date::text as d, s.branch_id, cu.id as customer_id, cu.full_name, cu.phone, sv.name_ar as service_name, i.plan_id
                    from treatment_sessions s join customers cu on cu.id = s.customer_id join plan_items i on i.id = s.plan_item_id join services sv on sv.id = i.service_id
                    join treatment_plans p on p.id = i.plan_id`;
    const paid = (await this.db.query(`${base} where s.status = 'paid' and s.scheduled_date < clinic_today() and ($1::bigint is null or s.branch_id = $1) order by s.scheduled_date, s.id`, [branchId])).rows;
    const waiting = (await this.db.query(`${base} where s.status = 'awaiting_booking' and p.status = 'active' and ($1::bigint is null or s.branch_id = $1) order by s.id`, [branchId])).rows;
    const shape = (r: any) => ({ session_id: Number(r.id), plan_id: Number(r.plan_id), seq_no: r.seq_no, service_name: r.service_name, scheduled_date: r.d, customer: { id: Number(r.customer_id), full_name: r.full_name, phone: r.phone } });
    return { paid_not_executed: paid.map(shape), awaiting_booking: waiting.map(shape) };
  }

  // ================================================================ داخلي
  private async today(q: Queryable): Promise<string> { return (await q.query(`select clinic_today()::text as d`)).rows[0].d; }

  private async lock(q: Queryable, who: Who, id: number): Promise<SessionRow> {
    const h = (await q.query(`select visit_id, branch_id, customer_id from treatment_sessions where id = $1`, [id])).rows[0];
    if (!h || (!who.isOwner && Number(h.branch_id) !== who.branchId) || (who.customerId !== null && Number(h.customer_id) !== who.customerId)) throw Errors.notFound('الجلسة');
    if (h.visit_id !== null) await q.query(`select 1 from visits where id = $1 for update`, [h.visit_id]);
    const r = (await q.query(
      `select s.id, s.branch_id, s.customer_id, s.plan_item_id, s.seq_no, s.status, s.visit_id, s.scheduled_date::text as d, i.interval_days, p.status as plan_status
         from treatment_sessions s join plan_items i on i.id = s.plan_item_id join treatment_plans p on p.id = i.plan_id where s.id = $1 for update of s`, [id])).rows[0];
    return { id: Number(r.id), branch_id: Number(r.branch_id), customer_id: Number(r.customer_id), plan_item_id: Number(r.plan_item_id), seq_no: r.seq_no, status: r.status,
      visit_id: r.visit_id === null ? null : Number(r.visit_id), d: r.d, interval_days: Number(r.interval_days), plan_status: r.plan_status };
  }

  /** أقل فرق: ما ينقدم أقرب من (تاريخ اللي قبلها + الفرق) */
  private async assertGap(q: Queryable, s: SessionRow, date: string) {
    const prev = (await q.query(`select scheduled_date::text as d from treatment_sessions where plan_item_id = $1 and seq_no < $2 and status in ('booked','paid','completed') and scheduled_date is not null order by seq_no desc limit 1`, [s.plan_item_id, s.seq_no])).rows[0];
    if (!prev) return;
    const earliest = addDays(prev.d, s.interval_days);
    if (date < earliest) throw Errors.conflictWith('TOO_EARLY', 'أقرب موعد مسموح بعد الفرق اللي كتبه الطبيب عن الجلسة اللي قبلها', { earliest_date: earliest, interval_days: s.interval_days });
  }

  /** بعد نقل جلسة لتاريخ أبعد: الجلسات غير المدفوعة اللي بعدها (بالترتيب) تنزاح لتبقى بعدها بالفرق. المدفوعة توقف السلسلة. */
  private async cascade(q: Queryable, who: Who, s: SessionRow, newDate: string) {
    const out: { id: number; scheduled_date: string }[] = [];
    let prevDate = newDate;
    const later = (await q.query(`select id, status, visit_id, scheduled_date::text as d from treatment_sessions where plan_item_id = $1 and seq_no > $2 and status in ('booked','paid') order by seq_no for update`, [s.plan_item_id, s.seq_no])).rows;
    for (const l of later) {
      if (l.status !== 'booked') break;
      const need = addDays(prevDate, s.interval_days);
      if (l.d >= need) break;
      const r = await this.bookings.reserveDayForSession(q, s.branch_id, s.customer_id, need, who.userId);
      if (!r) throw Errors.conflict('CASCADE_FAILED', 'ما لگينا يوم للجلسات اللي بعدها');
      await q.query(`update treatment_sessions set visit_id = $2, scheduled_date = $3, version = version + 1 where id = $1`, [l.id, r.visitId, r.date]);
      await q.query(`insert into booking_events (visit_id, treatment_session_id, event, from_date, to_date, to_seq, actor_user_id, actor_customer_id, reason) values ($1,$2,'moved',$3,$4,$5,$6,$7,'إعادة جدولة بعد نقل جلسة قبلها')`, [r.visitId, l.id, l.d, r.date, r.seqNo, who.userId, who.customerId]);
      if (l.visit_id !== null && Number(l.visit_id) !== r.visitId) await this.bookings.cancelVisitIfEmpty(q, Number(l.visit_id), 'إعادة جدولة الجلسات', who.userId);
      out.push({ id: Number(l.id), scheduled_date: r.date }); prevDate = r.date;
    }
    return out;
  }

  private async viewQ(q: Queryable, id: number) {
    const r = (await q.query(`select s.id, s.seq_no, s.status, s.scheduled_date::text as d, s.doctor_planned_date::text as planned, s.visit_id, v.seq_no as visit_seq from treatment_sessions s left join visits v on v.id = s.visit_id where s.id = $1`, [id])).rows[0];
    return { id: Number(r.id), seq_no: r.seq_no, status: r.status, scheduled_date: r.d, planned_date: r.planned, visit_id: r.visit_id === null ? null : Number(r.visit_id), visit_seq_no: r.visit_seq };
  }
}
