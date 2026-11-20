import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { Errors } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { consumeFifo, ConsumeLine, toMilli } from '../stock/consumption';
import { ExtraUsageDto, RevertConfirmationDto } from './nurse.dto';

interface SessionRow { id: number; branch_id: number; customer_id: number; status: string; visit_id: number | null; d: string | null; service_id: number; service_name: string; seq_no: number; completed_at: string | null; completed_by: number | null }

/**
 * تأكيد الممرض (القسم 4، 5 و، 7): «اكتملت» تخصم المواد FIFO وتثبت الإيراد وتطلب التقييم، والتراجع عن ضغطة غلط للمدير/المالك.
 * ترتيب الأقفال: الجلسة ← المواد (بترتيب id) ← دفعاتها. ما نقفل الزيارة لأننا ما نكتب عليها (قفل الجلسة يكفي ضد النقل والاسترجاع اللي يقفلون الزيارة ثم الجلسة).
 * قفل المادة قبل دفعاتها يمنع تشابك التأكيد والتراجع (اللي يمسون نفس الدفعات بترتيب مختلف).
 * الاسترجاع والتأكيد على نفس الجلسة يتسلسلون بقفلها: واحد بس ينجح.
 */
@Injectable()
export class NurseService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** قائمة الممرض: جلسات اليوم المدفوعة اللي تنتظر التنفيذ، ومعها التنبيه الصحي والمواد المخططة */
  async queue(actor: AuthUser, requestedBranch?: number) {
    const branchId = actor.role === 'owner' ? requestedBranch ?? null : actor.branchId;
    const { rows } = await this.db.query(
      `select s.id, s.seq_no, s.status, s.scheduled_date::text as d, s.customer_id, cu.full_name, cu.public_code, cu.gender, cu.birth_date::text as birth_date,
              sv.name_ar as service_name, i.sessions_count, v.seq_no as visit_seq, v.id as visit_id, h.id as health_id,
              h.allergies, h.pregnancy, h.chronic_conditions, h.medications, h.notes as health_notes,
              (h.id is not null and (coalesce(btrim(h.allergies),'') <> '' or h.pregnancy = 'yes' or coalesce(btrim(h.chronic_conditions),'') <> '' or coalesce(btrim(h.medications),'') <> '')) as has_health_alert
         from treatment_sessions s join customers cu on cu.id = s.customer_id join plan_items i on i.id = s.plan_item_id join services sv on sv.id = i.service_id
         join visits v on v.id = s.visit_id
         left join lateral (select * from customer_health where customer_id = cu.id order by id desc limit 1) h on true
        where s.status = 'paid' and s.scheduled_date = clinic_today() and v.status <> 'cancelled' and ($1::bigint is null or s.branch_id = $1)
        order by v.seq_no, s.id`, [branchId]);
    const ids = rows.map((r) => Number(r.id));
    const needs = ids.length ? (await this.db.query(
      `select n.treatment_session_id, n.material_id, m.name, m.base_unit, n.qty_base::float as qty from session_material_needs n join materials m on m.id = n.material_id
        where n.treatment_session_id = any($1::bigint[]) order by n.treatment_session_id, m.name`, [ids])).rows : [];
    return {
      date: (await this.db.query(`select clinic_today()::text as d`)).rows[0].d,
      sessions: rows.map((r) => ({
        session_id: Number(r.id), seq_no: r.seq_no, of: Number(r.sessions_count), service_name: r.service_name, visit_seq_no: Number(r.visit_seq),
        customer: { id: Number(r.customer_id), full_name: r.full_name, public_code: r.public_code, gender: r.gender, birth_date: r.birth_date },
        has_health_alert: r.has_health_alert,
        health: r.health_id === null ? null : { allergies: r.allergies, pregnancy: r.pregnancy, chronic_conditions: r.chronic_conditions, medications: r.medications, notes: r.health_notes },
        planned_materials: needs.filter((n) => Number(n.treatment_session_id) === Number(r.id)).map((n) => ({ material_id: Number(n.material_id), name: n.name, unit: n.base_unit, qty: Number(n.qty) })),
      })),
    };
  }

  /** «اكتملت»: paid → completed، خصم FIFO، وطلب التقييم. ما يمنع نقص المخزون (يصير سالب وينبّه المدير). */
  async complete(actor: AuthUser, id: number, ip: string | null) {
    return this.db.tx(async (q) => {
      const s = await this.lock(q, actor, id);
      if (s.status === 'completed') throw Errors.conflict('ALREADY_COMPLETED', 'الجلسة مؤكدة مسبقاً');
      if (s.status !== 'paid') throw Errors.conflict('NOT_PAID', 'الجلسة غير مدفوعة: ما تتأكد');
      const today = (await q.query(`select clinic_today()::text as d`)).rows[0].d;
      if (s.d !== today) throw Errors.conflictWith('NOT_TODAY', 'موعد الجلسة مو اليوم: الكاشير ينقلها أو يسترجعها', { scheduled_date: s.d });
      const needs = (await q.query(`select material_id, qty_base::text as qty from session_material_needs where treatment_session_id = $1 order by material_id`, [id])).rows;
      await this.lockMaterials(q, needs.map((n) => Number(n.material_id)));
      const consumed: { material_id: number; qty: string; lines: ConsumeLine[] }[] = [];
      for (const n of needs) consumed.push({ material_id: Number(n.material_id), qty: n.qty, lines: await consumeFifo(q, { branchId: s.branch_id, sessionId: id, materialId: Number(n.material_id), qtyMilli: toMilli(n.qty), actorId: actor.id }) });
      await q.query(`update treatment_sessions set status = 'completed', completed_at = now(), completed_by = $2, version = version + 1 where id = $1`, [id, actor.id]);
      const rated = (await q.query(`select 1 from session_ratings where session_id = $1`, [id])).rowCount;
      if (!rated)
        await q.query(`insert into notifications (customer_id, kind, title, body, data, treatment_session_id) values ($1,'rating_request','قيّم جلستك','شاركنا رأيك بجلستك اليوم',$2,$3)`, [s.customer_id, JSON.stringify({ session_id: id }), id]);
      const shortages = consumed.map((c) => ({ material_id: c.material_id, qty: c.lines.filter((l) => l.negative_stock).reduce((a, l) => a + toMilli(l.qty), 0n) })).filter((x) => x.qty > 0n)
        .map((x) => ({ material_id: x.material_id, qty: Number(x.qty) / 1000 }));
      const cost = consumed.reduce((a, c) => a + c.lines.reduce((b, l) => b + l.cost_amount, 0), 0);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: s.branch_id, action: 'session.complete', entityType: 'treatment_session', entityId: id, after: { cost, shortages }, ip });
      return { session_id: id, status: 'completed', cost_amount: cost, consumed: consumed.map((c) => ({ material_id: c.material_id, qty: Number(c.qty), cost_amount: c.lines.reduce((b, l) => b + l.cost_amount, 0) })), shortages };
    });
  }

  /** المدير يسجل الفرق إذا انصرف أكثر من المخطط (جلسة مكتملة): خصم FIFO إضافي على نفس الجلسة، وكلفتها النهائية تزيد */
  async recordExtraUsage(actor: AuthUser, id: number, dto: ExtraUsageDto, ip: string | null) {
    const reason = dto.reason.trim();
    if (reason.length < 3) throw Errors.badRequest('REASON_REQUIRED', 'اكتب سبب الاستهلاك الإضافي');
    const ids = dto.items.map((i) => i.material_id);
    if (new Set(ids).size !== ids.length) throw Errors.badRequest('DUPLICATE_MATERIAL', 'المادة مكررة');
    return this.db.tx(async (q) => {
      const s = await this.lock(q, actor, id);
      if (s.status !== 'completed') throw Errors.conflict('NOT_COMPLETED', 'الاستهلاك الإضافي للجلسة المكتملة بس');
      const sorted = [...dto.items].sort((a, b) => a.material_id - b.material_id);
      const mats = (await q.query(`select id, branch_id, is_active from materials where id = any($1::bigint[]) order by id for update`, [sorted.map((i) => i.material_id)])).rows;
      if (mats.length !== sorted.length || mats.some((m) => Number(m.branch_id) !== s.branch_id)) throw Errors.notFound('المادة');
      const consumed = [];
      for (const it of sorted) consumed.push({ material_id: it.material_id, qty: it.qty, lines: await consumeFifo(q, { branchId: s.branch_id, sessionId: id, materialId: it.material_id, qtyMilli: toMilli(it.qty), actorId: actor.id, note: `استهلاك إضافي: ${reason}` }) });
      const cost = consumed.reduce((a, c) => a + c.lines.reduce((b, l) => b + l.cost_amount, 0), 0);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: s.branch_id, action: 'session.extra_usage', entityType: 'treatment_session', entityId: id, reason,
        after: { items: sorted, cost }, ip });
      return { session_id: id, cost_amount: cost, consumed: consumed.map((c) => ({ material_id: c.material_id, qty: c.qty, cost_amount: c.lines.reduce((b, l) => b + l.cost_amount, 0), negative_stock: c.lines.some((l) => l.negative_stock) })) };
    });
  }

  /**
   * التراجع عن ضغطة غلط (والجلسة ما تنفذت): completed → paid بسبب إلزامي. المواد ترجع لنفس الدفعات بحركة عكس،
   * والإيراد ينعكس بتاريخ التصحيح (لقطة التأكيد الأصلي تنحفظ). المحجوز يرجع لأن الجلسة صارت مدفوعة. بعدها الاسترجاع ممكن.
   */
  async revert(actor: AuthUser, id: number, dto: RevertConfirmationDto, ip: string | null) {
    const reason = dto.reason.trim();
    if (reason.length < 3) throw Errors.badRequest('REASON_REQUIRED', 'اكتب سبب التراجع');
    return this.db.tx(async (q) => {
      const s = await this.lock(q, actor, id);
      if (s.status !== 'completed') throw Errors.conflict('NOT_COMPLETED', 'الجلسة مو مؤكدة');
      const moves = (await q.query(
        `select m.* from stock_movements m where m.treatment_session_id = $1 and m.movement_type = 'consume'
            and not exists (select 1 from stock_movements r where r.reverses_movement_id = m.id) order by m.id`, [id])).rows;
      await this.lockMaterials(q, moves.map((m) => Number(m.material_id)));
      const item = (await q.query(`select id from payment_items where session_id = $1 and status = 'paid' order by id desc limit 1`, [id])).rows[0];
      if (!item) throw Errors.conflict('NO_PAYMENT_ITEM', 'ما أكو بند وصل مدفوع لهذي الجلسة');
      const rv = (await q.query(
        `insert into confirmation_reverts (session_id, reverted_by, reason, original_completed_at, original_completed_by, payment_item_id) values ($1,$2,$3,$4,$5,$6) returning id, reverted_at`,
        [id, actor.id, reason, s.completed_at, s.completed_by, item.id])).rows[0];
      let returnedCost = 0;
      for (const m of moves) {
        await q.query(
          `insert into stock_movements (branch_id, material_id, batch_id, movement_type, qty_delta, unit_cost, cost_amount, treatment_session_id, reverses_movement_id, note, created_by)
           values ($1,$2,$3,'consume_reversal',-$4::numeric,$5,-$6::bigint,$7,$8,$9,$10)`,
          [m.branch_id, m.material_id, m.batch_id, m.qty_delta, m.unit_cost, m.cost_amount, id, m.id, `تراجع عن تأكيد: ${reason}`, actor.id]);
        returnedCost += -Number(m.cost_amount);
      }
      await q.query(`update treatment_sessions set status = 'paid', completed_at = null, completed_by = null, version = version + 1 where id = $1`, [id]);
      await q.query(`update notifications set status = 'cancelled' where treatment_session_id = $1 and kind = 'rating_request' and status = 'pending'`, [id]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: s.branch_id, action: 'session.revert_confirmation', entityType: 'treatment_session', entityId: id, reason,
        before: { status: 'completed', completed_at: s.completed_at, completed_by: s.completed_by }, after: { status: 'paid', returned_cost: returnedCost, movements: moves.length }, ip });
      return { session_id: id, status: 'paid', revert_id: Number(rv.id), reverted_at: rv.reverted_at, returned_cost: returnedCost, returned_movements: moves.length };
    });
  }

  // ================================================================ داخلي
  private async lockMaterials(q: Queryable, ids: number[]) {
    const u = [...new Set(ids)].sort((a, b) => a - b);
    if (u.length) await q.query(`select 1 from materials where id = any($1::bigint[]) order by id for update`, [u]);
  }

  private async lock(q: Queryable, actor: AuthUser, id: number): Promise<SessionRow> {
    const h = (await q.query(`select visit_id, branch_id from treatment_sessions where id = $1`, [id])).rows[0];
    if (!h || (actor.role !== 'owner' && Number(h.branch_id) !== actor.branchId)) throw Errors.notFound('الجلسة');
    const r = (await q.query(
      `select s.id, s.branch_id, s.customer_id, s.status, s.visit_id, s.scheduled_date::text as d, s.seq_no, s.completed_at, s.completed_by, i.service_id, sv.name_ar as service_name
         from treatment_sessions s join plan_items i on i.id = s.plan_item_id join services sv on sv.id = i.service_id where s.id = $1 for update of s`, [id])).rows[0];
    return { id: Number(r.id), branch_id: Number(r.branch_id), customer_id: Number(r.customer_id), status: r.status, visit_id: r.visit_id === null ? null : Number(r.visit_id), d: r.d,
      service_id: Number(r.service_id), service_name: r.service_name, seq_no: r.seq_no, completed_at: r.completed_at, completed_by: r.completed_by === null ? null : Number(r.completed_by) };
  }
}
