import { Injectable } from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { resolveBranch } from '../common/branch';
import { DbService } from '../db/db.service';

/** تنبيهات المخزون للمدير: قليل (على المتاح)، ينتهي قريب، دفعة منتهية، مادة سالبة. */
@Injectable()
export class AlertsService {
  constructor(private readonly db: DbService) {}

  async get(actor: AuthUser, requestedBranch?: number) {
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    const days = Number((await this.db.query(`select setting_int($1, 'stock.near_expiry_days', 30) as d`, [branchId])).rows[0].d);
    const low = (await this.db.query(
      `select v.material_id, v.name, v.base_unit, v.available, v.on_hand, v.reserved, v.low_threshold from v_material_stock v join materials m on m.id = v.material_id
        where v.branch_id = $1 and m.is_active and v.is_low and not v.is_negative order by v.name`, [branchId])).rows;
    const negative = (await this.db.query(`select v.material_id, v.name, v.base_unit, v.on_hand from v_material_stock v join materials m on m.id = v.material_id where v.branch_id = $1 and m.is_active and v.is_negative order by v.name`, [branchId])).rows;
    const batches = (await this.db.query(
      `select b.id, b.material_id, m.name, m.base_unit, b.expiry_date::text as expiry_date, b.qty_on_hand, b.unit_cost, (b.expiry_date < clinic_today()) as expired
         from material_batches b join materials m on m.id = b.material_id where b.branch_id = $1 and b.qty_on_hand > 0 and b.expiry_date <= clinic_today() + $2::int order by b.expiry_date, b.id`, [branchId, days])).rows;
    const mapB = (r: any) => ({ batch_id: Number(r.id), material: { id: Number(r.material_id), name: r.name, unit: r.base_unit }, expiry_date: r.expiry_date, qty_on_hand: Number(r.qty_on_hand), value: Math.round(Number(r.qty_on_hand) * Number(r.unit_cost)) });
    const expired = batches.filter((b) => b.expired).map(mapB);
    const near = batches.filter((b) => !b.expired).map(mapB);
    return {
      branch_id: branchId, near_expiry_days: days,
      low: low.map((r) => ({ material: { id: Number(r.material_id), name: r.name, unit: r.base_unit }, available: Number(r.available), on_hand: Number(r.on_hand), reserved: Number(r.reserved), threshold: Number(r.low_threshold) })),
      near_expiry: near, expired,
      negative: negative.map((r) => ({ material: { id: Number(r.material_id), name: r.name, unit: r.base_unit }, on_hand: Number(r.on_hand) })),
      counts: { low: low.length, near_expiry: near.length, expired: expired.length, negative: negative.length, total: low.length + near.length + expired.length + negative.length },
    };
  }
}
