import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { resolveBranch } from '../common/branch';
import { Errors } from '../common/errors';
import { mapSafeError } from '../common/safe-errors';
import { DbService, Queryable } from '../db/db.service';
import { assertDate } from '../schedule/schedule.service';
import { CancelExpenseDto, CreateCategoryDto, CreateExpenseDto, EditExpenseDto, UpdateCategoryDto } from './expenses.dto';

const cleanName = (s: string) => s.replace(/\s+/g, ' ').trim();
const MAX_LIST = 500;

/**
 * المصاريف (القسم 14): المدير والمالك يسجلون، صورة الإثبات إلزامية وما تنستخدم لمصروفين، والدفع من الخزنة (ينقص رصيدها وفوق الرصيد يفشل)
 * أو إلكتروني (اسم المصرف إلزامي وما يلمس الخزنة). المصروف ما ينحذف: التعديل والإلغاء للمالك بس بسبب مكتوب، وفرق المبلغ ينعكس على الخزنة.
 */
@Injectable()
export class ExpensesService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  // ================================================================ الأنواع
  async listCategories(actor: AuthUser, all: boolean, requestedBranch?: number) {
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    const { rows } = await this.db.query(`select id, name, kind, is_active from expense_categories where branch_id = $1 and ($2 or is_active) order by name`, [branchId, all]);
    return { branch_id: branchId, categories: rows.map((r) => ({ id: Number(r.id), name: r.name, kind: r.kind, is_active: r.is_active })) };
  }

  async createCategory(actor: AuthUser, dto: CreateCategoryDto, ip: string | null) {
    const name = cleanName(dto.name);
    if (name.length < 2) throw Errors.badRequest('INVALID_NAME', 'الاسم قصير');
    const branchId = await resolveBranch(this.db, actor, dto.branch_id);
    try {
      return await this.db.tx(async (q) => {
        if ((await q.query(`select 1 from expense_categories where branch_id = $1 and lower(name) = lower($2)`, [branchId, name])).rowCount) throw Errors.conflict('CATEGORY_EXISTS', 'النوع موجود');
        const { rows } = await q.query(`insert into expense_categories (branch_id, name, kind) values ($1,$2,$3) returning id, name, kind, is_active`, [branchId, name, dto.kind ?? 'operating']);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'expense_category.create', entityType: 'expense_category', entityId: Number(rows[0].id), after: { name, kind: rows[0].kind }, ip });
        return { id: Number(rows[0].id), name: rows[0].name, kind: rows[0].kind, is_active: rows[0].is_active };
      });
    } catch (e: any) {
      if (e?.code === '23505') throw Errors.conflict('CATEGORY_EXISTS', 'النوع موجود');
      throw e;
    }
  }

  /** الاسم والتفعيل بس. نوع الحساب (تشغيلي/عمولة/معدات) ما يتغير بعد الإنشاء لأنه يأثر على التقارير القديمة. */
  async updateCategory(actor: AuthUser, id: number, dto: UpdateCategoryDto, ip: string | null) {
    const name = dto.name === undefined ? undefined : cleanName(dto.name);
    if (name !== undefined && name.length < 2) throw Errors.badRequest('INVALID_NAME', 'الاسم قصير');
    if (name === undefined && dto.is_active === undefined) throw Errors.badRequest('NO_CHANGE', 'ما أكو تغيير');
    try {
      return await this.db.tx(async (q) => {
        const c = (await q.query(`select * from expense_categories where id = $1 for update`, [id])).rows[0];
        if (!c || (actor.role !== 'owner' && Number(c.branch_id) !== actor.branchId)) throw Errors.notFound('النوع');
        if (name !== undefined && (await q.query(`select 1 from expense_categories where branch_id = $1 and lower(name) = lower($2) and id <> $3`, [c.branch_id, name, id])).rowCount) throw Errors.conflict('CATEGORY_EXISTS', 'النوع موجود');
        const { rows } = await q.query(`update expense_categories set name = coalesce($2, name), is_active = coalesce($3, is_active) where id = $1 returning id, name, kind, is_active`, [id, name ?? null, dto.is_active ?? null]);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(c.branch_id), action: 'expense_category.update', entityType: 'expense_category', entityId: id,
          before: { name: c.name, is_active: c.is_active }, after: { name: rows[0].name, is_active: rows[0].is_active }, ip });
        return { id: Number(rows[0].id), name: rows[0].name, kind: rows[0].kind, is_active: rows[0].is_active };
      });
    } catch (e: any) {
      if (e?.code === '23505') throw Errors.conflict('CATEGORY_EXISTS', 'النوع موجود');
      throw e;
    }
  }

  // ================================================================ المصاريف
  async create(actor: AuthUser, dto: CreateExpenseDto, ip: string | null) {
    assertDate(dto.expense_date, 'تاريخ المصروف');
    const branchId = await resolveBranch(this.db, actor, dto.branch_id);
    const bank = dto.bank_name?.trim() || null;
    if (dto.pay_source === 'electronic' && !bank) throw Errors.badRequest('BANK_REQUIRED', 'اكتب اسم المصرف للدفع الإلكتروني');
    if (dto.pay_source === 'safe' && bank) throw Errors.badRequest('BANK_NOT_ALLOWED', 'اسم المصرف للدفع الإلكتروني بس');
    try {
      return await this.db.tx(async (q) => {
        const today = (await q.query(`select clinic_today()::text as d`)).rows[0].d;
        if (dto.expense_date > today) throw Errors.badRequest('FUTURE_DATE', 'تاريخ المصروف ما يكون بالمستقبل');
        await this.assertCategory(q, branchId, dto.category_id);
        const a = (await q.query(`select id, branch_id, kind, deleted_at from attachments where id = $1`, [dto.proof_attachment_id])).rows[0];
        if (!a || Number(a.branch_id) !== branchId || a.deleted_at) throw Errors.badRequest('PROOF_INVALID', 'صورة الإثبات غير موجودة');
        if (a.kind !== 'expense_proof') throw Errors.badRequest('PROOF_INVALID', 'المرفق مو صورة إثبات مصروف');
        const { rows } = await q.query(
          `insert into expenses (branch_id, category_id, amount, expense_date, description, pay_source, bank_name, proof_attachment_id, recorded_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
          [branchId, dto.category_id, dto.amount, dto.expense_date, dto.description?.trim() || null, dto.pay_source, bank, dto.proof_attachment_id, actor.id]);
        const id = Number(rows[0].id);
        if (dto.pay_source === 'safe') {
          await q.query(`insert into safes (branch_id) values ($1) on conflict do nothing`, [branchId]);
          await q.query(`insert into safe_movements (branch_id, direction, amount, kind, expense_id, note, created_by) values ($1,'out',$2,'expense',$3,'مصروف',$4)`, [branchId, dto.amount, id, actor.id]);
        }
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'expense.create', entityType: 'expense', entityId: id,
          after: { category_id: dto.category_id, amount: dto.amount, date: dto.expense_date, pay_source: dto.pay_source, bank_name: bank, proof_attachment_id: dto.proof_attachment_id }, ip });
        return this.viewQ(q, id);
      });
    } catch (e: any) {
      if (e?.code === '23505' && e.constraint === 'expenses_proof_uq') throw Errors.conflict('PROOF_ALREADY_USED', 'صورة الإثبات هذي مستخدمة لمصروف ثاني');
      return mapSafeError(e, this.db, branchId, dto.amount);
    }
  }

  /** تعديل المالك: النوع والمبلغ والتاريخ والملاحظة بسبب إلزامي. طريقة الدفع والإثبات ما يتغيرون. فرق مبلغ المصروف من الخزنة ينعكس عليها. */
  async edit(actor: AuthUser, id: number, dto: EditExpenseDto, ip: string | null) {
    const reason = dto.reason.trim();
    if (reason.length < 3) throw Errors.badRequest('REASON_REQUIRED', 'اكتب سبب التعديل');
    if (dto.expense_date !== undefined) assertDate(dto.expense_date, 'تاريخ المصروف');
    let branchId = 0;
    try {
      return await this.db.tx(async (q) => {
        const e = (await q.query(`select *, expense_date::text as date_text from expenses where id = $1 for update`, [id])).rows[0];
        if (!e) throw Errors.notFound('المصروف');
        branchId = Number(e.branch_id);
        if (e.status !== 'active') throw Errors.conflict('EXPENSE_CANCELLED', 'المصروف ملغى');
        if (Number(e.version) !== dto.expected_version) throw Errors.conflictWith('VERSION_CONFLICT', 'المصروف تعدل من شخص ثاني: حدّث الصفحة', { current_version: Number(e.version) });
        const prev = { category_id: Number(e.category_id), amount: Number(e.amount), expense_date: e.date_text as string, description: e.description };
        const next = {
          category_id: dto.category_id ?? prev.category_id, amount: dto.amount ?? prev.amount, expense_date: dto.expense_date ?? prev.expense_date,
          description: dto.description === undefined ? e.description : dto.description.trim() || null,
        };
        if (JSON.stringify(prev) === JSON.stringify(next)) throw Errors.badRequest('NO_CHANGE', 'ما غيرت شي');
        const today = (await q.query(`select clinic_today()::text as d`)).rows[0].d;
        if (next.expense_date > today) throw Errors.badRequest('FUTURE_DATE', 'تاريخ المصروف ما يكون بالمستقبل');
        if (next.category_id !== prev.category_id) await this.assertCategory(q, branchId, next.category_id);
        await q.query(`update expenses set category_id = $2, amount = $3, expense_date = $4, description = $5, version = version + 1 where id = $1`, [id, next.category_id, next.amount, next.expense_date, next.description]);
        const diff = next.amount - prev.amount;
        if (e.pay_source === 'safe' && diff !== 0) {
          await q.query(`insert into safe_movements (branch_id, direction, amount, kind, expense_id, note, created_by) values ($1,$2,$3,'expense_adjustment',$4,$5,$6)`,
            [branchId, diff > 0 ? 'out' : 'in', Math.abs(diff), id, `تعديل مصروف: ${prev.amount} ← ${next.amount}`, actor.id]);
        }
        await q.query(`insert into expense_edits (expense_id, edited_by, reason, old_values, new_values) values ($1,$2,$3,$4,$5)`, [id, actor.id, reason, JSON.stringify(prev), JSON.stringify(next)]);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'expense.edit', entityType: 'expense', entityId: id, reason, before: prev, after: next, ip });
        return this.viewQ(q, id);
      });
    } catch (e: any) {
      return mapSafeError(e, this.db, branchId, dto.amount ?? 0);
    }
  }

  /** الإلغاء الكامل (المالك، بسبب): يبقى ظاهر بعلامة «ملغى» وما ينحذف، ومبلغه يرجع للخزنة إذا كان منها. */
  async cancel(actor: AuthUser, id: number, dto: CancelExpenseDto, ip: string | null) {
    const reason = dto.reason.trim();
    if (reason.length < 3) throw Errors.badRequest('REASON_REQUIRED', 'اكتب سبب الإلغاء');
    return this.db.tx(async (q) => {
      const e = (await q.query(`select * from expenses where id = $1 for update`, [id])).rows[0];
      if (!e) throw Errors.notFound('المصروف');
      if (e.status !== 'active') throw Errors.conflict('EXPENSE_CANCELLED', 'المصروف ملغى مسبقاً');
      await q.query(`update expenses set status = 'cancelled', cancel_reason = $2, cancelled_by = $3, version = version + 1 where id = $1`, [id, reason, actor.id]);
      if (e.pay_source === 'safe') await q.query(`insert into safe_movements (branch_id, direction, amount, kind, expense_id, note, created_by) values ($1,'in',$2,'expense_adjustment',$3,'إلغاء مصروف',$4)`, [e.branch_id, e.amount, id, actor.id]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(e.branch_id), action: 'expense.cancel', entityType: 'expense', entityId: id, reason, before: { amount: Number(e.amount) }, ip });
      return this.viewQ(q, id);
    });
  }

  async get(actor: AuthUser, id: number) {
    const v = await this.viewQ(this.db, id);
    if (!v || (actor.role !== 'owner' && v.branch_id !== actor.branchId)) throw Errors.notFound('المصروف');
    return v;
  }

  /** قائمة الفترة (month=YYYY-MM أو from/to، والافتراضي الشهر الحالي) مع إجمالي المصاريف الفعالة حسب النوع. الملغى يظهر بس ما ينحسب. */
  async list(actor: AuthUser, p: { month?: string; from?: string; to?: string; categoryId?: number; status?: string; branchId?: number }) {
    const branchId = await resolveBranch(this.db, actor, p.branchId);
    let from = p.from; let to = p.to;
    if (p.month) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p.month)) throw Errors.badRequest('INVALID_MONTH', 'الشهر بصيغة YYYY-MM');
      from = `${p.month}-01`; to = (await this.db.query(`select (($1::date + interval '1 month') - interval '1 day')::date::text as d`, [from])).rows[0].d;
    }
    if (!from && !to) {
      const r = (await this.db.query(`select date_trunc('month', clinic_today())::date::text as f, (date_trunc('month', clinic_today()) + interval '1 month - 1 day')::date::text as t`)).rows[0];
      from = r.f; to = r.t;
    }
    if (!from || !to) throw Errors.badRequest('INVALID_RANGE', 'حدد التاريخين');
    assertDate(from, 'من تاريخ'); assertDate(to, 'إلى تاريخ');
    if (to < from) throw Errors.badRequest('INVALID_RANGE', 'تاريخ النهاية قبل البداية');
    if (p.status && !['active', 'cancelled'].includes(p.status)) throw Errors.badRequest('INVALID_STATUS', 'حالة غير معروفة');
    const { rows } = await this.db.query(
      `select id from expenses where branch_id = $1 and expense_date between $2 and $3 and ($4::bigint is null or category_id = $4) and ($5::text is null or status = $5)
        order by expense_date desc, id desc limit ${MAX_LIST}`, [branchId, from, to, p.categoryId ?? null, p.status ?? null]);
    const expenses = await Promise.all(rows.map((r) => this.viewQ(this.db, Number(r.id))));
    const totals = await this.db.query(
      `select c.id, c.name, c.kind, sum(e.amount)::bigint as total from expenses e join expense_categories c on c.id = e.category_id
        where e.branch_id = $1 and e.expense_date between $2 and $3 and e.status = 'active' group by c.id, c.name, c.kind order by sum(e.amount) desc`, [branchId, from, to]);
    return {
      branch_id: branchId, from, to, expenses,
      total_active: totals.rows.reduce((a, r) => a + Number(r.total), 0),
      by_category: totals.rows.map((r) => ({ category_id: Number(r.id), name: r.name, kind: r.kind, total: Number(r.total) })),
    };
  }

  // ================================================================ داخلي
  private async assertCategory(q: Queryable, branchId: number, categoryId: number) {
    const c = (await q.query(`select branch_id, is_active from expense_categories where id = $1`, [categoryId])).rows[0];
    if (!c || Number(c.branch_id) !== branchId) throw Errors.badRequest('CATEGORY_INVALID', 'نوع المصروف غير موجود');
    if (!c.is_active) throw Errors.conflict('CATEGORY_INACTIVE', 'نوع المصروف معطل');
  }

  private async viewQ(q: Queryable, id: number) {
    const e = (await q.query(
      `select e.*, e.expense_date::text as date_text, c.name as category_name, c.kind as category_kind, u.full_name as recorded_by_name from expenses e
         join expense_categories c on c.id = e.category_id join users u on u.id = e.recorded_by where e.id = $1`, [id])).rows[0];
    if (!e) return null;
    const edits = (await q.query(`select ed.id, ed.reason, ed.old_values, ed.new_values, ed.edited_at, u.full_name as by_name from expense_edits ed join users u on u.id = ed.edited_by where ed.expense_id = $1 order by ed.id`, [id])).rows;
    return {
      id: Number(e.id), branch_id: Number(e.branch_id), category: { id: Number(e.category_id), name: e.category_name, kind: e.category_kind }, amount: Number(e.amount),
      original_amount: edits.length ? Number(edits[0].old_values.amount) : Number(e.amount),                    // «عُدّل · كان X»: بالمبلغ الأصلي حتى بعد تعديل ثاني
      expense_date: e.date_text as string, description: e.description, pay_source: e.pay_source, bank_name: e.bank_name, proof_attachment_id: Number(e.proof_attachment_id),
      status: e.status, cancel_reason: e.cancel_reason, version: Number(e.version), recorded_by: { id: Number(e.recorded_by), full_name: e.recorded_by_name }, recorded_at: e.recorded_at,
      edits: edits.map((x) => ({ id: Number(x.id), reason: x.reason, old: x.old_values, new: x.new_values, by: x.by_name, at: x.edited_at })),
    };
  }
}
