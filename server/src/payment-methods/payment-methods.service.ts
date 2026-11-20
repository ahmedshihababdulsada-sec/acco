import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { can } from '../auth/permissions';
import { resolveBranch } from '../common/branch';
import { Errors } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { CreatePaymentMethodDto, UpdatePaymentMethodDto } from './payment-methods.dto';

interface Method { id: number; branch_id: number; name_ar: string; kind: 'cash' | 'electronic'; device_label: string | null; is_active: boolean; sort_order: number }

const view = (r: any) => ({ id: Number(r.id), name_ar: r.name_ar, name_en: r.name_en, kind: r.kind, device_label: r.device_label, is_active: r.is_active, sort_order: r.sort_order });

@Injectable()
export class PaymentMethodsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** الكاشير يشوف الفعالة بس (للدفع)، والمالك والمدير يشوفون الكل مع المعطلة. */
  async list(actor: AuthUser, includeInactive: boolean, requestedBranch?: number) {
    const manage = can(actor.role, 'settings.receipt_and_methods');
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    const { rows } = await this.db.query(
      `select id, name_ar, name_en, kind, device_label, is_active, sort_order from payment_methods
        where branch_id = $1 and ($2::boolean and $3::boolean or is_active) order by sort_order, id`, [branchId, manage, includeInactive]);
    return rows.map(view);
  }

  async create(actor: AuthUser, dto: CreatePaymentMethodDto, ip: string | null) {
    const branchId = await resolveBranch(this.db, actor, dto.branch_id);
    try {
      return await this.db.tx(async (q) => {
        const max = await q.query(`select coalesce(max(sort_order), 0) + 1 as n from payment_methods where branch_id = $1`, [branchId]);
        const { rows } = await q.query(
          `insert into payment_methods (branch_id, name_ar, name_en, kind, device_label, sort_order) values ($1,$2,$3,'electronic',$4,$5)
           returning id, name_ar, name_en, kind, device_label, is_active, sort_order`,
          [branchId, dto.name_ar.trim(), dto.name_en?.trim() || null, dto.device_label.trim(), max.rows[0].n]);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'payment_method.create', entityType: 'payment_method', entityId: Number(rows[0].id), after: view(rows[0]), ip });
        return view(rows[0]);
      });
    } catch (e: any) { throw mapDup(e); }
  }

  async update(actor: AuthUser, id: number, dto: UpdatePaymentMethodDto, ip: string | null) {
    try {
      return await this.db.tx(async (q) => {
        const m = await this.load(q, actor, id);
        if (m.kind === 'cash') throw Errors.conflict('CASH_FIXED', 'طريقة الكاش ثابتة وما تنعدل');
        // الاسم يتغير والوصولات القديمة تحتفظ باسمها وقت الدفع (payment_tenders.method_name). النوع ما ينتغير.
        const { rows } = await q.query(
          `update payment_methods set name_ar = coalesce($2, name_ar), name_en = coalesce($3, name_en), device_label = coalesce($4, device_label)
            where id = $1 returning id, name_ar, name_en, kind, device_label, is_active, sort_order`,
          [id, dto.name_ar?.trim() ?? null, dto.name_en?.trim() ?? null, dto.device_label?.trim() ?? null]);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: m.branch_id, action: 'payment_method.update', entityType: 'payment_method', entityId: id, before: { name_ar: m.name_ar, device_label: m.device_label }, after: view(rows[0]), ip });
        return view(rows[0]);
      });
    } catch (e: any) { throw mapDup(e); }
  }

  /** التعطيل يوقف قبول الدفعات الجديدة فوراً. الشفت المفتوح يكمل تسويتها، والاسترجاع على دفعة قديمة يبقى ممكن. */
  async disable(actor: AuthUser, id: number, ip: string | null) {
    return this.db.tx(async (q) => {
      const m = await this.load(q, actor, id);
      if (m.kind === 'cash') throw Errors.conflict('CASH_FIXED', 'طريقة الكاش ما تتعطل');
      if (!m.is_active) return { ...view(m), warning: null };
      await q.query(`update payment_methods set is_active = false where id = $1`, [id]);
      // تنبيه للمدير: أكو شفت مفتوح انقبض بيه مبلغ بهذي الطريقة (لازم يطابقه عند التسليم)
      const open = await q.query(
        `select count(distinct s.id)::int as shifts, coalesce(sum(t.amount), 0)::bigint as collected
           from payment_tenders t join payments p on p.id = t.payment_id join shifts s on s.id = p.shift_id
          where t.method_id = $1 and s.status = 'open'`, [id]);
      const w = open.rows[0];
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: m.branch_id, action: 'payment_method.disable', entityType: 'payment_method', entityId: id, ip });
      return { ...view({ ...m, is_active: false }), warning: w.shifts > 0 ? { open_shifts: w.shifts, collected: Number(w.collected) } : null };
    });
  }

  async enable(actor: AuthUser, id: number, ip: string | null) {
    return this.db.tx(async (q) => {
      const m = await this.load(q, actor, id);
      if (!m.is_active) {
        await q.query(`update payment_methods set is_active = true where id = $1`, [id]);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: m.branch_id, action: 'payment_method.enable', entityType: 'payment_method', entityId: id, ip });
      }
      return view({ ...m, is_active: true });
    });
  }

  /** ترتيب الظهور عند الكاشير: تبديل مع الجار (فوق/تحت). */
  async move(actor: AuthUser, id: number, direction: 'up' | 'down', ip: string | null) {
    await this.db.tx(async (q) => {
      const m = await this.load(q, actor, id);
      await q.query(`select 1 from payment_methods where branch_id = $1 for update`, [m.branch_id]);
      const { rows } = await q.query(`select id, sort_order from payment_methods where branch_id = $1 order by sort_order, id`, [m.branch_id]);
      const i = rows.findIndex((r) => Number(r.id) === id);
      const j = direction === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= rows.length) return;
      // نعيد ترقيم كل القائمة 1..n حتى ما تبقى أرقام مكررة
      const order = rows.map((r) => Number(r.id));
      [order[i], order[j]] = [order[j], order[i]];
      for (let k = 0; k < order.length; k++) await q.query(`update payment_methods set sort_order = $2 where id = $1`, [order[k], k + 1]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: m.branch_id, action: 'payment_method.reorder', entityType: 'payment_method', entityId: id, reason: direction, ip });
    });
    return this.list(actor, true);
  }

  /** يجيب الطريقة بقفل. المدير يشوف فرعه بس (فرع ثاني → 404). */
  private async load(q: Queryable, actor: AuthUser, id: number): Promise<Method & { name_en: string | null }> {
    const { rows } = await q.query(`select * from payment_methods where id = $1 for update`, [id]);
    const m = rows[0];
    if (!m || (actor.role !== 'owner' && Number(m.branch_id) !== actor.branchId)) throw Errors.notFound('طريقة الدفع');
    return { ...m, id: Number(m.id), branch_id: Number(m.branch_id) };
  }
}

function mapDup(e: any) {
  if (e?.code === '23505') return Errors.conflict('PAYMENT_METHOD_EXISTS', 'طريقة الدفع بنفس الاسم والجهاز موجودة (حتى لو معطلة)');
  if (e?.code === '23514') return Errors.badRequest('INVALID_PAYMENT_METHOD', 'اسم الجهاز أو المصرف مطلوب للطرق الإلكترونية');
  return e;
}
