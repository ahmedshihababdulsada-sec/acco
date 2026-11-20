import { AuthUser } from '../auth/auth.types';
import { Errors } from './errors';
import { Queryable } from '../db/db.service';

/**
 * يحدد الفرع اللي تنطبق عليه العملية: غير المالك دائماً فرعه (وإذا طلب فرع ثاني → 403)،
 * والمالك يحدد الفرع، ولو ما حدد وكان أكو فرع فعال وحيد ينعتمد.
 */
export async function resolveBranch(q: Queryable, actor: AuthUser, requested?: number): Promise<number> {
  if (actor.role !== 'owner') {
    if (requested !== undefined && requested !== actor.branchId) throw Errors.forbidden();
    return actor.branchId!;
  }
  if (requested !== undefined) {
    const ok = await q.query(`select 1 from branches where id = $1 and is_active`, [requested]);
    if (!ok.rowCount) throw Errors.badRequest('BRANCH_NOT_FOUND', 'الفرع غير موجود أو معطل');
    return requested;
  }
  const { rows } = await q.query(`select id from branches where is_active`);
  if (rows.length !== 1) throw Errors.badRequest('BRANCH_REQUIRED', 'حدد الفرع');
  return Number(rows[0].id);
}
