import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { resolveBranch } from '../common/branch';
import { Errors } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { assertDate } from '../schedule/schedule.service';
import { CountLineDto, CreateCountDto } from './stock.dto';
import { validAndReserved } from './waste.service';

const EPS = 0.0005;

/**
 * الجرد (القسم 7): لكل دفعة صالحة. الخانة اللي ما انذكرت ما تتغير، وأي فرق يحتاج ملاحظة، والكمية ما تنزل تحت المحجوز،
 * والدفعات المنتهية ما تنجرد (تنسجل تالف). الزيادة تنضاف لنفس الدفعة بكلفتها. المادة السالبة تتصحح بدفعة جديدة.
 * فروقات الجرد تنسجل منفصلة عن التالف (count_adjust) وخارج معادلة الربح.
 * ترتيب الأقفال: المواد (بترتيب المعرّف) ← الدفعات (بترتيب المعرّف).
 */
@Injectable()
export class CountsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** ورقة الجرد: الدفعات الصالحة بكمية النظام، والمواد السالبة، وعدد الدفعات المنتهية (تروح للتالف). */
  async sheet(actor: AuthUser, requestedBranch?: number) {
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    const batches = (await this.db.query(
      `select b.id, b.material_id, m.name, m.base_unit, b.expiry_date::text as expiry_date, b.qty_on_hand, b.unit_cost
         from material_batches b join materials m on m.id = b.material_id where b.branch_id = $1 and m.is_active and b.expiry_date >= clinic_today() and b.qty_on_hand > 0 order by m.name, b.expiry_date, b.id`, [branchId])).rows;
    const negative = (await this.db.query(
      `select v.material_id, m.name, m.base_unit, v.on_hand, m.last_unit_cost,
              (select coalesce(sum(qty_on_hand),0) from material_batches b where b.material_id = v.material_id) as batch_qty
         from v_material_stock v join materials m on m.id = v.material_id where v.branch_id = $1 and v.on_hand < 0 order by m.name`, [branchId])).rows;
    const expired = (await this.db.query(`select count(*)::int as n from material_batches where branch_id = $1 and expiry_date < clinic_today() and qty_on_hand > 0`, [branchId])).rows[0].n;
    return {
      branch_id: branchId,
      batches: batches.map((r) => ({ batch_id: Number(r.id), material: { id: Number(r.material_id), name: r.name, unit: r.base_unit }, expiry_date: r.expiry_date, system_qty: Number(r.qty_on_hand), unit_cost: Number(r.unit_cost) })),
      negative_materials: negative.map((r) => ({ material: { id: Number(r.material_id), name: r.name, unit: r.base_unit }, system_qty: Number(r.on_hand), last_unit_cost: r.last_unit_cost === null ? null : Number(r.last_unit_cost), has_batches: Number(r.batch_qty) > 0 })),
      expired_batches_to_waste: expired,
    };
  }

  async create(actor: AuthUser, dto: CreateCountDto, ip: string | null) {
    // ---- تحقق شكلي أول (بدون قاعدة)
    const seenB = new Set<number>(); const seenM = new Set<number>();
    for (const l of dto.lines) {
      if (l.kind === 'batch') {
        if (l.batch_id === undefined || l.material_id !== undefined) throw Errors.badRequest('INVALID_LINE', 'سطر الدفعة يحتاج batch_id بس');
        if (seenB.has(l.batch_id)) throw Errors.badRequest('DUPLICATE_LINE', 'دفعة مكررة بالجرد');
        seenB.add(l.batch_id);
      } else {
        if (l.material_id === undefined || l.batch_id !== undefined) throw Errors.badRequest('INVALID_LINE', 'سطر المادة السالبة يحتاج material_id بس');
        if (seenM.has(l.material_id)) throw Errors.badRequest('DUPLICATE_LINE', 'مادة مكررة بالجرد');
        seenM.add(l.material_id);
        if (l.new_batch_expiry !== undefined) assertDate(l.new_batch_expiry, 'صلاحية الدفعة الجديدة');
      }
    }
    return this.db.tx(async (q) => {
      // ---- نحدد المواد ونقفلها بالترتيب، وبعدين الدفعات
      const batchRows = new Map<number, any>();
      for (const id of seenB) {
        const b = (await q.query(`select id, material_id, branch_id from material_batches where id = $1`, [id])).rows[0];
        if (!b) throw Errors.notFound('الدفعة');
        batchRows.set(id, b);
      }
      const branchIds = new Set<number>([...batchRows.values()].map((b) => Number(b.branch_id)));
      const matIds = new Set<number>([...batchRows.values()].map((b) => Number(b.material_id)));
      for (const id of seenM) matIds.add(id);
      for (const id of [...matIds].sort((a, b) => a - b)) {
        const m = (await q.query(`select id, branch_id from materials where id = $1 for update`, [id])).rows[0];
        if (!m) throw Errors.notFound('المادة');
        branchIds.add(Number(m.branch_id));
      }
      if (branchIds.size !== 1) throw Errors.badRequest('MIXED_BRANCHES', 'الجرد لفرع واحد');
      const branchId = [...branchIds][0];
      if (actor.role !== 'owner' && branchId !== actor.branchId) throw Errors.notFound('الدفعة');
      const today = (await q.query(`select clinic_today()::text as d`)).rows[0].d;

      const plan: { line: CountLineDto; b?: any; m?: any; system: number; diff: number; note: string | null }[] = [];
      const delta = new Map<number, number>();                 // مجموع الفروقات الموجبة والسالبة للدفعات الصالحة بكل مادة
      for (const l of dto.lines) {
        const note = l.note?.trim() || null;
        if (l.kind === 'batch') {
          const b = (await q.query(`select *, (expiry_date < clinic_today()) as expired from material_batches where id = $1 for update`, [l.batch_id])).rows[0];
          if (b.expired) throw Errors.conflictWith('BATCH_EXPIRED', 'الدفعة المنتهية ما تنجرد: سجلها تالف', { batch_id: Number(b.id) });
          const system = Number(b.qty_on_hand);
          if (Math.abs(system - l.expected_system_qty) > EPS) throw Errors.conflictWith('STOCK_CHANGED', 'كمية النظام تغيرت من فتحت الورقة: أعد العدّ', { batch_id: Number(b.id), current_system_qty: system });
          const diff = Math.round((l.actual_qty - system) * 1000) / 1000;
          if (Math.abs(diff) > EPS && !note) throw Errors.conflictWith('NOTE_REQUIRED', 'أي فرق يحتاج ملاحظة', { batch_id: Number(b.id), system_qty: system, actual_qty: l.actual_qty });
          plan.push({ line: l, b, system, diff, note });
          delta.set(Number(b.material_id), (delta.get(Number(b.material_id)) ?? 0) + diff);
        } else {
          const m = (await q.query(`select id, name, last_unit_cost from materials where id = $1`, [l.material_id])).rows[0];
          const st = (await q.query(`select on_hand from v_material_stock where material_id = $1`, [l.material_id])).rows[0];
          const onHand = Number(st.on_hand);
          if (onHand >= 0) throw Errors.conflict('NOT_NEGATIVE', `المادة «${m.name}» مو سالبة: اجردها بالدفعات`);
          const bq = Number((await q.query(`select coalesce(sum(qty_on_hand),0) as s from material_batches where material_id = $1`, [l.material_id])).rows[0].s);
          if (bq > EPS) throw Errors.conflict('HAS_BATCHES', `المادة «${m.name}» عندها دفعات: اجردها بالدفعات`);
          if (Math.abs(onHand - l.expected_system_qty) > EPS) throw Errors.conflictWith('STOCK_CHANGED', 'كمية النظام تغيرت من فتحت الورقة: أعد العدّ', { material_id: Number(m.id), current_system_qty: onHand });
          if (!note) throw Errors.conflictWith('NOTE_REQUIRED', 'تصحيح المادة السالبة يحتاج ملاحظة', { material_id: Number(m.id) });
          if (l.actual_qty > EPS && !l.new_batch_expiry) throw Errors.badRequest('EXPIRY_REQUIRED', 'اكتب تاريخ صلاحية الدفعة الجديدة');
          if (l.new_batch_expiry && l.new_batch_expiry <= today && l.actual_qty > EPS) throw Errors.badRequest('EXPIRY_PAST', 'تاريخ الصلاحية لازم يكون بعد اليوم');
          const cost = l.new_batch_unit_cost ?? (m.last_unit_cost === null ? null : Number(m.last_unit_cost));
          if (cost === null) throw Errors.badRequest('COST_REQUIRED', 'اكتب كلفة الوحدة (ما أكو آخر سعر شراء)');
          plan.push({ line: { ...l, new_batch_unit_cost: cost }, m, system: onHand, diff: Math.round((l.actual_qty - onHand) * 1000) / 1000, note });
        }
      }
      // ---- الكمية الفعلية ما تنزل تحت المحجوز
      for (const [mid, d] of delta) {
        if (d >= -EPS) continue;
        const { valid, reserved } = await validAndReserved(q, mid);
        if (valid + d < reserved - EPS) throw Errors.conflictWith('BELOW_RESERVED', 'الكمية الفعلية أقل من المحجوز لجلسات مدفوعة', { material_id: mid, reserved, would_be_valid: valid + d });
      }
      for (const p of plan) if (p.line.kind === 'material_level') {
        const { reserved } = await validAndReserved(q, Number(p.m.id));
        if (p.line.actual_qty < reserved - EPS) throw Errors.conflictWith('BELOW_RESERVED', 'الكمية الفعلية أقل من المحجوز لجلسات مدفوعة', { material_id: Number(p.m.id), reserved, actual_qty: p.line.actual_qty });
      }

      // ---- التنفيذ
      const count = (await q.query(`insert into stock_counts (branch_id, count_date, status, note, created_by, posted_by, posted_at) values ($1,$2,'posted',$3,$4,$4,now()) returning id`,
        [branchId, today, dto.note?.trim() || null, actor.id])).rows[0];
      const countId = Number(count.id);
      for (const p of plan) {
        if (p.line.kind === 'batch') {
          const b = p.b;
          const line = (await q.query(`insert into stock_count_lines (count_id, material_id, batch_id, line_kind, system_qty, actual_qty, note) values ($1,$2,$3,'batch',$4,$5,$6) returning id`,
            [countId, b.material_id, b.id, String(p.system), String(p.line.actual_qty), p.note])).rows[0];
          if (Math.abs(p.diff) > EPS) {
            const cost = Number((await q.query(`select round($1::numeric * $2::numeric)::bigint as v`, [String(Math.abs(p.diff)), b.unit_cost])).rows[0].v);
            await q.query(`insert into stock_movements (branch_id, material_id, batch_id, movement_type, qty_delta, unit_cost, cost_amount, count_line_id, note, created_by) values ($1,$2,$3,'count_adjust',$4,$5,$6,$7,$8,$9)`,
              [branchId, b.material_id, b.id, String(p.diff), b.unit_cost, p.diff > 0 ? cost : -cost, line.id, p.note, actor.id]);
          }
        } else {
          const l = p.line; const unitCost = String(l.new_batch_unit_cost);
          const expiry = l.actual_qty > EPS ? l.new_batch_expiry! : (await q.query(`select (clinic_today() + 1)::text as d`)).rows[0].d;       // الدفعة ما تنفتح لو الفعلي صفر؛ التاريخ يلبّي قيد الجدول بس
          const line = (await q.query(`insert into stock_count_lines (count_id, material_id, line_kind, system_qty, actual_qty, note, new_batch_expiry, new_batch_unit_cost) values ($1,$2,'material_level',$3,$4,$5,$6,$7) returning id`,
            [countId, p.m.id, String(p.system), String(l.actual_qty), p.note, expiry, unitCost])).rows[0];
          // (أ) نصفّر السالب (حركة بدون دفعة)، (ب) الكمية الفعلية تدخل بدفعة جديدة
          const zero = -p.system;
          const zeroCost = Number((await q.query(`select round($1::numeric * $2::numeric)::bigint as v`, [String(zero), unitCost])).rows[0].v);
          await q.query(`insert into stock_movements (branch_id, material_id, movement_type, qty_delta, unit_cost, cost_amount, count_line_id, note, created_by) values ($1,$2,'count_adjust',$3,$4,$5,$6,$7,$8)`,
            [branchId, p.m.id, String(zero), unitCost, zeroCost, line.id, p.note, actor.id]);
          if (l.actual_qty > EPS) {
            const nb = (await q.query(`insert into material_batches (branch_id, material_id, source, received_on, expiry_date, unit_cost, qty_initial, qty_on_hand) values ($1,$2,'count',$3,$4,$5,$6,0) returning id`,
              [branchId, p.m.id, today, expiry, unitCost, String(l.actual_qty)])).rows[0];
            const cost = Number((await q.query(`select round($1::numeric * $2::numeric)::bigint as v`, [String(l.actual_qty), unitCost])).rows[0].v);
            await q.query(`insert into stock_movements (branch_id, material_id, batch_id, movement_type, qty_delta, unit_cost, cost_amount, count_line_id, note, created_by) values ($1,$2,$3,'count_adjust',$4,$5,$6,$7,$8,$9)`,
              [branchId, p.m.id, nb.id, String(l.actual_qty), unitCost, cost, line.id, p.note, actor.id]);
          }
        }
      }
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'stock.count', entityType: 'stock_count', entityId: countId, reason: dto.note?.trim() || undefined,
        after: { lines: plan.length, differences: plan.filter((p) => Math.abs(p.diff) > EPS).length }, ip });
      return this.viewQ(q, countId);
    });
  }

  async list(actor: AuthUser, requestedBranch?: number) {
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    const { rows } = await this.db.query(`select id from stock_counts where branch_id = $1 order by id desc limit 100`, [branchId]);
    return { branch_id: branchId, counts: await Promise.all(rows.map((r) => this.viewQ(this.db, Number(r.id), false))) };
  }

  async get(actor: AuthUser, id: number) {
    const v = await this.viewQ(this.db, id);
    if (!v || (actor.role !== 'owner' && v.branch_id !== actor.branchId)) throw Errors.notFound('الجرد');
    return v;
  }

  private async viewQ(q: Queryable, id: number, withLines = true) {
    const c = (await q.query(`select c.*, c.count_date::text as date_text, u.full_name as by_name from stock_counts c join users u on u.id = c.created_by where c.id = $1`, [id])).rows[0];
    if (!c) return null;
    // قيمة النقص والزيادة من حركات الجرد نفسها
    const t = (await q.query(
      `select coalesce(sum(case when m.cost_amount < 0 then -m.cost_amount end),0)::bigint as shortage, coalesce(sum(case when m.cost_amount > 0 then m.cost_amount end),0)::bigint as surplus
         from stock_movements m join stock_count_lines l on l.id = m.count_line_id where l.count_id = $1`, [id])).rows[0];
    const out: any = { id: Number(c.id), branch_id: Number(c.branch_id), count_date: c.date_text as string, status: c.status, note: c.note, by: c.by_name, shortage_value: Number(t.shortage), surplus_value: Number(t.surplus) };
    if (withLines) {
      const lines = (await q.query(`select l.*, l.new_batch_expiry::text as expiry_text, m.name as material_name from stock_count_lines l join materials m on m.id = l.material_id where l.count_id = $1 order by l.id`, [id])).rows;
      out.lines = lines.map((l) => ({ id: Number(l.id), kind: l.line_kind, material: { id: Number(l.material_id), name: l.material_name }, batch_id: l.batch_id === null ? null : Number(l.batch_id),
        system_qty: Number(l.system_qty), actual_qty: l.actual_qty === null ? null : Number(l.actual_qty), diff_qty: Number(l.diff_qty), note: l.note, new_batch_expiry: l.line_kind === 'material_level' ? l.expiry_text : null }));
    }
    return out;
  }
}
