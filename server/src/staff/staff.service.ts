import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { StaffRole, can, permissionToManage } from '../auth/permissions';
import { Errors } from '../common/errors';
import { generateTempPassword, hashPassword } from '../common/passwords';
import { DbService, Queryable } from '../db/db.service';
import { CreateStaffDto } from './staff.dto';

interface Target { id: number; username: string; role: StaffRole; branch_id: number | null; is_active: boolean }

@Injectable()
export class StaffService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async create(actor: AuthUser, dto: CreateStaffDto, ip: string | null) {
    this.assertCanManage(actor, dto.role);

    let branchId: number;
    if (actor.role === 'manager') {
      if (dto.branch_id !== undefined && dto.branch_id !== actor.branchId) throw Errors.forbidden();
      branchId = actor.branchId!;
    } else {
      if (dto.branch_id === undefined) throw Errors.badRequest('BRANCH_REQUIRED', 'حدد الفرع');
      branchId = dto.branch_id;
    }

    const temp = generateTempPassword();
    const passwordHash = await hashPassword(temp);
    try {
      return await this.db.tx(async (q) => {
        const branch = await q.query(`select 1 from branches where id = $1 and is_active`, [branchId]);
        if (!branch.rowCount) throw Errors.badRequest('BRANCH_NOT_FOUND', 'الفرع غير موجود أو معطل');
        const { rows } = await q.query(
          `insert into users (username, password_hash, full_name, phone, role, branch_id, must_change_password, created_by)
           values ($1,$2,$3,$4,$5,$6,true,$7) returning id`,
          [dto.username, passwordHash, dto.full_name, dto.phone ?? null, dto.role, branchId, actor.id]);
        const id = Number(rows[0].id);
        if (dto.role === 'doctor') {
          await q.query(`insert into doctors (user_id, title, room) values ($1,$2,$3)`, [id, dto.title ?? null, dto.room ?? null]);
        }
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'staff.create', entityType: 'user', entityId: id, after: { username: dto.username, role: dto.role, branch_id: branchId }, ip });
        return { id, username: dto.username, role: dto.role, branch_id: branchId, temp_password: temp };
      });
    } catch (err: any) {
      if (err?.code === '23505') throw Errors.conflict('USERNAME_TAKEN', 'اسم المستخدم مستخدم من قبل');
      throw err;
    }
  }

  async list(actor: AuthUser) {
    const { rows } = await this.db.query(
      `select id, username, full_name, phone, role, branch_id, is_active, must_change_password, created_at
         from users where role <> 'owner' and ($1::bigint is null or branch_id = $1)
        order by branch_id, role, username`, [actor.role === 'manager' ? actor.branchId : null]);
    return rows.map((r) => ({ ...r, id: Number(r.id), branch_id: Number(r.branch_id) }));
  }

  async deactivate(actor: AuthUser, id: number, reason: string | undefined, ip: string | null) {
    if (id === actor.id) throw Errors.badRequest('CANNOT_DEACTIVATE_SELF', 'ما تقدر تعطل حسابك');
    await this.db.tx(async (q) => {
      const t = await this.loadTarget(q, actor, id);
      if (!t.is_active) return;
      await q.query(`update users set is_active = false, deactivated_at = now(), deactivated_by = $2 where id = $1`, [id, actor.id]);
      await q.query(`update refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null`, [id]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: t.branch_id, action: 'staff.deactivate', entityType: 'user', entityId: id, reason, ip });
    });
  }

  async reactivate(actor: AuthUser, id: number, reason: string | undefined, ip: string | null) {
    await this.db.tx(async (q) => {
      const t = await this.loadTarget(q, actor, id);
      if (t.is_active) return;
      await q.query(`update users set is_active = true, deactivated_at = null, deactivated_by = null, failed_logins = 0, locked_until = null where id = $1`, [id]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: t.branch_id, action: 'staff.reactivate', entityType: 'user', entityId: id, reason, ip });
    });
  }

  async resetPassword(actor: AuthUser, id: number, ip: string | null) {
    if (id === actor.id) throw Errors.badRequest('USE_CHANGE_PASSWORD', 'لتغيير رمزك استخدم «تغيير الرمز السري»');
    const temp = generateTempPassword();
    const passwordHash = await hashPassword(temp);
    await this.db.tx(async (q) => {
      const t = await this.loadTarget(q, actor, id);
      await q.query(`update users set password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = null where id = $1`, [id, passwordHash]);
      await q.query(`update refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null`, [id]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: t.branch_id, action: 'staff.reset_password', entityType: 'user', entityId: id, ip });
    });
    return { temp_password: temp };
  }

  /** يجيب الهدف بقفل، ويتأكد إنه ضمن نطاق الفاعل (فرع المدير) وإن دوره يقدر الفاعل يديره. */
  private async loadTarget(q: Queryable, actor: AuthUser, id: number): Promise<Target> {
    const { rows } = await q.query(`select id, username, role, branch_id, is_active from users where id = $1 for update`, [id]);
    const t = rows[0];
    // المدير ما يعرف بوجود حسابات فروع ثانية: يرجع «غير موجود» مو «ممنوع»
    if (!t || (actor.role === 'manager' && Number(t.branch_id) !== actor.branchId)) throw Errors.notFound('الموظف');
    this.assertCanManage(actor, t.role);
    return { ...t, id: Number(t.id), branch_id: t.branch_id === null ? null : Number(t.branch_id) };
  }

  private assertCanManage(actor: AuthUser, targetRole: StaffRole) {
    const perm = permissionToManage(targetRole);
    if (!perm || !can(actor.role, perm)) throw Errors.forbidden();
  }
}
