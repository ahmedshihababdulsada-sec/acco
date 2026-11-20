import { HttpException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { resolveBranch } from '../common/branch';
import { Errors } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { DATE_RE, CreateDayOffDto, CreateHolidayDto, SetClinicDaysDto, SetWeeklyDto } from './schedule.dto';

const MAX_RANGE_DAYS = 62;
const conflict = (code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, 409);

/** يتحقق إن النص تاريخ حقيقي (مو 2026-02-30). */
export function assertDate(s: string, field = 'التاريخ'): string {
  const m = DATE_RE.exec(s);
  const d = m ? new Date(`${s}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw Errors.badRequest('INVALID_DATE', `${field} غير صحيح`);
  return s;
}

export interface DayAvailability {
  date: string; weekday: number; clinic_open: boolean;
  closed_reason: 'weekday' | 'holiday' | null;
  holiday: { id: number; name: string; kind: string } | null;
  doctor?: { works: boolean; start_time: string | null; end_time: string | null; day_off: { id: number; reason: string | null } | null };
}

/** حدث إغلاق (عطلة، إجازة طبيب، يوم دوام انسكر): وحدة الحجز تسجل معالج ينقل الحجوزات المتأثرة داخل نفس المعاملة. */
export interface ClosureEvent {
  branchId: number; kind: 'holiday' | 'doctor_day_off' | 'weekdays';
  date?: string; doctorId?: number; weekdays?: number[]; reason: string; actor: AuthUser;
}
export type ClosureHandler = (q: Queryable, ev: ClosureEvent) => Promise<{ moved: number; unmoved: number }>;

@Injectable()
export class ScheduleService {
  private closureHandlers: ClosureHandler[] = [];
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  registerClosureHandler(h: ClosureHandler) { this.closureHandlers.push(h); }
  private async runClosure(q: Queryable, ev: ClosureEvent) {
    let moved = 0; let unmoved = 0;
    for (const h of this.closureHandlers) { const r = await h(q, ev); moved += r.moved; unmoved += r.unmoved; }
    return { moved_visits: moved, unmoved_visits: unmoved };
  }

  // ================================================================ أيام العيادة
  /** أطباء الفرع الفعالين (لشاشات الحجز عند الكاشير والمدير) */
  async listDoctors(actor: AuthUser, requestedBranch?: number) {
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    const { rows } = await this.db.query(`select d.user_id, u.full_name, d.title, d.room from doctors d join users u on u.id = d.user_id where u.branch_id = $1 and u.is_active order by u.full_name`, [branchId]);
    return { branch_id: branchId, doctors: rows.map((r) => ({ id: Number(r.user_id), full_name: r.full_name as string, title: r.title as string | null, room: r.room as string | null })) };
  }

  async getClinicDays(actor: AuthUser, requestedBranch?: number) {
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    const { rows } = await this.db.query(`select weekday, is_open from clinic_weekdays where branch_id = $1`, [branchId]);
    const m = new Map(rows.map((r) => [r.weekday, r.is_open]));
    // أي يوم ما انسجل = مفتوح (مثل ما تسوي التهيئة)
    return { branch_id: branchId, days: [1, 2, 3, 4, 5, 6, 7].map((w) => ({ weekday: w, is_open: m.get(w) ?? true })) };
  }

  /**
   * يحدد أيام دوام العيادة (الأسبوع كامل). لازم يبقى يوم واحد مفتوح على الأقل.
   * يرجع عدد الحجوزات المستقبلية اللي صارت على يوم مسكر حتى المدير يعرف (نقلها يصير بوحدة الحجز).
   */
  async setClinicDays(actor: AuthUser, dto: SetClinicDaysDto, ip: string | null) {
    const branchId = await resolveBranch(this.db, actor, dto.branch_id);
    const weekdays = dto.days.map((d) => d.weekday);
    if (new Set(weekdays).size !== weekdays.length) throw Errors.badRequest('DUPLICATE_WEEKDAY', 'يوم مكرر');
    return this.db.tx(async (q) => {
      const cur = await this.getClinicDaysQ(q, branchId);
      // الأيام اللي ما انسجلت بعد = مفتوحة (مثل getClinicDays)
      const next = new Map<number, boolean>([1, 2, 3, 4, 5, 6, 7].map((w) => [w, true]));
      for (const d of cur) next.set(d.weekday, d.is_open);
      for (const d of dto.days) next.set(d.weekday, d.is_open);
      if (![...next.values()].some(Boolean)) throw Errors.badRequest('NO_OPEN_DAY', 'لازم يوم دوام واحد على الأقل');
      for (const d of dto.days) {
        await q.query(`insert into clinic_weekdays (branch_id, weekday, is_open) values ($1,$2,$3) on conflict (branch_id, weekday) do update set is_open = excluded.is_open`, [branchId, d.weekday, d.is_open]);
      }
      const closed = [...next.entries()].filter(([, open]) => !open).map(([w]) => w);
      const affected = closed.length ? Number((await q.query(
        `select count(*)::int as n from visits where branch_id = $1 and status in ('booked','arrived') and visit_date >= clinic_today()
            and extract(isodow from visit_date)::int = any($2::int[])`, [branchId, closed])).rows[0].n) : 0;
      const moved = closed.length ? await this.runClosure(q, { branchId, kind: 'weekdays', weekdays: closed, reason: 'إغلاق يوم دوام العيادة', actor }) : { moved_visits: 0, unmoved_visits: 0 };
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'schedule.clinic_days', entityType: 'branch', entityId: branchId,
        before: cur, after: [...next.entries()].map(([weekday, is_open]) => ({ weekday, is_open })), ip });
      return { branch_id: branchId, days: [1, 2, 3, 4, 5, 6, 7].map((w) => ({ weekday: w, is_open: next.get(w) ?? true })), affected_visits: affected, ...moved };
    });
  }

  private async getClinicDaysQ(q: Queryable, branchId: number) {
    const { rows } = await q.query(`select weekday, is_open from clinic_weekdays where branch_id = $1 order by weekday`, [branchId]);
    return rows as { weekday: number; is_open: boolean }[];
  }

  // ================================================================ العطل
  async listHolidays(actor: AuthUser, from: string | undefined, to: string | undefined, requestedBranch?: number) {
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    if (from) assertDate(from, 'من تاريخ');
    if (to) assertDate(to, 'إلى تاريخ');
    const { rows } = await this.db.query(
      `select id, holiday_date::text as date, name, kind, cancelled_at from holidays
        where branch_id = $1 and cancelled_at is null and holiday_date >= coalesce($2::date, clinic_today()) and ($3::date is null or holiday_date <= $3::date)
        order by holiday_date`, [branchId, from ?? null, to ?? null]);
    return rows.map((r) => ({ id: Number(r.id), date: r.date, name: r.name, kind: r.kind }));
  }

  async createHoliday(actor: AuthUser, dto: CreateHolidayDto, ip: string | null) {
    assertDate(dto.date);
    const branchId = await resolveBranch(this.db, actor, dto.branch_id);
    try {
      return await this.db.tx(async (q) => {
        const today = (await q.query(`select clinic_today()::text as d`)).rows[0].d;
        if (dto.date < today) throw Errors.badRequest('DATE_IN_PAST', 'ما تنضاف عطلة بتاريخ مضى');
        const { rows } = await q.query(
          `insert into holidays (branch_id, holiday_date, name, kind, created_by) values ($1,$2,$3,$4,$5) returning id`,
          [branchId, dto.date, dto.name.trim(), dto.kind ?? 'official', actor.id]);
        const id = Number(rows[0].id);
        const affected = await this.countVisitsOn(q, branchId, dto.date);
        const moved = await this.runClosure(q, { branchId, kind: 'holiday', date: dto.date, reason: `عطلة: ${dto.name.trim()}`, actor });
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'schedule.holiday_add', entityType: 'holiday', entityId: id, after: { date: dto.date, name: dto.name, kind: dto.kind ?? 'official' }, ip });
        return { id, date: dto.date, name: dto.name.trim(), kind: dto.kind ?? 'official', affected_visits: affected, ...moved };
      });
    } catch (e: any) {
      if (e?.code === '23505') throw conflict('HOLIDAY_EXISTS', 'هذا اليوم عطلة مسبقاً');
      throw e;
    }
  }

  /** إلغاء عطلة قادمة. الحجوزات اللي انتقلت بسببها ما ترجع (افتراض موثق). */
  async cancelHoliday(actor: AuthUser, id: number, ip: string | null) {
    await this.db.tx(async (q) => {
      const h = (await q.query(`select * from holidays where id = $1 for update`, [id])).rows[0];
      if (!h || (actor.role !== 'owner' && Number(h.branch_id) !== actor.branchId)) throw Errors.notFound('العطلة');
      if (h.cancelled_at) return;
      const today = (await q.query(`select clinic_today()::text as d`)).rows[0].d;
      const date = h.holiday_date instanceof Date ? h.holiday_date.toISOString().slice(0, 10) : String(h.holiday_date);
      if (date < today) throw Errors.badRequest('DATE_IN_PAST', 'ما تنلغي عطلة مضت');
      await q.query(`update holidays set cancelled_at = now(), cancelled_by = $2 where id = $1`, [id, actor.id]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(h.branch_id), action: 'schedule.holiday_cancel', entityType: 'holiday', entityId: id, ip });
    });
  }

  // ================================================================ دوام الطبيب
  /** الدوام الساري بتاريخ معين + التغييرات القادمة + الإجازات القادمة. */
  async getDoctor(actor: AuthUser, doctorId: number, onDate?: string) {
    await this.assertDoctor(this.db, actor, doctorId);
    const date = onDate ? assertDate(onDate) : null;
    const eff = await this.db.query(
      `select weekday, to_char(start_time, 'HH24:MI') as start_time, to_char(end_time, 'HH24:MI') as end_time, effective_from::text as effective_from, effective_to::text as effective_to
         from doctor_schedules where doctor_id = $1 and effective_from <= coalesce($2::date, clinic_today())
          and coalesce(effective_to, 'infinity'::date) >= coalesce($2::date, clinic_today()) order by weekday`, [doctorId, date]);
    const upcoming = await this.db.query(
      `select weekday, to_char(start_time, 'HH24:MI') as start_time, to_char(end_time, 'HH24:MI') as end_time, effective_from::text as effective_from, effective_to::text as effective_to
         from doctor_schedules where doctor_id = $1 and effective_from > coalesce($2::date, clinic_today()) order by effective_from, weekday`, [doctorId, date]);
    const off = await this.db.query(
      `select id, off_date::text as date, reason from doctor_days_off where doctor_id = $1 and cancelled_at is null and off_date >= clinic_today() order by off_date`, [doctorId]);
    return { doctor_id: doctorId, weekly: eff.rows, upcoming_changes: upcoming.rows, days_off: off.rows.map((r) => ({ id: Number(r.id), date: r.date, reason: r.reason })) };
  }

  /**
   * يحدد الأسبوع الجديد كامل من تاريخ معين (اليوم أو بعده). التغيير يبدي من تاريخه وما يغير اللي قبله:
   * الصفوف الساري مداها بهذا التاريخ تنقفل قبله، والصفوف اللي تبدي بهذا التاريخ أو بعده (ما بدت) تنستبدل.
   */
  async setWeekly(actor: AuthUser, doctorId: number, dto: SetWeeklyDto, ip: string | null) {
    const from = assertDate(dto.effective_from, 'تاريخ البدء');
    const seen = new Set<number>();
    for (const d of dto.days) {
      if (seen.has(d.weekday)) throw Errors.badRequest('DUPLICATE_WEEKDAY', 'يوم مكرر');
      seen.add(d.weekday);
      if (d.end_time <= d.start_time) throw Errors.badRequest('INVALID_HOURS', 'نهاية الدوام لازم بعد بدايته');
    }
    await this.db.tx(async (q) => {
      await this.assertDoctor(q, actor, doctorId);
      await q.query(`select 1 from doctors where user_id = $1 for update`, [doctorId]);   // تعديلين متزامنين ما يتداخلون
      const today = (await q.query(`select clinic_today()::text as d`)).rows[0].d;
      if (from < today) throw Errors.badRequest('DATE_IN_PAST', 'التغيير يبدي من اليوم أو بعده (ما يتغير الدوام بأثر رجعي)');
      const before = (await q.query(`select weekday, to_char(start_time,'HH24:MI') as start_time, to_char(end_time,'HH24:MI') as end_time, effective_from::text as effective_from, effective_to::text as effective_to from doctor_schedules where doctor_id = $1 and coalesce(effective_to, 'infinity'::date) >= $2::date order by effective_from, weekday`, [doctorId, from])).rows;
      await q.query(`delete from doctor_schedules where doctor_id = $1 and effective_from >= $2::date`, [doctorId, from]);
      await q.query(`update doctor_schedules set effective_to = $2::date - 1 where doctor_id = $1 and effective_from < $2::date and coalesce(effective_to, 'infinity'::date) >= $2::date`, [doctorId, from]);
      for (const d of dto.days) {
        await q.query(`insert into doctor_schedules (doctor_id, weekday, start_time, end_time, effective_from, created_by) values ($1,$2,$3,$4,$5,$6)`, [doctorId, d.weekday, d.start_time, d.end_time, from, actor.id]);
      }
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, action: 'schedule.doctor_weekly', entityType: 'doctor', entityId: doctorId, before, after: { effective_from: from, days: dto.days }, ip });
    });
    return this.getDoctor(actor, doctorId, from);
  }

  async addDayOff(actor: AuthUser, doctorId: number, dto: CreateDayOffDto, ip: string | null) {
    assertDate(dto.date);
    try {
      return await this.db.tx(async (q) => {
        const { branchId: docBranch } = await this.assertDoctor(q, actor, doctorId);
        const today = (await q.query(`select clinic_today()::text as d`)).rows[0].d;
        if (dto.date < today) throw Errors.badRequest('DATE_IN_PAST', 'ما تنضاف إجازة بتاريخ مضى');
        const { rows } = await q.query(`insert into doctor_days_off (doctor_id, off_date, reason, created_by) values ($1,$2,$3,$4) returning id`, [doctorId, dto.date, dto.reason?.trim() || null, actor.id]);
        const id = Number(rows[0].id);
        // غياب الطبيب يأثر على كشفياته ومراجعاته بس، الجلسات تبقى (الممرض ينفذها)
        const affected = Number((await q.query(`select count(*)::int as n from visits where doctor_id = $1 and visit_date = $2 and status in ('booked','arrived')`, [doctorId, dto.date])).rows[0].n);
        const moved = await this.runClosure(q, { branchId: docBranch, kind: 'doctor_day_off', date: dto.date, doctorId, reason: 'إجازة الطبيب', actor });
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, action: 'schedule.day_off_add', entityType: 'doctor_day_off', entityId: id, after: { doctor_id: doctorId, date: dto.date, reason: dto.reason ?? null }, ip });
        return { id, date: dto.date, reason: dto.reason?.trim() || null, affected_visits: affected, ...moved };
      });
    } catch (e: any) {
      if (e?.code === '23505') throw conflict('DAY_OFF_EXISTS', 'هذا اليوم إجازة للطبيب مسبقاً');
      throw e;
    }
  }

  async cancelDayOff(actor: AuthUser, id: number, ip: string | null) {
    await this.db.tx(async (q) => {
      const d = (await q.query(`select * from doctor_days_off where id = $1 for update`, [id])).rows[0];
      if (!d) throw Errors.notFound('الإجازة');
      await this.assertDoctor(q, actor, Number(d.doctor_id));    // فرع ثاني → 404
      if (d.cancelled_at) return;
      await q.query(`update doctor_days_off set cancelled_at = now(), cancelled_by = $2 where id = $1`, [id, actor.id]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, action: 'schedule.day_off_cancel', entityType: 'doctor_day_off', entityId: id, ip });
    });
  }

  private async assertDoctor(q: Queryable, actor: AuthUser, doctorId: number) {
    const { rows } = await q.query(`select u.branch_id, u.is_active from doctors d join users u on u.id = d.user_id where d.user_id = $1`, [doctorId]);
    const r = rows[0];
    if (!r || (actor.role !== 'owner' && Number(r.branch_id) !== actor.branchId)) throw Errors.notFound('الطبيب');
    // الطبيب نفسه يشوف دوامه بس (ما يشوف دوام زميله)
    if (actor.role === 'doctor' && actor.id !== doctorId) throw Errors.notFound('الطبيب');
    return { branchId: Number(r.branch_id) };
  }

  private async countVisitsOn(q: Queryable, branchId: number, date: string): Promise<number> {
    return Number((await q.query(`select count(*)::int as n from visits where branch_id = $1 and visit_date = $2 and status in ('booked','arrived')`, [branchId, date])).rows[0].n);
  }

  // ================================================================ التوفر (تعتمد عليه وحدة الحجز)
  /**
   * لكل يوم بالمدى: العيادة مفتوحة؟ (يوم الدوام + ماكو عطلة)، وإذا حددنا طبيب: يداوم؟ بأي ساعات؟ أو إجازة؟
   * الجلسات ما مربوطة بدوام الطبيب، فيكفيها clinic_open.
   */
  async availability(actor: AuthUser, from: string, to: string, doctorId?: number, requestedBranch?: number): Promise<{ branch_id: number; days: DayAvailability[] }> {
    assertDate(from, 'من تاريخ'); assertDate(to, 'إلى تاريخ');
    if (to < from) throw Errors.badRequest('INVALID_RANGE', 'تاريخ النهاية قبل البداية');
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    if (doctorId !== undefined) {
      const d = await this.assertDoctor(this.db, actor, doctorId);
      if (d.branchId !== branchId) throw Errors.notFound('الطبيب');
    }
    return { branch_id: branchId, days: await this.availabilityQ(this.db, branchId, from, to, doctorId) };
  }

  async availabilityQ(q: Queryable, branchId: number, from: string, to: string, doctorId?: number): Promise<DayAvailability[]> {
    const span = (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000 + 1;
    if (span > MAX_RANGE_DAYS) throw Errors.badRequest('RANGE_TOO_LONG', `المدى أطول من ${MAX_RANGE_DAYS} يوم`);
    const { rows } = await q.query(
      `select d::date::text as date, extract(isodow from d)::int as weekday,
              coalesce(cw.is_open, true) as weekday_open, h.id as holiday_id, h.name as holiday_name, h.kind as holiday_kind,
              ds.start_time is not null as has_schedule, to_char(ds.start_time, 'HH24:MI') as start_time, to_char(ds.end_time, 'HH24:MI') as end_time,
              o.id as off_id, o.reason as off_reason
         from generate_series($2::date, $3::date, interval '1 day') d
         left join clinic_weekdays cw on cw.branch_id = $1 and cw.weekday = extract(isodow from d)::int
         left join holidays h on h.branch_id = $1 and h.holiday_date = d::date and h.cancelled_at is null
         left join doctor_schedules ds on $4::bigint is not null and ds.doctor_id = $4 and ds.weekday = extract(isodow from d)::int
              and ds.effective_from <= d::date and coalesce(ds.effective_to, 'infinity'::date) >= d::date
         left join doctor_days_off o on $4::bigint is not null and o.doctor_id = $4 and o.off_date = d::date and o.cancelled_at is null
        order by d`, [branchId, from, to, doctorId ?? null]);
    return rows.map((r): DayAvailability => {
      const open = r.weekday_open && r.holiday_id === null;
      const out: DayAvailability = {
        date: r.date, weekday: r.weekday, clinic_open: open,
        closed_reason: open ? null : r.holiday_id !== null ? 'holiday' : 'weekday',
        holiday: r.holiday_id === null ? null : { id: Number(r.holiday_id), name: r.holiday_name, kind: r.holiday_kind },
      };
      if (doctorId !== undefined) {
        out.doctor = {
          works: open && r.has_schedule && r.off_id === null,
          start_time: r.has_schedule ? r.start_time : null, end_time: r.has_schedule ? r.end_time : null,
          day_off: r.off_id === null ? null : { id: Number(r.off_id), reason: r.off_reason },
        };
      }
      return out;
    });
  }

  /** أقرب يوم بعد التاريخ تكون العيادة مفتوحة (والطبيب يداوم إذا حددناه). تستخدمه وحدة الحجز لنقل الحجوزات. */
  async nextAvailableDate(q: Queryable, branchId: number, after: string, doctorId?: number, searchDays = 60): Promise<string | null> {
    const start = new Date(`${after}T00:00:00Z`); start.setUTCDate(start.getUTCDate() + 1);
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + searchDays - 1);
    const days = await this.availabilityQ(q, branchId, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10), doctorId);
    const hit = days.find((d) => (doctorId === undefined ? d.clinic_open : d.doctor!.works));
    return hit?.date ?? null;
  }
}
