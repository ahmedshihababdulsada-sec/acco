import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { resolveBranch } from '../common/branch';
import { Errors } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { mapSafeError } from '../common/safe-errors';
import { assertDate } from '../schedule/schedule.service';
import { DecideWithdrawalDto, OpeningBalanceDto, WithdrawalDto } from './shifts.dto';

@Injectable()
export class SafeService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** رصيد الخزنة وآخر حركاتها (الأحدث أول). المدير والمالك. */
  async get(actor: AuthUser, requestedBranch: number | undefined, limit = 100) {
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    const bal = (await this.db.query(`select balance from safes where branch_id = $1`, [branchId])).rows[0];
    const lim = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
    const { rows } = await this.db.query(
      `select m.id, m.direction, m.amount, m.kind, m.shift_id, m.note, m.occurred_at, m.business_date::text as business_date, u.full_name as by_name
         from safe_movements m join users u on u.id = m.created_by where m.branch_id = $1 order by m.id desc limit $2`, [branchId, lim]);
    return {
      branch_id: branchId, balance: bal ? Number(bal.balance) : 0,
      movements: rows.map((r) => ({ id: Number(r.id), direction: r.direction, amount: Number(r.amount), kind: r.kind, shift_id: r.shift_id === null ? null : Number(r.shift_id), note: r.note, occurred_at: r.occurred_at, business_date: r.business_date, by: r.by_name })),
    };
  }

  /** الرصيد الافتتاحي: المالك بس ومرة وحدة لكل فرع (رأس مال الخزنة عند بداية النظام). */
  async setOpening(actor: AuthUser, dto: OpeningBalanceDto, ip: string | null) {
    const branchId = await resolveBranch(this.db, actor, dto.branch_id);
    return this.db.tx(async (q) => {
      await q.query(`insert into safes (branch_id) values ($1) on conflict do nothing`, [branchId]);
      await q.query(`select 1 from safes where branch_id = $1 for update`, [branchId]);
      const dup = await q.query(`select 1 from safe_movements where branch_id = $1 and kind = 'opening_balance'`, [branchId]);
      if (dup.rowCount) throw Errors.conflict('OPENING_ALREADY_SET', 'الرصيد الافتتاحي انسجل مسبقاً');
      const m = (await q.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',$2,'opening_balance',$3,$4) returning id`, [branchId, dto.amount, dto.note?.trim() || 'رصيد افتتاحي', actor.id])).rows[0];
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'safe.opening_balance', entityType: 'safe_movement', entityId: Number(m.id), after: { amount: dto.amount }, ip });
      const bal = Number((await q.query(`select balance from safes where branch_id = $1`, [branchId])).rows[0].balance);
      return { branch_id: branchId, balance: bal, movement_id: Number(m.id) };
    });
  }

  // ================================================================ سحب المالك (القسم 12 و، 9)
  /** المدير يسجل السحب (بانتظار موافقة المالك). ما ينقص الخزنة لحد الموافقة، وما ينحسب مصروف. */
  async recordWithdrawal(actor: AuthUser, dto: WithdrawalDto, ip: string | null) {
    assertDate(dto.withdrawal_date, 'تاريخ السحب');
    const name = dto.withdrawn_by_name.replace(/\s+/g, ' ').trim();
    if (name.length < 2) throw Errors.badRequest('INVALID_NAME', 'اكتب باسم منو انسحب');
    const branchId = actor.branchId!;                                         // المدير بس، وفرعه
    return this.db.tx(async (q) => {
      const today = (await q.query(`select clinic_today()::text as d`)).rows[0].d;
      if (dto.withdrawal_date > today) throw Errors.badRequest('FUTURE_DATE', 'تاريخ السحب ما يكون بالمستقبل');
      const { rows } = await q.query(`insert into owner_withdrawals (branch_id, amount, withdrawn_by_name, withdrawal_date, note, recorded_by) values ($1,$2,$3,$4,$5,$6) returning id`,
        [branchId, dto.amount, name, dto.withdrawal_date, dto.note?.trim() || null, actor.id]);
      const id = Number(rows[0].id);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'withdrawal.record', entityType: 'owner_withdrawal', entityId: id, after: { amount: dto.amount, withdrawn_by_name: name, date: dto.withdrawal_date }, ip });
      return this.withdrawalQ(q, id);
    });
  }

  async listWithdrawals(actor: AuthUser, status: string | undefined, requestedBranch?: number) {
    if (status && !['pending', 'approved', 'rejected', 'cancelled'].includes(status)) throw Errors.badRequest('INVALID_STATUS', 'حالة غير معروفة');
    const branchId = actor.role === 'owner' ? requestedBranch ?? null : actor.branchId;
    const { rows } = await this.db.query(`select id from owner_withdrawals where ($1::bigint is null or branch_id = $1) and ($2::text is null or status = $2) order by id desc limit 200`, [branchId, status ?? null]);
    return Promise.all(rows.map((r) => this.withdrawalQ(this.db, Number(r.id))));
  }

  /** موافقة المالك: وقتها بس تنسجل حركة الخزنة (تفشل إذا المبلغ أكبر من الرصيد وتبقى معلقة). */
  async approveWithdrawal(actor: AuthUser, id: number, dto: DecideWithdrawalDto, ip: string | null) {
    let branchId = 0; let amount = 0;
    try {
      return await this.db.tx(async (q) => {
        const w = (await q.query(`select * from owner_withdrawals where id = $1 for update`, [id])).rows[0];
        if (!w) throw Errors.notFound('السحب');
        branchId = Number(w.branch_id); amount = Number(w.amount);
        if (w.status !== 'pending') throw Errors.conflict('ALREADY_DECIDED', w.status === 'approved' ? 'السحب موافق عليه مسبقاً' : w.status === 'cancelled' ? 'السحب انلغى' : 'السحب مرفوض مسبقاً');
        await q.query(`insert into safes (branch_id) values ($1) on conflict do nothing`, [branchId]);
        await q.query(`insert into safe_movements (branch_id, direction, amount, kind, owner_withdrawal_id, note, created_by) values ($1,'out',$2,'owner_withdrawal',$3,$4,$5)`, [branchId, amount, id, `سحب المالك: ${w.withdrawn_by_name}`, actor.id]);
        await q.query(`update owner_withdrawals set status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3 where id = $1`, [id, actor.id, dto.note?.trim() || null]);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'withdrawal.approve', entityType: 'owner_withdrawal', entityId: id, after: { amount }, ip });
        return this.withdrawalQ(q, id);
      });
    } catch (e) {
      return mapSafeError(e, this.db, branchId, amount);
    }
  }

  async rejectWithdrawal(actor: AuthUser, id: number, dto: DecideWithdrawalDto, ip: string | null) {
    return this.db.tx(async (q) => {
      const w = (await q.query(`select * from owner_withdrawals where id = $1 for update`, [id])).rows[0];
      if (!w) throw Errors.notFound('السحب');
      if (w.status !== 'pending') throw Errors.conflict('ALREADY_DECIDED', w.status === 'approved' ? 'السحب موافق عليه مسبقاً' : w.status === 'cancelled' ? 'السحب انلغى' : 'السحب مرفوض مسبقاً');
      await q.query(`update owner_withdrawals set status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 where id = $1`, [id, actor.id, dto.note?.trim() || null]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(w.branch_id), action: 'withdrawal.reject', entityType: 'owner_withdrawal', entityId: id, reason: dto.note?.trim() || undefined, ip });
      return this.withdrawalQ(q, id);
    });
  }

  /** المدير يلغي طلبه (هو اللي سجله) قبل قرار المالك. ما يمس الخزنة لأنها ما نقصت. */
  async cancelWithdrawal(actor: AuthUser, id: number, dto: DecideWithdrawalDto, ip: string | null) {
    return this.db.tx(async (q) => {
      const w = (await q.query(`select * from owner_withdrawals where id = $1 for update`, [id])).rows[0];
      if (!w || Number(w.recorded_by) !== actor.id) throw Errors.notFound('السحب');
      if (w.status !== 'pending') throw Errors.conflict('ALREADY_DECIDED', w.status === 'approved' ? 'السحب موافق عليه مسبقاً' : w.status === 'cancelled' ? 'السحب انلغى مسبقاً' : 'السحب مرفوض مسبقاً');
      await q.query(`update owner_withdrawals set status = 'cancelled', decided_by = $2, decided_at = now(), decision_note = $3 where id = $1`, [id, actor.id, dto.note?.trim() || null]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(w.branch_id), action: 'withdrawal.cancel', entityType: 'owner_withdrawal', entityId: id, reason: dto.note?.trim() || undefined, ip });
      return this.withdrawalQ(q, id);
    });
  }

  private async withdrawalQ(q: Queryable, id: number) {
    const w = (await q.query(
      `select w.*, w.withdrawal_date::text as date_text, r.full_name as recorded_name, d.full_name as decided_name from owner_withdrawals w
         join users r on r.id = w.recorded_by left join users d on d.id = w.decided_by where w.id = $1`, [id])).rows[0];
    if (!w) return null;
    return { id: Number(w.id), branch_id: Number(w.branch_id), amount: Number(w.amount), withdrawn_by_name: w.withdrawn_by_name, withdrawal_date: w.date_text as string, note: w.note, status: w.status,
      recorded_by: { id: Number(w.recorded_by), full_name: w.recorded_name }, recorded_at: w.recorded_at,
      decided_by: w.decided_by === null ? null : { id: Number(w.decided_by), full_name: w.decided_name }, decided_at: w.decided_at, decision_note: w.decision_note };
  }
}
