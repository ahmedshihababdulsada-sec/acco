import { Injectable } from '@nestjs/common';
import { Queryable } from '../db/db.service';

export interface AuditEntry {
  actorUserId?: number | null;
  actorRole?: string | null;
  branchId?: number | null;
  action: string;
  entityType?: string;
  entityId?: number;
  reason?: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

/** سجل الحركات: إضافة فقط (trigger بالقاعدة يمنع التعديل والحذف). لازم يُكتب بنفس معاملة العملية. */
@Injectable()
export class AuditService {
  async log(q: Queryable, e: AuditEntry): Promise<void> {
    await q.query(
      `insert into audit_log (branch_id, actor_user_id, actor_role, action, entity_type, entity_id, reason, before_values, after_values, ip)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::inet)`,
      [
        e.branchId ?? null, e.actorUserId ?? null, e.actorRole ?? null, e.action,
        e.entityType ?? null, e.entityId ?? null, e.reason ?? null,
        e.before === undefined ? null : JSON.stringify(e.before),
        e.after === undefined ? null : JSON.stringify(e.after),
        normalizeIp(e.ip),
      ],
    );
  }
}

function normalizeIp(ip?: string | null): string | null {
  if (!ip) return null;
  const v = ip.replace(/^::ffff:/, '');
  return /^[0-9a-fA-F:.]+$/.test(v) ? v : null;
}
