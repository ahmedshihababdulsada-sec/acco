import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { Errors } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { SettingsService } from '../settings/settings.service';
import { allocate, pointsClawback } from './allocation';
import { IdempotencyService, Replay } from './idempotency.service';
import { BookingsService } from '../bookings/bookings.service';
import { PaymentsService } from './payments.service';
import { RefundDto } from './refunds.dto';

export interface RefundResult { status: number; body: unknown; replay: boolean }

/**
 * الاسترجاع (القسم 5 و): خدمة وحدة أو الوصل كله، قبل ما يدخل الزبون للطبيب (الكشفية).
 * يرجع صافي البند بالضبط، ويتسجل بشفت الكاشير الحالي، ويحفظ طريقة الدفع الأصلية وطريقة إرجاع الفلوس الفعلية.
 * ترتيب الأقفال مثل الدفع حتى ما يصير تشابك: الكشفية والزيارة ← الوصل ← الشفت ← عداد الاسترجاع.
 */
@Injectable()
export class RefundsService {
  constructor(
    private readonly db: DbService, private readonly audit: AuditService, private readonly settings: SettingsService,
    private readonly idem: IdempotencyService, private readonly payments: PaymentsService, private readonly bookings: BookingsService,
  ) {}

  async refund(actor: AuthUser, paymentId: number, dto: RefundDto, key: string | undefined, ip: string | null): Promise<RefundResult> {
    const idemKey = IdempotencyService.validate(key);
    const reason = dto.reason.trim();
    if (reason.length < 3) throw Errors.badRequest('REASON_REQUIRED', 'اكتب سبب الاسترجاع');
    if (!!dto.items === !!dto.full_receipt) throw Errors.badRequest('ITEMS_OR_FULL', 'حدد البنود أو الوصل كله (واحد منهم بس)');
    return this.db.tx(async (q): Promise<RefundResult> => {
      const replay: Replay | null = await this.idem.begin(q, actor.id, idemKey, `POST /payments/${paymentId}/refund`, dto);
      if (replay) return { ...replay, replay: true };

      // ---- 1) الكشفيات والزيارات أول (نفس ترتيب الدفع)
      const head = (await q.query(`select id, branch_id, customer_id from payments where id = $1`, [paymentId])).rows[0];
      if (!head || (actor.role !== 'owner' && Number(head.branch_id) !== actor.branchId)) throw Errors.notFound('الوصل');
      const branchId = Number(head.branch_id);
      const consIds = (await q.query(`select consultation_id from payment_items where payment_id = $1 and consultation_id is not null order by consultation_id`, [paymentId])).rows.map((r) => Number(r.consultation_id));
      const cons = new Map<number, { status: string; visit_id: number; visit_date: string; seq_no: number }>();
      for (const cid of consIds) {
        const r = (await q.query(
          `select c.status, c.visit_id, v.visit_date::text as visit_date, v.seq_no from consultations c join visits v on v.id = c.visit_id where c.id = $1 for update of c, v`, [cid])).rows[0];
        cons.set(cid, { status: r.status, visit_id: Number(r.visit_id), visit_date: r.visit_date, seq_no: Number(r.seq_no) });
      }
      // ---- 1ب) جلسات الوصل: زياراتها أول (بالترتيب) وبعدها الجلسات نفسها
      const sessIds = (await q.query(`select session_id from payment_items where payment_id = $1 and session_id is not null order by session_id`, [paymentId])).rows.map((r) => Number(r.session_id));
      const sess = new Map<number, { status: string; visit_id: number | null; d: string | null }>();
      if (sessIds.length) {
        const heads = (await q.query(`select id, visit_id from treatment_sessions where id = any($1::bigint[])`, [sessIds])).rows;
        const vids = [...new Set(heads.filter((h) => h.visit_id !== null).map((h) => Number(h.visit_id)))].sort((a, b) => a - b);
        for (const vid of vids) await q.query(`select 1 from visits where id = $1 for update`, [vid]);
        for (const r of (await q.query(`select id, status, visit_id, scheduled_date::text as d from treatment_sessions where id = any($1::bigint[]) order by id for update`, [sessIds])).rows)
          sess.set(Number(r.id), { status: r.status, visit_id: r.visit_id === null ? null : Number(r.visit_id), d: r.d });
      }
      // ---- 2) الوصل نفسه (بعد القفل نقرأ حالة البنود الأخيرة)
      const p = (await q.query(`select * from payments where id = $1 for update`, [paymentId])).rows[0];
      const items = (await q.query(`select * from payment_items where payment_id = $1 order by id`, [paymentId])).rows;
      const byId = new Map(items.map((i) => [Number(i.id), i]));
      const wanted: number[] = dto.full_receipt ? items.filter((i) => i.status === 'paid').map((i) => Number(i.id)) : [...new Set(dto.items!)];
      if (!wanted.length) throw Errors.conflict('ALREADY_REFUNDED', 'الوصل كله مسترجع');
      for (const id of wanted) {
        const it = byId.get(id);
        if (!it) throw Errors.badRequest('ITEM_NOT_IN_PAYMENT', 'بند ما ينتمي لهذا الوصل');
        if (it.status !== 'paid') throw Errors.conflict('ALREADY_REFUNDED', 'هذا البند مسترجع مسبقاً');
        if (it.item_type === 'consultation' && cons.get(Number(it.consultation_id))!.status !== 'paid')
          throw Errors.conflict('CONSULTATION_ENTERED', 'الزبون دخل للطبيب: الكشفية ما تنسترجع');
        if (it.item_type === 'session') {
          const st = sess.get(Number(it.session_id))!.status;
          if (st === 'completed') throw Errors.conflict('SESSION_COMPLETED', 'الجلسة تنفذت (أكدها الممرض): ما تنسترجع');
          if (st !== 'paid') throw Errors.conflict('SESSION_NOT_REFUNDABLE', 'حالة الجلسة ما تسمح بالاسترجاع');
        }
      }
      const total = wanted.reduce((a, id) => a + Number(byId.get(id).net_amount), 0);
      if (total <= 0) throw Errors.conflict('NOTHING_TO_REFUND', 'ما أكو مبلغ يرجع (وصل صفري)');

      // ---- 3) الزبون (النقاط) والشفت الحالي للكاشير
      // رصيد النقاط يتحدث بجملة وحدة ذرية داخل trigger الدفتر، وما نقرأ الرصيد هنا، فما نحتاج قفل صف الزبون (بعكس الدفع)
      const customerId = Number(p.customer_id);
      const shift = (await q.query(`select id, branch_id from shifts where cashier_id = $1 and status = 'open' for share`, [actor.id])).rows[0];
      if (!shift) throw Errors.conflict('NO_OPEN_SHIFT', 'افتح شفتك أول');
      if (Number(shift.branch_id) !== branchId) throw Errors.conflict('SHIFT_BRANCH_MISMATCH', 'شفتك المفتوح بفرع ثاني');

      // ---- 4) طريقة إرجاع الفلوس (كاش افتراضياً) ومقابلتها بطرق الدفع الأصلية
      const payoutMethods = await this.payoutLines(q, branchId, dto.payout, total);
      const pairs = await this.pairWithOriginals(q, paymentId, total, payoutMethods.lines);

      // ---- 5) النقاط: المصروفة بالبنود ترجع بعددها، والمكتسبة تنعاد على الباقي
      const returned = wanted.reduce((a, id) => a + Number(byId.get(id).points_used_share), 0);
      const refundedBefore = Number((await q.query(`select coalesce(sum(ri.amount),0)::bigint as s from refund_items ri join refunds r on r.id = ri.refund_id where r.payment_id = $1`, [paymentId])).rows[0].s);
      const alreadyClawed = -Number((await q.query(
        `select coalesce(sum(l.points),0)::bigint as s from points_ledger l join refunds r on r.id = l.refund_id where r.payment_id = $1 and l.entry_type = 'earn_clawback'`, [paymentId])).rows[0].s);
      const perAmount = await this.settings.effective<number>(q, branchId, 'points.earn_per_amount');
      const earnPts = await this.settings.effective<number>(q, branchId, 'points.earn_points');
      const remaining = Number(p.net_amount) - refundedBefore - total;
      const clawed = pointsClawback(Number(p.points_earned), alreadyClawed, remaining, perAmount, earnPts);

      // ---- 6) الإصدار
      const refundNo = await this.nextRefundNo(q, branchId);
      const rf = (await q.query(
        `insert into refunds (branch_id, payment_id, refund_no, shift_id, cashier_id, total_amount, points_returned, points_clawed_back, reason)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, [branchId, paymentId, refundNo, shift.id, actor.id, total, returned, clawed, reason])).rows[0];
      const refundId = Number(rf.id);
      for (const id of wanted) {
        await q.query(`insert into refund_items (refund_id, payment_item_id, amount) values ($1,$2,$3)`, [refundId, id, Number(byId.get(id).net_amount)]);
        await q.query(`update payment_items set status = 'refunded' where id = $1`, [id]);
      }
      for (const pr of pairs) {
        const m = payoutMethods.methods.get(pr.payout_method_id)!;
        await q.query(`insert into refund_tenders (refund_id, original_method_id, payout_method_id, payout_method_name, payout_kind, device_label, amount) values ($1,$2,$3,$4,$5,$6,$7)`,
          [refundId, pr.original_method_id, m.id, m.name_ar, m.kind, m.device_label, pr.amount]);
      }
      if (returned > 0) await q.query(`insert into points_ledger (customer_id, entry_type, points, refund_id, created_by) values ($1,'redeem_return',$2,$3,$4)`, [customerId, returned, refundId, actor.id]);
      if (clawed > 0) await q.query(`insert into points_ledger (customer_id, entry_type, points, refund_id, created_by) values ($1,'earn_clawback',$2,$3,$4)`, [customerId, -clawed, refundId, actor.id]);
      const stillPaid = items.filter((i) => i.status === 'paid' && !wanted.includes(Number(i.id))).length;
      await q.query(`update payments set status = $2 where id = $1`, [paymentId, stillPaid ? 'partially_refunded' : 'refunded']);

      // ---- 7) الكشفية المسترجعة تنلغي مع حجزها (المكان يرجع)، وتبقى المراجعات المجانية المرتبطة بيها تنفحص عند دخولها
      for (const id of wanted) {
        const it = byId.get(id);
        if (it.item_type !== 'consultation') continue;
        const c = cons.get(Number(it.consultation_id))!;
        await q.query(`update consultations set status = 'cancelled' where id = $1`, [it.consultation_id]);
        // زيارة فيها جلسات فعالة (الكشفية انضمت لها): ما نلغي الزيارة ولا نرجع مقعدها، وترجع «محجوز» إذا ما أكو شي مدفوع بيها
        const keep = (await q.query(`select 1 from treatment_sessions where visit_id = $1 and status in ('booked','paid')`, [c.visit_id])).rowCount;
        if (keep) await q.query(`update visits set doctor_id = null, status = case when status = 'arrived' and not exists (select 1 from treatment_sessions where visit_id = $1 and status = 'paid') then 'booked' else status end where id = $1`, [c.visit_id]);
        else {
          await q.query(`update visits set status = 'cancelled', cancelled_at = now(), cancel_reason = 'استرجاع الكشفية' where id = $1 and status in ('booked','arrived')`, [c.visit_id]);
          await q.query(`update booking_days set used_slots = greatest(used_slots - 1, 0) where branch_id = $1 and day = $2`, [branchId, c.visit_date]);
        }
        await q.query(`insert into booking_events (visit_id, consultation_id, event, from_date, from_seq, actor_user_id, reason) values ($1,$2,'cancelled',$3,$4,$5,$6)`,
          [c.visit_id, it.consultation_id, c.visit_date, c.seq_no, actor.id, `استرجاع: ${reason}`]);
      }
      // ---- 8) الجلسة المسترجعة: ترجع «تنتظر حجز» وينحذف حجز موادها، والزيارة اللي تفضى تنلغي ويرجع مقعدها
      const oldVisits = new Set<number>();
      for (const id of wanted) {
        const it = byId.get(id);
        if (it.item_type !== 'session') continue;
        const ss = sess.get(Number(it.session_id))!;
        await q.query(`update treatment_sessions set status = 'awaiting_booking', visit_id = null, scheduled_date = null, version = version + 1 where id = $1`, [it.session_id]);
        await q.query(`delete from session_material_needs where treatment_session_id = $1`, [it.session_id]);
        await q.query(`insert into booking_events (visit_id, treatment_session_id, event, from_date, actor_user_id, reason) values ($1,$2,'cancelled',$3,$4,$5)`, [ss.visit_id, it.session_id, ss.d, actor.id, `استرجاع الجلسة: ${reason}`]);
        if (ss.visit_id !== null) oldVisits.add(ss.visit_id);
      }
      for (const vid of [...oldVisits].sort((a, b) => a - b)) await this.bookings.cancelVisitIfEmpty(q, vid, 'استرجاع الجلسة', actor.id);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'payment.refund', entityType: 'refund', entityId: refundId, reason,
        after: { payment_id: paymentId, refund_no: refundNo, total, items: wanted, points_returned: returned, points_clawed_back: clawed, payout: payoutMethods.lines }, ip });

      const body = await this.viewQ(q, refundId);
      await this.idem.finish(q, actor.id, idemKey, 201, body, 'refund', refundId);
      return { status: 201, body, replay: false };
    });
  }

  async get(actor: AuthUser, id: number) {
    const r = await this.viewQ(this.db, id);
    if (!r || (actor.role !== 'owner' && r.branch_id !== actor.branchId)) throw Errors.notFound('الاسترجاع');
    if (actor.role === 'cashier') {
      const own = (await this.db.query(`select 1 from refunds f join payments p on p.id = f.payment_id where f.id = $1 and p.cashier_id = $2`, [id, actor.id])).rowCount;
      if (!own) throw Errors.notFound('الاسترجاع');
    }
    return r;
  }

  // ================================================================ داخلي
  /** كاش بالكامل إذا ما انذكر شي. وإلا مجموع الأسطر = المبلغ والطرق فعالة بنفس الفرع وغير مكررة. */
  private async payoutLines(q: Queryable, branchId: number, payout: { method_id: number; amount: number }[] | undefined, total: number) {
    let lines = payout ?? [];
    if (!lines.length) {
      const cash = (await q.query(`select id from payment_methods where branch_id = $1 and kind = 'cash' and is_active`, [branchId])).rows[0];
      if (!cash) throw Errors.conflict('METHOD_INVALID', 'ما أكو طريقة كاش فعالة بالفرع');
      lines = [{ method_id: Number(cash.id), amount: total }];
    }
    const ids = lines.map((l) => l.method_id);
    if (new Set(ids).size !== ids.length) throw Errors.badRequest('DUPLICATE_METHOD', 'طريقة الإرجاع مكررة');
    const sum = lines.reduce((a, l) => a + l.amount, 0);
    if (sum !== total) throw Errors.conflictWith('PAYOUT_MISMATCH', 'مجموع طرق الإرجاع لازم يساوي مبلغ الاسترجاع', { refund_total: total, payout_total: sum });
    const { rows } = await q.query(`select id, name_ar, kind, device_label from payment_methods where id = any($1::bigint[]) and branch_id = $2 and is_active`, [ids, branchId]);
    const methods = new Map(rows.map((r) => [Number(r.id), { ...r, id: Number(r.id) }]));
    if (methods.size !== ids.length) throw Errors.conflict('METHOD_INVALID', 'طريقة إرجاع غير موجودة أو معطلة بهذا الفرع');
    return { lines, methods };
  }

  /**
   * كل استرجاع يحفظ طريقتين: الأصلية والفعلية. المبلغ ينقسم على طرق الدفع الأصلية بنسبة الباقي من كل طريقة
   * (حتى ما نتجاوز اللي انقبض بيها)، وبعدين ينقابل بأسطر الإرجاع بالترتيب.
   */
  private async pairWithOriginals(q: Queryable, paymentId: number, total: number, lines: { method_id: number; amount: number }[]) {
    const { rows } = await q.query(
      `select t.method_id, t.amount::bigint - coalesce((select sum(rt.amount) from refund_tenders rt join refunds r on r.id = rt.refund_id
                                                      where r.payment_id = t.payment_id and rt.original_method_id = t.method_id), 0)::bigint as remaining
         from payment_tenders t where t.payment_id = $1 order by t.id`, [paymentId]);
    const originals = rows.map((r) => ({ method_id: Number(r.method_id), remaining: Number(r.remaining) }));
    const shares = allocate(total, originals.map((o) => o.remaining));
    const queue = originals.map((o, i) => ({ method_id: o.method_id, left: shares[i] })).filter((o) => o.left > 0);
    const out: { original_method_id: number; payout_method_id: number; amount: number }[] = [];
    for (const l of lines) {
      let need = l.amount;
      while (need > 0) {
        const o = queue[0];
        const take = Math.min(need, o.left);
        out.push({ original_method_id: o.method_id, payout_method_id: l.method_id, amount: take });
        need -= take; o.left -= take;
        if (o.left === 0) queue.shift();
      }
    }
    return out;
  }

  private async nextRefundNo(q: Queryable, branchId: number): Promise<string> {
    const year = Number((await q.query(`select extract(year from clinic_today())::int as y`)).rows[0].y);
    const n = Number((await q.query(
      `insert into number_counters (branch_id, kind, year, last_value) values ($1,'refund',$2,1)
       on conflict (branch_id, kind, year) do update set last_value = number_counters.last_value + 1 returning last_value`, [branchId, year])).rows[0].last_value);
    return `R-${year}-${String(n).padStart(5, '0')}`;
  }

  private async viewQ(q: Queryable, id: number) {
    const r = (await q.query(
      `select r.*, r.business_date::text as business_date_text, p.receipt_no, p.status as payment_status, u.full_name as cashier_name, c.points_balance
         from refunds r join payments p on p.id = r.payment_id join users u on u.id = r.cashier_id join customers c on c.id = p.customer_id where r.id = $1`, [id])).rows[0];
    if (!r) return null;
    const items = (await q.query(`select ri.payment_item_id, ri.amount, pi.service_name from refund_items ri join payment_items pi on pi.id = ri.payment_item_id where ri.refund_id = $1 order by ri.id`, [id])).rows;
    const tenders = (await q.query(`select * from refund_tenders where refund_id = $1 order by id`, [id])).rows;
    return {
      id: Number(r.id), branch_id: Number(r.branch_id), refund_no: r.refund_no, payment_id: Number(r.payment_id), receipt_no: r.receipt_no, payment_status: r.payment_status,
      shift_id: Number(r.shift_id), cashier: { id: Number(r.cashier_id), full_name: r.cashier_name }, total_amount: Number(r.total_amount),
      points_returned: r.points_returned, points_clawed_back: r.points_clawed_back, points_balance_now: Number(r.points_balance), reason: r.reason,
      refunded_at: r.refunded_at, business_date: r.business_date_text as string,
      items: items.map((i) => ({ payment_item_id: Number(i.payment_item_id), service_name: i.service_name, amount: Number(i.amount) })),
      payouts: tenders.map((t) => ({ original_method_id: Number(t.original_method_id), payout_method_id: Number(t.payout_method_id), payout_method_name: t.payout_method_name, payout_kind: t.payout_kind, device_label: t.device_label, amount: Number(t.amount) })),
    };
  }
}
