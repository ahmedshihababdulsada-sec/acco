import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { resolveBranch } from '../common/branch';
import { Errors } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { CloseShiftDto, ConfirmShiftDto, OpenShiftDto } from './shifts.dto';

interface MethodRow { method_id: number; method_name: string; method_kind: 'cash' | 'electronic'; device_label: string | null; collected: number; refunded: number }

/**
 * الشفت (القسم 12 و): فتح بفكة تطلع من الخزنة، تسكير بعدّ الكاش وكشف كل جهاز (الكاشير ما يشوف المتوقع)،
 * وتأكيد المدير لكل طريقة لحالها؛ الكاش المؤكد بس يدخل الخزنة بنفس عملية التأكيد.
 * ترتيب الأقفال: الدفع والاسترجاع ياخذون الشفت FOR SHARE، والتسكير FOR UPDATE، فما يفلت وصل بعد حساب الإجمالي.
 */
@Injectable()
export class ShiftsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async open(actor: AuthUser, dto: OpenShiftDto, ip: string | null) {
    const branchId = await resolveBranch(this.db, actor, dto.branch_id);
    try {
      return await this.db.tx(async (q) => {
        if (dto.float_given_by !== undefined) {
          const g = (await q.query(`select role, branch_id, is_active from users where id = $1`, [dto.float_given_by])).rows[0];
          const okRole = g && ['manager', 'owner'].includes(g.role) && g.is_active && (g.role === 'owner' || Number(g.branch_id) === branchId);
          if (!okRole) throw Errors.badRequest('INVALID_FLOAT_GIVER', 'اللي سلّم الفكة لازم مدير أو مالك فعال بنفس الفرع');
        }
        const { rows } = await q.query(
          `insert into shifts (branch_id, cashier_id, opening_float, float_given_by) values ($1,$2,$3,$4) returning id`,
          [branchId, actor.id, dto.opening_float, dto.float_given_by ?? null]);
        const id = Number(rows[0].id);
        if (dto.opening_float > 0) {
          // الفكة تطلع من الخزنة (قرار التصميم 1): إذا الرصيد ما يكفي يفشل CHECK بالقاعدة، وحركتين متزامنتين تتسلسلان على صف الخزنة
          await q.query(`insert into safes (branch_id) values ($1) on conflict do nothing`, [branchId]);
          await q.query(`insert into safe_movements (branch_id, direction, amount, kind, shift_id, note, created_by) values ($1,'out',$2,'shift_float',$3,'فكة الشفت',$4)`, [branchId, dto.opening_float, id, actor.id]);
        }
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'shift.open', entityType: 'shift', entityId: id,
          after: { opening_float: dto.opening_float, float_given_by: dto.float_given_by ?? null }, ip });
        return this.currentQ(q, actor.id);
      });
    } catch (e: any) {
      if (e?.code === '23505') throw Errors.conflict('SHIFT_ALREADY_OPEN', 'عندك شفت مفتوح');
      if (e?.code === '23514' && e.constraint === 'safes_balance_check') {
        const bal = (await this.db.query(`select balance from safes where branch_id = $1`, [branchId])).rows[0]?.balance ?? 0;
        throw Errors.conflictWith('SAFE_INSUFFICIENT', 'رصيد الخزنة ما يكفي للفكة', { safe_balance: Number(bal), requested: dto.opening_float });
      }
      throw e;
    }
  }

  /** الشفت المفتوح للمستخدم مع مقبوضاته ومرتجعاته لحد الآن حسب الطريقة (بدون المتوقع)، أو null */
  async current(actor: AuthUser) { return this.currentQ(this.db, actor.id); }

  private async currentQ(q: Queryable, userId: number) {
    const s = (await q.query(`select id, branch_id, opened_at, opening_float, float_given_by from shifts where cashier_id = $1 and status = 'open'`, [userId])).rows[0];
    if (!s) return null;
    const n = (await q.query(`select count(*)::int as n from payments where shift_id = $1`, [s.id])).rows[0].n;
    const methods = await this.methodRows(q, Number(s.id), Number(s.branch_id));
    return {
      id: Number(s.id), branch_id: Number(s.branch_id), opened_at: s.opened_at, opening_float: Number(s.opening_float),
      float_given_by: s.float_given_by === null ? null : Number(s.float_given_by), receipts_count: n,
      collected: methods.filter((m) => m.collected > 0).map((m) => ({ method_id: m.method_id, method_name: m.method_name, method_kind: m.method_kind, device_label: m.device_label, collected: m.collected })),
      methods_to_count: methods.map((m) => ({ method_id: m.method_id, method_name: m.method_name, method_kind: m.method_kind, device_label: m.device_label, collected: m.collected, refunded: m.refunded })),
    };
  }

  /** الطرق اللي لازم تنعد: كل طريقة صار بيها مقبوض أو مرتجع بالشفت، والكاش دائماً (فيه الفكة). */
  private async methodRows(q: Queryable, shiftId: number, branchId: number): Promise<MethodRow[]> {
    const coll = (await q.query(
      `select pt.method_id, min(pt.method_name) as name, min(pt.method_kind) as kind, min(pt.device_label) as device, sum(pt.amount)::bigint as s
         from payment_tenders pt join payments p on p.id = pt.payment_id where p.shift_id = $1 group by pt.method_id`, [shiftId])).rows;
    const refs = (await q.query(
      `select rt.payout_method_id as method_id, min(rt.payout_method_name) as name, min(rt.payout_kind) as kind, min(rt.device_label) as device, sum(rt.amount)::bigint as s
         from refund_tenders rt join refunds r on r.id = rt.refund_id where r.shift_id = $1 group by rt.payout_method_id`, [shiftId])).rows;
    const cash = (await q.query(`select id, name_ar, device_label from payment_methods where branch_id = $1 and kind = 'cash' and is_active`, [branchId])).rows[0];
    const map = new Map<number, MethodRow>();
    const touch = (id: number, name: string, kind: any, device: string | null) => {
      if (!map.has(id)) map.set(id, { method_id: id, method_name: name, method_kind: kind, device_label: device, collected: 0, refunded: 0 });
      return map.get(id)!;
    };
    if (cash) touch(Number(cash.id), cash.name_ar, 'cash', cash.device_label);
    for (const r of coll) touch(Number(r.method_id), r.name, r.kind, r.device).collected += Number(r.s);
    for (const r of refs) touch(Number(r.method_id), r.name, r.kind, r.device).refunded += Number(r.s);
    return [...map.values()].sort((a, b) => (a.method_kind === b.method_kind ? a.method_id - b.method_id : a.method_kind === 'cash' ? -1 : 1));
  }

  // ================================================================ التسكير
  async close(actor: AuthUser, dto: CloseShiftDto, ip: string | null) {
    return this.db.tx(async (q) => {
      const s = (await q.query(`select id, branch_id, opening_float from shifts where cashier_id = $1 and status = 'open' for update`, [actor.id])).rows[0];
      if (!s) throw Errors.conflict('NO_OPEN_SHIFT', 'ما عندك شفت مفتوح');
      const shiftId = Number(s.id);
      const rows = await this.methodRows(q, shiftId, Number(s.branch_id));        // بعد القفل: ما يدخل وصل أو استرجاع جديد
      const ids = dto.counts.map((c) => c.method_id);
      if (new Set(ids).size !== ids.length) throw Errors.badRequest('DUPLICATE_METHOD', 'طريقة مكررة بالعد');
      const required = rows.map((r) => r.method_id);
      if (ids.length !== required.length || !required.every((id) => ids.includes(id)))
        throw Errors.conflictWith('COUNTS_MISMATCH', 'لازم تدخل عدّ كل طريقة (الكاش وكل جهاز صار عليه حركة)', { required_methods: rows.map((r) => ({ method_id: r.method_id, method_name: r.method_name, device_label: r.device_label })) });
      const counted = new Map(dto.counts.map((c) => [c.method_id, c.counted]));
      for (const r of rows) {
        const expected = (r.method_kind === 'cash' ? Number(s.opening_float) : 0) + r.collected - r.refunded;
        await q.query(`insert into shift_method_totals (shift_id, method_id, method_name, method_kind, collected, refunded, expected, counted) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [shiftId, r.method_id, r.method_name, r.method_kind, r.collected, r.refunded, expected, counted.get(r.method_id)]);
      }
      await q.query(`update shifts set status = 'closed', closed_at = now() where id = $1`, [shiftId]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(s.branch_id), action: 'shift.close', entityType: 'shift', entityId: shiftId,
        after: { counts: dto.counts } , ip });
      // الكاشير ما يشوف المتوقع (عدّ أعمى): يرجع له اللي عدّه والمقبوض والمرتجع بس
      return { id: shiftId, status: 'closed', counts: rows.map((r) => ({ method_id: r.method_id, method_name: r.method_name, device_label: r.device_label, collected: r.collected, refunded: r.refunded, counted: counted.get(r.method_id)! })) };
    });
  }

  /**
   * تسكير إجباري من المدير/المالك لشفت منسي (بسبب مكتوب). نفس حساب المتوقع، بس العدّ (counted) يبقى فاضي لأن الكاشير ما عدّ،
   * والمدير يأكد بعدين اللي استلمه فعلاً (ويكتب ملاحظة لأي فرق).
   */
  async forceClose(actor: AuthUser, shiftId: number, reason: string, ip: string | null) {
    const why = reason.trim();
    if (why.length < 3) throw Errors.badRequest('REASON_REQUIRED', 'اكتب سبب التسكير');
    return this.db.tx(async (q) => {
      const s = (await q.query(`select id, branch_id, cashier_id, opening_float, status from shifts where id = $1 for update`, [shiftId])).rows[0];
      if (!s || (actor.role !== 'owner' && Number(s.branch_id) !== actor.branchId)) throw Errors.notFound('الشفت');
      if (s.status !== 'open') throw Errors.conflict('NOT_OPEN', 'الشفت مو مفتوح');
      const rows = await this.methodRows(q, shiftId, Number(s.branch_id));
      for (const r of rows) {
        const expected = (r.method_kind === 'cash' ? Number(s.opening_float) : 0) + r.collected - r.refunded;
        await q.query(`insert into shift_method_totals (shift_id, method_id, method_name, method_kind, collected, refunded, expected) values ($1,$2,$3,$4,$5,$6,$7)`,
          [shiftId, r.method_id, r.method_name, r.method_kind, r.collected, r.refunded, expected]);
      }
      await q.query(`update shifts set status = 'closed', closed_at = now() where id = $1`, [shiftId]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(s.branch_id), action: 'shift.force_close', entityType: 'shift', entityId: shiftId, reason: why,
        after: { cashier_id: Number(s.cashier_id) }, ip });
      return this.detailQ(q, shiftId);
    });
  }

  // ================================================================ تأكيد المدير والخزنة
  async confirm(actor: AuthUser, shiftId: number, dto: ConfirmShiftDto, ip: string | null) {
    return this.db.tx(async (q) => {
      const s = (await q.query(`select * from shifts where id = $1 for update`, [shiftId])).rows[0];
      if (!s || (actor.role !== 'owner' && Number(s.branch_id) !== actor.branchId)) throw Errors.notFound('الشفت');
      if (s.status === 'open') throw Errors.conflict('NOT_CLOSED', 'الكاشير لسه ما سكّر الشفت');
      if (s.status === 'confirmed') throw Errors.conflict('ALREADY_CONFIRMED', 'الشفت مؤكد مسبقاً');
      const totals = (await q.query(`select * from shift_method_totals where shift_id = $1 order by id`, [shiftId])).rows;
      const ids = dto.lines.map((l) => l.method_id);
      if (new Set(ids).size !== ids.length) throw Errors.badRequest('DUPLICATE_METHOD', 'طريقة مكررة');
      const have = totals.map((t) => Number(t.method_id));
      if (ids.length !== have.length || !have.every((id) => ids.includes(id)))
        throw Errors.conflictWith('LINES_MISMATCH', 'لازم تأكد كل طريقة بالشفت', { required_methods: totals.map((t) => ({ method_id: Number(t.method_id), method_name: t.method_name })) });
      const byMethod = new Map(dto.lines.map((l) => [l.method_id, l]));
      let cash = 0; const diffs: object[] = [];
      for (const t of totals) {
        const l = byMethod.get(Number(t.method_id))!;
        const expected = Number(t.expected); const note = l.note?.trim() || null;
        if (l.confirmed !== expected && !note) throw Errors.conflictWith('NOTE_REQUIRED', 'اكتب ملاحظة للنقص أو الزيادة', { method_id: Number(t.method_id), method_name: t.method_name, expected, confirmed: l.confirmed });
        await q.query(`update shift_method_totals set confirmed = $3, note = $4 where shift_id = $1 and method_id = $2`, [shiftId, t.method_id, l.confirmed, note]);
        if (t.method_kind === 'cash') cash += l.confirmed;
        if (l.confirmed !== expected) diffs.push({ method_id: Number(t.method_id), method_name: t.method_name, expected, confirmed: l.confirmed, difference: l.confirmed - expected, note });
      }
      // الكاش المؤكد بس يدخل الخزنة (الإلكتروني يبقى بحساباته)
      if (cash > 0) await q.query(`insert into safe_movements (branch_id, direction, amount, kind, shift_id, note, created_by) values ($1,'in',$2,'shift_handover',$3,'استلام شفت',$4)`, [s.branch_id, cash, shiftId, actor.id]);
      await q.query(`update shifts set status = 'confirmed', confirmed_by = $2, confirmed_at = now() where id = $1`, [shiftId, actor.id]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(s.branch_id), action: 'shift.confirm', entityType: 'shift', entityId: shiftId,
        after: { cash_to_safe: cash, differences: diffs }, ip });
      return this.detailQ(q, shiftId);
    });
  }

  // ================================================================ القراءة (المدير والمالك)
  async list(actor: AuthUser, p: { status?: string; date?: string; branchId?: number }) {
    const branchId = actor.role === 'owner' ? p.branchId ?? null : actor.branchId;
    if (p.status && !['open', 'closed', 'confirmed'].includes(p.status)) throw Errors.badRequest('INVALID_STATUS', 'حالة غير معروفة');
    if (p.date && !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw Errors.badRequest('INVALID_DATE', 'التاريخ بصيغة YYYY-MM-DD');
    const { rows } = await this.db.query(
      `select s.id from shifts s where ($1::bigint is null or s.branch_id = $1) and ($2::text is null or s.status = $2)
          and ($3::date is null or (s.opened_at at time zone 'Asia/Baghdad')::date = $3) order by s.id desc limit 100`, [branchId, p.status ?? null, p.date ?? null]);
    return Promise.all(rows.map((r) => this.detailQ(this.db, Number(r.id))));
  }

  async get(actor: AuthUser, id: number) {
    const d = await this.detailQ(this.db, id);
    if (!d || (actor.role !== 'owner' && d.branch_id !== actor.branchId)) throw Errors.notFound('الشفت');
    return d;
  }

  private async detailQ(q: Queryable, id: number) {
    const s = (await q.query(`select s.*, u.full_name as cashier_name, c.full_name as confirmed_by_name from shifts s join users u on u.id = s.cashier_id left join users c on c.id = s.confirmed_by where s.id = $1`, [id])).rows[0];
    if (!s) return null;
    const t = (await q.query(`select * from shift_method_totals where shift_id = $1 order by id`, [id])).rows;
    return {
      id: Number(s.id), branch_id: Number(s.branch_id), status: s.status, cashier: { id: Number(s.cashier_id), full_name: s.cashier_name },
      opened_at: s.opened_at, closed_at: s.closed_at, confirmed_at: s.confirmed_at, confirmed_by: s.confirmed_by === null ? null : { id: Number(s.confirmed_by), full_name: s.confirmed_by_name },
      opening_float: Number(s.opening_float),
      methods: t.map((r) => ({ method_id: Number(r.method_id), method_name: r.method_name, method_kind: r.method_kind, collected: Number(r.collected), refunded: Number(r.refunded), expected: Number(r.expected),
        counted: r.counted === null ? null : Number(r.counted), confirmed: r.confirmed === null ? null : Number(r.confirmed), difference: r.difference === null ? null : Number(r.difference), note: r.note })),
    };
  }
}
