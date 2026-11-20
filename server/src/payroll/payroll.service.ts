import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { can } from '../auth/permissions';
import { resolveBranch } from '../common/branch';
import { Errors } from '../common/errors';
import { mapSafeError } from '../common/safe-errors';
import { DbService, Queryable } from '../db/db.service';
import { assertDate } from '../schedule/schedule.service';
import { AdjustItemDto, PayItemDto, PayRuleDto, SetBaseDto } from './payroll.dto';

const PAYABLE_ROLES = ['manager', 'cashier', 'doctor', 'nurse'];
const MAX_AHEAD_DAYS = 366;

/**
 * الرواتب (القسم 4 و12 هـ): راتب كل موظف بتاريخ بداية (ما يغير اللي قبله)، ويتولد تلقائياً يوم 1 لكل موظف عن الشهر الماضي.
 * الراتب = السجل الساري بآخر يوم بالشهر (بدون تناسب). نسبة الطبيب من كشفياته تنجمع مع الراتب (doctor_earnings المثبتة وقت إنهاء الكشفية).
 * الطبيب/المدير بدون راتب = «الراتب ما انحدد» (not_payable) لحد ما المالك يحدد. التسديد من الخزنة ما ينحسب مصروف ثاني (ما ينكتب بالمصاريف).
 * صلاحيات: الكاشير والممرض راتبهم للمدير والمالك، والطبيب والمدير للمالك بس. راتب المدير يسدده المالك بس.
 */
@Injectable()
export class PayrollService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  // ================================================================ قواعد الأجر
  async setPayRule(actor: AuthUser, userId: number, dto: PayRuleDto, ip: string | null) {
    assertDate(dto.effective_from, 'تاريخ البداية');
    const hasSalary = dto.monthly_salary !== undefined; const hasPercent = dto.consult_percent !== undefined;    // null = مسح صريح، undefined = ما انرسل
    if (!hasSalary && !hasPercent) throw Errors.badRequest('NOTHING_TO_SET', 'حدد الراتب أو النسبة');
    return this.db.tx(async (q) => {
      const u = await this.targetUser(q, actor, userId);
      this.assertCanSet(actor, u.role);
      if (hasPercent && dto.consult_percent !== null && !can(actor.role, 'doctor.percent_set')) throw Errors.forbidden();
      if (hasPercent && dto.consult_percent !== null && u.role !== 'doctor') throw Errors.badRequest('PERCENT_DOCTORS_ONLY', 'النسبة للأطباء بس');
      const today = (await q.query(`select clinic_today()::text as d`)).rows[0].d;
      if (dto.effective_from < today) throw Errors.badRequest('EFFECTIVE_IN_PAST', 'التغيير يبدي من اليوم أو بعده (ما يغير اللي مضى)');
      if ((Date.parse(`${dto.effective_from}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000 > MAX_AHEAD_DAYS) throw Errors.badRequest('EFFECTIVE_TOO_FAR', 'التاريخ بعيد');
      const cur = await this.ruleAt(q, userId, dto.effective_from);
      const salary = hasSalary ? dto.monthly_salary ?? null : cur?.monthly_salary ?? null;
      const percent = hasPercent ? (dto.consult_percent ?? null) : cur?.consult_percent ?? null;
      const prev = (await q.query(`select id, monthly_salary::bigint as s, consult_percent::text as p from pay_rules where user_id = $1 and effective_from = $2 for update`, [userId, dto.effective_from])).rows[0];
      if (prev) await q.query(`update pay_rules set monthly_salary = $2, consult_percent = $3, set_by = $4, created_at = now() where id = $1`, [prev.id, salary, percent, actor.id]);
      else await q.query(`insert into pay_rules (user_id, effective_from, monthly_salary, consult_percent, set_by) values ($1,$2,$3,$4,$5)`, [userId, dto.effective_from, salary, percent, actor.id]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: u.branch_id, action: 'pay_rule.set', entityType: 'user', entityId: userId,
        before: prev ? { salary: prev.s === null ? null : Number(prev.s), percent: prev.p } : cur, after: { effective_from: dto.effective_from, salary, percent }, ip });
      return this.rulesQ(q, actor, userId);
    });
  }

  async payRules(actor: AuthUser, userId: number) {
    const u = await this.targetUser(this.db, actor, userId);
    this.assertCanSet(actor, u.role);
    return this.rulesQ(this.db, actor, userId);
  }

  /** الموظفين وراتبهم الساري (المدير ما يشوف مبلغ راتب الطبيب والمدير، بس إذا محدد أو لا) */
  async staffOverview(actor: AuthUser, requestedBranch?: number) {
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    const { rows } = await this.db.query(
      `select u.id, u.full_name, u.role, u.is_active, r.monthly_salary::bigint as salary, r.consult_percent::float as percent, r.effective_from::text as since
         from users u left join lateral (select * from pay_rules where user_id = u.id and effective_from <= clinic_today() order by effective_from desc limit 1) r on true
        where u.branch_id = $1 and u.role = any($2::text[]) and u.is_active order by u.role, u.full_name`, [branchId, PAYABLE_ROLES]);
    return { branch_id: branchId, staff: rows.map((r) => {
      const visible = can(actor.role, r.role === 'cashier' || r.role === 'nurse' ? 'salary.staff_set' : 'salary.doctor_manager_set');
      return { user_id: Number(r.id), full_name: r.full_name, role: r.role, salary_set: r.salary !== null, monthly_salary: visible && r.salary !== null ? Number(r.salary) : null, consult_percent: visible ? r.percent : null, since: r.since };
    }) };
  }

  // ================================================================ توليد الشهر
  /** يولد رواتب الشهر الماضي لكل فرع فعال ما انولد له (مهمة يوم 1 وأي يوم بعدها لو انقطع السيرفر). */
  async generateDue(branchId?: number): Promise<number> {
    const prev = (await this.db.query(`select (date_trunc('month', clinic_today()) - interval '1 month')::date::text as m`)).rows[0].m;
    let n = 0;
    for (const b of (await this.db.query(`select id from branches where is_active and ($1::bigint is null or id = $1) order by id`, [branchId ?? null])).rows) if (await this.generateForMonth(Number(b.id), prev, null)) n++;
    return n;
  }

  /** null = موجود مسبقاً (ما يتكرر)، أو الفرع ما كان موجود بذاك الشهر */
  async generateForMonth(branchId: number, month: string, actor: AuthUser | null): Promise<{ run_id: number; items: number } | null> {
    return this.db.tx(async (q) => {
      const b = (await q.query(`select created_at < ($2::date + interval '1 month') as existed from branches where id = $1`, [branchId, month])).rows[0];
      if (!b?.existed) return null;
      const run = (await q.query(`insert into payroll_runs (branch_id, period_month) values ($1,$2) on conflict (branch_id, period_month) do nothing returning id`, [branchId, month])).rows[0];
      if (!run) return null;
      const runId = Number(run.id);
      const monthEnd = (await q.query(`select ($1::date + interval '1 month' - interval '1 day')::date::text as d`, [month])).rows[0].d;
      const users = (await q.query(
        `select id, role from users where branch_id = $1 and role = any($2::text[]) and created_at < ($3::date + interval '1 month') and (is_active or deactivated_at >= $3::date) order by id`, [branchId, PAYABLE_ROLES, month])).rows;
      for (const u of users) {
        const rule = await this.ruleAt(q, Number(u.id), monthEnd);
        const base = rule?.monthly_salary ?? null;
        const item = (await q.query(
          `insert into payroll_items (run_id, user_id, role_snapshot, base_salary, consult_amount, total_due, status) values ($1,$2,$3,$4,0,$5,$6) returning id`,
          [runId, u.id, u.role, base, base ?? 0, base === null ? 'not_payable' : 'pending'])).rows[0];
        if (u.role === 'doctor') {
          const e = (await q.query(
            `update doctor_earnings set payroll_item_id = $1 where doctor_id = $2 and payroll_item_id is null and earned_on >= $3::date and earned_on < ($3::date + interval '1 month') returning amount`, [item.id, u.id, month])).rows;
          const consult = e.reduce((a, r) => a + Number(r.amount), 0);
          if (consult > 0) await q.query(`update payroll_items set consult_amount = $2, total_due = $3 where id = $1`, [item.id, consult, (base ?? 0) + consult]);
        }
      }
      await this.audit.log(q, { actorUserId: actor?.id ?? null, actorRole: actor?.role ?? 'system', branchId, action: 'payroll.generate', entityType: 'payroll_run', entityId: runId, after: { month, items: users.length } });
      return { run_id: runId, items: users.length };
    });
  }

  async generate(actor: AuthUser, month: string, requestedBranch: number | undefined) {
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    const first = `${month}-01`;
    const cur = (await this.db.query(`select date_trunc('month', clinic_today())::date::text as m`)).rows[0].m;
    if (first >= cur) throw Errors.badRequest('MONTH_NOT_FINISHED', 'الشهر ما انتهى بعد');
    const r = await this.generateForMonth(branchId, first, actor);
    if (!r) throw Errors.conflict('ALREADY_GENERATED', 'رواتب هذا الشهر انولدت مسبقاً');
    return this.list(actor, month, branchId);
  }

  // ================================================================ القراءة
  async list(actor: AuthUser, month: string, requestedBranch?: number) {
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    const first = `${month}-01`;
    const run = (await this.db.query(`select id, generated_at from payroll_runs where branch_id = $1 and period_month = $2`, [branchId, first])).rows[0];
    if (!run) return { branch_id: branchId, month, generated: false, items: [], totals: { due: 0, paid: 0, pending: 0 }, not_payable: 0 };
    const rows = (await this.db.query(
      `select i.*, u.full_name from payroll_items i join users u on u.id = i.user_id where i.run_id = $1 and ($2::boolean or i.role_snapshot <> 'manager') order by i.role_snapshot, u.full_name`, [run.id, actor.role === 'owner'])).rows;
    const items = rows.map((r) => this.itemShape(r));
    return {
      branch_id: branchId, month, generated: true, run_id: Number(run.id), generated_at: run.generated_at, items,
      totals: { due: items.filter((i) => i.status !== 'not_payable').reduce((a, i) => a + i.total_due, 0), paid: items.filter((i) => i.status === 'paid').reduce((a, i) => a + i.total_due, 0), pending: items.filter((i) => i.status === 'pending').reduce((a, i) => a + i.total_due, 0) },
      not_payable: items.filter((i) => i.status === 'not_payable').length,
    };
  }

  // ================================================================ تعديل وتسديد
  async adjust(actor: AuthUser, itemId: number, dto: AdjustItemDto, ip: string | null) {
    const reason = dto.reason?.trim() ?? '';
    if (dto.amount !== 0 && reason.length < 3) throw Errors.badRequest('REASON_REQUIRED', 'اكتب سبب التعديل');
    return this.db.tx(async (q) => {
      const it = await this.lockItem(q, actor, itemId);
      if (it.status !== 'pending') throw Errors.conflict('NOT_PENDING', it.status === 'paid' ? 'الراتب مسدد: ما ينعدل' : 'الراتب ما انحدد: المالك يحدده أول');
      const total = Number(it.base_salary) + Number(it.consult_amount) + dto.amount;
      if (total < 0) throw Errors.conflictWith('NEGATIVE_TOTAL', 'التعديل يخلي المستحق سالب', { max_deduction: Number(it.base_salary) + Number(it.consult_amount) });
      await q.query(`update payroll_items set adjustment_amount = $2, adjustment_reason = $3, adjusted_by = $4, total_due = $5 where id = $1`, [itemId, dto.amount, dto.amount === 0 ? null : reason, dto.amount === 0 ? null : actor.id, total]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(it.branch_id), action: 'payroll.adjust', entityType: 'payroll_item', entityId: itemId, reason: reason || undefined,
        before: { adjustment: Number(it.adjustment_amount), total_due: Number(it.total_due) }, after: { adjustment: dto.amount, total_due: total }, ip });
      return this.itemQ(q, itemId);
    });
  }

  /** المالك يحدد راتب «ما انحدد» بعد التوليد: يتحول معلّق والمستحق ينحسب */
  async setBase(actor: AuthUser, itemId: number, dto: SetBaseDto, ip: string | null) {
    const reason = dto.reason.trim();
    if (reason.length < 3) throw Errors.badRequest('REASON_REQUIRED', 'اكتب سبب التحديد');
    return this.db.tx(async (q) => {
      const it = await this.lockItem(q, actor, itemId);
      if (it.status !== 'not_payable') throw Errors.conflict('ALREADY_SET', 'الراتب محدد مسبقاً');
      const total = dto.base_salary + Number(it.consult_amount) + Number(it.adjustment_amount);
      await q.query(`update payroll_items set base_salary = $2, total_due = $3, status = 'pending' where id = $1`, [itemId, dto.base_salary, total]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(it.branch_id), action: 'payroll.set_base', entityType: 'payroll_item', entityId: itemId, reason, after: { base_salary: dto.base_salary, total_due: total }, ip });
      return this.itemQ(q, itemId);
    });
  }

  async pay(actor: AuthUser, itemId: number, dto: PayItemDto, ip: string | null) {
    const bank = dto.bank_name?.trim() || null;
    if (dto.pay_source === 'electronic' && !bank) throw Errors.badRequest('BANK_REQUIRED', 'اكتب اسم المصرف');
    if (dto.pay_source === 'safe' && bank) throw Errors.badRequest('BANK_NOT_ALLOWED', 'اسم المصرف للتسديد الإلكتروني بس');
    if (dto.paid_on) assertDate(dto.paid_on, 'تاريخ التسديد');
    let branchId = 0; let amount = 0;
    try {
      return await this.db.tx(async (q) => {
        const it = await this.lockItem(q, actor, itemId);
        branchId = Number(it.branch_id); amount = Number(it.total_due);
        if (it.status === 'paid') throw Errors.conflict('ALREADY_PAID', 'الراتب مسدد مسبقاً');
        if (it.status === 'not_payable') throw Errors.conflict('SALARY_NOT_SET', 'الراتب ما انحدد: المالك يحدده أول');
        if (amount <= 0) throw Errors.conflict('NOTHING_TO_PAY', 'المستحق صفر');
        const today = (await q.query(`select clinic_today()::text as d`)).rows[0].d;
        const paidOn = dto.paid_on ?? today;
        if (paidOn > today) throw Errors.badRequest('FUTURE_DATE', 'تاريخ التسديد ما يكون بالمستقبل');
        if (dto.pay_source === 'safe')
          await q.query(`insert into safe_movements (branch_id, direction, amount, kind, payroll_item_id, note, created_by) values ($1,'out',$2,'salary',$3,'راتب',$4)`, [branchId, amount, itemId, actor.id]);
        await q.query(`update payroll_items set status = 'paid', pay_source = $2, bank_name = $3, paid_on = $4, paid_by = $5, note = $6 where id = $1`, [itemId, dto.pay_source, bank, paidOn, actor.id, dto.note?.trim() || null]);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'payroll.pay', entityType: 'payroll_item', entityId: itemId, after: { amount, pay_source: dto.pay_source, paid_on: paidOn }, ip });
        return this.itemQ(q, itemId);
      });
    } catch (e: any) { return mapSafeError(e, this.db, branchId, amount); }
  }

  // ================================================================ داخلي
  private assertCanSet(actor: AuthUser, role: string) {
    const perm = role === 'cashier' || role === 'nurse' ? 'salary.staff_set' : 'salary.doctor_manager_set';
    if (!can(actor.role, perm)) throw Errors.forbidden();
  }

  private async targetUser(q: Queryable, actor: AuthUser, id: number) {
    const u = (await q.query(`select id, role, branch_id, full_name from users where id = $1`, [id])).rows[0];
    if (!u || u.role === 'owner' || (actor.role !== 'owner' && Number(u.branch_id) !== actor.branchId)) throw Errors.notFound('الموظف');
    return { id: Number(u.id), role: u.role as string, branch_id: Number(u.branch_id) };
  }

  private async ruleAt(q: Queryable, userId: number, date: string): Promise<{ monthly_salary: number | null; consult_percent: number | null } | null> {
    const r = (await q.query(`select monthly_salary::bigint as s, consult_percent::float as p from pay_rules where user_id = $1 and effective_from <= $2 order by effective_from desc limit 1`, [userId, date])).rows[0];
    return r ? { monthly_salary: r.s === null ? null : Number(r.s), consult_percent: r.p } : null;
  }

  private async rulesQ(q: Queryable, actor: AuthUser, userId: number) {
    const rows = (await q.query(`select r.effective_from::text as d, r.monthly_salary::bigint as s, r.consult_percent::float as p, r.set_by, u.full_name as by_name, r.created_at from pay_rules r join users u on u.id = r.set_by where r.user_id = $1 order by r.effective_from desc`, [userId])).rows;
    const today = (await q.query(`select clinic_today()::text as d`)).rows[0].d;
    return { user_id: userId, current: rows.find((r) => r.d <= today) ? this.ruleShape(rows.find((r) => r.d <= today)) : null, rules: rows.map((r) => ({ ...this.ruleShape(r), set_by: { id: Number(r.set_by), name: r.by_name }, created_at: r.created_at })) };
  }
  private ruleShape(r: any) { return { effective_from: r.d, monthly_salary: r.s === null ? null : Number(r.s), consult_percent: r.p }; }

  /** صف الراتب مقفول مع فحص الفرع وصلاحية الدور (المدير ما يتعامل مع راتب مدير: للمالك بس) */
  private async lockItem(q: Queryable, actor: AuthUser, id: number) {
    const it = (await q.query(`select i.*, r.branch_id from payroll_items i join payroll_runs r on r.id = i.run_id where i.id = $1 for update of i`, [id])).rows[0];
    if (!it || (actor.role !== 'owner' && Number(it.branch_id) !== actor.branchId)) throw Errors.notFound('الراتب');
    if (it.role_snapshot === 'manager' && actor.role !== 'owner') throw Errors.notFound('الراتب');
    return it;
  }

  private itemShape(r: any) {
    return {
      id: Number(r.id), user: { id: Number(r.user_id), full_name: r.full_name, role: r.role_snapshot }, status: r.status as string, salary_set: r.base_salary !== null,
      base_salary: r.base_salary === null ? null : Number(r.base_salary), consult_amount: Number(r.consult_amount), adjustment_amount: Number(r.adjustment_amount), adjustment_reason: r.adjustment_reason as string | null,
      total_due: Number(r.total_due), pay_source: r.pay_source as string | null, bank_name: r.bank_name as string | null, paid_on: r.paid_on ? new Date(r.paid_on).toISOString().slice(0, 10) : null, note: r.note as string | null,
    };
  }
  private async itemQ(q: Queryable, id: number) {
    const r = (await q.query(`select i.*, u.full_name, i.paid_on::text as paid_on_text from payroll_items i join users u on u.id = i.user_id where i.id = $1`, [id])).rows[0];
    return { ...this.itemShape({ ...r, paid_on: null }), paid_on: r.paid_on_text as string | null };
  }
}
