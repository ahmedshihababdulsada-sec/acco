import { HttpException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { BookingsService } from '../bookings/bookings.service';
import { CatalogService, LoadedService } from '../catalog/catalog.service';
import { quote as quoteService, Quote } from '../catalog/pricing';
import { Errors } from '../common/errors';
import { DoctorsService } from '../doctors/doctors.service';
import { DbService, Queryable } from '../db/db.service';
import { assertDate } from '../schedule/schedule.service';
import { CreatePlanDto, PlanItemDto, StopPlanDto } from './plans.dto';

const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** فشل حجز الجلسات: يرجع كل شي (ما يبقى حجز نص نص) والخطة تنحفظ مسودة بسبب الفشل (القسم 5 ج) */
class PlanBookingFailed extends Error {}

interface PreparedItem { dto: PlanItemDto; svc: LoadedService; quote: Quote; planned: string[] }

/**
 * الخطة العلاجية (القسم 4 و5 ج): الطبيب يكتب الخدمات وحقولها وعدد الجلسات والفرق وتاريخ الأول، والنظام يحجز كل الجلسات تلقائياً.
 * الحفظ والحجز عملية وحدة: يا تنحفظ كلها (active)، يا تبقى مسودة (draft) بسبب الفشل وبدون أي حجز.
 * الجلسة التالية ما تقل عن الفرق بعد اللي قبلها (حتى لو انزاحت بسبب امتلاء يوم)، والجلسات بنفس اليوم تشارك زيارة (مقعد ورقم واحد).
 */
@Injectable()
export class PlansService {
  constructor(
    private readonly db: DbService, private readonly audit: AuditService, private readonly catalog: CatalogService,
    private readonly bookings: BookingsService, private readonly doctors: DoctorsService,
  ) {}

  async create(actor: AuthUser, consultationId: number, dto: CreatePlanDto, ip: string | null) {
    this.assertShape(dto);
    try {
      return await this.db.tx(async (q) => {
        const { c, items, plan } = await this.prepareAndStore(q, actor, consultationId, dto, null);
        const planId = plan;
        for (const it of items) await this.bookItem(q, actor, c.branch_id, c.customer_id, planId, it);
        await q.query(`update treatment_plans set status = 'active', draft_failure_reason = null where id = $1`, [planId]);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: c.branch_id, action: 'plan.create', entityType: 'treatment_plan', entityId: planId,
          after: { consultation_id: consultationId, items: items.map((i) => ({ service_id: i.svc.id, sessions: i.dto.sessions_count })) }, ip });
        return this.viewQ(q, planId, true);
      });
    } catch (e) {
      if (!(e instanceof PlanBookingFailed)) throw e;
      const reason = e.message;
      const saved = await this.db.tx(async (q) => {
        const { c, plan } = await this.prepareAndStore(q, actor, consultationId, dto, reason);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: c.branch_id, action: 'plan.draft_saved', entityType: 'treatment_plan', entityId: plan, reason });
        return plan;
      });
      throw new HttpException({ code: 'PLAN_BOOKING_FAILED', message: `تعذر حجز الجلسات: ${reason}. انحفظت الخطة مسودة.`, plan_id: saved, reason }, 409);
    }
  }

  async getByConsultation(actor: AuthUser, consultationId: number) {
    const c = (await this.db.query(`select doctor_id, branch_id from consultations where id = $1`, [consultationId])).rows[0];
    if (!c || (actor.role === 'doctor' ? Number(c.doctor_id) !== actor.id : actor.role !== 'owner')) throw Errors.notFound('الكشفية');
    const p = (await this.db.query(`select id from treatment_plans where consultation_id = $1 order by id desc limit 1`, [consultationId])).rows[0];
    if (!p) throw Errors.notFound('الخطة');
    return this.viewQ(this.db, Number(p.id), false);
  }

  /** إيقاف الخطة (الطبيب): الجلسات غير المدفوعة تنلغي ومقاعدها ترجع، والمدفوعة تبقى (تروح لقائمة المتابعة)، والمكتملة ما تتأثر. */
  async stop(actor: AuthUser, planId: number, dto: StopPlanDto, ip: string | null) {
    const reason = dto.reason.trim();
    if (reason.length < 3) throw Errors.badRequest('REASON_REQUIRED', 'اكتب سبب الإيقاف');
    return this.db.tx(async (q) => {
      const p = (await q.query(`select * from treatment_plans where id = $1 for update`, [planId])).rows[0];
      if (!p || Number(p.doctor_id) !== actor.id) throw Errors.notFound('الخطة');
      if (p.status !== 'active') throw Errors.conflict('NOT_ACTIVE', p.status === 'stopped' ? 'الخطة موقوفة مسبقاً' : 'الخطة مو فعالة');
      const { cancel, paid, released } = await this.cancelUnpaid(q, actor, `i.plan_id = $1`, planId, `إيقاف الخطة: ${reason}`, 'إيقاف الخطة');
      await q.query(`update treatment_plans set status = 'stopped', stopped_at = now(), stopped_by = $2, stop_reason = $3, version = version + 1 where id = $1`, [planId, actor.id, reason]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(p.branch_id), action: 'plan.stop', entityType: 'treatment_plan', entityId: planId, reason,
        after: { cancelled_sessions: cancel.length, paid_sessions_left: paid.length, released_visits: released } , ip });
      return { ...(await this.viewQ(q, planId, false)), cancelled_sessions: cancel.length, released_visits: released, paid_sessions_to_follow_up: paid.map((s) => Number(s.id)) };
    });
  }

  /** إضافة بند علاج لخطة فعالة (الطبيب صاحبها): تنحجز جلساته بنفس قواعد الإنشاء. الفشل يرجع كل شي (409) بدون ما يبقى شي. */
  async addItem(actor: AuthUser, planId: number, dto: PlanItemDto, ip: string | null) {
    this.assertShape({ items: [dto] } as CreatePlanDto);
    try {
      return await this.db.tx(async (q) => {
        const p = (await q.query(`select * from treatment_plans where id = $1 for update`, [planId])).rows[0];
        if (!p || Number(p.doctor_id) !== actor.id) throw Errors.notFound('الخطة');
        if (p.status !== 'active') throw Errors.conflict('NOT_ACTIVE', p.status === 'stopped' ? 'الخطة موقوفة' : 'الخطة مو فعالة');
        const today = (await q.query(`select clinic_today()::text as d`)).rows[0].d;
        const it = await this.prepareItem(q, Number(p.branch_id), dto, today);
        const order = Number((await q.query(`select coalesce(max(sort_order), -1) + 1 as n from plan_items where plan_id = $1`, [planId])).rows[0].n);
        const pi = Number((await q.query(`insert into plan_items (plan_id, service_id, sessions_count, interval_days, first_session_date, note, sort_order) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
          [planId, it.svc.id, dto.sessions_count, dto.interval_days, it.planned[0], dto.note?.trim() || null, order])).rows[0].id);
        (it as any).planItemId = pi;
        await this.storeValues(q, pi, it);
        await this.bookItem(q, actor, Number(p.branch_id), Number(p.customer_id), planId, it);
        await q.query(`update treatment_plans set version = version + 1 where id = $1`, [planId]);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(p.branch_id), action: 'plan.add_item', entityType: 'treatment_plan', entityId: planId, after: { plan_item_id: pi, service_id: it.svc.id, sessions: dto.sessions_count }, ip });
        return this.viewQ(q, planId, true);
      });
    } catch (e) {
      if (e instanceof PlanBookingFailed) throw new HttpException({ code: 'PLAN_BOOKING_FAILED', message: `تعذر حجز جلسات البند: ${e.message}. ما انضاف شي.`, reason: e.message }, 409);
      throw e;
    }
  }

  /** إيقاف بند واحد من خطة فعالة (الطبيب): جلساته غير المدفوعة تنلغي ومقاعدها ترجع، والمدفوعة تروح للمتابعة، والمكتملة ما تتأثر */
  async stopItem(actor: AuthUser, itemId: number, dto: StopPlanDto, ip: string | null) {
    const reason = dto.reason.trim();
    if (reason.length < 3) throw Errors.badRequest('REASON_REQUIRED', 'اكتب سبب الإيقاف');
    return this.db.tx(async (q) => {
      const head = (await q.query(`select plan_id from plan_items where id = $1`, [itemId])).rows[0];
      if (!head) throw Errors.notFound('بند الخطة');
      const p = (await q.query(`select * from treatment_plans where id = $1 for update`, [head.plan_id])).rows[0];
      if (Number(p.doctor_id) !== actor.id) throw Errors.notFound('بند الخطة');
      if (p.status !== 'active') throw Errors.conflict('NOT_ACTIVE', p.status === 'stopped' ? 'الخطة موقوفة' : 'الخطة مو فعالة');
      const { cancel, paid, released } = await this.cancelUnpaid(q, actor, `i.id = $1`, itemId, `إيقاف بند: ${reason}`, 'إيقاف بند من الخطة');
      if (!cancel.length && !paid.length) throw Errors.conflict('NOTHING_TO_STOP', 'ما أكو جلسات غير منفذة بهذا البند');
      await q.query(`update treatment_plans set version = version + 1 where id = $1`, [p.id]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(p.branch_id), action: 'plan.stop_item', entityType: 'treatment_plan', entityId: Number(p.id), reason,
        after: { plan_item_id: itemId, cancelled_sessions: cancel.length, paid_sessions_left: paid.length, released_visits: released }, ip });
      return { ...(await this.viewQ(q, Number(p.id), false)), cancelled_sessions: cancel.length, released_visits: released, paid_sessions_to_follow_up: paid.map((x) => Number(x.id)) };
    });
  }

  /** يلغي الجلسات غير المدفوعة (تنتظر حجز/محجوزة) لشرط معيّن، ويرجّع مقاعد الزيارات اللي فضيت. المدفوعة والمكتملة ما تنلمس. */
  private async cancelUnpaid(q: Queryable, actor: AuthUser, where: string, param: number, cancelReason: string, visitReason: string) {
    const sessions = (await q.query(
      `select s.id, s.status, s.visit_id, s.scheduled_date::text as d from treatment_sessions s join plan_items i on i.id = s.plan_item_id where ${where} order by s.id for update of s`, [param])).rows;
    const cancel = sessions.filter((s) => ['awaiting_booking', 'booked'].includes(s.status));
    const paid = sessions.filter((s) => s.status === 'paid');
    const visitIds = [...new Set(cancel.filter((s) => s.visit_id !== null).map((s) => Number(s.visit_id)))].sort((a, b) => a - b);
    for (const s of cancel) {
      await q.query(`update treatment_sessions set status = 'cancelled', cancelled_at = now(), cancel_reason = $2, version = version + 1 where id = $1`, [s.id, cancelReason]);
      await q.query(`insert into booking_events (treatment_session_id, event, from_date, actor_user_id, reason) values ($1,'cancelled',$2,$3,$4)`, [s.id, s.d, actor.id, cancelReason]);
    }
    let released = 0;
    for (const vid of visitIds) {
      const v = (await q.query(`select id, branch_id, visit_date::text as d, seq_no, status from visits where id = $1 for update`, [vid])).rows[0];
      const live = await q.query(
        `select (exists (select 1 from consultations where visit_id = $1 and status <> 'cancelled') or exists (select 1 from treatment_sessions where visit_id = $1 and status in ('booked','paid'))) as live`, [vid]);
      if (v.status !== 'booked' || live.rows[0].live) continue;                          // الزيارة فيها كشفية أو جلسات ثانية: تبقى
      await q.query(`update booking_days set used_slots = greatest(used_slots - 1, 0) where branch_id = $1 and day = $2`, [v.branch_id, v.d]);
      await q.query(`update visits set status = 'cancelled', cancelled_at = now(), cancel_reason = $2 where id = $1`, [vid, visitReason]);
      await q.query(`insert into booking_events (visit_id, event, from_date, from_seq, actor_user_id, reason) values ($1,'cancelled',$2,$3,$4,$5)`, [vid, v.d, v.seq_no, actor.id, visitReason]);
      released++;
    }
    return { cancel, paid, released };
  }

  /** يسعّر بند خطة بسعر اليوم (للدفع والعرض) من القيم المحفوظة بالخطة. إذا الخدمة تغيرت بشكل ما يطابق القيم: 409 والطبيب يعدّل الخطة. */
  async quotePlanItem(q: Queryable, planItemId: number): Promise<{ svc: LoadedService; quote: Quote }> {
    const i = (await q.query(`select service_id from plan_items where id = $1`, [planItemId])).rows[0];
    if (!i) throw Errors.notFound('بند الخطة');
    const svc = await this.catalog.load(q, Number(i.service_id));
    const vals = (await q.query(
      `select f.field_key, f.field_type, v.value_number, v.value_text, v.value_bool,
              coalesce((select array_agg(o.option_id order by o.option_id) from plan_item_value_options o where o.plan_item_value_id = v.id), '{}') as opts
         from plan_item_values v join service_fields f on f.id = v.field_id where v.plan_item_id = $1`, [planItemId])).rows;
    const values: Record<string, unknown> = {};
    for (const v of vals) {
      values[v.field_key] = v.field_type === 'number' ? Number(v.value_number) : v.field_type === 'text' ? v.value_text : v.field_type === 'bool' ? v.value_bool
        : v.field_type === 'select' ? Number(v.opts[0]) : (v.opts as unknown[]).map(Number);
    }
    try { return { svc, quote: quoteService(svc, values) }; } catch (e: any) {
      throw Errors.conflictWith('PLAN_ITEM_OUTDATED', `الخدمة «${svc.name_ar}» تغيرت بعد كتابة الخطة (حقل أو خيار أو سعر): الطبيب يعدّل الخطة`, { service_id: svc.id, detail: e?.response?.message ?? String(e?.message ?? e) });
    }
  }

  // ================================================================ داخلي
  private assertShape(dto: CreatePlanDto) {
    for (const it of dto.items) {
      if ((it.first_session_date === undefined) === (it.dates === undefined)) throw Errors.badRequest('DATES_OR_FIRST', 'حدد تاريخ أول جلسة، أو تواريخ الجلسات كلها (واحد منهم بس)');
      if (it.first_session_date) assertDate(it.first_session_date, 'تاريخ أول جلسة');
      if (it.dates) {
        if (it.dates.length !== it.sessions_count) throw Errors.badRequest('DATES_COUNT_MISMATCH', 'عدد التواريخ لازم يساوي عدد الجلسات');
        it.dates.forEach((d) => assertDate(d, 'تاريخ الجلسة'));
        for (let i = 1; i < it.dates.length; i++) if (it.dates[i] <= it.dates[i - 1]) throw Errors.badRequest('DATES_NOT_INCREASING', 'تواريخ الجلسات لازم تتزايد');
      }
    }
  }

  /** يتحقق من الكشفية والخدمات والقيم، ويخزن الخطة (مسودة) وبنودها وقيمها. يستبدل مسودة سابقة. يرجع الخطة مو الحجز. */
  private async prepareAndStore(q: Queryable, actor: AuthUser, consultationId: number, dto: CreatePlanDto, failure: string | null) {
    const c = await this.doctors.lockOwn(q, actor, consultationId);
    if (c.status !== 'with_doctor') throw Errors.conflict('NOT_WITH_DOCTOR', 'الخطة تنكتب والكشفية مفتوحة (افتح ملف الزبون أول)');
    const existing = (await q.query(`select id, status from treatment_plans where consultation_id = $1 for update`, [consultationId])).rows;
    if (existing.some((p) => p.status !== 'draft')) throw Errors.conflict('PLAN_EXISTS', 'للكشفية هذي خطة مسبقاً');
    const today = (await q.query(`select clinic_today()::text as d`)).rows[0].d;
    const items: PreparedItem[] = [];
    for (const it of dto.items) items.push(await this.prepareItem(q, c.branch_id, it, today));
    for (const p of existing) {
      const ids = (await q.query(`select id from plan_items where plan_id = $1`, [p.id])).rows.map((r) => r.id);
      if (ids.length) {
        await q.query(`delete from plan_item_value_options where plan_item_value_id in (select id from plan_item_values where plan_item_id = any($1::bigint[]))`, [ids]);
        await q.query(`delete from plan_item_values where plan_item_id = any($1::bigint[])`, [ids]);
        await q.query(`delete from plan_items where id = any($1::bigint[])`, [ids]);
      }
      await q.query(`delete from treatment_plans where id = $1`, [p.id]);
    }
    const plan = Number((await q.query(
      `insert into treatment_plans (branch_id, customer_id, consultation_id, doctor_id, status, treatments_text, draft_failure_reason) values ($1,$2,$3,$4,'draft',$5,$6) returning id`,
      [c.branch_id, c.customer_id, consultationId, actor.id, dto.treatments_text?.trim() || null, failure])).rows[0].id);
    for (const [i, it] of items.entries()) {
      const pi = Number((await q.query(`insert into plan_items (plan_id, service_id, sessions_count, interval_days, first_session_date, note, sort_order) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [plan, it.svc.id, it.dto.sessions_count, it.dto.interval_days, it.planned[0], it.dto.note?.trim() || null, i])).rows[0].id);
      (it as any).planItemId = pi;
      await this.storeValues(q, pi, it);
    }
    return { c, items, plan };
  }

  /** يتحقق من خدمة البند وقيمها وتواريخها ويسعّرها (مشترك بين إنشاء الخطة وإضافة بند) */
  private async prepareItem(q: Queryable, branchId: number, it: PlanItemDto, today: string): Promise<PreparedItem> {
    const svc = await this.catalog.load(q, it.service_id);
    if (svc.branch_id !== branchId) throw Errors.badRequest('SERVICE_INVALID', 'الخدمة غير موجودة');
    if (svc.kind !== 'treatment') throw Errors.badRequest('SERVICE_INVALID', 'الكشفية مو خدمة علاجية');
    if (!svc.is_active) throw Errors.conflict('SERVICE_INACTIVE', `الخدمة «${svc.name_ar}» معطلة`);
    const quote = quoteService(svc, it.values ?? {});
    const first = it.dates ? it.dates[0] : it.first_session_date!;
    if (first < today) throw Errors.badRequest('DATE_IN_PAST', 'تاريخ أول جلسة ما يكون بالماضي');
    const planned = it.dates ?? Array.from({ length: it.sessions_count }, (_, k) => addDays(first, k * it.interval_days));
    return { dto: it, svc, quote, planned };
  }

  private async storeValues(q: Queryable, planItemId: number, it: PreparedItem) {
    const values = it.dto.values ?? {};
    for (const f of it.svc.fields.filter((x) => x.is_active)) {
      const raw = values[f.field_key];
      if (raw === undefined || raw === null) continue;
      const fv = (await q.query(`select id from service_field_versions where field_id = $1 order by version_no desc limit 1`, [f.id])).rows[0];
      if (!fv) throw Errors.conflict('FIELD_VERSION_MISSING', `الحقل «${f.label_ar}» بدون نسخة محفوظة`);
      const row = await q.query(
        `insert into plan_item_values (plan_item_id, field_id, field_version_id, value_number, value_text, value_bool) values ($1,$2,$3,$4,$5,$6) returning id`,
        [planItemId, f.id, fv.id, f.field_type === 'number' ? String(raw) : null, f.field_type === 'text' ? String(raw).trim() : null, f.field_type === 'bool' ? Boolean(raw) : null]);
      if (f.field_type === 'select' || f.field_type === 'multi_select') {
        for (const id of (f.field_type === 'select' ? [raw] : (raw as number[]))) await q.query(`insert into plan_item_value_options (plan_item_value_id, option_id) values ($1,$2)`, [row.rows[0].id, id]);
      }
    }
  }

  /** يحجز جلسات بند واحد بالتسلسل: كل جلسة من تاريخها المخطط، وبعد اللي قبلها بالفرق على الأقل. */
  private async bookItem(q: Queryable, actor: AuthUser, branchId: number, customerId: number, planId: number, it: PreparedItem) {
    const planItemId = (it as any).planItemId as number;
    let prev: string | null = null;
    for (let k = 0; k < it.dto.sessions_count; k++) {
      let from = it.planned[k];
      if (prev !== null) { const min = addDays(prev, it.dto.interval_days); if (min > from) from = min; }
      const res = await this.bookings.reserveDayForSession(q, branchId, customerId, from, actor.id);
      if (!res) throw new PlanBookingFailed(`ما لگينا يوم مناسب للجلسة ${k + 1} من «${it.svc.name_ar}» بعد ${from}`);
      const s = (await q.query(
        `insert into treatment_sessions (branch_id, customer_id, plan_item_id, seq_no, status, scheduled_date, doctor_planned_date, visit_id) values ($1,$2,$3,$4,'booked',$5,$6,$7) returning id`,
        [branchId, customerId, planItemId, k + 1, res.date, it.planned[k], res.visitId])).rows[0];
      await q.query(`insert into booking_events (visit_id, treatment_session_id, event, to_date, to_seq, actor_user_id) values ($1,$2,'booked',$3,$4,$5)`, [res.visitId, s.id, res.date, res.seqNo, actor.id]);
      prev = res.date;
    }
    void planId;
  }

  private async viewQ(q: Queryable, planId: number, withWarnings: boolean) {
    const p = (await q.query(`select p.*, c.visit_id from treatment_plans p join consultations c on c.id = p.consultation_id where p.id = $1`, [planId])).rows[0];
    if (!p) return null;
    const items = (await q.query(`select i.*, i.first_session_date::text as first_text, s.name_ar as service_name from plan_items i join services s on s.id = i.service_id where i.plan_id = $1 order by i.sort_order, i.id`, [planId])).rows;
    const out: any[] = []; const needs = new Map<number, number>();
    for (const i of items) {
      const sessions = (await q.query(
        `select s.id, s.seq_no, s.status, s.scheduled_date::text as scheduled_date, s.doctor_planned_date::text as planned_date, s.visit_id, v.seq_no as visit_seq from treatment_sessions s left join visits v on v.id = s.visit_id where s.plan_item_id = $1 order by s.seq_no`, [i.id])).rows;
      const vals = (await q.query(
        `select f.field_key, f.label_ar, v.value_number, v.value_text, v.value_bool, coalesce((select array_agg(o.option_id order by o.option_id) from plan_item_value_options o where o.plan_item_value_id = v.id), '{}') as opts
           from plan_item_values v join service_fields f on f.id = v.field_id where v.plan_item_id = $1 order by f.sort_order, f.id`, [i.id])).rows;
      // تسعير تقديري بسعر اليوم (الدفع يحسب سعر يوم الدفع)، والاستهلاك المتوقع
      let estimate: { per_session: number | null; total: number | null } = { per_session: null, total: null };
      try {
        const svc = await this.catalog.load(q, Number(i.service_id));
        const values: Record<string, unknown> = {};
        for (const v of vals) {
          const f = svc.fields.find((x) => x.field_key === v.field_key)!;
          values[v.field_key] = f.field_type === 'number' ? Number(v.value_number) : f.field_type === 'text' ? v.value_text : f.field_type === 'bool' ? v.value_bool : f.field_type === 'select' ? Number(v.opts[0]) : (v.opts as unknown[]).map(Number);
        }
        const qt = quoteService(svc, values);
        estimate = { per_session: qt.list_price, total: qt.list_price * Number(i.sessions_count) };
        for (const c of qt.consumption) needs.set(Number(c.material_id), (needs.get(Number(c.material_id)) ?? 0) + Number(c.qty_base) * Number(i.sessions_count));
      } catch { /* الخدمة تغيّرت بعد الكتابة: نعرض الخطة بدون تقدير */ }
      out.push({ id: Number(i.id), service: { id: Number(i.service_id), name: i.service_name }, sessions_count: Number(i.sessions_count), interval_days: Number(i.interval_days), first_session_date: i.first_text, note: i.note,
        values: vals.map((v) => ({ field_key: v.field_key, label: v.label_ar, number: v.value_number === null ? null : Number(v.value_number), text: v.value_text, bool: v.value_bool, option_ids: (v.opts as unknown[]).map(Number) })),
        estimate, sessions: sessions.map((s) => ({ id: Number(s.id), seq_no: s.seq_no, status: s.status, scheduled_date: s.scheduled_date, planned_date: s.planned_date, visit_id: s.visit_id === null ? null : Number(s.visit_id), visit_seq_no: s.visit_seq,
          moved: s.scheduled_date !== null && s.scheduled_date !== s.planned_date })) });
    }
    const view: any = {
      id: Number(p.id), consultation_id: Number(p.consultation_id), customer_id: Number(p.customer_id), doctor_id: Number(p.doctor_id), status: p.status, treatments_text: p.treatments_text,
      draft_failure_reason: p.draft_failure_reason, stop_reason: p.stop_reason, version: Number(p.version), items: out,
      estimated_total: out.every((x) => x.estimate.total !== null) ? out.reduce((a, x) => a + x.estimate.total, 0) : null,
    };
    if (withWarnings && needs.size) {
      const { rows } = await q.query(`select v.material_id, v.name, v.base_unit, v.available from v_material_stock v where v.material_id = any($1::bigint[])`, [[...needs.keys()]]);
      view.stock_warnings = rows.filter((r) => Number(r.available) < (needs.get(Number(r.material_id)) ?? 0)).map((r) => ({ material_id: Number(r.material_id), name: r.name, unit: r.base_unit, needed: needs.get(Number(r.material_id)), available: Number(r.available) }));
    }
    return view;
  }
}
