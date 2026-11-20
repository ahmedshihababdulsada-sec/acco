import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { resolveBranch } from '../common/branch';
import { Errors } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { assertDate } from '../schedule/schedule.service';
import { buildCsv, buildXlsx, Table } from './xlsx';

const TZ = `'Asia/Baghdad'`;
const MAX_RANGE_DAYS = 366;
export const REPORT_NAMES = ['dashboard', 'sales', 'services', 'cashiers', 'stock', 'doctors', 'payroll'] as const;
export type ReportName = (typeof REPORT_NAMES)[number];
export interface ReportParams { from: string; to: string; branchId?: number }

/**
 * التقارير والأرباح (القسم 4، 12 هـ، 3 ج): للمالك بس. كل رقم يبين أساسه: الفرع، الفترة، أساس التاريخ، المنطقة الزمنية، ووقت التوليد.
 * ثلاث أرقام منفصلة: التحصيل (بيوم الدفع)، إيراد الخدمات المنفذة (بيوم إنهاء الكشفية/اكتمال الجلسة، والتراجع ينعكس بتاريخ التصحيح)،
 * والكاش بالدرج (الشفتات). ربح الإدارة = إيراد المنفذ − كلفة المواد الفعلية − الرواتب ونسب الأطباء − التالف − المصاريف − التعويضات.
 * الرواتب بشهر استحقاقها (مو يوم تسديدها)، ومصاريف «المعدات» خارج الربح، وفروقات الجرد منفصلة عن التالف.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  // ================================================================ أساسيات
  async params(actor: AuthUser, from?: string, to?: string, branch?: number): Promise<ReportParams> {
    if (!from || !to) throw Errors.badRequest('RANGE_REQUIRED', 'حدد الفترة (from و to)');
    assertDate(from, 'من'); assertDate(to, 'إلى');
    if (to < from) throw Errors.badRequest('RANGE_INVALID', 'نهاية الفترة قبل بدايتها');
    if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1 > MAX_RANGE_DAYS) throw Errors.badRequest('RANGE_TOO_LONG', 'الفترة أطول من سنة');
    return { from, to, branchId: await resolveBranch(this.db, actor, branch) };
  }

  private basis(p: ReportParams, extra: Record<string, string> = {}) {
    return { branch_id: p.branchId, from: p.from, to: p.to, timezone: 'Asia/Baghdad', generated_at: new Date().toISOString(), ...extra };
  }

  /** أحداث إيراد الخدمات المنفذة (بند، يوم، مبلغ): الجلسة المكتملة + الكشفية المنتهية + عكس التأكيدات المتراجع عنها */
  private revenueEventsSql(): string {
    return `
      select (s.completed_at at time zone ${TZ})::date as d, i.service_id, i.net_amount as amt, 'session' as kind, s.id as session_id
        from treatment_sessions s join payment_items i on i.session_id = s.id and i.status = 'paid' where s.branch_id = $1 and s.status = 'completed'
      union all
      select (r.original_completed_at at time zone ${TZ})::date, i.service_id, i.net_amount, 'session', s.id
        from confirmation_reverts r join treatment_sessions s on s.id = r.session_id join payment_items i on i.id = r.payment_item_id where s.branch_id = $1
      union all
      select (r.reverted_at at time zone ${TZ})::date, i.service_id, -i.net_amount, 'session', s.id
        from confirmation_reverts r join treatment_sessions s on s.id = r.session_id join payment_items i on i.id = r.payment_item_id where s.branch_id = $1
      union all
      select (c.finished_at at time zone ${TZ})::date, i.service_id, i.net_amount, 'consultation', null::bigint
        from consultations c join payment_items i on i.consultation_id = c.id and i.status = 'paid' where c.branch_id = $1 and c.status = 'finished'`;
  }

  private async n(q: Queryable, sql: string, params: unknown[]): Promise<number> { return Number((await q.query(sql, params)).rows[0].v ?? 0); }

  // ================================================================ اللوحة الرئيسية
  async dashboard(p: ReportParams) {
    const q = this.db; const a = [p.branchId, p.from, p.to];
    const collectedRows = (await q.query(
      `select t.method_name, t.method_kind, sum(t.amount)::bigint as amt from payment_tenders t join payments p on p.id = t.payment_id
        where p.branch_id = $1 and p.business_date between $2 and $3 group by t.method_name, t.method_kind order by t.method_name`, a)).rows;
    const refundRows = (await q.query(
      `select t.payout_method_name as method_name, t.payout_kind as method_kind, sum(t.amount)::bigint as amt from refund_tenders t join refunds r on r.id = t.refund_id
        where r.branch_id = $1 and r.business_date between $2 and $3 group by t.payout_method_name, t.payout_kind order by 1`, a)).rows;
    const collected = collectedRows.reduce((s, r) => s + Number(r.amt), 0); const refunded = refundRows.reduce((s, r) => s + Number(r.amt), 0);
    const rev = (await q.query(`with ev as (${this.revenueEventsSql()}) select kind, coalesce(sum(amt),0)::bigint as v from ev where d between $2 and $3 group by kind`, a)).rows;
    const revenue = { sessions: Number(rev.find((r) => r.kind === 'session')?.v ?? 0), consultations: Number(rev.find((r) => r.kind === 'consultation')?.v ?? 0) };
    const executed = revenue.sessions + revenue.consultations;
    const materials = -(await this.n(q, `select coalesce(sum(cost_amount),0)::bigint as v from stock_movements where branch_id = $1 and movement_type in ('consume','consume_reversal') and business_date between $2 and $3`, a));
    const waste = await this.n(q, `select coalesce(sum(cost_amount),0)::bigint as v from stock_waste where branch_id = $1 and wasted_on between $2 and $3`, a);
    const salaries = await this.n(q, `select coalesce(sum(i.total_due),0)::bigint as v from payroll_items i join payroll_runs r on r.id = i.run_id where r.branch_id = $1 and r.period_month between $2 and $3 and i.status <> 'not_payable'`, a);
    const expenses = await this.n(q, `select coalesce(sum(e.amount),0)::bigint as v from expenses e join expense_categories c on c.id = e.category_id where e.branch_id = $1 and e.status = 'active' and c.kind <> 'equipment' and e.expense_date between $2 and $3`, a);
    const equipment = await this.n(q, `select coalesce(sum(e.amount),0)::bigint as v from expenses e join expense_categories c on c.id = e.category_id where e.branch_id = $1 and e.status = 'active' and c.kind = 'equipment' and e.expense_date between $2 and $3`, a);
    const compensations = await this.n(q, `select coalesce(sum(amount),0)::bigint as v from compensations where branch_id = $1 and (created_at at time zone ${TZ})::date between $2 and $3`, a);
    const counts = (await q.query(
      `select (select count(*)::int from customers where branch_id = $1 and (created_at at time zone ${TZ})::date between $2 and $3) as new_customers,
              (select count(*)::int from customers where branch_id = $1 and status = 'active') as customers_total,
              (select count(*)::int from treatment_sessions where branch_id = $1 and status = 'completed' and (completed_at at time zone ${TZ})::date between $2 and $3) as completed_sessions,
              (select count(*)::int from consultations where branch_id = $1 and status = 'finished' and (finished_at at time zone ${TZ})::date between $2 and $3) as finished_consultations,
              (select count(*)::int from payments where branch_id = $1 and business_date between $2 and $3) as payments,
              (select count(*)::int from refunds where branch_id = $1 and business_date between $2 and $3) as refunds`, a)).rows[0];
    const alerts = await this.alerts(q, p.branchId!);
    const profit = executed - materials - salaries - waste - expenses - compensations;
    return {
      basis: this.basis(p, { collections: 'تاريخ الدفع', executed_revenue: 'يوم إنهاء الكشفية أو اكتمال الجلسة (والتراجع بتاريخ التصحيح)', payroll: 'شهر الاستحقاق (الأشهر اللي بدايتها ضمن الفترة)', expenses: 'تاريخ المصروف (بدون المعدات)' }),
      collections: { gross: collected, refunds: refunded, net: collected - refunded, by_method: collectedRows.map((r) => ({ method_name: r.method_name as string, kind: r.method_kind as string, collected: Number(r.amt), refunded: Number(refundRows.find((x) => x.method_name === r.method_name)?.amt ?? 0) })) },
      executed_revenue: { total: executed, ...revenue },
      costs: { materials, salaries, waste, expenses, compensations, total: materials + salaries + waste + expenses + compensations },
      outside_profit: { equipment },
      management_profit: profit,
      counts: { new_customers: Number(counts.new_customers), customers_total: Number(counts.customers_total), completed_sessions: Number(counts.completed_sessions), finished_consultations: Number(counts.finished_consultations), payments: Number(counts.payments), refunds: Number(counts.refunds) },
      alerts,
      table: {
        title: 'اللوحة الرئيسية',
        columns: [{ key: 'item', label: 'البند' }, { key: 'amount', label: 'المبلغ', type: 'money' as const }],
        rows: [
          { item: 'التحصيل (قبل الاسترجاع)', amount: collected }, { item: 'الاسترجاعات', amount: refunded }, { item: 'صافي التحصيل', amount: collected - refunded },
          { item: 'إيراد الخدمات المنفذة', amount: executed }, { item: 'كلفة المواد الفعلية', amount: materials }, { item: 'الرواتب ونسب الأطباء', amount: salaries },
          { item: 'التالف', amount: waste }, { item: 'المصاريف', amount: expenses }, { item: 'التعويضات', amount: compensations }, { item: 'ربح الإدارة', amount: profit },
        ],
      } as Table,
    };
  }

  /** تنبيهات بأعلى الصفحة: أطباء بدون راتب، سحوبات بانتظار الموافقة، مواد سالبة، ورصيد الخزنة */
  private async alerts(q: Queryable, branchId: number) {
    const docs = (await q.query(
      `select u.id, u.full_name from users u join doctors d on d.user_id = u.id where u.branch_id = $1 and u.is_active
          and coalesce((select monthly_salary from pay_rules where user_id = u.id and effective_from <= clinic_today() order by effective_from desc limit 1), -1) < 0 order by u.full_name`, [branchId])).rows;
    const w = await this.n(q, `select count(*)::int as v from owner_withdrawals where branch_id = $1 and status = 'pending'`, [branchId]);
    const neg = await this.n(q, `select count(*)::int as v from v_material_stock v join materials m on m.id = v.material_id where v.branch_id = $1 and m.is_active and v.is_negative`, [branchId]);
    const unset = await this.n(q, `select count(*)::int as v from payroll_items i join payroll_runs r on r.id = i.run_id where r.branch_id = $1 and i.status = 'not_payable'`, [branchId]);
    const safe = await this.n(q, `select coalesce(balance,0)::bigint as v from safes where branch_id = $1`, [branchId]);
    return { doctors_without_salary: docs.map((d) => ({ id: Number(d.id), full_name: d.full_name as string })), pending_withdrawals: w, negative_stock: neg, payroll_unset_items: unset, safe_balance: safe };
  }

  // ================================================================ المبيعات (التحصيل)
  async sales(p: ReportParams) {
    const a = [p.branchId, p.from, p.to];
    const days = (await this.db.query(
      `with pay as (select business_date d, count(*)::int n, coalesce(sum(net_amount),0)::bigint net from payments where branch_id = $1 and business_date between $2 and $3 group by 1),
            col as (select p.business_date d, coalesce(sum(t.amount),0)::bigint amt from payments p join payment_tenders t on t.payment_id = p.id where p.branch_id = $1 and p.business_date between $2 and $3 group by 1),
            ref as (select business_date d, count(*)::int n, coalesce(sum(total_amount),0)::bigint amt from refunds where branch_id = $1 and business_date between $2 and $3 group by 1)
       select to_char(g.d, 'YYYY-MM-DD') as day, coalesce(pay.n,0) as payments, coalesce(col.amt,0) as collected, coalesce(ref.n,0) as refunds, coalesce(ref.amt,0) as refunded
         from generate_series($2::date, $3::date, interval '1 day') as g(d) left join pay on pay.d = g.d left join col on col.d = g.d left join ref on ref.d = g.d
        order by g.d`, a)).rows.map((r) => ({ day: r.day as string, payments: Number(r.payments), collected: Number(r.collected), refunds: Number(r.refunds), refunded: Number(r.refunded), net: Number(r.collected) - Number(r.refunded) }));
    const byKind = (await this.db.query(`select kind, count(*)::int n, coalesce(sum(net_amount),0)::bigint net, coalesce(sum(offer_discount),0)::bigint offers, coalesce(sum(manual_discount),0)::bigint manual, coalesce(sum(points_discount),0)::bigint points from payments where branch_id = $1 and business_date between $2 and $3 group by kind order by kind`, a)).rows
      .map((r) => ({ kind: r.kind as string, payments: Number(r.n), net: Number(r.net), offer_discount: Number(r.offers), manual_discount: Number(r.manual), points_discount: Number(r.points) }));
    const total = days.reduce((s, d) => ({ payments: s.payments + d.payments, collected: s.collected + d.collected, refunds: s.refunds + d.refunds, refunded: s.refunded + d.refunded, net: s.net + d.net }), { payments: 0, collected: 0, refunds: 0, refunded: 0, net: 0 });
    return {
      basis: this.basis(p, { collections: 'تاريخ الدفع، والاسترجاع بتاريخ الاسترجاع' }), total, days, by_kind: byKind,
      table: { title: 'المبيعات', columns: [{ key: 'day', label: 'اليوم', type: 'date' }, { key: 'payments', label: 'عدد الوصولات', type: 'int' }, { key: 'collected', label: 'المقبوض', type: 'money' }, { key: 'refunds', label: 'عدد الاسترجاعات', type: 'int' }, { key: 'refunded', label: 'المسترجع', type: 'money' }, { key: 'net', label: 'الصافي', type: 'money' }], rows: days } as Table,
    };
  }

  // ================================================================ أرباح كل خدمة
  async services(p: ReportParams) {
    const a = [p.branchId, p.from, p.to];
    const { rows } = await this.db.query(
      `with ev as (${this.revenueEventsSql()}),
            rev as (select service_id, coalesce(sum(amt),0)::bigint revenue, count(*) filter (where kind = 'session' and amt > 0)::int executed, count(*) filter (where kind = 'consultation')::int consultations
                      from ev where d between $2 and $3 group by service_id),
            mat as (select i.service_id, -coalesce(sum(m.cost_amount),0)::bigint cost from stock_movements m join treatment_sessions s on s.id = m.treatment_session_id join plan_items i on i.id = s.plan_item_id
                     where m.branch_id = $1 and m.movement_type in ('consume','consume_reversal') and m.business_date between $2 and $3 group by i.service_id)
       select sv.id, sv.name_ar, sv.kind, coalesce(rev.revenue,0) as revenue, coalesce(rev.executed,0) as executed, coalesce(rev.consultations,0) as consultations, coalesce(mat.cost,0) as cost
         from services sv left join rev on rev.service_id = sv.id left join mat on mat.service_id = sv.id
        where sv.branch_id = $1 and (rev.service_id is not null or mat.service_id is not null) order by coalesce(rev.revenue,0) - coalesce(mat.cost,0) desc, sv.name_ar`, a);
    const items = rows.map((r) => ({ service_id: Number(r.id), name: r.name_ar as string, kind: r.kind as string, executed: Number(r.executed) + Number(r.consultations), revenue: Number(r.revenue), materials_cost: Number(r.cost), margin: Number(r.revenue) - Number(r.cost) }));
    return {
      basis: this.basis(p, { revenue: 'يوم اكتمال الجلسة/إنهاء الكشفية', materials: 'تاريخ الخصم من المخزون (التراجع بتاريخ التصحيح)' }),
      total: { revenue: items.reduce((s, i) => s + i.revenue, 0), materials_cost: items.reduce((s, i) => s + i.materials_cost, 0), margin: items.reduce((s, i) => s + i.margin, 0) }, services: items,
      table: { title: 'أرباح الخدمات', columns: [{ key: 'name', label: 'الخدمة' }, { key: 'executed', label: 'المنفذ', type: 'int' }, { key: 'revenue', label: 'الإيراد', type: 'money' }, { key: 'materials_cost', label: 'كلفة المواد', type: 'money' }, { key: 'margin', label: 'الهامش', type: 'money' }], rows: items } as Table,
    };
  }

  // ================================================================ أداء كل كاشير
  async cashiers(p: ReportParams) {
    const a = [p.branchId, p.from, p.to];
    const { rows } = await this.db.query(
      `select u.id, u.full_name,
              (select count(*)::int from payments x where x.cashier_id = u.id and x.branch_id = $1 and x.business_date between $2 and $3) as payments,
              (select coalesce(sum(x.net_amount),0)::bigint from payments x where x.cashier_id = u.id and x.branch_id = $1 and x.business_date between $2 and $3) as net,
              (select coalesce(sum(x.manual_discount),0)::bigint from payments x where x.cashier_id = u.id and x.branch_id = $1 and x.business_date between $2 and $3) as manual,
              (select count(*)::int from refunds x where x.cashier_id = u.id and x.branch_id = $1 and x.business_date between $2 and $3) as refunds,
              (select coalesce(sum(x.total_amount),0)::bigint from refunds x where x.cashier_id = u.id and x.branch_id = $1 and x.business_date between $2 and $3) as refunded,
              (select count(*)::int from shifts x where x.cashier_id = u.id and x.branch_id = $1 and (x.opened_at at time zone ${TZ})::date between $2 and $3) as shifts,
              (select coalesce(sum(t.difference),0)::bigint from shift_method_totals t join shifts x on x.id = t.shift_id where x.cashier_id = u.id and x.branch_id = $1 and (x.opened_at at time zone ${TZ})::date between $2 and $3) as difference
         from users u where u.role = 'cashier' and u.branch_id = $1
          and (exists (select 1 from payments x where x.cashier_id = u.id and x.business_date between $2 and $3) or exists (select 1 from shifts x where x.cashier_id = u.id and (x.opened_at at time zone ${TZ})::date between $2 and $3) or u.is_active)
        order by u.full_name`, a);
    const items = rows.map((r) => ({ cashier_id: Number(r.id), name: r.full_name as string, payments: Number(r.payments), net: Number(r.net), manual_discounts: Number(r.manual), refunds: Number(r.refunds), refunded: Number(r.refunded), shifts: Number(r.shifts), cash_difference: Number(r.difference) }));
    return {
      basis: this.basis(p, { payments: 'تاريخ الدفع', difference: 'فرق المؤكد عن المتوقع بشفتات الفترة' }), cashiers: items,
      table: { title: 'أداء الكاشير', columns: [{ key: 'name', label: 'الكاشير' }, { key: 'payments', label: 'الوصولات', type: 'int' }, { key: 'net', label: 'الصافي', type: 'money' }, { key: 'manual_discounts', label: 'الخصومات اليدوية', type: 'money' }, { key: 'refunds', label: 'الاسترجاعات', type: 'int' }, { key: 'refunded', label: 'المسترجع', type: 'money' }, { key: 'shifts', label: 'الشفتات', type: 'int' }, { key: 'cash_difference', label: 'فرق الشفتات', type: 'money' }], rows: items } as Table,
    };
  }

  // ================================================================ المخزون والتالف والجرد
  async stock(p: ReportParams) {
    const a = [p.branchId, p.from, p.to];
    const mats = (await this.db.query(
      `select m.id, m.name, m.base_unit, v.on_hand, v.valid_qty, v.expired_qty, v.reserved, v.available,
              coalesce((select sum(b.qty_on_hand * b.unit_cost) from material_batches b where b.material_id = m.id and b.qty_on_hand > 0), 0)::bigint as value
         from materials m join v_material_stock v on v.material_id = m.id where m.branch_id = $1 and m.is_active order by m.name`, [p.branchId])).rows
      .map((r) => ({ material_id: Number(r.id), name: r.name as string, unit: r.base_unit as string, on_hand: Number(r.on_hand), valid: Number(r.valid_qty), expired: Number(r.expired_qty), reserved: Number(r.reserved), available: Number(r.available), value: Number(r.value) }));
    const waste = (await this.db.query(`select reason, count(*)::int n, coalesce(sum(cost_amount),0)::bigint cost from stock_waste where branch_id = $1 and wasted_on between $2 and $3 group by reason order by reason`, a)).rows
      .map((r) => ({ reason: r.reason as string, count: Number(r.n), cost: Number(r.cost) }));
    const counts = (await this.db.query(`select count(*)::int n, coalesce(sum(cost_amount) filter (where cost_amount > 0),0)::bigint gains, coalesce(-sum(cost_amount) filter (where cost_amount < 0),0)::bigint losses from stock_movements where branch_id = $1 and movement_type = 'count_adjust' and business_date between $2 and $3`, a)).rows[0];
    return {
      basis: this.basis(p, { valuation: 'كمية الدفعات الحالية × كلفة كل دفعة (لحظة التقرير)', waste: 'تاريخ التسجيل', count_adjustments: 'تاريخ الجرد' }),
      valuation: { total: mats.reduce((s, m) => s + m.value, 0) }, materials: mats,
      waste: { total_cost: waste.reduce((s, w) => s + w.cost, 0), by_reason: waste }, count_adjustments: { movements: Number(counts.n), gains: Number(counts.gains), losses: Number(counts.losses) },
      table: { title: 'المخزون', columns: [{ key: 'name', label: 'المادة' }, { key: 'unit', label: 'الوحدة' }, { key: 'on_hand', label: 'الموجود', type: 'int' }, { key: 'valid', label: 'الصالح', type: 'int' }, { key: 'expired', label: 'المنتهي', type: 'int' }, { key: 'reserved', label: 'المحجوز', type: 'int' }, { key: 'available', label: 'المتاح', type: 'int' }, { key: 'value', label: 'القيمة', type: 'money' }], rows: mats } as Table,
    };
  }

  // ================================================================ الأطباء (كشفيات ونسب)
  async doctors(p: ReportParams) {
    const a = [p.branchId, p.from, p.to];
    const { rows } = await this.db.query(
      `select u.id, u.full_name,
              (select count(*)::int from consultations c where c.doctor_id = u.id and c.status = 'finished' and (c.finished_at at time zone ${TZ})::date between $2 and $3) as consultations,
              (select coalesce(sum(e.base_amount),0)::bigint from doctor_earnings e where e.doctor_id = u.id and e.earned_on between $2 and $3) as base,
              (select coalesce(sum(e.amount),0)::bigint from doctor_earnings e where e.doctor_id = u.id and e.earned_on between $2 and $3) as percent_amount
         from users u join doctors d on d.user_id = u.id where u.branch_id = $1 order by u.full_name`, a);
    const items = rows.map((r) => ({ doctor_id: Number(r.id), name: r.full_name as string, consultations: Number(r.consultations), consultation_net: Number(r.base), percent_amount: Number(r.percent_amount) }));
    return {
      basis: this.basis(p, { consultations: 'يوم إنهاء الكشفية', percent: 'يوم إنهاء الكشفية (النسبة مثبتة وقتها)' }), doctors: items,
      table: { title: 'الأطباء', columns: [{ key: 'name', label: 'الطبيب' }, { key: 'consultations', label: 'الكشفيات المنتهية', type: 'int' }, { key: 'consultation_net', label: 'صافي الكشفيات (أساس النسبة)', type: 'money' }, { key: 'percent_amount', label: 'نسبة الكشفيات', type: 'money' }], rows: items } as Table,
    };
  }

  // ================================================================ الرواتب
  async payroll(p: ReportParams) {
    const { rows } = await this.db.query(
      `select to_char(r.period_month, 'YYYY-MM') as month, i.role_snapshot as role, u.full_name, i.status, i.base_salary, i.consult_amount, i.adjustment_amount, i.total_due
         from payroll_items i join payroll_runs r on r.id = i.run_id join users u on u.id = i.user_id where r.branch_id = $1 and r.period_month between $2 and $3 order by r.period_month, i.role_snapshot, u.full_name`, [p.branchId, p.from, p.to]);
    const items = rows.map((r) => ({ month: r.month as string, role: r.role as string, name: r.full_name as string, status: r.status as string, base_salary: r.base_salary === null ? null : Number(r.base_salary), consult_amount: Number(r.consult_amount), adjustment_amount: Number(r.adjustment_amount), total_due: Number(r.total_due) }));
    return {
      basis: this.basis(p, { period: 'أشهر الاستحقاق اللي بدايتها ضمن الفترة' }), items,
      totals: { accrued: items.filter((i) => i.status !== 'not_payable').reduce((s, i) => s + i.total_due, 0), paid: items.filter((i) => i.status === 'paid').reduce((s, i) => s + i.total_due, 0), unset: items.filter((i) => i.status === 'not_payable').length },
      table: { title: 'الرواتب', columns: [{ key: 'month', label: 'الشهر' }, { key: 'name', label: 'الموظف' }, { key: 'role', label: 'الدور' }, { key: 'status', label: 'الحالة' }, { key: 'base_salary', label: 'الراتب', type: 'money' }, { key: 'consult_amount', label: 'نسبة الكشفيات', type: 'money' }, { key: 'adjustment_amount', label: 'التعديل', type: 'money' }, { key: 'total_due', label: 'المستحق', type: 'money' }], rows: items } as Table,
    };
  }

  // ================================================================ التصدير (المالك بس، وينسجل)
  async export(actor: AuthUser, name: ReportName, p: ReportParams, format: 'csv' | 'xlsx', ip: string | null) {
    const data = await (this[name] as (p: ReportParams) => Promise<{ table: Table }>).call(this, p);
    const table = data.table;
    const body = format === 'xlsx' ? buildXlsx(table) : buildCsv(table);
    await this.db.tx(async (q) => {
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: p.branchId, action: 'report.export', entityType: 'report', reason: name, after: { report: name, format, from: p.from, to: p.to, rows: table.rows.length }, ip });
    });
    const filename = `${name}-${p.from}_${p.to}.${format}`;
    return { body, filename, contentType: format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8' };
  }
}
