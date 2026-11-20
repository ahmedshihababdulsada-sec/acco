import { Queryable } from '../db/db.service';

/** كميات المواد numeric(14,3): نشتغل بالألف (BigInt) حتى ما ندخل أخطاء الفاصلة العائمة بالخصم */
export const toMilli = (v: string | number): bigint => {
  const [i, f = ''] = String(v).split('.');
  const neg = i.startsWith('-');
  const n = BigInt(i.replace('-', '') || '0') * 1000n + BigInt((f + '000').slice(0, 3));
  return neg ? -n : n;
};
export const fromMilli = (n: bigint): string => `${n < 0n ? '-' : ''}${(n < 0n ? -n : n) / 1000n}.${String((n < 0n ? -n : n) % 1000n).padStart(3, '0')}`;

export interface ConsumeLine { batch_id: number | null; qty: string; unit_cost: string; cost_amount: number; negative_stock: boolean }

/**
 * خصم FIFO لمادة واحدة (القسم 7): من الدفعات غير المنتهية بترتيب أقرب انتهاء، والكلفة من الدفعة اللي انصرفت فعلاً.
 * إذا ما تكفي: ما نمنع. الباقي يتسجل بحركة بدون دفعة (المخزون يصير سالب) بآخر سعر شراء، وتطلع بتنبيهات المدير.
 * لازم المادة تكون مقفولة (FOR UPDATE) من المستدعي، وبترتيب id لما أكثر من مادة.
 */
export async function consumeFifo(q: Queryable, p: { branchId: number; sessionId: number; materialId: number; qtyMilli: bigint; actorId: number; note?: string | null }): Promise<ConsumeLine[]> {
  const out: ConsumeLine[] = [];
  let remaining = p.qtyMilli;
  const batches = (await q.query(
    `select id, qty_on_hand::text as qty, unit_cost::text as unit_cost from material_batches
      where material_id = $1 and qty_on_hand > 0 and expiry_date >= clinic_today() order by expiry_date, id for update`, [p.materialId])).rows;
  const insert = async (batchId: number | null, qtyMilli: bigint, unitCost: string): Promise<void> => {
    const qty = fromMilli(qtyMilli);
    const r = (await q.query(
      `insert into stock_movements (branch_id, material_id, batch_id, movement_type, qty_delta, unit_cost, cost_amount, treatment_session_id, note, created_by)
       values ($1,$2,$3,'consume',-$4::numeric,$5::numeric,-round($4::numeric * $5::numeric)::bigint,$6,$7,$8) returning cost_amount::bigint as c`,
      [p.branchId, p.materialId, batchId, qty, unitCost, p.sessionId, p.note ?? null, p.actorId])).rows[0];
    out.push({ batch_id: batchId, qty, unit_cost: unitCost, cost_amount: -Number(r.c), negative_stock: batchId === null });
  };
  for (const b of batches) {
    if (remaining <= 0n) break;
    const have = toMilli(b.qty);
    const take = have < remaining ? have : remaining;
    await insert(Number(b.id), take, b.unit_cost);
    remaining -= take;
  }
  if (remaining > 0n) {
    const m = (await q.query(`select coalesce(last_unit_cost, 0)::text as c from materials where id = $1`, [p.materialId])).rows[0];
    await insert(null, remaining, m.c);
  }
  return out;
}
