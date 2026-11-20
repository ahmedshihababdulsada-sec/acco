import { HttpException, Injectable, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { resolveBranch } from '../common/branch';
import { Errors } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { ClosureEvent, ScheduleService, assertDate } from '../schedule/schedule.service';
import { SettingsService } from '../settings/settings.service';
import { CancelBookingDto, CreateBookingDto, MoveBookingDto, StopDayDto } from './bookings.dto';

/** أبعد يوم يقدر الحجز اليدوي يوصله من اليوم (60 يوم). نقل الإغلاقات ما يتقيد بيه لأن الغلط مو غلط الزبون. */
export const MAX_AHEAD_DAYS = 60;
const SEARCH_DAYS = 60;
const MAX_RANGE_DAYS = 62;

const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const conflict = (code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, 409);

/** من ينفذ العملية: موظف (userId) أو زبون من التطبيق (customerId). الزبون ما عنده userId (حجوزاته source=app). */
export interface Who { userId: number | null; customerId: number | null; role: string; branchId: number | null; isOwner: boolean }
export const staffWho = (a: AuthUser): Who => ({ userId: a.id, customerId: null, role: a.role, branchId: a.branchId, isOwner: a.role === 'owner' });
export const customerWho = (c: { id: number; branchId: number }): Who => ({ userId: null, customerId: c.id, role: 'customer', branchId: c.branchId, isOwner: false });

interface VisitRow {
  id: number; branch_id: number; customer_id: number; visit_date: string; seq_no: number; status: string; doctor_id: number | null;
  consultation_id: number | null; consultation_status: string | null; consultation_kind: string | null; parent_consultation_id: number | null;
}

@Injectable()
export class BookingsService implements OnModuleInit {
  constructor(
    private readonly db: DbService, private readonly audit: AuditService,
    private readonly schedule: ScheduleService, private readonly settings: SettingsService,
  ) {}

  onModuleInit() { this.schedule.registerClosureHandler((q, ev) => this.moveForClosure(q, ev)); }

  // ================================================================ الحجز
  /**
   * كشفية أو مراجعة لطبيب بيوم معين. وصفة القفل من اختبارات المرحلة 1أ (t.book):
   * صف booking_days FOR UPDATE يحمي الحد اليومي ورقم التسلسل، والزبون ما ياخذ زيارة ثانية فعالة بنفس اليوم.
   */
  async create(actor: AuthUser, dto: CreateBookingDto, ip: string | null) {
    assertDate(dto.date);
    const branchId = await resolveBranch(this.db, actor, dto.branch_id);
    return this.createImpl(staffWho(actor), branchId, dto, ip);
  }

  /** حجز كشفية/مراجعة من تطبيق الزبون: نفس القواعد، المصدر «تطبيق» وبدون موظف */
  async createForCustomer(c: { id: number; branchId: number }, dto: { doctor_id: number; date: string; type?: 'standard' | 'sessions_only'; note?: string; service_id?: number }, ip: string | null) {
    assertDate(dto.date);
    return this.createImpl(customerWho(c), c.branchId, { customer_id: c.id, doctor_id: dto.doctor_id, date: dto.date, type: dto.type, note: dto.note, service_id: dto.service_id }, ip);
  }

  private async createImpl(who: Who, branchId: number, dto: { customer_id: number; doctor_id: number; date: string; type?: 'standard' | 'sessions_only'; note?: string; service_id?: number }, ip: string | null) {
    const note = dto.note?.trim() || null;
    return this.db.tx(async (q) => {
      if (dto.service_id !== undefined) {
        const sv = (await q.query(`select 1 from services where id = $1 and branch_id = $2 and kind = 'treatment' and is_active`, [dto.service_id, branchId])).rows[0];
        if (!sv) throw Errors.badRequest('INVALID_SERVICE', 'الخدمة غير موجودة أو غير فعالة');
      }
      const today = await this.today(q);
      this.assertHorizon(dto.date, today);
      const cust = (await q.query(`select id, status from customers where id = $1`, [dto.customer_id])).rows[0];
      if (!cust) throw Errors.notFound('الزبون');
      if (cust.status !== 'active') throw conflict('CUSTOMER_MERGED', 'هذا الملف مدموج بملف ثاني');
      const doc = (await q.query(`select u.branch_id, u.is_active from doctors d join users u on u.id = d.user_id where d.user_id = $1`, [dto.doctor_id])).rows[0];
      if (!doc || Number(doc.branch_id) !== branchId) throw Errors.notFound('الطبيب');
      if (!doc.is_active) throw conflict('DOCTOR_INACTIVE', 'الطبيب معطل');
      const limit = await this.dailyLimit(q, branchId);

      await this.assertOpen(q, branchId, dto.date, dto.doctor_id, dto.customer_id, limit, today);

      const days = await this.lockDays(q, branchId, [dto.date]);
      // زيارة الزبون الفعالة بهذا اليوم (مثلاً جلسات ليزر محجوزة): الكشفية تنضاف لنفس الزيارة بنفس الرقم والمقعد (زيارة وحدة = كشفية + جلسات).
      // المرفوض فقط: عنده كشفية فعالة بنفس اليوم (زيارة وحدة ما تشيل كشفيتين).
      const ex = (await q.query(
        `select v.id, v.seq_no, c.id as consultation_id from visits v left join consultations c on c.visit_id = v.id and c.status <> 'cancelled'
          where v.customer_id = $1 and v.visit_date = $2 and v.status in ('booked','arrived') for update of v`, [dto.customer_id, dto.date])).rows[0];
      if (ex?.consultation_id) throw conflict('ALREADY_BOOKED_THAT_DAY', 'توجد كشفية فعالة بنفس هذا اليوم: اختر يوماً ثانياً', { next_available_date: await this.nextDayWithRoom(q, branchId, dto.date, dto.doctor_id, dto.customer_id, limit, SEARCH_DAYS, addDays(today, MAX_AHEAD_DAYS)) });
      if (!ex && days.get(dto.date)!.stopped) throw await this.dayStopped(q, branchId, dto.date, dto.doctor_id, dto.customer_id, limit, today);
      if (!ex && days.get(dto.date)!.used >= limit) throw await this.dayFull(q, branchId, dto.date, dto.doctor_id, dto.customer_id, limit, today);   // الانضمام ما ياخذ مقعد جديد

      // «جلسات فقط»: كشفية بسعرها الخاص (الافتراضي مجانية) والطبيب ينظم الجلسات؛ المراجعة المجانية التلقائية تخص الكشفية العادية بس
      const sessionsOnly = dto.type === 'sessions_only';
      const parent = sessionsOnly ? null : await this.freeFollowupParent(q, branchId, dto.customer_id, dto.doctor_id, dto.date);
      const consKind = sessionsOnly ? 'sessions_only' : parent ? 'free_followup' : 'new';
      let visitId: number; let seq: number;
      if (ex) {
        visitId = Number(ex.id); seq = Number(ex.seq_no);
        await q.query(`update visits set doctor_id = $2 where id = $1`, [visitId, dto.doctor_id]);
      } else {
        seq = await this.takeSeat(q, branchId, dto.date);
        visitId = Number((await q.query(
          `insert into visits (branch_id, customer_id, visit_date, seq_no, source, doctor_id, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
          [branchId, dto.customer_id, dto.date, seq, who.userId === null ? 'app' : 'cashier', dto.doctor_id, who.userId])).rows[0].id);
      }
      const consId = Number((await q.query(
        `insert into consultations (branch_id, visit_id, customer_id, doctor_id, kind, parent_consultation_id, booking_note, interest_service_id) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [branchId, visitId, dto.customer_id, dto.doctor_id, consKind, parent, note, dto.service_id ?? null])).rows[0].id);
      await q.query(`insert into booking_events (visit_id, consultation_id, event, to_date, to_seq, actor_user_id, actor_customer_id, reason) values ($1,$2,'booked',$3,$4,$5,$6,$7)`, [visitId, consId, dto.date, seq, who.userId, who.customerId, ex ? 'انضمت الكشفية لزيارة الجلسات بنفس اليوم' : null]);
      await this.audit.log(q, { actorUserId: who.userId, actorRole: who.role, branchId, action: 'booking.create', entityType: 'visit', entityId: visitId,
        after: { customer_id: dto.customer_id, doctor_id: dto.doctor_id, date: dto.date, seq_no: seq, kind: consKind, joined_existing_visit: !!ex, note, service_id: dto.service_id ?? null }, ip });
      return (await this.views(q, [visitId]))[0];
    });
  }

  async cancel(actor: AuthUser, id: number, dto: CancelBookingDto, ip: string | null) {
    const reason = dto.reason.trim();
    if (reason.length < 3) throw Errors.badRequest('REASON_REQUIRED', 'اكتب سبب الإلغاء');
    return this.cancelImpl(staffWho(actor), id, reason, ip, false);
  }

  /** الزبون يلغي كشفيته قبل الدفع (القسم 4). الزيارة اللي بيها جلسات تنتقل مو تنلغي. */
  async cancelForCustomer(c: { id: number; branchId: number }, id: number, ip: string | null) {
    return this.cancelImpl(customerWho(c), id, 'ألغاه الزبون من التطبيق', ip, true);
  }

  private async cancelImpl(who: Who, id: number, reason: string, ip: string | null, selfService: boolean) {
    return this.db.tx(async (q) => {
      const v = await this.loadVisit(q, who, id);
      if (selfService) await this.assertSelfServiceVisit(q, v, 'cancel');
      // كشفية غير مدفوعة منضمة لزيارة فيها جلسات: نلغي الكشفية بس، والزيارة وجلساتها تبقى (ما ينلغي موعد الجلسات بسبب كشفية)
      if (v.consultation_id && v.consultation_status === 'awaiting_payment' && ['booked', 'arrived'].includes(v.status)) {
        const live = await q.query(`select 1 from treatment_sessions where visit_id = $1 and status in ('booked','paid')`, [id]);
        if (live.rowCount) {
          await q.query(`update consultations set status = 'cancelled' where id = $1`, [v.consultation_id]);
          await q.query(`update visits set doctor_id = null where id = $1`, [id]);                    // رجعت زيارة جلسات بدون كشفية
          await q.query(`insert into booking_events (visit_id, consultation_id, event, from_date, from_seq, actor_user_id, actor_customer_id, reason) values ($1,$2,'cancelled',$3,$4,$5,$6,$7)`,
            [id, v.consultation_id, v.visit_date, v.seq_no, who.userId, who.customerId, `${reason} (الكشفية فقط: جلسات الزيارة باقية)`]);
          await this.audit.log(q, { actorUserId: who.userId, actorRole: who.role, branchId: v.branch_id, action: 'booking.cancel_consultation_only', entityType: 'visit', entityId: id, reason, before: { date: v.visit_date, seq_no: v.seq_no, consultation_id: v.consultation_id }, ip });
          return (await this.views(q, [id]))[0];
        }
      }
      if (v.status !== 'booked') throw conflict('NOT_CANCELLABLE', v.status === 'arrived' ? 'الحجز مدفوع. الإلغاء يصير باسترجاع الدفع' : 'الحجز مو فعال');
      if (v.consultation_status && v.consultation_status !== 'awaiting_payment') throw conflict('NOT_CANCELLABLE', 'الحجز مدفوع. الإلغاء يصير باسترجاع الدفع');
      const paidSessions = await q.query(`select 1 from treatment_sessions where visit_id = $1 and status = 'paid'`, [id]);
      if (paidSessions.rowCount) throw conflict('HAS_PAID_SESSIONS', 'بالزيارة جلسات مدفوعة: انقلها أو استرجع دفعها أول');
      await this.lockDays(q, v.branch_id, [v.visit_date]);
      await q.query(`update visits set status = 'cancelled', cancelled_at = now(), cancel_reason = $2 where id = $1`, [id, reason]);
      if (v.consultation_id) await q.query(`update consultations set status = 'cancelled' where id = $1`, [v.consultation_id]);
      await this.releaseSeat(q, v.branch_id, v.visit_date);
      await this.releaseSessions(q, id, 'cancelled', who.userId);                 // جلسات الزيارة ترجع «تنتظر حجز» وجلسات الخطة اللي بعدها تتحرر
      await q.query(`insert into booking_events (visit_id, consultation_id, event, from_date, from_seq, actor_user_id, actor_customer_id, reason) values ($1,$2,'cancelled',$3,$4,$5,$6,$7)`,
        [id, v.consultation_id, v.visit_date, v.seq_no, who.userId, who.customerId, reason]);
      await this.audit.log(q, { actorUserId: who.userId, actorRole: who.role, branchId: v.branch_id, action: 'booking.cancel', entityType: 'visit', entityId: id, reason, before: { date: v.visit_date, seq_no: v.seq_no }, ip });
      return (await this.views(q, [id]))[0];
    });
  }

  /**
   * نقل حجز ليوم ثاني برقم جديد بنهاية اليوم الجديد (الرقم القديم ما ينعاد). مسموح قبل الدفع وبعده، وقبل ما يدخل للطبيب.
   * كل شي ينجح كامل أو ما يتغير شي.
   */
  async move(actor: AuthUser, id: number, dto: MoveBookingDto, ip: string | null) {
    assertDate(dto.date);
    return this.moveImpl(staffWho(actor), id, dto.date, dto.reason?.trim() || null, ip, false);
  }

  /** الزبون يغير يوم كشفيته قبل الدفع بس (القسم 4) */
  async moveForCustomer(c: { id: number; branchId: number }, id: number, date: string, ip: string | null) {
    assertDate(date);
    return this.moveImpl(customerWho(c), id, date, null, ip, true);
  }

  private async moveImpl(who: Who, id: number, date: string, reason: string | null, ip: string | null, selfService: boolean) {
    const dto = { date, reason };
    return this.db.tx(async (q) => {
      const v = await this.loadVisit(q, who, id);
      if (selfService) await this.assertSelfServiceVisit(q, v, 'move');
      const today = await this.today(q);
      this.assertHorizon(dto.date, today);
      if (!['booked', 'arrived'].includes(v.status)) throw conflict('NOT_MOVABLE', 'الحجز مو فعال');
      if (v.consultation_status && !['awaiting_payment', 'paid'].includes(v.consultation_status)) throw conflict('NOT_MOVABLE', 'الزبون دخل للطبيب، ما يتنقل الحجز');
      if (dto.date === v.visit_date) throw Errors.badRequest('SAME_DATE', 'نفس يوم الحجز الحالي');
      const limit = await this.dailyLimit(q, v.branch_id);

      // المراجعة المجانية تبقى مجانية بس ضمن مدتها من كشفيتها
      if (v.consultation_kind === 'free_followup' && v.parent_consultation_id) {
        const windowDays = await this.settings.effective<number>(q, v.branch_id, 'booking.free_followup_days');
        const parentDate = (await q.query(`select v.visit_date::text as d from consultations c join visits v on v.id = c.visit_id where c.id = $1`, [v.parent_consultation_id])).rows[0].d;
        if (dto.date > addDays(parentDate, windowDays)) throw conflict('FOLLOWUP_WINDOW_EXPIRED', `المراجعة المجانية تنتهي بعد ${windowDays} يوم من الكشفية. ألغِ الحجز واحجز كشفية جديدة`);
      }
      await this.assertOpen(q, v.branch_id, dto.date, v.doctor_id ?? undefined, v.customer_id, limit, today);

      const ok = await this.relocate(q, v, dto.date, limit);
      if (ok === 'full') throw await this.dayFull(q, v.branch_id, dto.date, v.doctor_id ?? undefined, v.customer_id, limit, today);
      if (ok === 'stopped') throw await this.dayStopped(q, v.branch_id, dto.date, v.doctor_id ?? undefined, v.customer_id, limit, today);
      if (ok === 'customer_busy') throw conflict('ALREADY_BOOKED_THAT_DAY', 'الزبون عنده حجز فعال بنفس اليوم');
      await q.query(`insert into booking_events (visit_id, consultation_id, event, from_date, to_date, from_seq, to_seq, actor_user_id, actor_customer_id, reason) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, v.consultation_id, selfService ? 'postponed_by_customer' : 'moved_by_cashier', v.visit_date, dto.date, v.seq_no, ok.seq, who.userId, who.customerId, dto.reason]);
      await this.audit.log(q, { actorUserId: who.userId, actorRole: who.role, branchId: v.branch_id, action: 'booking.move', entityType: 'visit', entityId: id,
        reason: dto.reason ?? undefined, before: { date: v.visit_date, seq_no: v.seq_no }, after: { date: dto.date, seq_no: ok.seq }, ip });
      return (await this.views(q, [id]))[0];
    });
  }

  /** نهاية اليوم: الحجز الغير مدفوع بيوم مضى يصير «فات» (بدون عقوبة) وكشفيته تنلغي. المهمة المجدولة تستدعيه، والمدير يگدر يدوياً. */
  async closePastDays(actor: AuthUser, requestedBranch?: number) {
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    return this.closeBranchPastDays(branchId, actor);
  }

  // ================================================================ إيقاف الحجز ليوم
  /** المدير يوقف الحجز الجديد ليوم (زحمة مثلاً): الحجوزات الموجودة تبقى، والجديدة (تطبيق، كاشير، جلسات الخطة) تتخطى اليوم تلقائياً. */
  async stopDay(actor: AuthUser, date: string, dto: StopDayDto, ip: string | null) {
    assertDate(date);
    const branchId = await resolveBranch(this.db, actor, dto.branch_id);
    const reason = dto.reason?.trim() || null;
    return this.db.tx(async (q) => {
      const today = await this.today(q);
      this.assertHorizon(date, today);
      const days = await this.lockDays(q, branchId, [date]);
      if (days.get(date)!.stopped) throw conflict('ALREADY_STOPPED', 'الحجز موقوف لهذا اليوم أصلاً');
      await q.query(`update booking_days set stopped_at = now(), stopped_by = $3, stop_reason = $4 where branch_id = $1 and day = $2`, [branchId, date, actor.id, reason]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'booking.stop_day', entityType: 'booking_day', reason: reason ?? undefined, after: { date }, ip });
      return this.daySummary(q, branchId, date);
    });
  }

  async resumeDay(actor: AuthUser, date: string, requestedBranch: number | undefined, ip: string | null) {
    assertDate(date);
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    return this.db.tx(async (q) => {
      const days = await this.lockDays(q, branchId, [date]);
      if (!days.get(date)!.stopped) throw conflict('NOT_STOPPED', 'الحجز مو موقوف لهذا اليوم');
      await q.query(`update booking_days set stopped_at = null, stopped_by = null, stop_reason = null where branch_id = $1 and day = $2`, [branchId, date]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'booking.resume_day', entityType: 'booking_day', after: { date }, ip });
      return this.daySummary(q, branchId, date);
    });
  }

  /** زيارات مدفوعة (كشفية أو جلسة) بيوم مضى وما انخدمت: الكشفية ما دخلت للطبيب أو جلسة مدفوعة ما انفذت. اللي دخل للطبيب وما خلص مو منها (الطبيب يكمله). */
  private static readonly UNSERVED_SQL = `v.status = 'arrived' and v.visit_date < clinic_today()
      and (c.id is null or c.status in ('paid','finished'))
      and (c.status = 'paid' or exists (select 1 from treatment_sessions s where s.visit_id = v.id and s.status = 'paid'))`;

  /** actor = null للمهمة المجدولة (النظام) */
  async closeBranchPastDays(branchId: number, actor: AuthUser | null): Promise<{ branch_id: number; missed: number; rolled_over: number }> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query(
        `update visits set status = 'missed' where branch_id = $1 and status = 'booked' and visit_date < clinic_today() returning id, visit_date::text as d, seq_no`, [branchId]);
      if (rows.length) {
        const ids = rows.map((r) => r.id);
        await q.query(`update consultations set status = 'cancelled' where visit_id = any($1::bigint[]) and status = 'awaiting_payment'`, [ids]);
        // العدّاد لازم يطابق الزيارات الفعالة دائماً (فحص v_integrity_checks)، فالمكان ينحسب راجع حتى لو اليوم مضى
        await q.query(
          `update booking_days bd set used_slots = greatest(bd.used_slots - x.n, 0)
             from (select visit_date, count(*)::int as n from visits where id = any($2::bigint[]) group by visit_date) x
            where bd.branch_id = $1 and bd.day = x.visit_date`, [branchId, ids]);
        await q.query(
          `insert into booking_events (visit_id, event, from_date, from_seq, actor_user_id, reason)
           select v.id, 'missed', v.visit_date, v.seq_no, $2, 'إقفال اليوم' from visits v where v.id = any($1::bigint[])`, [ids, actor?.id ?? null]);
        for (const id of [...ids].sort((a: number, b: number) => a - b)) await this.releaseSessions(q, Number(id), 'missed', actor?.id ?? null);     // الجلسات ما تنلغي: ترجع «تنتظر حجز» وتتحرر اللي بعدها
      }
      // الزبون اللي دفع وما وصله الدور: ينتقل لأقرب يوم فيه مكان برقم جديد بنهاية اليوم (جلساته وياه). إذا ما لگينا يوم يبقى ويطلع بقائمة المتابعة.
      const limit = await this.dailyLimit(q, branchId);
      const unserved = (await q.query(
        `select v.id from visits v left join consultations c on c.visit_id = v.id and c.status <> 'cancelled' where v.branch_id = $1 and ${BookingsService.UNSERVED_SQL} order by v.visit_date, v.seq_no, v.id`, [branchId])).rows.map((r) => Number(r.id));
      let rolled = 0;
      for (const id of unserved) {
        const v = await this.loadVisitRaw(q, id);
        if (!v || v.status !== 'arrived') continue;
        const yesterday = addDays((await this.today(q)), -1);
        let after = yesterday;
        for (let attempt = 0; attempt < 5; attempt++) {
          const target = await this.nextDayWithRoom(q, branchId, after, v.doctor_id ?? undefined, v.customer_id, limit, SEARCH_DAYS);
          if (!target) break;
          const r = await this.relocate(q, v, target, limit);
          if (typeof r === 'object') {
            await q.query(`insert into booking_events (visit_id, consultation_id, event, from_date, to_date, from_seq, to_seq, actor_user_id, reason) values ($1,$2,'rolled_over',$3,$4,$5,$6,$7,$8)`,
              [id, v.consultation_id, v.visit_date, target, v.seq_no, r.seq, actor?.id ?? null, 'ما وصله الدور باليوم']);
            rolled++; break;
          }
          after = target;
        }
      }
      if (rows.length || rolled || actor) await this.audit.log(q, { actorUserId: actor?.id ?? null, actorRole: actor?.role ?? 'system', branchId, action: 'booking.close_past_days', after: { missed: rows.length, rolled_over: rolled } });
      return { branch_id: branchId, missed: rows.length, rolled_over: rolled };
    });
  }

  // ================================================================ القراءة
  async list(actor: AuthUser, p: { date?: string; from?: string; to?: string; doctorId?: number; customerId?: number; status?: string; branchId?: number }) {
    const branchId = await resolveBranch(this.db, actor, p.branchId);
    let from = p.from; let to = p.to;
    if (p.date) { assertDate(p.date); from = to = p.date; }
    if (from) assertDate(from, 'من تاريخ');
    if (to) assertDate(to, 'إلى تاريخ');
    if (!from && !to) from = to = await this.today(this.db);
    if (!from || !to) throw Errors.badRequest('INVALID_RANGE', 'حدد التاريخين أو يوم واحد');
    if (to < from) throw Errors.badRequest('INVALID_RANGE', 'تاريخ النهاية قبل البداية');
    if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1 > MAX_RANGE_DAYS) throw Errors.badRequest('RANGE_TOO_LONG', `المدى أطول من ${MAX_RANGE_DAYS} يوم`);
    if (p.status && !['booked', 'arrived', 'missed', 'cancelled'].includes(p.status)) throw Errors.badRequest('INVALID_STATUS', 'حالة غير معروفة');
    const doctorId = actor.role === 'doctor' ? actor.id : p.doctorId;     // الطبيب حجوزاته بس
    const { rows } = await this.db.query(
      `select v.id from visits v where v.branch_id = $1 and v.visit_date between $2 and $3
          and ($4::bigint is null or v.doctor_id = $4) and ($5::bigint is null or v.customer_id = $5) and ($6::text is null or v.status = $6)
        order by v.visit_date, v.seq_no`, [branchId, from, to, doctorId ?? null, p.customerId ?? null, p.status ?? null]);
    const bookings = await this.views(this.db, rows.map((r) => Number(r.id)));
    const out: Record<string, unknown> = { branch_id: branchId, from, to, bookings };
    if (from === to) out.day = await this.daySummary(this.db, branchId, from);
    return out;
  }

  /** لكل يوم بالمدى: مفتوح؟ الطبيب يداوم؟ كم مكان مستخدم من الحد؟ (شاشة الحجز) */
  async days(actor: AuthUser, from: string, to: string, doctorId?: number, requestedBranch?: number) {
    const r = await this.schedule.availability(actor, from, to, doctorId, requestedBranch);
    const limit = await this.dailyLimit(this.db, r.branch_id);
    const { rows } = await this.db.query(`select day::text as day, used_slots, (stopped_at is not null) as stopped, stop_reason from booking_days where branch_id = $1 and day between $2 and $3`, [r.branch_id, from, to]);
    const used = new Map(rows.map((x) => [x.day, Number(x.used_slots)]));
    const stoppedDays = new Map(rows.filter((x) => x.stopped).map((x) => [x.day as string, (x.stop_reason as string | null)]));
    return { branch_id: r.branch_id, daily_limit: limit, days: r.days.map((d) => {
      const u = used.get(d.date) ?? 0;
      const stopped = stoppedDays.has(d.date);
      const available = d.clinic_open && (d.doctor ? d.doctor.works : true) && u < limit && !stopped;
      return { ...d, used_slots: u, remaining: Math.max(limit - u, 0), stopped, stop_reason: stoppedDays.get(d.date) ?? null, bookable: available };
    }) };
  }

  /** أيام الحجز للزبون (قراءة بس): نفس حساب الكاشير */
  async daysForCustomer(c: { id: number; branchId: number }, from: string, to: string, doctorId?: number) {
    const shim: AuthUser = { id: 0, username: 'customer', role: 'cashier', branchId: c.branchId, mustChangePassword: false };
    const r = await this.days(shim, from, to, doctorId);
    // زيارات الزبون نفسه بالمدى: يوم فيه كشفية فعالة ما ينحجز، ويوم فيه جلسات بس ينحجز (الكشفية تنضاف لنفس الزيارة وما تاخذ مقعد جديد)
    const mine = (await this.db.query(
      `select v.visit_date::text as d, (c.id is not null) as has_consultation, (select count(*)::int from treatment_sessions s where s.visit_id = v.id and s.status in ('booked','paid')) as sessions
         from visits v left join consultations c on c.visit_id = v.id and c.status <> 'cancelled'
        where v.customer_id = $1 and v.status in ('booked','arrived') and v.visit_date between $2 and $3`, [c.id, from, to])).rows;
    const byDay = new Map(mine.map((x) => [x.d as string, { has_consultation: x.has_consultation as boolean, sessions_count: Number(x.sessions) }]));
    return { ...r, days: r.days.map((d) => {
      const own = byDay.get(d.date) ?? null;
      const open = d.clinic_open && (d.doctor ? d.doctor.works : true);
      return { ...d, customer_visit: own, bookable: own ? !own.has_consultation && open : d.bookable };
    }) };
  }

  /** للكاشير: زبائن انتقلت مواعيدهم بسبب عطلة/إجازة (يتصل بيهم)، وحجوزات ما لگينا لها يوم بديل (باقية على يوم مسكر). */
  async followUp(actor: AuthUser, days = 7, requestedBranch?: number) {
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    const n = Math.min(Math.max(Math.trunc(days) || 7, 1), 60);
    const moved = await this.db.query(
      `select e.visit_id, e.from_date::text as from_date, e.to_date::text as to_date, e.from_seq, e.to_seq, e.reason, e.created_at,
              c.id as customer_id, c.full_name, c.phone
         from booking_events e join visits v on v.id = e.visit_id join customers c on c.id = v.customer_id
        where e.event in ('moved_by_closure','rolled_over') and v.branch_id = $1 and e.created_at >= now() - ($2 || ' days')::interval and v.status in ('booked','arrived')
        order by e.created_at desc, e.id desc`, [branchId, String(n)]);
    const stuck = await this.db.query(
      `select v.id from visits v
         left join clinic_weekdays cw on cw.branch_id = v.branch_id and cw.weekday = extract(isodow from v.visit_date)::int
         left join holidays h on h.branch_id = v.branch_id and h.holiday_date = v.visit_date and h.cancelled_at is null
         left join doctor_days_off o on o.doctor_id = v.doctor_id and o.off_date = v.visit_date and o.cancelled_at is null
        where v.branch_id = $1 and v.status in ('booked','arrived') and v.visit_date >= clinic_today()
          and (coalesce(cw.is_open, true) = false or h.id is not null or o.id is not null)
        order by v.visit_date, v.seq_no`, [branchId]);
    return {
      branch_id: branchId,
      moved: moved.rows.map((r) => ({ visit_id: Number(r.visit_id), customer: { id: Number(r.customer_id), full_name: r.full_name, phone: r.phone },
        from_date: r.from_date, to_date: r.to_date, from_seq: r.from_seq, to_seq: r.to_seq, reason: r.reason, at: r.created_at })),
      stuck: await this.views(this.db, stuck.rows.map((r) => Number(r.id))),
      // مدفوعين بيوم مضى وما انخدموا ولا لگينا لهم يوم (المتصل بيهم الكاشير)
      unserved: await this.views(this.db, (await this.db.query(
        `select v.id from visits v left join consultations c on c.visit_id = v.id and c.status <> 'cancelled' where v.branch_id = $1 and ${BookingsService.UNSERVED_SQL} order by v.visit_date, v.seq_no`, [branchId])).rows.map((r) => Number(r.id))),
    };
  }

  // ================================================================ نقل الحجوزات عند الإغلاق (القسم 5 ط)
  /**
   * عطلة / إجازة طبيب / يوم دوام انسكر: كل حجز متأثر ينتقل لأقرب يوم مفتوح (والطبيب يداوم) بيه مكان وما عند الزبون حجز بيه،
   * برقم جديد بنهاية اليوم الجديد. بترتيب الأسبقية القديمة. الحجز اللي ما لگينا له يوم خلال 60 يوم يبقى ويطلع بقائمة المتابعة.
   * الزبون اللي دخل للطبيب ما يتنقل. المراجعة المجانية تبقى مجانية حتى لو الموعد الجديد بعد مدتها.
   */
  private async moveForClosure(q: Queryable, ev: ClosureEvent): Promise<{ moved: number; unmoved: number }> {
    let ids: number[];
    const base = `select v.id from visits v left join consultations c on c.visit_id = v.id and c.status <> 'cancelled'
                   where v.branch_id = $1 and v.status in ('booked','arrived') and (c.id is null or c.status in ('awaiting_payment','paid'))`;
    if (ev.kind === 'holiday') ids = (await q.query(`${base} and v.visit_date = $2 order by v.seq_no, v.id`, [ev.branchId, ev.date])).rows.map((r) => Number(r.id));
    else if (ev.kind === 'doctor_day_off') ids = (await q.query(`${base} and v.visit_date = $2 and v.doctor_id = $3 order by v.seq_no, v.id`, [ev.branchId, ev.date, ev.doctorId])).rows.map((r) => Number(r.id));
    else ids = (await q.query(`${base} and v.visit_date >= clinic_today() and extract(isodow from v.visit_date)::int = any($2::int[]) order by v.visit_date, v.seq_no, v.id`, [ev.branchId, ev.weekdays])).rows.map((r) => Number(r.id));

    const limit = await this.dailyLimit(q, ev.branchId);
    let moved = 0; let unmoved = 0;
    for (const id of ids) {
      const v = await this.loadVisitRaw(q, id);
      if (!v || !['booked', 'arrived'].includes(v.status)) continue;
      let after = v.visit_date; let done = false;
      for (let attempt = 0; attempt < 5 && !done; attempt++) {
        const target = await this.nextDayWithRoom(q, ev.branchId, after, v.doctor_id ?? undefined, v.customer_id, limit, SEARCH_DAYS);
        if (!target) break;
        const r = await this.relocate(q, v, target, limit);
        if (typeof r === 'object') {
          await q.query(`insert into booking_events (visit_id, consultation_id, event, from_date, to_date, from_seq, to_seq, actor_user_id, reason) values ($1,$2,'moved_by_closure',$3,$4,$5,$6,$7,$8)`,
            [id, v.consultation_id, v.visit_date, target, v.seq_no, r.seq, ev.actor.id, ev.reason]);
          done = true;
        } else after = target;                                  // امتلأ باللحظة أو الزبون عنده حجز: جرب اليوم اللي بعده
      }
      if (done) moved++; else unmoved++;
    }
    return { moved, unmoved };
  }

  /** يحجز مكان لزبون بيوم معين: ينضم لزيارته الفعالة إذا موجودة، وإلا مقعد جديد برقم جديد إذا فيه مكان. null = اليوم ممتلئ. */
  private async claimDay(q: Queryable, branchId: number, customerId: number, d: string, limit: number, actorUserId: number | null): Promise<{ date: string; visitId: number; seqNo: number; joined: boolean } | null> {
    const ex = (await q.query(`select id, seq_no from visits where customer_id = $1 and visit_date = $2 and status in ('booked','arrived') for share`, [customerId, d])).rows[0];
    if (ex) return { date: d, visitId: Number(ex.id), seqNo: Number(ex.seq_no), joined: true };
    const fast = (await q.query(`select coalesce((select used_slots from booking_days where branch_id = $1 and day = $2), 0) as u, coalesce((select stopped_at is not null from booking_days where branch_id = $1 and day = $2), false) as stopped`, [branchId, d])).rows[0];
    if (Number(fast.u) >= limit || fast.stopped) return null;                   // قراءة سريعة بدون قفل: المليان والموقوف نتخطاه
    const locked = await this.lockDays(q, branchId, [d]);
    if (locked.get(d)!.used >= limit || locked.get(d)!.stopped) return null;    // امتلأ أو توقف باللحظة
    const seq = await this.takeSeat(q, branchId, d);
    const v = (await q.query(`insert into visits (branch_id, customer_id, visit_date, seq_no, source, created_by) values ($1,$2,$3,$4,$5,$6) returning id`, [branchId, customerId, d, seq, actorUserId === null ? 'app' : 'cashier', actorUserId])).rows[0];
    await q.query(`insert into booking_events (visit_id, event, to_date, to_seq, actor_user_id) values ($1,'booked',$2,$3,$4)`, [v.id, d, seq, actorUserId]);
    return { date: d, visitId: Number(v.id), seqNo: seq, joined: false };
  }

  /**
   * يحجز أقرب يوم صالح لجلسة علاجية من `from` فصاعداً (وبحد أقصى 366 يوم): العيادة مفتوحة، والزبون عنده زيارة فعالة بنفس اليوم → تنضم إليها
   * (زيارة وحدة = مكان ورقم واحد، القسم 5 د)، وإلا مقعد جديد برقم تسلسل جديد إذا باليوم مكان. الجلسات ما مربوطة بدوام الطبيب.
   * يرجع null إذا ما لقى يوم. الأقفال: صفوف الأيام بالترتيب التصاعدي (الأيام تتقدم دائماً).
   */
  async reserveDayForSession(q: Queryable, branchId: number, customerId: number, from: string, actorUserId: number | null): Promise<{ date: string; visitId: number; seqNo: number; joined: boolean } | null> {
    const limit = await this.dailyLimit(q, branchId);
    const last = addDays(from, 366);
    let cursor = from;
    while (cursor <= last) {
      const end = addDays(cursor, MAX_RANGE_DAYS - 1) < last ? addDays(cursor, MAX_RANGE_DAYS - 1) : last;
      const days = await this.schedule.availabilityQ(q, branchId, cursor, end);
      for (const d of days.filter((x) => x.clinic_open).map((x) => x.date)) {
        const r = await this.claimDay(q, branchId, customerId, d, limit, actorUserId);
        if (r) return r;
      }
      cursor = addDays(end, 1);
    }
    return null;
  }

  /** نفس اليوم المطلوب بالضبط (لنقل جلسة): 'closed' إذا العيادة مسكرة، 'full' إذا ممتلئ، وإلا الزيارة. */
  async reserveExactDay(q: Queryable, branchId: number, customerId: number, date: string, actorUserId: number | null): Promise<{ date: string; visitId: number; seqNo: number; joined: boolean } | 'closed' | 'full' | 'stopped'> {
    const [av] = await this.schedule.availabilityQ(q, branchId, date, date);
    if (!av.clinic_open) return 'closed';
    const r = await this.claimDay(q, branchId, customerId, date, await this.dailyLimit(q, branchId), actorUserId);
    if (r) return r;
    const stopped = (await q.query(`select 1 from booking_days where branch_id = $1 and day = $2 and stopped_at is not null`, [branchId, date])).rowCount;
    return stopped ? 'stopped' : 'full';
  }

  /** أقرب يوم بعد `after` فيه مكان للزبون (لاقتراح يوم بديل عند امتلاء يوم النقل). */
  async suggestDayAfter(q: Queryable, branchId: number, customerId: number, after: string, doctorId?: number): Promise<string | null> {
    return this.nextDayWithRoom(q, branchId, after, doctorId, customerId, await this.dailyLimit(q, branchId), SEARCH_DAYS);
  }

  /** إذا الزيارة فارغة (ما بيها كشفية فعالة ولا جلسات محجوزة/مدفوعة) تنلغي ويرجع مقعدها. */
  async cancelVisitIfEmpty(q: Queryable, visitId: number, reason: string, actorUserId: number | null): Promise<boolean> {
    const v = (await q.query(`select id, branch_id, visit_date::text as d, seq_no, status from visits where id = $1 for update`, [visitId])).rows[0];
    if (!v || !['booked', 'arrived'].includes(v.status)) return false;
    const live = (await q.query(
      `select (exists (select 1 from consultations where visit_id = $1 and status <> 'cancelled') or exists (select 1 from treatment_sessions where visit_id = $1 and status in ('booked','paid'))) as live`, [visitId])).rows[0].live;
    if (live) return false;
    await q.query(`update booking_days set used_slots = greatest(used_slots - 1, 0) where branch_id = $1 and day = $2`, [v.branch_id, v.d]);
    await q.query(`update visits set status = 'cancelled', cancelled_at = now(), cancel_reason = $2 where id = $1`, [visitId, reason]);
    await q.query(`insert into booking_events (visit_id, event, from_date, from_seq, actor_user_id, reason) values ($1,'cancelled',$2,$3,$4,$5)`, [visitId, v.d, v.seq_no, actorUserId, reason]);
    return true;
  }

  /**
   * زيارة فاتت أو انلغت: جلساتها المحجوزة ترجع «تنتظر حجز» (ما تنلغي ولا ينحسب غياب)، وجلسات نفس البند اللي بعدها (غير المدفوعة) تتحرر هم
   * وحجوزاتها تنلغي (ما نحجز أماكن على الفاضي، القسم 5 هـ). الزيارات اللي تفضى بسببها تنلغي ويرجع مقعدها. الأقفال: الجلسات بالترتيب.
   */
  async releaseSessions(q: Queryable, visitId: number, kind: 'missed' | 'cancelled', actorUserId: number | null): Promise<number> {
    const first = (await q.query(`select id, plan_item_id, seq_no, scheduled_date::text as d from treatment_sessions where visit_id = $1 and status = 'booked' order by id for update`, [visitId])).rows;
    let released = 0; const touched = new Set<number>();
    for (const s of first) {
      await q.query(`update treatment_sessions set status = 'awaiting_booking', visit_id = null, scheduled_date = null, version = version + 1 where id = $1`, [s.id]);
      await q.query(`insert into booking_events (visit_id, treatment_session_id, event, from_date, actor_user_id, reason) values ($1,$2,$3,$4,$5,$6)`,
        [visitId, s.id, kind === 'missed' ? 'released_missed' : 'cancelled', s.d, actorUserId, kind === 'missed' ? 'الزيارة فاتت' : 'الزيارة انلغت']);
      released++;
      const chain = (await q.query(
        `select id, visit_id, scheduled_date::text as d from treatment_sessions where plan_item_id = $1 and seq_no > $2 and status = 'booked' order by seq_no for update`, [s.plan_item_id, s.seq_no])).rows;
      for (const c of chain) {
        await q.query(`update treatment_sessions set status = 'awaiting_booking', visit_id = null, scheduled_date = null, version = version + 1 where id = $1`, [c.id]);
        await q.query(`insert into booking_events (visit_id, treatment_session_id, event, from_date, actor_user_id, reason) values ($1,$2,'released_chain',$3,$4,'جلسة قبلها فاتت أو انلغت')`, [c.visit_id, c.id, c.d, actorUserId]);
        if (c.visit_id !== null && Number(c.visit_id) !== visitId) touched.add(Number(c.visit_id));
        released++;
      }
    }
    for (const vid of [...touched].sort((a, b) => a - b)) await this.cancelVisitIfEmpty(q, vid, 'تحرير جلسات الخطة', actorUserId);
    return released;
  }

  // ================================================================ داخلي
  private async today(q: Queryable): Promise<string> { return (await q.query(`select clinic_today()::text as d`)).rows[0].d; }
  private async dailyLimit(q: Queryable, branchId: number): Promise<number> { return this.settings.effective<number>(q, branchId, 'booking.daily_limit'); }

  private assertHorizon(date: string, today: string) {
    if (date < today) throw Errors.badRequest('DATE_IN_PAST', 'ما ينحجز بتاريخ مضى');
    if (date > addDays(today, MAX_AHEAD_DAYS)) throw Errors.badRequest('DATE_TOO_FAR', `أبعد يوم للحجز ${MAX_AHEAD_DAYS} يوم من اليوم`);
  }

  /** العيادة مفتوحة والطبيب يداوم؟ وإلا 409 مع أقرب يوم مناسب. */
  private async assertOpen(q: Queryable, branchId: number, date: string, doctorId: number | undefined, customerId: number, limit: number, today: string) {
    const [av] = await this.schedule.availabilityQ(q, branchId, date, date, doctorId);
    if (!av.clinic_open) throw conflict('CLINIC_CLOSED', av.closed_reason === 'holiday' ? `العيادة معطلة بهذا اليوم (${av.holiday!.name})` : 'العيادة ما تداوم بهذا اليوم',
      { reason: av.closed_reason, next_available_date: await this.nextDayWithRoom(q, branchId, date, doctorId, customerId, limit, SEARCH_DAYS, addDays(today, MAX_AHEAD_DAYS)) });
    if (doctorId !== undefined && !av.doctor!.works)
      throw conflict('DOCTOR_NOT_WORKING', av.doctor!.day_off ? 'الطبيب بإجازة بهذا اليوم' : 'الطبيب ما يداوم بهذا اليوم',
        { next_available_date: await this.nextDayWithRoom(q, branchId, date, doctorId, customerId, limit, SEARCH_DAYS, addDays(today, MAX_AHEAD_DAYS)) });
  }

  private async dayFull(q: Queryable, branchId: number, date: string, doctorId: number | undefined, customerId: number, limit: number, today: string) {
    return conflict('DAY_FULL', 'اليوم ممتلئ', { next_available_date: await this.nextDayWithRoom(q, branchId, date, doctorId, customerId, limit, SEARCH_DAYS, addDays(today, MAX_AHEAD_DAYS)) });
  }

  private async dayStopped(q: Queryable, branchId: number, date: string, doctorId: number | undefined, customerId: number, limit: number, today: string) {
    return conflict('DAY_STOPPED', 'الحجز موقوف لهذا اليوم', { next_available_date: await this.nextDayWithRoom(q, branchId, date, doctorId, customerId, limit, SEARCH_DAYS, addDays(today, MAX_AHEAD_DAYS)) });
  }

  /** أقرب يوم بعد `after`: مفتوح، الطبيب يداوم، بيه مكان، الحجز مو موقوف، والزبون ما عنده حجز فعال بيه. */
  private async nextDayWithRoom(q: Queryable, branchId: number, after: string, doctorId: number | undefined, customerId: number, limit: number, searchDays: number, maxDate?: string): Promise<string | null> {
    const start = addDays(after, 1);
    let end = addDays(start, searchDays - 1);
    if (maxDate && maxDate < end) end = maxDate;
    if (end < start) return null;
    const days = await this.schedule.availabilityQ(q, branchId, start, end, doctorId);
    const open = days.filter((d) => (doctorId === undefined ? d.clinic_open : d.doctor!.works)).map((d) => d.date);
    if (!open.length) return null;
    const dayRows = (await q.query(`select day::text as day, used_slots, (stopped_at is not null) as stopped from booking_days where branch_id = $1 and day = any($2::date[])`, [branchId, open])).rows;
    const used = new Map(dayRows.map((r) => [r.day, Number(r.used_slots)]));
    const stopped = new Set(dayRows.filter((r) => r.stopped).map((r) => r.day as string));
    const busy = new Set((await q.query(`select visit_date::text as d from visits where customer_id = $1 and status in ('booked','arrived') and visit_date = any($2::date[])`, [customerId, open])).rows.map((r) => r.d));
    return open.find((d) => (used.get(d) ?? 0) < limit && !stopped.has(d) && !busy.has(d)) ?? null;
  }

  /** يقفل صفوف الأيام بترتيب التاريخ دائماً (يمنع التشابك بين نقلين). */
  private async lockDays(q: Queryable, branchId: number, days: string[]): Promise<Map<string, { used: number; last: number; stopped: boolean }>> {
    const sorted = [...new Set(days)].sort();
    for (const d of sorted) await q.query(`insert into booking_days (branch_id, day) values ($1,$2) on conflict do nothing`, [branchId, d]);
    const out = new Map<string, { used: number; last: number; stopped: boolean }>();
    for (const d of sorted) {
      const r = (await q.query(`select used_slots, last_seq, (stopped_at is not null) as stopped from booking_days where branch_id = $1 and day = $2 for update`, [branchId, d])).rows[0];
      out.set(d, { used: Number(r.used_slots), last: Number(r.last_seq), stopped: r.stopped as boolean });
    }
    return out;
  }
  private async takeSeat(q: Queryable, branchId: number, day: string): Promise<number> {
    return Number((await q.query(`update booking_days set used_slots = used_slots + 1, last_seq = last_seq + 1 where branch_id = $1 and day = $2 returning last_seq`, [branchId, day])).rows[0].last_seq);
  }
  private async releaseSeat(q: Queryable, branchId: number, day: string) {
    await q.query(`update booking_days set used_slots = greatest(used_slots - 1, 0) where branch_id = $1 and day = $2`, [branchId, day]);
  }

  /** ينقل الزيارة ليوم ثاني برقم جديد. يرجع {seq} أو 'full' أو 'customer_busy' (بدون ما يغير شي). الأيام تنقفل بالترتيب. */
  private async relocate(q: Queryable, v: VisitRow, toDate: string, limit: number): Promise<{ seq: number } | 'full' | 'stopped' | 'customer_busy'> {
    const days = await this.lockDays(q, v.branch_id, [v.visit_date, toDate]);
    if (days.get(toDate)!.stopped) return 'stopped';
    if (days.get(toDate)!.used >= limit) return 'full';
    const busy = await q.query(`select 1 from visits where customer_id = $1 and visit_date = $2 and status in ('booked','arrived') and id <> $3`, [v.customer_id, toDate, v.id]);
    if (busy.rowCount) return 'customer_busy';
    const seq = await this.takeSeat(q, v.branch_id, toDate);
    await this.releaseSeat(q, v.branch_id, v.visit_date);
    await q.query(`update visits set visit_date = $2, seq_no = $3 where id = $1`, [v.id, toDate, seq]);
    // جلسات الزيارة (المحجوزة والمدفوعة) تتحرك وياها لنفس اليوم الجديد
    await q.query(`update treatment_sessions set scheduled_date = $2, version = version + 1 where visit_id = $1 and status in ('booked','paid')`, [v.id, toDate]);
    return { seq };
  }

  /** المراجعة المجانية: نفس الطبيب، خلال مدة الإعداد من كشفية «مدفوعة»، ومرة وحدة لكل كشفية (إلغاء المراجعة يرجّع الحق). */
  private async freeFollowupParent(q: Queryable, branchId: number, customerId: number, doctorId: number, date: string): Promise<number | null> {
    const windowDays = await this.settings.effective<number>(q, branchId, 'booking.free_followup_days');
    const { rows } = await q.query(
      `select c.id from consultations c join visits v on v.id = c.visit_id
        where c.customer_id = $1 and c.doctor_id = $2 and c.kind = 'new' and c.status in ('paid','with_doctor','finished')
          and v.visit_date <= $3::date and ($3::date - v.visit_date) <= $4
          and not exists (select 1 from consultations f where f.parent_consultation_id = c.id and f.status <> 'cancelled')
        order by v.visit_date desc, c.id desc limit 1`, [customerId, doctorId, date, windowDays]);
    return rows.length ? Number(rows[0].id) : null;
  }

  private async loadVisitRaw(q: Queryable, id: number): Promise<VisitRow | null> {
    const r = (await q.query(
      `select v.id, v.branch_id, v.customer_id, v.visit_date::text as visit_date, v.seq_no, v.status, v.doctor_id,
              c.id as consultation_id, c.status as consultation_status, c.kind as consultation_kind, c.parent_consultation_id
         from visits v left join consultations c on c.visit_id = v.id and c.status <> 'cancelled'
        where v.id = $1 for update of v`, [id])).rows[0];
    if (!r) return null;
    const n = (x: unknown) => (x === null ? null : Number(x));
    return { id: Number(r.id), branch_id: Number(r.branch_id), customer_id: Number(r.customer_id), visit_date: r.visit_date, seq_no: r.seq_no, status: r.status, doctor_id: n(r.doctor_id),
      consultation_id: n(r.consultation_id), consultation_status: r.consultation_status, consultation_kind: r.consultation_kind, parent_consultation_id: n(r.parent_consultation_id) };
  }
  private async loadVisit(q: Queryable, who: Who, id: number): Promise<VisitRow> {
    const v = await this.loadVisitRaw(q, id);
    if (!v || (!who.isOwner && v.branch_id !== who.branchId) || (who.customerId !== null && v.customer_id !== who.customerId)) throw Errors.notFound('الحجز');
    return v;
  }

  /** الزبون يتعامل مع حجز كشفية غير مدفوعة وبدون جلسات بنفس الزيارة (الجلسات ينقلها من شاشة الجلسات) */
  private async assertSelfServiceVisit(q: Queryable, v: VisitRow, op: 'cancel' | 'move') {
    if (!v.consultation_id || v.consultation_status !== 'awaiting_payment') throw conflict('NOT_CHANGEABLE', op === 'cancel' ? 'الكشفية مدفوعة أو مو فعالة: راجع العيادة' : 'الحجز مدفوع: راجع العيادة لتغيير موعده');
    if (op === 'move') {                                                                  // الإلغاء مسموح دائماً (للكشفية بس إذا بالزيارة جلسات)، أما النقل فيحرك الجلسات
      const s = await q.query(`select 1 from treatment_sessions where visit_id = $1 and status in ('booked','paid')`, [v.id]);
      if (s.rowCount) throw conflict('HAS_SESSIONS', 'بهذي الزيارة جلسات: لتغيير الكشفية الغِها واحجز يوم ثاني، أو غيّر موعد الجلسات من صفحة الجلسات');
    }
  }

  private async daySummary(q: Queryable, branchId: number, day: string) {
    const limit = await this.dailyLimit(q, branchId);
    const r = (await q.query(`select used_slots, last_seq, (stopped_at is not null) as stopped, stop_reason from booking_days where branch_id = $1 and day = $2`, [branchId, day])).rows[0];
    const used = r ? Number(r.used_slots) : 0;
    return { date: day, daily_limit: limit, used_slots: used, remaining: Math.max(limit - used, 0), last_seq: r ? Number(r.last_seq) : 0, stopped: r ? r.stopped as boolean : false, stop_reason: r ? (r.stop_reason as string | null) : null };
  }

  private async views(q: Queryable, ids: number[]) {
    if (!ids.length) return [];
    const { rows } = await q.query(
      `select v.id, v.branch_id, v.visit_date::text as date, v.seq_no, v.status, v.source, v.created_at, v.cancel_reason,
              cu.id as customer_id, cu.full_name as customer_name, cu.phone, cu.public_code,
              v.doctor_id, du.full_name as doctor_name, c.id as consultation_id, c.kind as consultation_kind, c.status as consultation_status,
              c.booking_note, c.interest_service_id, isv.name_ar as interest_name
         from visits v join customers cu on cu.id = v.customer_id left join users du on du.id = v.doctor_id
         left join lateral (select id, kind, status, booking_note, interest_service_id from consultations where visit_id = v.id order by (status <> 'cancelled') desc, id desc limit 1) c on true
         left join services isv on isv.id = c.interest_service_id
        where v.id = any($1::bigint[]) order by v.visit_date, v.seq_no`, [ids]);
    const sess = (await q.query(
      `select s.visit_id, s.id, s.seq_no, s.status, sv.name_ar, i.sessions_count from treatment_sessions s join plan_items i on i.id = s.plan_item_id join services sv on sv.id = i.service_id
        where s.visit_id = any($1::bigint[]) and s.status <> 'cancelled' order by s.visit_id, s.id`, [ids])).rows;
    const sessionsOf = new Map<number, { id: number; service_name: string; seq_no: number; of: number; status: string }[]>();
    for (const s of sess) { const k = Number(s.visit_id); if (!sessionsOf.has(k)) sessionsOf.set(k, []); sessionsOf.get(k)!.push({ id: Number(s.id), service_name: s.name_ar, seq_no: s.seq_no, of: Number(s.sessions_count), status: s.status }); }
    const fees = new Map<number, number>();                                              // سعر «جلسات فقط» لكل فرع (يظهر للكاشير: 0 = يدخل بدون دفع)
    for (const r of rows) if (r.consultation_kind === 'sessions_only' && !fees.has(Number(r.branch_id))) fees.set(Number(r.branch_id), await this.settings.effective<number>(q, Number(r.branch_id), 'consultation.sessions_only_fee'));
    return rows.map((r) => ({
      id: Number(r.id), branch_id: Number(r.branch_id), date: r.date, seq_no: r.seq_no, status: r.status, source: r.source, created_at: r.created_at, cancel_reason: r.cancel_reason,
      customer: { id: Number(r.customer_id), full_name: r.customer_name, phone: r.phone, public_code: r.public_code },
      doctor: r.doctor_id === null ? null : { id: Number(r.doctor_id), full_name: r.doctor_name },
      consultation: r.consultation_id === null ? null : { id: Number(r.consultation_id), kind: r.consultation_kind, status: r.consultation_status, note: r.booking_note ?? null,
        interest: r.interest_service_id === null ? null : { id: Number(r.interest_service_id), name: r.interest_name as string },
        ...(r.consultation_kind === 'sessions_only' ? { fee: fees.get(Number(r.branch_id)) ?? 0 } : {}) },
      // الطور: الكشفية لين تخلص (أو تنلغي)، وبعدها الزيارة تنتقل لقائمة الجلسات
      phase: r.consultation_id !== null && ['awaiting_payment', 'paid', 'with_doctor'].includes(r.consultation_status as string) ? 'consultation' : 'sessions',
      sessions: sessionsOf.get(Number(r.id)) ?? [],
      // خلصت عند الكاشير: ملغية أو فاتت، أو حضر ومافي شغل للكاشير: الكشفية منتهية/ملغية (مو عند الطبيب لسه) وما أكو جلسة بانتظار الدفع.
      // الجلسة المدفوعة اللي بانتظار الممرض ما تحتاج كاشير (استرجاعها من الوصولات).
      done: ['cancelled', 'missed'].includes(r.status as string) || (r.status === 'arrived'
        && (r.consultation_id === null || ['finished', 'cancelled'].includes(r.consultation_status as string))
        && !(sessionsOf.get(Number(r.id)) ?? []).some((s) => s.status === 'booked')),
    }));
  }
}
