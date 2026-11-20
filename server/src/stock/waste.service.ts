import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { resolveBranch } from '../common/branch';
import { Errors } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { assertDate } from '../schedule/schedule.service';
import { CreateWasteDto } from './stock.dto';

/** رصيد المادة الصالح (غير المنتهي) والمحجوز لجلسات مدفوعة. المحجوز ما يتشال بتالف ولا جرد ولا مرتجع. */
export async function validAndReserved(q: Queryable, materialId: number): Promise<{ valid: number; reserved: number }> {
  const r = (await q.query(
    `select coalesce((select sum(qty_on_hand) from material_batches where material_id = $1 and expiry_date >= clinic_today()), 0)::float as valid,
            coalesce((select sum(n.qty_base) from session_material_needs n join treatment_sessions s on s.id = n.treatment_session_id and s.status = 'paid' where n.material_id = $1), 0)::float as reserved`, [materialId])).rows[0];
  return { valid: Number(r.valid), reserved: Number(r.reserved) };
}

/**
 * التالف (القسم 7): يسجله المدير يدوياً. الدفعة المنتهية تنسجل كلها، وغير المنتهي ما ياخذ كمية محجوزة لجلسات مدفوعة.
 * كلفة التالف = الكمية × كلفة الدفعة، وتنخصم من الربح بيوم تسجيله (خارج الجرد).
 * ترتيب الأقفال: المادة ← الدفعة.
 */
@Injectable()
export class WasteService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async create(actor: AuthUser, dto: CreateWasteDto, ip: string | null) {
    const note = dto.note?.trim() || null;
    if (dto.reason === 'other' && !note) throw Errors.badRequest('NOTE_REQUIRED', 'السبب «أخرى» يحتاج ملاحظة');
    return this.db.tx(async (q) => {
      const head = (await q.query(`select material_id, branch_id from material_batches where id = $1`, [dto.batch_id])).rows[0];
      if (!head || (actor.role !== 'owner' && Number(head.branch_id) !== actor.branchId)) throw Errors.notFound('الدفعة');
      await q.query(`select 1 from materials where id = $1 for update`, [head.material_id]);
      const b = (await q.query(`select *, (expiry_date < clinic_today()) as expired from material_batches where id = $1 for update`, [dto.batch_id])).rows[0];
      const qty = dto.qty;
      if (qty > Number(b.qty_on_hand)) throw Errors.conflictWith('WASTE_EXCEEDS_BATCH', 'الكمية أكبر من المتبقي بالدفعة', { available: Number(b.qty_on_hand), requested: qty });
      if (b.expired) {
        if (Math.abs(qty - Number(b.qty_on_hand)) > 0.0005) throw Errors.conflictWith('EXPIRED_FULL_ONLY', 'الدفعة المنتهية تنسجل تالف كلها', { available: Number(b.qty_on_hand), requested: qty });
      } else {
        const { valid, reserved } = await validAndReserved(q, Number(b.material_id));
        if (valid - reserved < qty - 0.0005) throw Errors.conflictWith('WASTE_RESERVED', 'الكمية تدخل بالمحجوز لجلسات مدفوعة', { available_to_waste: Math.max(valid - reserved, 0), reserved, requested: qty });
      }
      const cost = Number((await q.query(`select round($1::numeric * $2::numeric)::bigint as v`, [String(qty), b.unit_cost])).rows[0].v);
      const w = (await q.query(
        `insert into stock_waste (branch_id, material_id, batch_id, qty, reason, note, cost_amount, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [b.branch_id, b.material_id, b.id, String(qty), dto.reason, note, cost, actor.id])).rows[0];
      const id = Number(w.id);
      await q.query(`insert into stock_movements (branch_id, material_id, batch_id, movement_type, qty_delta, unit_cost, cost_amount, waste_id, note, created_by) values ($1,$2,$3,'waste',$4,$5,$6,$7,$8,$9)`,
        [b.branch_id, b.material_id, b.id, `-${qty}`, b.unit_cost, -cost, id, note, actor.id]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(b.branch_id), action: 'stock.waste', entityType: 'stock_waste', entityId: id, reason: note ?? undefined,
        after: { batch_id: b.id, material_id: Number(b.material_id), qty, reason: dto.reason, cost }, ip });
      return this.viewQ(q, id);
    });
  }

  async list(actor: AuthUser, p: { month?: string; from?: string; to?: string; materialId?: number; branchId?: number }) {
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
    const { rows } = await this.db.query(`select id from stock_waste where branch_id = $1 and wasted_on between $2 and $3 and ($4::bigint is null or material_id = $4) order by wasted_on desc, id desc limit 500`, [branchId, from, to, p.materialId ?? null]);
    const tot = await this.db.query(`select reason, sum(cost_amount)::bigint as cost, count(*)::int as n from stock_waste where branch_id = $1 and wasted_on between $2 and $3 and ($4::bigint is null or material_id = $4) group by reason`, [branchId, from, to, p.materialId ?? null]);
    return {
      branch_id: branchId, from, to, waste: await Promise.all(rows.map((r) => this.viewQ(this.db, Number(r.id)))),
      total_cost: tot.rows.reduce((a, r) => a + Number(r.cost), 0), by_reason: tot.rows.map((r) => ({ reason: r.reason, cost: Number(r.cost), count: r.n })),
    };
  }

  private async viewQ(q: Queryable, id: number) {
    const w = (await q.query(`select w.*, w.wasted_on::text as date_text, m.name as material_name, m.base_unit, u.full_name as by_name, b.expiry_date::text as batch_expiry from stock_waste w join materials m on m.id = w.material_id join users u on u.id = w.created_by join material_batches b on b.id = w.batch_id where w.id = $1`, [id])).rows[0];
    if (!w) return null;
    return { id: Number(w.id), branch_id: Number(w.branch_id), material: { id: Number(w.material_id), name: w.material_name, unit: w.base_unit }, batch_id: Number(w.batch_id), batch_expiry: w.batch_expiry,
      qty: Number(w.qty), reason: w.reason, note: w.note, cost_amount: Number(w.cost_amount), wasted_on: w.date_text as string, by: w.by_name };
  }
}
