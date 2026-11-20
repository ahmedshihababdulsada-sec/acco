import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { Errors } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { assertDate } from '../schedule/schedule.service';
import { HealthRecordDto } from './doctors.dto';

/**
 * صفحة الطبيب (القسم 4): قائمة اليوم، دخول ملف الزبون (من هنا الاسترجاع ممنوع)، المعلومات الصحية، إنهاء الكشفية، وملف الزبون.
 * الطبيب يتعامل مع كشفياته هو بس. ترتيب الأقفال مثل الدفع والاسترجاع: الكشفية والزيارة أول.
 */
@Injectable()
export class DoctorsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** قائمة اليوم: زبائنه اللي دفعوا الكشفية (أو دخلوا مراجعة مجانية) بالتسلسل. */
  async queue(actor: AuthUser, date?: string) {
    const day = date ?? (await this.db.query(`select clinic_today()::text as d`)).rows[0].d;
    if (date) assertDate(date);
    const { rows } = await this.db.query(
      `select c.id, c.kind, c.status, c.entered_at, c.finished_at, v.id as visit_id, v.seq_no, cu.id as customer_id, cu.full_name, cu.public_code, cu.gender, cu.birth_date::text as birth_date,
              c.booking_note, isv.name_ar as interest_name, h.allergies, h.pregnancy, h.chronic_conditions, h.medications,
              (h.id is not null and (coalesce(btrim(h.allergies),'') <> '' or h.pregnancy = 'yes' or coalesce(btrim(h.chronic_conditions),'') <> '' or coalesce(btrim(h.medications),'') <> '')) as has_health_alert
         from consultations c join visits v on v.id = c.visit_id join customers cu on cu.id = c.customer_id left join services isv on isv.id = c.interest_service_id
         left join lateral (select * from customer_health where customer_id = cu.id order by id desc limit 1) h on true
        where c.doctor_id = $1 and v.visit_date = $2 and c.status in ('paid','with_doctor','finished') order by v.seq_no`, [actor.id, day]);
    return {
      date: day,
      queue: rows.map((r) => ({
        consultation_id: Number(r.id), visit_id: Number(r.visit_id), seq_no: r.seq_no, kind: r.kind, status: r.status, booking_note: r.booking_note ?? null, interest_name: r.interest_name ?? null, entered_at: r.entered_at, finished_at: r.finished_at,
        customer: { id: Number(r.customer_id), full_name: r.full_name, public_code: r.public_code, gender: r.gender, birth_date: r.birth_date }, has_health_alert: r.has_health_alert,
      })),
      waiting: rows.filter((r) => r.status === 'paid').length,
    };
  }

  /** يفتح الملف: paid → with_doctor (entered_at). إعادة الفتح لنفس الكشفية المفتوحة مسموحة. من هنا الاسترجاع ممنوع. */
  async enter(actor: AuthUser, consultationId: number, ip: string | null) {
    return this.db.tx(async (q) => {
      const c = await this.lockOwn(q, actor, consultationId);
      if (c.status === 'with_doctor') return this.consultationView(q, consultationId);
      if (c.status === 'finished') throw Errors.conflict('ALREADY_FINISHED', 'الكشفية منتهية');
      if (c.status !== 'paid') throw Errors.conflict('NOT_PAID', 'الزبون ما دفع الكشفية (أو انلغت)');
      await q.query(`update consultations set status = 'with_doctor', entered_at = now() where id = $1`, [consultationId]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: c.branch_id, action: 'consultation.enter', entityType: 'consultation', entityId: consultationId, ip });
      return this.consultationView(q, consultationId);
    });
  }

  /** المعلومات الصحية (إضافة فقط، آخر سجل هو الحالي). تنكتب أثناء الكشفية المفتوحة، ويقدر يحدثها بأي كشفية أو مراجعة. */
  async recordHealth(actor: AuthUser, consultationId: number, dto: HealthRecordDto, ip: string | null) {
    const t = (v?: string) => (v === undefined ? null : v.trim() || null);
    const rec = { allergies: t(dto.allergies), pregnancy: dto.pregnancy ?? 'unknown', chronic_conditions: t(dto.chronic_conditions), medications: t(dto.medications), notes: t(dto.notes) };
    if (!rec.allergies && !rec.chronic_conditions && !rec.medications && !rec.notes && rec.pregnancy === 'unknown') throw Errors.badRequest('EMPTY_RECORD', 'اكتب معلومة وحدة على الأقل');
    return this.db.tx(async (q) => {
      const c = await this.lockOwn(q, actor, consultationId);
      if (c.status !== 'with_doctor') throw Errors.conflict('NOT_WITH_DOCTOR', 'افتح ملف الزبون أول');
      const { rows } = await q.query(
        `insert into customer_health (customer_id, consultation_id, recorded_by, allergies, pregnancy, chronic_conditions, medications, notes) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, created_at`,
        [c.customer_id, consultationId, actor.id, rec.allergies, rec.pregnancy, rec.chronic_conditions, rec.medications, rec.notes]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: c.branch_id, action: 'health.record', entityType: 'customer', entityId: c.customer_id, after: { consultation_id: consultationId, pregnancy: rec.pregnancy } , ip });
      return { id: Number(rows[0].id), customer_id: c.customer_id, consultation_id: consultationId, ...rec, created_at: rows[0].created_at };
    });
  }

  /** «إنهاء الكشفية»: with_doctor → finished حتى لو ما كتب علاج. إذا للطبيب نسبة، يثبت مستحقه من صافي الكشفية المدفوعة (المراجعة المجانية ما إلها مبلغ). */
  async finish(actor: AuthUser, consultationId: number, ip: string | null) {
    return this.db.tx(async (q) => {
      const c = await this.lockOwn(q, actor, consultationId);
      if (c.status === 'finished') throw Errors.conflict('ALREADY_FINISHED', 'الكشفية منتهية');
      if (c.status !== 'with_doctor') throw Errors.conflict('NOT_WITH_DOCTOR', 'افتح ملف الزبون أول');
      await q.query(`update consultations set status = 'finished', finished_at = now() where id = $1`, [consultationId]);
      let earning: { base_amount: number; percent: number; amount: number } | null = null;
      const item = (await q.query(`select net_amount from payment_items where consultation_id = $1 and status = 'paid'`, [consultationId])).rows[0];
      const rule = (await q.query(`select consult_percent from pay_rules where user_id = $1 and consult_percent is not null and effective_from <= clinic_today() order by effective_from desc limit 1`, [actor.id])).rows[0];
      if (item && rule && Number(item.net_amount) > 0) {
        const base = Number(item.net_amount); const percent = Number(rule.consult_percent);
        const amount = Number((await q.query(`select round($1::numeric * $2::numeric / 100)::bigint as v`, [String(base), String(percent)])).rows[0].v);
        await q.query(`insert into doctor_earnings (doctor_id, consultation_id, base_amount, percent, amount, earned_on) values ($1,$2,$3,$4,$5,clinic_today())`, [actor.id, consultationId, base, percent, amount]);
        earning = { base_amount: base, percent, amount };
      }
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: c.branch_id, action: 'consultation.finish', entityType: 'consultation', entityId: consultationId, after: { earning }, ip });
      return { ...(await this.consultationView(q, consultationId)), doctor_earning: earning };
    });
  }

  /** ملف الزبون: الطبيب لزبائنه بس (سوّى عنده كشفية)، والمالك للكل. يشمل تاريخ كل الأطباء للقراءة. */
  async customerFile(actor: AuthUser, customerId: number) {
    const cu = (await this.db.query(`select id, branch_id, public_code, phone, full_name, gender, birth_date::text as birth_date, status, points_balance from customers where id = $1`, [customerId])).rows[0];
    if (!cu) throw Errors.notFound('الزبون');
    if (actor.role === 'doctor') {
      const own = await this.db.query(`select 1 from v_doctor_customers where doctor_id = $1 and customer_id = $2`, [actor.id, customerId]);
      if (!own.rowCount) throw Errors.notFound('الزبون');
    }
    const health = (await this.db.query(`select h.*, u.full_name as by_name from customer_health h join users u on u.id = h.recorded_by where h.customer_id = $1 order by h.id desc`, [customerId])).rows;
    const consultations = (await this.db.query(
      `select c.id, c.kind, c.status, c.doctor_id, du.full_name as doctor_name, v.visit_date::text as date, v.seq_no, c.booking_note, isv.name_ar as interest_name from consultations c join visits v on v.id = c.visit_id join users du on du.id = c.doctor_id left join services isv on isv.id = c.interest_service_id
        where c.customer_id = $1 and c.status <> 'cancelled' order by v.visit_date desc, c.id desc`, [customerId])).rows;
    const plans = (await this.db.query(
      `select p.id, p.consultation_id, p.status, p.treatments_text, du.full_name as doctor_name, p.created_at from treatment_plans p join users du on du.id = p.doctor_id where p.customer_id = $1 order by p.id desc`, [customerId])).rows;
    const sessions = plans.length ? (await this.db.query(
      `select s.id, s.plan_item_id, pi.plan_id, sv.name_ar as service_name, s.seq_no, s.status, s.scheduled_date::text as scheduled_date, s.doctor_planned_date::text as planned_date
         from treatment_sessions s join plan_items pi on pi.id = s.plan_item_id join services sv on sv.id = pi.service_id where pi.plan_id = any($1::bigint[]) order by pi.plan_id, pi.sort_order, pi.id, s.seq_no`, [plans.map((p) => p.id)])).rows : [];
    const n = (x: unknown) => (x === null ? null : Number(x));
    return {
      customer: { id: Number(cu.id), public_code: cu.public_code, phone: cu.phone, full_name: cu.full_name, gender: cu.gender, birth_date: cu.birth_date, status: cu.status, points_balance: Number(cu.points_balance) },
      health: { current: health[0] ? this.healthShape(health[0]) : null, history: health.map((h) => this.healthShape(h)) },
      consultations: consultations.map((c) => ({ id: Number(c.id), kind: c.kind, status: c.status, date: c.date, seq_no: c.seq_no, booking_note: c.booking_note ?? null, interest_name: c.interest_name ?? null, doctor: { id: Number(c.doctor_id), full_name: c.doctor_name }, mine: Number(c.doctor_id) === actor.id })),
      plans: plans.map((p) => ({ id: Number(p.id), consultation_id: Number(p.consultation_id), status: p.status, treatments_text: p.treatments_text, doctor_name: p.doctor_name,
        sessions: sessions.filter((s) => Number(s.plan_id) === Number(p.id)).map((s) => ({ id: Number(s.id), service_name: s.service_name, seq_no: s.seq_no, status: s.status, scheduled_date: s.scheduled_date, planned_date: s.planned_date, plan_item_id: n(s.plan_item_id) })) })),
    };
  }

  // ================================================================ داخلي
  /** الكشفية والزيارة بقفل، وللطبيب نفسه بس (غير هيج 404). */
  async lockOwn(q: Queryable, actor: AuthUser, id: number) {
    const r = (await q.query(
      `select c.id, c.branch_id, c.customer_id, c.doctor_id, c.visit_id, c.kind, c.status, v.visit_date::text as visit_date from consultations c join visits v on v.id = c.visit_id where c.id = $1 for update of c, v`, [id])).rows[0];
    if (!r || Number(r.doctor_id) !== actor.id) throw Errors.notFound('الكشفية');
    return { id: Number(r.id), branch_id: Number(r.branch_id), customer_id: Number(r.customer_id), doctor_id: Number(r.doctor_id), visit_id: Number(r.visit_id), kind: r.kind as string, status: r.status as string, visit_date: r.visit_date as string };
  }

  private healthShape(h: any) {
    return { id: Number(h.id), consultation_id: h.consultation_id === null ? null : Number(h.consultation_id), allergies: h.allergies, pregnancy: h.pregnancy, chronic_conditions: h.chronic_conditions, medications: h.medications, notes: h.notes, recorded_by: h.by_name, created_at: h.created_at };
  }

  private async consultationView(q: Queryable, id: number) {
    const c = (await q.query(`select c.id, c.kind, c.status, c.entered_at, c.finished_at, c.customer_id, c.visit_id, v.seq_no, c.booking_note, isv.name_ar as interest_name from consultations c join visits v on v.id = c.visit_id left join services isv on isv.id = c.interest_service_id where c.id = $1`, [id])).rows[0];
    return { booking_note: c.booking_note ?? null, interest_name: c.interest_name ?? null, id: Number(c.id), kind: c.kind, status: c.status, entered_at: c.entered_at, finished_at: c.finished_at, customer_id: Number(c.customer_id), visit_id: Number(c.visit_id), seq_no: c.seq_no };
  }
}
