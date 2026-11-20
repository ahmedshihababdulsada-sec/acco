import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { can } from '../auth/permissions';
import { resolveBranch } from '../common/branch';
import { Errors, apiError } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { SETTINGS, SETTING_BY_KEY, validateSetting } from './settings.registry';

@Injectable()
export class SettingsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** القيمة الفعالة: إعداد الفرع ← الإعداد العام ← الافتراضي. تستخدمها بقية الوحدات (الحجز، الدفع، النقاط...). */
  async effective<T extends number | string | null>(q: Queryable, branchId: number, key: string): Promise<T> {
    const d = SETTING_BY_KEY.get(key);
    if (!d) throw new Error(`إعداد غير معروف: ${key}`);
    const { rows } = await q.query(
      `select value from settings where key = $2 and (branch_id = $1 or branch_id is null) order by branch_id nulls last limit 1`, [branchId, key]);
    return (rows.length ? rows[0].value : d.default) as T;
  }

  async list(actor: AuthUser, requestedBranch?: number) {
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    const { rows } = await this.db.query(
      `select s.key, s.value, s.version, s.updated_at, s.updated_by, u.full_name as updated_by_name
         from settings s left join users u on u.id = s.updated_by
        where s.branch_id = $1`, [branchId]);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return {
      branch_id: branchId,
      settings: SETTINGS.map((d) => {
        const r = byKey.get(d.key);
        return {
          key: d.key, label: d.label, type: d.type, value: r ? r.value : d.default, default: d.default,
          is_default: !r, version: r ? r.version : 0, can_edit: can(actor.role, d.permission),
          updated_at: r?.updated_at ?? null, updated_by_name: r?.updated_by_name ?? null,
        };
      }),
    };
  }

  /**
   * تغيير إعداد بقفل تفاؤلي: expected_version = 0 إذا ما انغيّر قبل، وإلا النسخة اللي شافها المستخدم.
   * إذا اختلفت (أحد غيّره قبله) يرفض 409 ويرجع القيمة الحالية للمقارنة، فما ينمسح تعديل بصمت.
   */
  async update(actor: AuthUser, key: string, value: unknown, expectedVersion: number, reason: string | undefined, requestedBranch: number | undefined, ip: string | null) {
    const d = SETTING_BY_KEY.get(key);
    if (!d) throw Errors.notFound('الإعداد');
    if (!can(actor.role, d.permission)) throw Errors.forbidden();
    if (value === undefined) throw Errors.badRequest('INVALID_SETTING', 'القيمة مطلوبة');
    const next = validateSetting(d, value);
    const branchId = await resolveBranch(this.db, actor, requestedBranch);

    return this.db.tx(async (q) => {
      if (key === 'receipt.logo_attachment_id' && next !== null) {
        const ok = (await q.query(`select 1 from attachments where id = $1 and kind = 'logo' and branch_id = $2 and deleted_at is null`, [next, branchId])).rows[0];
        if (!ok) throw Errors.badRequest('INVALID_LOGO', 'الشعار لازم يكون صورة شعار مرفوعة لنفس الفرع');
      }
      const cur = (await q.query(`select id, version, value from settings where branch_id = $1 and key = $2 for update`, [branchId, key])).rows[0];
      const curVersion = cur ? cur.version : 0;
      if (curVersion !== expectedVersion) {
        throw apiError(409, 'SETTING_CONFLICT', 'أحد غيّر هذا الإعداد قبلك. راجع القيمة الحالية');
      }
      let id: number; let version: number;
      if (!cur) {
        // الصف ما موجود فما أكو شي نقفله: لو إنسان ثاني أدرجه بنفس اللحظة، الإدراج يتجاهل ونعتبره تعارض (409) مو خطأ
        const ins = await q.query(`insert into settings (branch_id, key, value, version, updated_by) values ($1,$2,$3::jsonb,1,$4)
                                   on conflict do nothing returning id`, [branchId, key, JSON.stringify(next), actor.id]);
        if (!ins.rowCount) throw apiError(409, 'SETTING_CONFLICT', 'أحد غيّر هذا الإعداد قبلك. راجع القيمة الحالية');
        id = Number(ins.rows[0].id); version = 1;
      } else {
        id = Number(cur.id); version = curVersion + 1;
        await q.query(`update settings set value = $2::jsonb, version = $3, updated_by = $4, updated_at = now() where id = $1`,
          [id, JSON.stringify(next), version, actor.id]);
      }
      await q.query(`insert into setting_history (setting_id, version, value, changed_by, reason) values ($1,$2,$3::jsonb,$4,$5)`,
        [id, version, JSON.stringify(next), actor.id, reason ?? null]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'settings.update', entityType: 'setting', entityId: id,
        reason, before: cur ? { value: cur.value, version: cur.version } : { value: d.default, version: 0 }, after: { key, value: next, version }, ip });
      return { key, value: next, version };
    });
  }

  async history(actor: AuthUser, key: string, requestedBranch?: number) {
    if (!SETTING_BY_KEY.has(key)) throw Errors.notFound('الإعداد');
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    const { rows } = await this.db.query(
      `select h.version, h.value, h.reason, h.changed_at, u.full_name as changed_by_name
         from setting_history h join settings s on s.id = h.setting_id left join users u on u.id = h.changed_by
        where s.branch_id = $1 and s.key = $2 order by h.version desc limit 100`, [branchId, key]);
    return rows;
  }
}
