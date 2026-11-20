import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { resolveBranch } from '../common/branch';
import { Errors } from '../common/errors';
import { mapSafeError } from '../common/safe-errors';
import { DbService, Queryable } from '../db/db.service';
import { assertDate } from '../schedule/schedule.service';
import { CreatePurchaseDto, CreateReturnDto, VoidPurchaseDto } from './suppliers.dto';
import { SuppliersService } from './suppliers.service';

/**
 * فواتير الشراء والمرتجعات (القسم 7). الشراء يضيف دفعات للمخزون بتاريخ صلاحيتها ويحدّث حساب المورد، وما يعتبر استهلاكاً.
 * ترتيب الأقفال: المورد ← المواد (بترتيب المعرّف) ← الدفعات ← الخزنة.
 */
@Injectable()
export class PurchasesService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly suppliers: SuppliersService) {}

  async create(actor: AuthUser, dto: CreatePurchaseDto, ip: string | null) {
    assertDate(dto.purchase_date, 'تاريخ الفاتورة');
    for (const it of dto.items) assertDate(it.expiry_date, 'تاريخ الصلاحية');
    const pay = dto.payment;
    if (pay.mode === 'credit' && (pay.amount !== undefined || pay.pay_source !== undefined || pay.bank_name !== undefined)) throw Errors.badRequest('PAYMENT_NOT_ALLOWED', 'الفاتورة الآجلة بدون بيانات دفع');
    if (pay.mode !== 'credit' && !pay.pay_source) throw Errors.badRequest('PAY_SOURCE_REQUIRED', 'حدد مصدر الدفع (الخزنة أو إلكتروني)');
    if (pay.mode === 'full' && pay.amount !== undefined) throw Errors.badRequest('AMOUNT_NOT_ALLOWED', 'الدفع الكامل بدون مبلغ (ينحسب من الفاتورة)');
    if (pay.mode === 'partial' && pay.amount === undefined) throw Errors.badRequest('AMOUNT_REQUIRED', 'اكتب المبلغ المدفوع');
    const bank = pay.bank_name?.trim() || null;
    if (pay.pay_source === 'electronic' && !bank) throw Errors.badRequest('BANK_REQUIRED', 'اكتب اسم المصرف للدفع الإلكتروني');
    if (pay.pay_source === 'safe' && bank) throw Errors.badRequest('BANK_NOT_ALLOWED', 'اسم المصرف للدفع الإلكتروني بس');
    const invoice = dto.invoice_no?.trim() || null;
    let branchId = 0; let paidNow = 0;
    try {
      return await this.db.tx(async (q) => {
        const s = await this.suppliers.lockSupplier(q, actor, dto.supplier_id);
        branchId = Number(s.branch_id);
        if (!s.is_active) throw Errors.conflict('SUPPLIER_INACTIVE', 'المورد معطل: ما تنضاف فواتير جديدة له');
        const today = (await q.query(`select clinic_today()::text as d`)).rows[0].d;
        if (dto.purchase_date > today) throw Errors.badRequest('FUTURE_DATE', 'تاريخ الفاتورة ما يكون بالمستقبل');
        for (const it of dto.items) if (it.expiry_date <= today) throw Errors.badRequest('EXPIRY_PAST', 'تاريخ الصلاحية لازم يكون بعد اليوم');
        const a = (await q.query(`select branch_id, kind, deleted_at from attachments where id = $1`, [dto.receipt_attachment_id])).rows[0];
        if (!a || Number(a.branch_id) !== branchId || a.deleted_at || a.kind !== 'purchase_receipt') throw Errors.badRequest('RECEIPT_INVALID', 'صورة الوصل غير صالحة (لازم مرفق من نوع purchase_receipt)');

        // المواد: نقفلها بترتيب المعرّف (يمنع التشابك بين فاتورتين تشتركان بمواد)
        const ids = [...new Set(dto.items.map((i) => i.material_id))].sort((x, y) => x - y);
        const mats = new Map<number, any>();
        for (const id of ids) {
          const m = (await q.query(`select id, branch_id, name, base_per_pack, is_active from materials where id = $1 for update`, [id])).rows[0];
          if (!m || Number(m.branch_id) !== branchId) throw Errors.badRequest('MATERIAL_INVALID', 'مادة غير موجودة');
          if (!m.is_active) throw Errors.conflict('MATERIAL_INACTIVE', `المادة «${m.name}» معطلة`);
          mats.set(id, m);
        }
        const lines: { it: (typeof dto.items)[number]; qtyBase: string; unitCost: string }[] = [];
        for (const it of dto.items) {
          const m = mats.get(it.material_id);
          const qtyBase = (await q.query(`select round($1::numeric * $2::numeric, 3)::text as v`, [String(it.qty_pack), m.base_per_pack])).rows[0].v as string;
          if (Number(qtyBase) <= 0) throw Errors.badRequest('QTY_TOO_SMALL', 'الكمية صغيرة جداً');
          const unitCost = (await q.query(`select round($1::numeric / $2::numeric, 4)::text as v`, [String(it.line_total), qtyBase])).rows[0].v as string;
          lines.push({ it, qtyBase, unitCost });
        }
        const total = dto.items.reduce((acc, i) => acc + i.line_total, 0);
        if (total <= 0) throw Errors.badRequest('TOTAL_ZERO', 'إجمالي الفاتورة لازم يكون أكبر من صفر');
        paidNow = pay.mode === 'full' ? total : pay.mode === 'partial' ? pay.amount! : 0;
        if (pay.mode === 'partial' && !(paidNow >= 1 && paidNow < total)) throw Errors.badRequest('PARTIAL_RANGE', 'المدفوع الجزئي لازم يكون من 1 إلى أقل من الإجمالي');

        const p = (await q.query(`insert into purchases (branch_id, supplier_id, invoice_no, purchase_date, total_amount, receipt_attachment_id, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
          [branchId, dto.supplier_id, invoice, dto.purchase_date, total, dto.receipt_attachment_id, actor.id])).rows[0];
        const purchaseId = Number(p.id);
        for (const l of lines) {
          const item = (await q.query(`insert into purchase_items (purchase_id, material_id, qty_pack, qty_base, unit_cost, line_total, expiry_date) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
            [purchaseId, l.it.material_id, String(l.it.qty_pack), l.qtyBase, l.unitCost, l.it.line_total, l.it.expiry_date])).rows[0];
          const batch = (await q.query(
            `insert into material_batches (branch_id, material_id, source, purchase_item_id, received_on, expiry_date, unit_cost, qty_initial, qty_on_hand) values ($1,$2,'purchase',$3,$4,$5,$6,$7,0) returning id`,
            [branchId, l.it.material_id, item.id, dto.purchase_date, l.it.expiry_date, l.unitCost, l.qtyBase])).rows[0];
          await q.query(
            `insert into stock_movements (branch_id, material_id, batch_id, movement_type, qty_delta, unit_cost, cost_amount, purchase_item_id, created_by) values ($1,$2,$3,'purchase',$4,$5,$6,$7,$8)`,
            [branchId, l.it.material_id, batch.id, l.qtyBase, l.unitCost, l.it.line_total, item.id, actor.id]);
          await q.query(`update materials set last_unit_cost = $2 where id = $1`, [l.it.material_id, l.unitCost]);
        }
        if (paidNow > 0) {
          const sp = (await q.query(`insert into supplier_payments (branch_id, supplier_id, purchase_id, amount, pay_source, bank_name, paid_on, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
            [branchId, dto.supplier_id, purchaseId, paidNow, pay.pay_source, bank, dto.purchase_date, actor.id])).rows[0];
          if (pay.pay_source === 'safe') {
            await q.query(`insert into safes (branch_id) values ($1) on conflict do nothing`, [branchId]);
            await q.query(`insert into safe_movements (branch_id, direction, amount, kind, supplier_payment_id, note, created_by) values ($1,'out',$2,'supplier_payment',$3,$4,$5)`, [branchId, paidNow, sp.id, `دفع فاتورة: ${s.name}`, actor.id]);
          }
        }
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'purchase.create', entityType: 'purchase', entityId: purchaseId,
          after: { supplier_id: dto.supplier_id, invoice_no: invoice, total, paid_now: paidNow, items: dto.items.length }, ip });
        return this.viewQ(q, purchaseId);
      });
    } catch (e: any) {
      if (e?.code === '23505' && e.constraint === 'purchases_invoice_uq') throw Errors.conflict('INVOICE_EXISTS', 'رقم الفاتورة مسجل عند هذا المورد');
      if (e?.code === '23505' && e.constraint === 'purchases_receipt_uq') throw Errors.conflict('RECEIPT_ALREADY_USED', 'صورة الوصل هذي مستخدمة لفاتورة ثانية');
      return mapSafeError(e, this.db, branchId, paidNow);
    }
  }

  /**
   * إلغاء فاتورة شراء غلط (المالك، بسبب): تنعكس دفعاتها من المخزون (purchase_void) بشرط ما انستخدم منها شي، وتطلع من حساب المورد.
   * اللي انسدد عليها يبقى مسدد: يصير رصيد للعيادة عند المورد (بالسالب)، ويتسوى بفاتورة قادمة (قاعدة محاسبية 6).
   */
  async voidPurchase(actor: AuthUser, id: number, dto: VoidPurchaseDto, ip: string | null) {
    const reason = dto.reason.trim();
    if (reason.length < 3) throw Errors.badRequest('REASON_REQUIRED', 'اكتب سبب الإلغاء');
    return this.db.tx(async (q) => {
      const head = (await q.query(`select supplier_id from purchases where id = $1`, [id])).rows[0];
      if (!head) throw Errors.notFound('الفاتورة');
      await this.suppliers.lockSupplier(q, actor, Number(head.supplier_id));
      const p = (await q.query(`select * from purchases where id = $1 for update`, [id])).rows[0];
      if (p.status !== 'posted') throw Errors.conflict('ALREADY_VOIDED', 'الفاتورة ملغاة مسبقاً');
      const items = (await q.query(
        `select pi.id, pi.material_id, pi.qty_base, pi.unit_cost, pi.line_total, b.id as batch_id, b.qty_on_hand, b.qty_initial
           from purchase_items pi join material_batches b on b.purchase_item_id = pi.id where pi.purchase_id = $1 order by pi.material_id, pi.id for update of b`, [id])).rows;
      if (items.some((i) => Number(i.qty_on_hand) !== Number(i.qty_initial))) throw Errors.conflict('PURCHASE_USED', 'انصرف أو انرجع من هذي الفاتورة شي: ما تنلغي');
      for (const i of items) {
        await q.query(`insert into stock_movements (branch_id, material_id, batch_id, movement_type, qty_delta, unit_cost, cost_amount, purchase_item_id, note, created_by) values ($1,$2,$3,'purchase_void',$4,$5,$6,$7,$8,$9)`,
          [p.branch_id, i.material_id, i.batch_id, `-${i.qty_base}`, i.unit_cost, -Number(i.line_total), i.id, `إلغاء فاتورة: ${reason}`, actor.id]);
      }
      await q.query(`update purchases set status = 'voided', void_reason = $2, voided_by = $3, voided_at = now() where id = $1`, [id, reason, actor.id]);
      const paid = Number((await q.query(`select coalesce(sum(amount),0)::bigint as s from supplier_payments where purchase_id = $1`, [id])).rows[0].s);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(p.branch_id), action: 'purchase.void', entityType: 'purchase', entityId: id, reason, after: { total: Number(p.total_amount), paid_on_invoice: paid }, ip });
      return { ...(await this.viewQ(q, id)), supplier_credit_from_void: paid };
    });
  }

  async createReturn(actor: AuthUser, dto: CreateReturnDto, ip: string | null) {
    const reason = dto.reason.trim();
    if (reason.length < 3) throw Errors.badRequest('REASON_REQUIRED', 'اكتب سبب المرتجع');
    const itemIds = dto.items.map((i) => i.purchase_item_id);
    if (new Set(itemIds).size !== itemIds.length) throw Errors.badRequest('DUPLICATE_ITEM', 'بند مكرر بالمرتجع');
    return this.db.tx(async (q) => {
      const head = (await q.query(`select supplier_id from purchases where id = $1`, [dto.purchase_id])).rows[0];
      if (!head) throw Errors.notFound('الفاتورة');
      const s = await this.suppliers.lockSupplier(q, actor, Number(head.supplier_id));
      const p = (await q.query(`select * from purchases where id = $1 for update`, [dto.purchase_id])).rows[0];
      if (p.status !== 'posted') throw Errors.conflict('PURCHASE_VOIDED', 'الفاتورة ملغاة');
      const branchId = Number(p.branch_id);
      const sorted = [...dto.items].sort((a, b) => a.purchase_item_id - b.purchase_item_id);
      const ret = (await q.query(`insert into supplier_returns (branch_id, supplier_id, purchase_id, reason, credit_amount, created_by) values ($1,$2,$3,$4,1,$5) returning id`, [branchId, s.id, dto.purchase_id, reason, actor.id])).rows[0];
      let total = 0; const perMaterial = new Map<number, number>();
      for (const it of sorted) {
        const row = (await q.query(
          `select pi.id, pi.material_id, pi.qty_base, pi.unit_cost, pi.line_total, b.id as batch_id, b.qty_on_hand
             from purchase_items pi join material_batches b on b.purchase_item_id = pi.id where pi.id = $1 and pi.purchase_id = $2 for update of b`, [it.purchase_item_id, dto.purchase_id])).rows[0];
        if (!row) throw Errors.badRequest('ITEM_NOT_IN_PURCHASE', 'بند ما ينتمي لهذي الفاتورة');
        if (Number(it.qty_base) > Number(row.qty_on_hand)) throw Errors.conflictWith('RETURN_EXCEEDS_STOCK', 'الكمية أكبر من المتبقي بالدفعة', { available: Number(row.qty_on_hand), requested: it.qty_base });
        // الكلفة بنسبة الكمية من سطر الفاتورة، وما نتجاوز مجموع السطر لو تكررت المرتجعات (تقريب)
        const credited = Number((await q.query(`select coalesce(sum(ri.credit_amount),0)::bigint as s from supplier_return_items ri where ri.purchase_item_id = $1`, [it.purchase_item_id])).rows[0].s);
        const returnedQty = Number((await q.query(`select coalesce(sum(ri.qty_base),0)::numeric as s from supplier_return_items ri where ri.purchase_item_id = $1`, [it.purchase_item_id])).rows[0].s);
        const raw = Number((await q.query(`select round($1::numeric * $2::numeric / $3::numeric)::bigint as v`, [String(it.qty_base), row.line_total, row.qty_base])).rows[0].v);
        // آخر كمية ترجع من البند = الباقي من سعر السطر بالضبط (حتى ما يضيع دينار بالتقريب لو تكررت المرتجعات)
        const completes = Math.abs(returnedQty + it.qty_base - Number(row.qty_base)) < 0.0005;
        const credit = completes ? Number(row.line_total) - credited : Math.max(0, Math.min(raw, Number(row.line_total) - credited));
        const ri = (await q.query(`insert into supplier_return_items (return_id, purchase_item_id, batch_id, qty_base, credit_amount) values ($1,$2,$3,$4,$5) returning id`, [ret.id, it.purchase_item_id, row.batch_id, String(it.qty_base), credit])).rows[0];
        await q.query(`insert into stock_movements (branch_id, material_id, batch_id, movement_type, qty_delta, unit_cost, cost_amount, supplier_return_item_id, note, created_by) values ($1,$2,$3,'supplier_return',$4,$5,$6,$7,$8,$9)`,
          [branchId, row.material_id, row.batch_id, `-${it.qty_base}`, row.unit_cost, -credit, ri.id, `مرتجع: ${reason}`, actor.id]);
        total += credit;
        perMaterial.set(Number(row.material_id), (perMaterial.get(Number(row.material_id)) ?? 0) + it.qty_base);
      }
      if (total <= 0) throw Errors.conflict('NOTHING_TO_CREDIT', 'الكلفة صفر: ما أكو مبلغ يتنزل من حساب المورد');
      // ما يرجع المحجوز لجلسات مدفوعة (المتاح بعد الإرجاع ما ينزل تحت صفر)
      for (const [mid, qty] of perMaterial) {
        const st = (await q.query(`select available, on_hand, reserved from v_material_stock where material_id = $1`, [mid])).rows[0];
        if (Number(st.reserved) > 0 && Number(st.available) < 0) throw Errors.conflictWith('RETURN_EXCEEDS_AVAILABLE', 'الكمية المرجعة تدخل بالمحجوز لجلسات مدفوعة', { material_id: mid, requested: qty, reserved: Number(st.reserved) });
      }
      await q.query(`update supplier_returns set credit_amount = $2 where id = $1`, [ret.id, total]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'supplier.return', entityType: 'supplier_return', entityId: Number(ret.id), reason, after: { purchase_id: dto.purchase_id, credit: total, items: dto.items }, ip });
      const owed = Number((await q.query(`select balance_owed from v_supplier_balance where supplier_id = $1`, [s.id])).rows[0].balance_owed);
      return { id: Number(ret.id), purchase_id: dto.purchase_id, supplier_id: Number(s.id), credit_amount: total, reason, balance_owed: owed, has_credit: owed < 0 };
    });
  }

  async get(actor: AuthUser, id: number) {
    const v = await this.viewQ(this.db, id);
    if (!v || (actor.role !== 'owner' && v.branch_id !== actor.branchId)) throw Errors.notFound('الفاتورة');
    return v;
  }

  async list(actor: AuthUser, p: { supplierId?: number; from?: string; to?: string; status?: string; branchId?: number }) {
    const branchId = await resolveBranch(this.db, actor, p.branchId);
    if (p.from) assertDate(p.from, 'من تاريخ');
    if (p.to) assertDate(p.to, 'إلى تاريخ');
    if (p.status && !['posted', 'voided'].includes(p.status)) throw Errors.badRequest('INVALID_STATUS', 'حالة غير معروفة');
    const { rows } = await this.db.query(
      `select id from purchases where branch_id = $1 and ($2::bigint is null or supplier_id = $2) and ($3::date is null or purchase_date >= $3) and ($4::date is null or purchase_date <= $4) and ($5::text is null or status = $5)
        order by purchase_date desc, id desc limit 200`, [branchId, p.supplierId ?? null, p.from ?? null, p.to ?? null, p.status ?? null]);
    return { branch_id: branchId, purchases: await Promise.all(rows.map((r) => this.viewQ(this.db, Number(r.id)))) };
  }

  private async viewQ(q: Queryable, id: number) {
    const p = (await q.query(`select p.*, p.purchase_date::text as date_text, s.name as supplier_name from purchases p join suppliers s on s.id = p.supplier_id where p.id = $1`, [id])).rows[0];
    if (!p) return null;
    const items = (await q.query(
      `select pi.*, pi.expiry_date::text as expiry_text, m.name as material_name, b.id as batch_id, b.qty_on_hand from purchase_items pi join materials m on m.id = pi.material_id left join material_batches b on b.purchase_item_id = pi.id
        where pi.purchase_id = $1 order by pi.id`, [id])).rows;
    const pays = (await q.query(`select id, amount, pay_source, bank_name from supplier_payments where purchase_id = $1 order by id`, [id])).rows;
    const rets = (await q.query(`select id, credit_amount, reason from supplier_returns where purchase_id = $1 order by id`, [id])).rows;
    const paid = pays.reduce((a, x) => a + Number(x.amount), 0);
    return {
      id: Number(p.id), branch_id: Number(p.branch_id), supplier: { id: Number(p.supplier_id), name: p.supplier_name }, invoice_no: p.invoice_no, purchase_date: p.date_text as string,
      total_amount: Number(p.total_amount), paid_on_invoice: paid, unpaid_on_invoice: Number(p.total_amount) - paid, receipt_attachment_id: Number(p.receipt_attachment_id),
      status: p.status, void_reason: p.void_reason,
      items: items.map((i) => ({ id: Number(i.id), material: { id: Number(i.material_id), name: i.material_name }, qty_pack: Number(i.qty_pack), qty_base: Number(i.qty_base), unit_cost: Number(i.unit_cost), line_total: Number(i.line_total),
        expiry_date: i.expiry_text as string, batch_id: i.batch_id === null ? null : Number(i.batch_id), qty_on_hand: i.qty_on_hand === null ? null : Number(i.qty_on_hand) })),
      payments: pays.map((x) => ({ id: Number(x.id), amount: Number(x.amount), pay_source: x.pay_source, bank_name: x.bank_name })),
      returns: rets.map((x) => ({ id: Number(x.id), credit_amount: Number(x.credit_amount), reason: x.reason })),
    };
  }
}
