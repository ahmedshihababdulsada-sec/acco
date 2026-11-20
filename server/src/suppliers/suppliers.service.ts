import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { resolveBranch } from '../common/branch';
import { Errors } from '../common/errors';
import { mapSafeError } from '../common/safe-errors';
import { DbService, Queryable } from '../db/db.service';
import { assertDate } from '../schedule/schedule.service';
import { CreateSupplierDto, SupplierPaymentDto, UpdateSupplierDto } from './suppliers.dto';

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * الموردين (القسم 7 و14): الباقي علينا = الافتتاحي + الفواتير − المرتجعات − التسديدات (v_supplier_balance).
 * كل عملية تغير الحساب تقفل صف المورد أول، فالتسديد والفاتورة والمرتجع ما يتداخلون.
 */
@Injectable()
export class SuppliersService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async create(actor: AuthUser, dto: CreateSupplierDto, ip: string | null) {
    const name = clean(dto.name);
    if (name.length < 2) throw Errors.badRequest('INVALID_NAME', 'الاسم قصير');
    const branchId = await resolveBranch(this.db, actor, dto.branch_id);
    const phone = dto.phone?.trim() || null;
    try {
      return await this.db.tx(async (q) => {
        const { rows } = await q.query(`insert into suppliers (branch_id, name, phone, notes, opening_balance, created_by) values ($1,$2,$3,$4,$5,$6) returning id`,
          [branchId, name, phone, dto.notes?.trim() || null, dto.opening_balance ?? 0, actor.id]);
        const id = Number(rows[0].id);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'supplier.create', entityType: 'supplier', entityId: id, after: { name, phone, opening_balance: dto.opening_balance ?? 0 }, ip });
        return { ...(await this.viewQ(q, id)), warnings: await this.phoneWarnings(q, branchId, phone, id) };
      });
    } catch (e: any) {
      if (e?.code === '23505') throw Errors.conflict('SUPPLIER_EXISTS', 'المورد موجود (الاسم فريد حتى بين المعطلين)');
      throw e;
    }
  }

  async update(actor: AuthUser, id: number, dto: UpdateSupplierDto, ip: string | null) {
    const name = dto.name === undefined ? undefined : clean(dto.name);
    if (name !== undefined && name.length < 2) throw Errors.badRequest('INVALID_NAME', 'الاسم قصير');
    if ([name, dto.phone, dto.notes, dto.opening_balance, dto.is_active].every((v) => v === undefined)) throw Errors.badRequest('NO_CHANGE', 'ما أكو تغيير');
    try {
      return await this.db.tx(async (q) => {
        const s = await this.lockSupplier(q, actor, id);
        if (dto.opening_balance !== undefined && Number(s.opening_balance) !== dto.opening_balance && (await this.hasMovements(q, id)))
          throw Errors.conflict('OPENING_LOCKED', 'الرصيد الافتتاحي ينقفل بعد أول حركة (فاتورة أو تسديد أو مرتجع): التصحيح بحركة جديدة');
        const phone = dto.phone === undefined ? s.phone : dto.phone.trim() || null;
        await q.query(`update suppliers set name = coalesce($2, name), phone = $3, notes = $4, opening_balance = coalesce($5::bigint, opening_balance), is_active = coalesce($6, is_active) where id = $1`,
          [id, name ?? null, phone, dto.notes === undefined ? s.notes : dto.notes.trim() || null, dto.opening_balance ?? null, dto.is_active ?? null]);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(s.branch_id), action: 'supplier.update', entityType: 'supplier', entityId: id,
          before: { name: s.name, phone: s.phone, opening_balance: Number(s.opening_balance), is_active: s.is_active }, after: { name: name ?? s.name, phone, opening_balance: dto.opening_balance ?? Number(s.opening_balance), is_active: dto.is_active ?? s.is_active }, ip });
        return { ...(await this.viewQ(q, id)), warnings: await this.phoneWarnings(q, Number(s.branch_id), phone, id) };
      });
    } catch (e: any) {
      if (e?.code === '23505') throw Errors.conflict('SUPPLIER_EXISTS', 'المورد موجود (الاسم فريد حتى بين المعطلين)');
      throw e;
    }
  }

  async list(actor: AuthUser, all: boolean, requestedBranch?: number) {
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    const { rows } = await this.db.query(`select id from suppliers where branch_id = $1 and ($2 or is_active) order by name`, [branchId, all]);
    const suppliers = await Promise.all(rows.map((r) => this.viewQ(this.db, Number(r.id))));
    return { branch_id: branchId, total_owed: suppliers.reduce((a, s) => a + Math.max(s!.balance_owed, 0), 0), suppliers };
  }

  /** كشف الحساب: حركات مرتبة بالتاريخ برصيد جاري. الفاتورة الملغاة تظهر وما تنحسب. */
  async statement(actor: AuthUser, id: number) {
    const s = await this.viewQ(this.db, id);
    if (!s || (actor.role !== 'owner' && s.branch_id !== actor.branchId)) throw Errors.notFound('المورد');
    const { rows } = await this.db.query(
      `select * from (
         select 'purchase' as kind, p.id, p.purchase_date::text as d, p.created_at as at, p.total_amount as amount, p.status, ('فاتورة ' || coalesce(p.invoice_no, '#' || p.id)) as note from purchases p where p.supplier_id = $1
         union all select 'return', r.id, r.return_date::text, r.created_at, r.credit_amount, 'posted', 'مرتجع: ' || r.reason from supplier_returns r where r.supplier_id = $1
         union all select 'payment', x.id, x.paid_on::text, x.created_at, x.amount, 'posted', case when x.purchase_id is null then 'تسديد' else 'دفع وقت الشراء' end from supplier_payments x where x.supplier_id = $1
       ) t order by d, at, kind, id`, [id]);
    let running = s.opening_balance;
    const lines = rows.map((r) => {
      const counted = r.status === 'posted';
      const delta = !counted ? 0 : r.kind === 'purchase' ? Number(r.amount) : -Number(r.amount);
      running += delta;
      return { kind: r.kind, id: Number(r.id), date: r.d, amount: Number(r.amount), status: r.status, note: r.note, balance_after: running };
    });
    return { supplier: s, opening_balance: s.opening_balance, lines, balance_owed: running };
  }

  /** التسديد (من الخزنة أو إلكتروني). ما يتجاوز اللي علينا للمورد. من الخزنة ينقص رصيدها وفوق الرصيد يفشل. */
  async pay(actor: AuthUser, supplierId: number, dto: SupplierPaymentDto, ip: string | null) {
    assertDate(dto.paid_on, 'تاريخ التسديد');
    const bank = dto.bank_name?.trim() || null;
    if (dto.pay_source === 'electronic' && !bank) throw Errors.badRequest('BANK_REQUIRED', 'اكتب اسم المصرف للدفع الإلكتروني');
    if (dto.pay_source === 'safe' && bank) throw Errors.badRequest('BANK_NOT_ALLOWED', 'اسم المصرف للدفع الإلكتروني بس');
    let branchId = 0;
    try {
      return await this.db.tx(async (q) => {
        const s = await this.lockSupplier(q, actor, supplierId);
        branchId = Number(s.branch_id);
        const today = (await q.query(`select clinic_today()::text as d`)).rows[0].d;
        if (dto.paid_on > today) throw Errors.badRequest('FUTURE_DATE', 'تاريخ التسديد ما يكون بالمستقبل');
        if (dto.proof_attachment_id !== undefined) {
          const a = (await q.query(`select branch_id, kind, deleted_at from attachments where id = $1`, [dto.proof_attachment_id])).rows[0];
          if (!a || Number(a.branch_id) !== branchId || a.deleted_at || a.kind !== 'supplier_payment_proof') throw Errors.badRequest('PROOF_INVALID', 'صورة الإثبات غير صالحة');
        }
        const owed = Number((await q.query(`select balance_owed from v_supplier_balance where supplier_id = $1`, [supplierId])).rows[0].balance_owed);
        if (dto.amount > owed) throw Errors.conflictWith('EXCEEDS_BALANCE', 'المبلغ أكبر من اللي علينا للمورد', { balance_owed: owed, requested: dto.amount });
        const { rows } = await q.query(
          `insert into supplier_payments (branch_id, supplier_id, amount, pay_source, bank_name, paid_on, proof_attachment_id, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
          [branchId, supplierId, dto.amount, dto.pay_source, bank, dto.paid_on, dto.proof_attachment_id ?? null, actor.id]);
        const id = Number(rows[0].id);
        if (dto.pay_source === 'safe') {
          await q.query(`insert into safes (branch_id) values ($1) on conflict do nothing`, [branchId]);
          await q.query(`insert into safe_movements (branch_id, direction, amount, kind, supplier_payment_id, note, created_by) values ($1,'out',$2,'supplier_payment',$3,$4,$5)`, [branchId, dto.amount, id, `تسديد: ${s.name}`, actor.id]);
        }
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'supplier.payment', entityType: 'supplier_payment', entityId: id, after: { supplier_id: supplierId, amount: dto.amount, pay_source: dto.pay_source, bank_name: bank }, ip });
        return { id, supplier_id: supplierId, amount: dto.amount, pay_source: dto.pay_source, bank_name: bank, paid_on: dto.paid_on, balance_owed: owed - dto.amount };
      });
    } catch (e: any) {
      if (e?.code === '23505' && e.constraint === 'supplier_payments_proof_uq') throw Errors.conflict('PROOF_ALREADY_USED', 'صورة الإثبات هذي مستخدمة لتسديد ثاني');
      return mapSafeError(e, this.db, branchId, dto.amount);
    }
  }

  // ================================================================ داخلي (تستخدمه الفواتير والمرتجعات)
  async lockSupplier(q: Queryable, actor: AuthUser, id: number) {
    const s = (await q.query(`select * from suppliers where id = $1 for update`, [id])).rows[0];
    if (!s || (actor.role !== 'owner' && Number(s.branch_id) !== actor.branchId)) throw Errors.notFound('المورد');
    return s;
  }

  private async hasMovements(q: Queryable, id: number): Promise<boolean> {
    const r = await q.query(
      `select (exists (select 1 from purchases where supplier_id = $1) or exists (select 1 from supplier_payments where supplier_id = $1) or exists (select 1 from supplier_returns where supplier_id = $1)) as has`, [id]);
    return r.rows[0].has;
  }

  /** رقم مكرر عند مورد ثاني: تحذير بس (ما يمنع الحفظ) */
  private async phoneWarnings(q: Queryable, branchId: number, phone: string | null, selfId: number) {
    if (!phone) return [];
    const { rows } = await q.query(`select id, name from suppliers where branch_id = $1 and phone = $2 and id <> $3`, [branchId, phone, selfId]);
    return rows.map((r) => ({ code: 'PHONE_DUPLICATE', supplier_id: Number(r.id), supplier_name: r.name }));
  }

  private async viewQ(q: Queryable, id: number) {
    const r = (await q.query(`select s.*, b.balance_owed from suppliers s join v_supplier_balance b on b.supplier_id = s.id where s.id = $1`, [id])).rows[0];
    if (!r) return null;
    return { id: Number(r.id), branch_id: Number(r.branch_id), name: r.name, phone: r.phone, notes: r.notes, opening_balance: Number(r.opening_balance), is_active: r.is_active,
      balance_owed: Number(r.balance_owed), has_credit: Number(r.balance_owed) < 0 };
  }
}
