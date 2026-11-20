import { Errors } from './errors';
import { Queryable } from '../db/db.service';

/** فشل CHECK رصيد الخزنة (الدفع فوق الرصيد) → 409 برصيد الخزنة الحالي، وغيره يرجع كما هو. */
export async function mapSafeError(e: any, q: Queryable, branchId: number, requested: number): Promise<never> {
  if (e?.code === '23514' && e.constraint === 'safes_balance_check') {
    const bal = (await q.query(`select balance from safes where branch_id = $1`, [branchId])).rows[0]?.balance ?? 0;
    throw Errors.conflictWith('SAFE_INSUFFICIENT', 'رصيد الخزنة ما يكفي', { safe_balance: Number(bal), requested });
  }
  throw e;
}
