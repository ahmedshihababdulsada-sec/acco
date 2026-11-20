import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { resolveBranch } from '../common/branch';
import { Errors } from '../common/errors';
import { mapSafeError } from '../common/safe-errors';
import { DbService } from '../db/db.service';
import { assertDate } from '../schedule/schedule.service';
import { CreateCompensationDto } from './compensations.dto';

/**
 * تعويض الزبون (القسم 5 و): الجلسة تنفذت فعلاً ما يصير تراجع ولا استرجاع، وأي تعويض يقرره **المالك** كمبلغ مستقل وبسبب مكتوب.
 * المواد ما ترجع. يطلع من الخزنة (ما يتجاوز رصيدها) أو إلكتروني بمصرف، وينخصم من ربح الإدارة بتاريخ تسجيله، وبسجل الحركات.
 */
@Injectable()
export class CompensationsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async create(actor: AuthUser, dto: CreateCompensationDto, ip: string | null) {
    const reason = dto.reason.trim();
    if (reason.length < 3) throw Errors.badRequest('REASON_REQUIRED', 'اكتب سبب التعويض');
    const bank = dto.bank_name?.trim() || null;
    if (dto.pay_source === 'electronic' && !bank) throw Errors.badRequest('BANK_REQUIRED', 'اكتب اسم المصرف');
    if (dto.pay_source === 'safe' && bank) throw Errors.badRequest('BANK_NOT_ALLOWED', 'اسم المصرف للدفع الإلكتروني بس');
    let branchId = 0;
    try {
      return await this.db.tx(async (q) => {
        const s = (await q.query(`select id, branch_id, customer_id, status from treatment_sessions where id = $1 for update`, [dto.session_id])).rows[0];
        if (!s) throw Errors.notFound('الجلسة');
        branchId = Number(s.branch_id);
        if (s.status !== 'completed') throw Errors.conflict('NOT_COMPLETED', 'التعويض للجلسة المنفذة (المؤكدة) بس. غيرها يتعالج بالاسترجاع');
        const c = (await q.query(
          `insert into compensations (branch_id, customer_id, session_id, amount, reason, pay_source, bank_name, decided_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
          [branchId, s.customer_id, s.id, dto.amount, reason, dto.pay_source, bank, actor.id])).rows[0];
        const id = Number(c.id);
        if (dto.pay_source === 'safe')
          await q.query(`insert into safe_movements (branch_id, direction, amount, kind, compensation_id, note, created_by) values ($1,'out',$2,'compensation',$3,'تعويض زبون',$4)`, [branchId, dto.amount, id, actor.id]);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'compensation.create', entityType: 'compensation', entityId: id, reason,
          after: { session_id: dto.session_id, customer_id: Number(s.customer_id), amount: dto.amount, pay_source: dto.pay_source }, ip });
        return this.viewQ(q, id);
      });
    } catch (e) { return mapSafeError(e, this.db, branchId, dto.amount); }
  }

  async list(actor: AuthUser, p: { branchId?: number; from?: string; to?: string }) {
    if (p.from) assertDate(p.from, 'من'); if (p.to) assertDate(p.to, 'إلى');
    const branchId = await resolveBranch(this.db, actor, p.branchId);
    const { rows } = await this.db.query(
      `select id from compensations where branch_id = $1 and ($2::date is null or created_at::date >= $2) and ($3::date is null or created_at::date <= $3) order by id desc limit 300`, [branchId, p.from ?? null, p.to ?? null]);
    const items = []; for (const r of rows) items.push(await this.viewQ(this.db, Number(r.id)));
    return { compensations: items, total: items.reduce((a, i) => a + i.amount, 0) };
  }

  private async viewQ(q: { query: DbService['query'] }, id: number) {
    const r = (await q.query(
      `select c.*, cu.full_name, cu.public_code, sv.name_ar as service_name, u.full_name as decider from compensations c join customers cu on cu.id = c.customer_id join treatment_sessions s on s.id = c.session_id
         join plan_items i on i.id = s.plan_item_id join services sv on sv.id = i.service_id join users u on u.id = c.decided_by where c.id = $1`, [id])).rows[0];
    return { id: Number(r.id), branch_id: Number(r.branch_id), amount: Number(r.amount), reason: r.reason as string, pay_source: r.pay_source as string, bank_name: r.bank_name as string | null,
      customer: { id: Number(r.customer_id), full_name: r.full_name as string, public_code: r.public_code as string }, session: { id: Number(r.session_id), service_name: r.service_name as string },
      decided_by: { id: Number(r.decided_by), name: r.decider as string }, created_at: r.created_at };
  }
}
