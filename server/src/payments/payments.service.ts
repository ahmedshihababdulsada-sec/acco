import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { Errors } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { SettingsService } from '../settings/settings.service';
import { ActiveOffer, OffersService } from '../offers/offers.service';
import { offerDiscount } from '../offers/offer-math';
import { allocate, pointsEarned, roundingDown } from './allocation';
import { IdempotencyService, Replay } from './idempotency.service';
import { PlansService } from '../plans/plans.service';
import { PayConsultationDto, PaySessionsDto } from './payments.dto';

/** عرض سعر: نفس مسار الدفع بالضبط (نفس الأقفال والحساب) لكنه يتوقف قبل الإصدار ويتراجع، فالرقم اللي يشوفه الكاشير هو الرقم اللي ينفرض بالدفع */
class QuoteResult { constructor(readonly quote: Record<string, unknown>) {} }

export interface PayResult { status: number; body: unknown; replay: boolean }

@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: DbService, private readonly audit: AuditService,
    private readonly settings: SettingsService, private readonly idem: IdempotencyService, private readonly plans: PlansService,
  ) {}

  // ================================================================ دفع الكشفية
  /**
   * «تم دفع الكشفية»: كل شي بمعاملة وحدة (الوصل، البنود، طرق الدفع، النقاط، حالة الكشفية والزيارة).
   * ترتيب الأقفال: الكشفية والزيارة ← الزبون (النقاط) ← الشفت (مشاركة) ← طلب الخصم ← عداد الوصل.
   */
  /** عرض سعر الكشفية (للكاشير قبل الدفع): نفس الحساب بدون إصدار */
  async quoteConsultation(actor: AuthUser, dto: PayConsultationDto) {
    try { await this.payConsultation(actor, dto, undefined, null, true); } catch (e) { if (e instanceof QuoteResult) return e.quote; throw e; }
    throw new Error('quote did not stop');
  }

  async payConsultation(actor: AuthUser, dto: PayConsultationDto, key: string | undefined, ip: string | null, quote = false): Promise<PayResult> {
    const idemKey = quote ? '' : IdempotencyService.validate(key);
    return this.db.tx(async (q): Promise<PayResult> => {
      if (!quote) {
        const replay: Replay | null = await this.idem.begin(q, actor.id, idemKey, 'POST /payments/consultation', dto);
        if (replay) return { ...replay, replay: true };
      }

      const c = await this.lockConsultation(q, actor, dto.consultation_id);
      if (c.status === 'paid' || c.status === 'with_doctor' || c.status === 'finished') throw Errors.conflict('ALREADY_PAID', 'الكشفية مدفوعة');
      if (c.status !== 'awaiting_payment') throw Errors.conflict('CONSULTATION_NOT_PAYABLE', 'هذي الكشفية ما تنقبل دفع (ملغاة)');
      if (!['booked', 'arrived'].includes(c.visit_status)) throw Errors.conflict('CONSULTATION_NOT_PAYABLE', 'الحجز مو فعال');       // «حضر» ممكن: زيارة جلسات انفتحت قبل (دفع جلسة) وانضمت لها الكشفية
      await this.assertToday(q, c);
      // «جلسات فقط»: سعرها من إعداد الفرع (الافتراضي 0 = مجانية فتدخل بدون دفع)، مو سعر الكشفية العادية
      let sessionsOnlyFee: number | null = null;
      if (c.kind === 'sessions_only') {
        sessionsOnlyFee = await this.settings.effective<number>(q, c.branch_id, 'consultation.sessions_only_fee');
        if (sessionsOnlyFee <= 0) throw Errors.conflict('FREE_CONSULTATION', 'هذي كشفية «جلسات فقط» مجانية: أدخل الزبون بدون دفع');
      }
      if (c.kind === 'free_followup') {
        if (await this.followupEligible(q, c)) throw Errors.conflict('FREE_FOLLOWUP', 'هذي مراجعة مجانية: أدخل الزبون بدون دفع');
        // ما عاد تنطبق عليها المجانية (الكشفية الأصلية انرجعت أو المدة انتهت): تتحول كشفية جديدة وتنحسب
        await q.query(`update consultations set kind = 'new', parent_consultation_id = null where id = $1`, [c.id]);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: c.branch_id, action: 'consultation.followup_to_new', entityType: 'consultation', entityId: c.id, before: { parent: c.parent_consultation_id } });
      }

      const customer = (await q.query(`select id, points_balance from customers where id = $1 for update`, [c.customer_id])).rows[0];
      const shift = (await q.query(`select id, branch_id from shifts where cashier_id = $1 and status = 'open' for share`, [actor.id])).rows[0];
      if (!shift) throw Errors.conflict('NO_OPEN_SHIFT', 'افتح شفتك أول');
      if (Number(shift.branch_id) !== c.branch_id) throw Errors.conflict('SHIFT_BRANCH_MISMATCH', 'شفتك المفتوح بفرع ثاني');

      // ---- السعر: سعر لحظة الدفع للكشفية الفعالة بالفرع
      const svc = (await q.query(`select id, name_ar from services where branch_id = $1 and kind = 'consultation' and is_active`, [c.branch_id])).rows[0];
      if (!svc) throw Errors.conflict('CONSULTATION_NOT_CONFIGURED', 'الكشفية غير مفعلة: المدير يحدد سعرها ويفعلها');
      const priceRow = (await q.query(`select price from service_prices where service_id = $1 and effective_from <= clock_timestamp() order by effective_from desc limit 1`, [svc.id])).rows[0];
      if (!priceRow) throw Errors.conflict('CONSULTATION_NOT_CONFIGURED', 'ما أكو سعر للكشفية');
      const gross = sessionsOnlyFee ?? Number(priceRow.price);
      const itemName = sessionsOnlyFee !== null ? `${svc.name_ar} (جلسات فقط)` : svc.name_ar;

      // ---- الخصم اليدوي المعتمد
      let manual = 0; let discountId: number | null = null;
      if (dto.discount_request_id !== undefined) {
        const d = (await q.query(`select *, ((requested_at at time zone 'Asia/Baghdad')::date < clinic_today()) as stale from discount_requests where id = $1 for update`, [dto.discount_request_id])).rows[0];
        if (!d || Number(d.branch_id) !== c.branch_id || Number(d.customer_id) !== c.customer_id || (d.visit_id !== null && Number(d.visit_id) !== c.visit_id))
          throw Errors.conflict('DISCOUNT_NOT_USABLE', 'طلب الخصم غير صالح لهذا الزبون');
        if (d.status !== 'approved') throw Errors.conflict('DISCOUNT_NOT_USABLE', d.status === 'used' ? 'طلب الخصم انستخدم' : 'طلب الخصم مو معتمد');
        if (d.stale) throw Errors.conflict('DISCOUNT_NOT_USABLE', 'طلب الخصم من يوم سابق وانتهى');
        if (Number(d.amount) > gross) throw Errors.conflict('DISCOUNT_TOO_LARGE', 'الخصم أكبر من مبلغ الوصل');
        manual = Number(d.amount); discountId = Number(d.id);
      }

      // ---- النقاط: باختيار الزبون، لحد السقف من المبلغ بعد العرض والخصم اليدوي، والرصيد الموجب فقط
      const S = async (k: string) => this.settings.effective<number>(q, c.branch_id, k);
      // بالتسلسل: اتصال المعاملة الواحد ما يشغّل أكثر من استعلام بنفس اللحظة
      const perAmount = await S('points.earn_per_amount'); const earnPts = await S('points.earn_points'); const pointValue = await S('points.point_value');
      const minRedeem = await S('points.min_redeem'); const maxPercent = await S('points.max_percent'); const step = await S('money.rounding_step');
      const base = gross - manual;
      let pointsUsed = 0;
      if (dto.redeem_points) {
        const balance = Number(customer.points_balance);
        const capAmount = Math.floor((base * maxPercent) / 100);
        pointsUsed = Math.min(Math.max(balance, 0), Math.floor(capAmount / pointValue));
        if (balance < Math.max(minRedeem, 1) || pointsUsed <= 0) throw Errors.conflict('POINTS_NOT_AVAILABLE', 'رصيد النقاط ما يكفي للاستخدام على هذا الوصل');
      }
      const pointsDiscount = pointsUsed * pointValue;
      const preRound = base - pointsDiscount;
      const rounding = roundingDown(preRound, step);
      const net = preRound - rounding;

      // ---- توزيع الخصم والنقاط والتقريب على البنود (هنا بند وحد، لكن نفس المنطق لوصل الجلسات)
      const [manualShare] = allocate(manual, [gross]);
      const [pointsShare] = allocate(pointsUsed, [gross]);
      const [roundShare] = allocate(rounding, [gross]);
      const itemNet = gross - manualShare - pointsShare * pointValue - roundShare;
      if (itemNet !== net) throw new Error(`خلل حسابي: ${itemNet} != ${net}`);
      if (quote) throw new QuoteResult({ gross_amount: gross, offer_discount: 0, manual_discount: manual, points_used: pointsUsed, points_discount: pointsDiscount, rounding_amount: rounding, net_amount: net,
        points_earned: pointsEarned(net, perAmount, earnPts), points_balance: Number(customer.points_balance), items: [{ service_name: itemName, list_price: gross, offer_percent: null, offer_discount: 0, net_amount: net }] });

      // ---- طرق الدفع
      const tenders = dto.tenders ?? [];
      const methods = await this.validateTenders(q, c.branch_id, tenders, net);

      // ---- الإصدار
      const receiptNo = await this.nextReceiptNo(q, c.branch_id);
      const snap = await this.clinicSnapshot(q, c.branch_id);
      const earned = pointsEarned(net, perAmount, earnPts);
      const pay = (await q.query(
        `insert into payments (branch_id, receipt_no, customer_id, visit_id, shift_id, cashier_id, kind, gross_amount, manual_discount, points_discount, rounding_amount,
                               net_amount, points_used, points_earned, discount_request_id, clinic_snapshot)
         values ($1,$2,$3,$4,$5,$6,'consultation',$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
        [c.branch_id, receiptNo, c.customer_id, c.visit_id, shift.id, actor.id, gross, manual, pointsDiscount, rounding, net, pointsUsed, earned, discountId, JSON.stringify(snap)])).rows[0];
      const paymentId = Number(pay.id);
      await q.query(
        `insert into payment_items (payment_id, item_type, consultation_id, service_id, service_name, quantity, list_price, manual_discount_share, points_discount_share, points_used_share, rounding_share, net_amount, pricing_snapshot)
         values ($1,'consultation',$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11)`,
        [paymentId, c.id, svc.id, itemName, gross, manualShare, pointsShare * pointValue, pointsShare, roundShare, itemNet, JSON.stringify({ unit_price: gross, kind: sessionsOnlyFee !== null ? 'consultation_sessions_only' : 'consultation' })]);
      for (const t of tenders) {
        const m = methods.get(t.method_id)!;
        await q.query(`insert into payment_tenders (payment_id, method_id, method_name, method_kind, device_label, amount, reference) values ($1,$2,$3,$4,$5,$6,$7)`,
          [paymentId, m.id, m.name_ar, m.kind, m.device_label, t.amount, t.reference?.trim() || null]);
      }
      if (pointsUsed > 0) await q.query(`insert into points_ledger (customer_id, entry_type, points, payment_id, created_by) values ($1,'redeem',$2,$3,$4)`, [c.customer_id, -pointsUsed, paymentId, actor.id]);
      if (earned > 0) await q.query(`insert into points_ledger (customer_id, entry_type, points, payment_id, created_by) values ($1,'earn',$2,$3,$4)`, [c.customer_id, earned, paymentId, actor.id]);
      if (discountId !== null) await q.query(`update discount_requests set status = 'used' where id = $1`, [discountId]);
      await q.query(`update consultations set status = 'paid' where id = $1`, [c.id]);
      await q.query(`update visits set status = 'arrived' where id = $1`, [c.visit_id]);
      await q.query(`insert into booking_events (visit_id, consultation_id, event, to_date, to_seq, actor_user_id) values ($1,$2,'arrived',$3,$4,$5)`, [c.visit_id, c.id, c.visit_date, c.seq_no, actor.id]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: c.branch_id, action: 'payment.consultation', entityType: 'payment', entityId: paymentId,
        after: { receipt_no: receiptNo, gross, manual, points_used: pointsUsed, rounding, net, earned, tenders: tenders.map((t) => ({ method_id: t.method_id, amount: t.amount })) }, ip });

      const body = await this.receiptQ(q, paymentId);
      await this.idem.finish(q, actor.id, idemKey, 201, body, 'payment', paymentId);
      return { status: 201, body, replay: false };
    });
  }

  // ================================================================ دفع الجلسات
  /**
   * «تم الدفع» للجلسات: الكاشير يختار من جلسات الزبون المحجوزة **اليوم** (الجلسة ما تندفع مقدماً). السعر سعر لحظة الدفع من قيم الخطة،
   * والخصم المعتمد والنقاط والتقريب تتوزع على الجلسات بأكبر البواقي. تنحفظ المواد المحجوزة (`session_material_needs`) والجلسة تصير «مدفوعة».
   * ترتيب الأقفال: الزيارة ← الجلسات (بالمعرّف) ← الزبون ← الشفت ← طلب الخصم ← عداد الوصل.
   */
  /** عرض سعر الجلسات (للكاشير قبل الدفع): نفس الحساب بدون إصدار */
  async quoteSessions(actor: AuthUser, dto: PaySessionsDto) {
    try { await this.paySessions(actor, dto, undefined, null, true); } catch (e) { if (e instanceof QuoteResult) return e.quote; throw e; }
    throw new Error('quote did not stop');
  }

  async paySessions(actor: AuthUser, dto: PaySessionsDto, key: string | undefined, ip: string | null, quote = false): Promise<PayResult> {
    const idemKey = quote ? '' : IdempotencyService.validate(key);
    return this.db.tx(async (q): Promise<PayResult> => {
      if (!quote) {
        const replay: Replay | null = await this.idem.begin(q, actor.id, idemKey, 'POST /payments/sessions', { ...dto, session_ids: [...dto.session_ids].sort((a, b) => a - b) });
        if (replay) return { ...replay, replay: true };
      }

      const ids = [...dto.session_ids].sort((a, b) => a - b);
      const head = (await q.query(`select id, customer_id, branch_id, visit_id from treatment_sessions where id = any($1::bigint[])`, [ids])).rows;
      if (head.length !== ids.length) throw Errors.notFound('الجلسة');
      if (actor.role !== 'owner' && head.some((h) => Number(h.branch_id) !== actor.branchId)) throw Errors.notFound('الجلسة');
      if (new Set(head.map((h) => Number(h.customer_id))).size !== 1) throw Errors.badRequest('MIXED_CUSTOMERS', 'الجلسات لازم لنفس الزبون');
      const customerId = Number(head[0].customer_id); const branchId = Number(head[0].branch_id);
      const visitIds = [...new Set(head.filter((h) => h.visit_id !== null).map((h) => Number(h.visit_id)))].sort((a, b) => a - b);
      const visits = new Map<number, { status: string; date: string }>();
      for (const vid of visitIds) {
        const v = (await q.query(`select status, visit_date::text as d from visits where id = $1 for update`, [vid])).rows[0];
        visits.set(vid, { status: v.status, date: v.d });
      }
      const sessions = (await q.query(
        `select s.id, s.status, s.visit_id, s.plan_item_id, s.seq_no, s.scheduled_date::text as d from treatment_sessions s where s.id = any($1::bigint[]) order by s.id for update of s`, [ids])).rows;
      const today = (await q.query(`select clinic_today()::text as d`)).rows[0].d;
      for (const s of sessions) {
        if (s.status === 'paid' || s.status === 'completed') throw Errors.conflict('SESSION_ALREADY_PAID', 'الجلسة مدفوعة مسبقاً');
        if (s.status !== 'booked') throw Errors.conflict('SESSION_NOT_PAYABLE', 'الجلسة مو محجوزة (تنتظر حجز أو ملغاة)');
        if (s.d !== today) throw Errors.conflictWith('NOT_TODAY', s.d > today ? 'الجلسة موعدها مو اليوم: الدفع يكون بيوم الجلسة' : 'موعد الجلسة مضى: انقلها لليوم أول', { session_id: Number(s.id), scheduled_date: s.d, today });
        if (!['booked', 'arrived'].includes(visits.get(Number(s.visit_id))!.status)) throw Errors.conflict('SESSION_NOT_PAYABLE', 'زيارة الجلسة مو فعالة');
      }
      const visitId = visitIds.length === 1 ? visitIds[0] : null;

      const customer = (await q.query(`select id, points_balance from customers where id = $1 for update`, [customerId])).rows[0];
      const shift = (await q.query(`select id, branch_id from shifts where cashier_id = $1 and status = 'open' for share`, [actor.id])).rows[0];
      if (!shift) throw Errors.conflict('NO_OPEN_SHIFT', 'افتح شفتك أول');
      if (Number(shift.branch_id) !== branchId) throw Errors.conflict('SHIFT_BRANCH_MISMATCH', 'شفتك المفتوح بفرع ثاني');

      // ---- السعر بسعر لحظة الدفع من قيم الخطة
      const priced: { s: any; svcId: number; svcName: string; quote: Awaited<ReturnType<PlansService['quotePlanItem']>>['quote'] }[] = [];
      for (const s of sessions) {
        const { svc, quote } = await this.plans.quotePlanItem(q, Number(s.plan_item_id));
        priced.push({ s, svcId: svc.id, svcName: svc.name_ar, quote });
      }
      const lists = priced.map((p) => p.quote.list_price);
      const gross = lists.reduce((a, b) => a + b, 0);
      // ---- العرض الفعال اليوم لكل خدمة (ينطبق تلقائياً): السعر ← العرض ← الخصم اليدوي ← النقاط
      const offers: (ActiveOffer | null)[] = [];
      for (const p of priced) offers.push(await OffersService.activeFor(q, branchId, p.svcId));
      const offerDisc = lists.map((l, i) => (offers[i] ? offerDiscount(l, offers[i]!.percent) : 0));
      const offerTotal = offerDisc.reduce((a, b) => a + b, 0);
      const afterOffer = lists.map((l, i) => l - offerDisc[i]);
      const grossAfterOffer = gross - offerTotal;

      let manual = 0; let discountId: number | null = null;
      if (dto.discount_request_id !== undefined) {
        const d = (await q.query(`select *, ((requested_at at time zone 'Asia/Baghdad')::date < clinic_today()) as stale from discount_requests where id = $1 for update`, [dto.discount_request_id])).rows[0];
        if (!d || Number(d.branch_id) !== branchId || Number(d.customer_id) !== customerId || (d.visit_id !== null && Number(d.visit_id) !== visitId))
          throw Errors.conflict('DISCOUNT_NOT_USABLE', 'طلب الخصم غير صالح لهذا الزبون');
        if (d.status !== 'approved') throw Errors.conflict('DISCOUNT_NOT_USABLE', d.status === 'used' ? 'طلب الخصم انستخدم' : 'طلب الخصم مو معتمد');
        if (d.stale) throw Errors.conflict('DISCOUNT_NOT_USABLE', 'طلب الخصم من يوم سابق وانتهى');
        if (Number(d.amount) > grossAfterOffer) throw Errors.conflict('DISCOUNT_TOO_LARGE', 'الخصم أكبر من مبلغ الوصل');
        manual = Number(d.amount); discountId = Number(d.id);
      }
      const S = async (k: string) => this.settings.effective<number>(q, branchId, k);
      const perAmount = await S('points.earn_per_amount'); const earnPts = await S('points.earn_points'); const pointValue = await S('points.point_value');
      const minRedeem = await S('points.min_redeem'); const maxPercent = await S('points.max_percent'); const step = await S('money.rounding_step');
      const base = grossAfterOffer - manual;
      let pointsUsed = 0;
      if (dto.redeem_points) {
        const balance = Number(customer.points_balance);
        const capAmount = Math.floor((base * maxPercent) / 100);
        pointsUsed = Math.min(Math.max(balance, 0), Math.floor(capAmount / pointValue));
        if (balance < Math.max(minRedeem, 1) || pointsUsed <= 0) throw Errors.conflict('POINTS_NOT_AVAILABLE', 'رصيد النقاط ما يكفي للاستخدام على هذا الوصل');
      }
      const pointsDiscount = pointsUsed * pointValue;
      const preRound = base - pointsDiscount;
      const rounding = roundingDown(preRound, step);
      const net = preRound - rounding;

      // ---- توزيع الخصم والنقاط والتقريب على الجلسات (أكبر البواقي): كل بند يعرف حصته والاسترجاع يرجع صافيه بالضبط
      const manualShares = allocate(manual, afterOffer);
      const baseI = afterOffer.map((l, i) => l - manualShares[i]);
      const pointShares = allocate(pointsUsed, baseI);
      const remI = baseI.map((b, i) => b - pointShares[i] * pointValue);
      const roundShares = allocate(rounding, remI);
      const netI = remI.map((r, i) => r - roundShares[i]);
      if (netI.reduce((a, b) => a + b, 0) !== net || netI.some((n) => n < 0)) throw new Error('خلل حسابي بتوزيع وصل الجلسات');
      if (quote) throw new QuoteResult({ gross_amount: gross, offer_discount: offerTotal, manual_discount: manual, points_used: pointsUsed, points_discount: pointsDiscount, rounding_amount: rounding, net_amount: net,
        points_earned: pointsEarned(net, perAmount, earnPts), points_balance: Number(customer.points_balance),
        items: priced.map((p, i) => ({ session_id: Number(p.s.id), service_name: p.svcName, list_price: lists[i], offer_percent: offers[i] ? Number(offers[i]!.percent) : null, offer_discount: offerDisc[i], net_amount: netI[i] })) });

      const tenders = dto.tenders ?? [];
      const methods = await this.validateTenders(q, branchId, tenders, net);
      const receiptNo = await this.nextReceiptNo(q, branchId);
      const snap = await this.clinicSnapshot(q, branchId);
      const earned = pointsEarned(net, perAmount, earnPts);
      const pay = (await q.query(
        `insert into payments (branch_id, receipt_no, customer_id, visit_id, shift_id, cashier_id, kind, gross_amount, offer_discount, manual_discount, points_discount, rounding_amount,
                               net_amount, points_used, points_earned, discount_request_id, clinic_snapshot)
         values ($1,$2,$3,$4,$5,$6,'sessions',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
        [branchId, receiptNo, customerId, visitId, shift.id, actor.id, gross, offerTotal, manual, pointsDiscount, rounding, net, pointsUsed, earned, discountId, JSON.stringify(snap)])).rows[0];
      const paymentId = Number(pay.id);
      for (const [i, p] of priced.entries()) {
        await q.query(
          `insert into payment_items (payment_id, item_type, session_id, service_id, service_name, quantity, list_price, offer_id, offer_percent, offer_discount, manual_discount_share, points_discount_share, points_used_share, rounding_share, net_amount, pricing_snapshot)
           values ($1,'session',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [paymentId, p.s.id, p.svcId, p.svcName, p.quote.quantity ?? '1', lists[i], offers[i]?.id ?? null, offers[i]?.percent ?? null, offerDisc[i], manualShares[i], pointShares[i] * pointValue, pointShares[i], roundShares[i], netI[i], JSON.stringify(p.quote.snapshot)]);
        await q.query(`update treatment_sessions set status = 'paid', version = version + 1 where id = $1`, [p.s.id]);
        for (const c of p.quote.consumption) await q.query(`insert into session_material_needs (treatment_session_id, material_id, qty_base) values ($1,$2,$3)`, [p.s.id, c.material_id, c.qty_base]);   // المحجوز
      }
      for (const t of tenders) {
        const m = methods.get(t.method_id)!;
        await q.query(`insert into payment_tenders (payment_id, method_id, method_name, method_kind, device_label, amount, reference) values ($1,$2,$3,$4,$5,$6,$7)`,
          [paymentId, m.id, m.name_ar, m.kind, m.device_label, t.amount, t.reference?.trim() || null]);
      }
      if (pointsUsed > 0) await q.query(`insert into points_ledger (customer_id, entry_type, points, payment_id, created_by) values ($1,'redeem',$2,$3,$4)`, [customerId, -pointsUsed, paymentId, actor.id]);
      if (earned > 0) await q.query(`insert into points_ledger (customer_id, entry_type, points, payment_id, created_by) values ($1,'earn',$2,$3,$4)`, [customerId, earned, paymentId, actor.id]);
      if (discountId !== null) await q.query(`update discount_requests set status = 'used' where id = $1`, [discountId]);
      for (const vid of visitIds) {
        if (visits.get(vid)!.status === 'booked') {
          await q.query(`update visits set status = 'arrived' where id = $1`, [vid]);
          const vv = (await q.query(`select visit_date::text as d, seq_no from visits where id = $1`, [vid])).rows[0];
          await q.query(`insert into booking_events (visit_id, event, to_date, to_seq, actor_user_id) values ($1,'arrived',$2,$3,$4)`, [vid, vv.d, vv.seq_no, actor.id]);
        }
      }
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'payment.sessions', entityType: 'payment', entityId: paymentId,
        after: { receipt_no: receiptNo, sessions: ids, gross, offer: offerTotal, manual, points_used: pointsUsed, rounding, net, earned }, ip });

      const body = await this.receiptQ(q, paymentId);
      await this.idem.finish(q, actor.id, idemKey, 201, body, 'payment', paymentId);
      return { status: 201, body, replay: false };
    });
  }

  // ================================================================ مراجعة مجانية: الدخول بدون دفع
  async checkInFree(actor: AuthUser, consultationId: number, ip: string | null) {
    return this.db.tx(async (q) => {
      const c = await this.lockConsultation(q, actor, consultationId);
      if (c.kind === 'sessions_only') {
        if ((await this.settings.effective<number>(q, c.branch_id, 'consultation.sessions_only_fee')) > 0) throw Errors.conflict('PAYMENT_REQUIRED', 'كشفية «جلسات فقط» لها سعر: لازم تندفع');
      } else if (c.kind !== 'free_followup') throw Errors.conflict('PAYMENT_REQUIRED', 'هذي كشفية جديدة: لازم تندفع');
      if (c.status !== 'awaiting_payment' || !['booked', 'arrived'].includes(c.visit_status)) throw Errors.conflict('NOT_CHECKABLE', 'المراجعة مدخلة مسبقاً أو غير فعالة');
      await this.assertToday(q, c);
      if (c.kind === 'free_followup' && !(await this.followupEligible(q, c))) throw Errors.conflict('FOLLOWUP_NOT_ELIGIBLE', 'ما تنطبق عليها المراجعة المجانية (الكشفية الأصلية أو المدة): لازم تندفع كشفية');
      await q.query(`update consultations set status = 'paid' where id = $1`, [c.id]);
      await q.query(`update visits set status = 'arrived' where id = $1`, [c.visit_id]);
      await q.query(`insert into booking_events (visit_id, consultation_id, event, to_date, to_seq, actor_user_id, reason) values ($1,$2,'arrived',$3,$4,$5,'مراجعة مجانية')`, [c.visit_id, c.id, c.visit_date, c.seq_no, actor.id]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: c.branch_id, action: 'consultation.free_checkin', entityType: 'consultation', entityId: c.id, ip });
      return { consultation_id: c.id, visit_id: c.visit_id, status: 'paid', visit_status: 'arrived', seq_no: c.seq_no, kind: c.kind };
    });
  }

  /**
   * إلغاء دخول مراجعة مجانية (انفتحت بدون وصل) قبل ما يفتح الطبيب ملف الزبون: الكشفية والحجز ينلغون ويرجع المكان.
   * (الكشفية المدفوعة بوصل تنلغي بالاسترجاع، وهذا المسار للمراجعة المجانية بس.)
   */
  async cancelFreeCheckIn(actor: AuthUser, consultationId: number, reason: string, ip: string | null) {
    const why = reason.trim();
    if (why.length < 3) throw Errors.badRequest('REASON_REQUIRED', 'اكتب سبب الإلغاء');
    return this.db.tx(async (q) => {
      const c = await this.lockConsultation(q, actor, consultationId);
      if (c.kind !== 'free_followup' && c.kind !== 'sessions_only') throw Errors.conflict('NOT_FREE_FOLLOWUP', 'هذي كشفية مدفوعة: تنلغي بالاسترجاع');
      if ((await q.query(`select 1 from payment_items where consultation_id = $1 and status = 'paid'`, [c.id])).rowCount) throw Errors.conflict('NOT_FREE_FOLLOWUP', 'هذي كشفية مدفوعة: تنلغي بالاسترجاع');
      if (c.status === 'with_doctor' || c.status === 'finished') throw Errors.conflict('CONSULTATION_ENTERED', 'الزبون دخل للطبيب: ما ينلغي');
      if (c.status !== 'paid' || c.visit_status !== 'arrived') throw Errors.conflict('NOT_CANCELLABLE', 'المراجعة مو بحالة «حضر»: إذا ما انفتحت إلغيها من الحجز');
      await q.query(`update consultations set status = 'cancelled' where id = $1`, [c.id]);
      // الزيارة فيها جلسات فعالة (الكشفية انضمت لها): نلغي الكشفية بس والزيارة تبقى، وترجع «محجوز» إذا ما أكو شي مدفوع بيها
      const keep = (await q.query(`select 1 from treatment_sessions where visit_id = $1 and status in ('booked','paid')`, [c.visit_id])).rowCount;
      if (keep) await q.query(`update visits set doctor_id = null, status = case when status = 'arrived' and not exists (select 1 from treatment_sessions where visit_id = $1 and status = 'paid') then 'booked' else status end where id = $1`, [c.visit_id]);
      else {
        await q.query(`update visits set status = 'cancelled', cancelled_at = now(), cancel_reason = $2 where id = $1`, [c.visit_id, why]);
        await q.query(`update booking_days set used_slots = greatest(used_slots - 1, 0) where branch_id = $1 and day = $2`, [c.branch_id, c.visit_date]);
      }
      await q.query(`insert into booking_events (visit_id, consultation_id, event, from_date, from_seq, actor_user_id, reason) values ($1,$2,'cancelled',$3,$4,$5,$6)`, [c.visit_id, c.id, c.visit_date, c.seq_no, actor.id, `إلغاء دخول مجاني: ${why}`]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: c.branch_id, action: 'consultation.free_checkin_cancel', entityType: 'consultation', entityId: c.id, reason: why, ip });
      const vs = (await q.query(`select status from visits where id = $1`, [c.visit_id])).rows[0].status as string;
      return { consultation_id: c.id, visit_id: c.visit_id, status: 'cancelled', visit_status: vs };
    });
  }

  // ================================================================ القراءة
  async get(actor: AuthUser, id: number) {
    const r = await this.receiptQ(this.db, id);
    if (!r || (actor.role !== 'owner' && r.branch_id !== actor.branchId)) throw Errors.notFound('الوصل');
    if (actor.role === 'cashier' && r.cashier.id !== actor.id) throw Errors.notFound('الوصل');     // الكاشير يشوف وصولاته هو بس (اللي حاسب عليها وفلوسها بشفته)
    return r;
  }

  /** بحث للكاشير: برقم الوصل أو الزبون أو الشفت أو اليوم (إذا ضاع رد الدفع). */
  async list(actor: AuthUser, p: { receiptNo?: string; customerId?: number; shiftId?: number; date?: string; branchId?: number }) {
    if (!p.receiptNo && !p.customerId && !p.shiftId && !p.date) throw Errors.badRequest('FILTER_REQUIRED', 'حدد رقم الوصل أو الزبون أو الشفت أو اليوم');
    if (p.date && !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw Errors.badRequest('INVALID_DATE', 'التاريخ بصيغة YYYY-MM-DD');
    const branch = actor.role === 'owner' ? p.branchId ?? null : actor.branchId;
    const onlyCashier = actor.role === 'cashier' ? actor.id : null;          // الكاشير وصولاته هو فقط؛ المدير والمالك يشوفون الكل
    const { rows } = await this.db.query(
      `select id from payments where ($1::bigint is null or branch_id = $1) and ($2::text is null or receipt_no = $2) and ($3::bigint is null or customer_id = $3)
          and ($4::bigint is null or shift_id = $4) and ($5::date is null or business_date = $5) and ($6::bigint is null or cashier_id = $6) order by id desc limit 50`,
      [branch, p.receiptNo ?? null, p.customerId ?? null, p.shiftId ?? null, p.date ?? null, onlyCashier]);
    return Promise.all(rows.map((r) => this.receiptQ(this.db, Number(r.id))));
  }

  /** تسجيل طباعة الوصل (أول مرة أو إعادة). نجاح الدفع ما يعتمد عليها. */
  async recordPrint(actor: AuthUser, id: number, note: string | undefined, ip: string | null) {
    return this.db.tx((q) => this.printTx(q, actor, id, note, ip));
  }

  private async printTx(q: Queryable, actor: AuthUser, id: number, note: string | undefined, ip: string | null) {
    const p = (await q.query(`select id, branch_id from payments where id = $1`, [id])).rows[0];
    if (!p || (actor.role !== 'owner' && Number(p.branch_id) !== actor.branchId)) throw Errors.notFound('الوصل');
    await q.query(`select 1 from payments where id = $1 for update`, [id]);                       // تسلسل الطباعات المتزامنة: واحدة فقط «أولى»
    const prior = (await q.query(`select count(*)::int as n from receipt_prints where payment_id = $1`, [id])).rows[0].n;
    const row = (await q.query(`insert into receipt_prints (payment_id, printed_by, is_reprint, note) values ($1,$2,$3,$4) returning printed_at`, [id, actor.id, prior > 0, note?.trim() || null])).rows[0];
    await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(p.branch_id), action: prior > 0 ? 'receipt.reprint' : 'receipt.print', entityType: 'payment', entityId: id, ip });
    return { payment_id: id, is_reprint: prior > 0, printed_at: row.printed_at, print_count: prior + 1 };
  }

  /** طباعة وصل واحد جامع (كشفية + جلسات): تسجيل الطباعة لكل وصل مشمول بمعاملة وحدة (الكل أو ولا شي). */
  async recordPrintBatch(actor: AuthUser, ids: number[], note: string | undefined, ip: string | null) {
    const sorted = [...new Set(ids)].sort((a, b) => a - b);                                      // ترتيب ثابت للأقفال
    return this.db.tx(async (q) => {
      const out = [];
      for (const id of sorted) out.push(await this.printTx(q, actor, id, note, ip));
      return { prints: out };
    });
  }

  /**
   * وصل اليوم الجامع للزبون: كل وصولاته «المدفوعة» بيوم العمل (كشفية + جلسات...) بوصل واحد للطباعة مرة وحدة بنهاية الزيارة.
   * الأرقام كلها من الخادم (مجاميع الوصولات)؛ كل وصل يبقى سجل مستقل (ترقيمه واسترجاعه)، وهذا مجرد عرض طباعة موحد.
   * الوصولات المسترجعة (كلياً أو جزئياً) ما تدخل: تنطبع منفردة من سجل الوصولات.
   */
  async dayReceipt(actor: AuthUser, customerId: number, date?: string) {
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) throw Errors.badRequest('INVALID_DATE', 'التاريخ بصيغة YYYY-MM-DD');
    const day = date ?? (await this.db.query(`select clinic_today()::text as d`)).rows[0].d;
    const branch = actor.role === 'owner' ? null : actor.branchId;
    const { rows } = await this.db.query(
      `select id from payments where customer_id = $1 and business_date = $2 and status = 'paid' and ($3::bigint is null or branch_id = $3) order by id`, [customerId, day, branch]);
    if (!rows.length) throw Errors.notFound('وصولات اليوم');
    const parts: NonNullable<Awaited<ReturnType<PaymentsService['receiptQ']>>>[] = [];
    for (const r of rows) parts.push((await this.receiptQ(this.db, Number(r.id)))!);
    const sum = (f: (p: (typeof parts)[number]) => number) => parts.reduce((a, p) => a + f(p), 0);
    const tenders = new Map<string, (typeof parts)[number]['tenders'][number]>();
    for (const p of parts) for (const t of p.tenders) { const k = `${t.method_id}|${t.device_label ?? ''}`; const cur = tenders.get(k); tenders.set(k, cur ? { ...cur, amount: cur.amount + t.amount } : { ...t }); }
    const last = parts[parts.length - 1];
    const cashiers = [...new Set(parts.map((p) => p.cashier.full_name))];
    return {
      id: last.id, branch_id: last.branch_id, receipt_no: parts.map((p) => p.receipt_no).join(' + '), receipt_numbers: parts.map((p) => p.receipt_no),
      kind: parts.length > 1 ? 'combined' : last.kind, status: 'paid', customer: last.customer, cashier: { id: last.cashier.id, full_name: cashiers.join('، ') },
      paid_at: last.paid_at, business_date: day, clinic: last.clinic,
      gross_amount: sum((p) => p.gross_amount), offer_discount: sum((p) => p.offer_discount), manual_discount: sum((p) => p.manual_discount), points_discount: sum((p) => p.points_discount),
      rounding_amount: sum((p) => p.rounding_amount), net_amount: sum((p) => p.net_amount), points_used: sum((p) => p.points_used), points_earned: sum((p) => p.points_earned), points_balance_now: last.points_balance_now,
      items: parts.flatMap((p) => p.items), tenders: [...tenders.values()],
      // mine: الوصل حاسب عليه هذا المستخدم (وصل كاشير ثاني يبان بالورقة الجامعة بس ما ينفتح ولا ينسترجع من عنده)
      payments: parts.map((p) => ({ id: p.id, receipt_no: p.receipt_no, kind: p.kind, net_amount: p.net_amount, print_count: p.print_count, mine: p.cashier.id === actor.id })),
      payment_ids: parts.map((p) => p.id), unprinted: parts.filter((p) => p.print_count === 0).length,
      print_count: Math.min(...parts.map((p) => p.print_count)), refunded_total: 0, refunds: [],
    };
  }

  // ================================================================ داخلي
  private async lockConsultation(q: Queryable, actor: AuthUser, id: number) {
    const r = (await q.query(
      `select c.id, c.branch_id, c.visit_id, c.customer_id, c.doctor_id, c.kind, c.parent_consultation_id, c.status,
              v.visit_date::text as visit_date, v.seq_no, v.status as visit_status
         from consultations c join visits v on v.id = c.visit_id where c.id = $1 for update of c, v`, [id])).rows[0];
    if (!r || (actor.role !== 'owner' && Number(r.branch_id) !== actor.branchId)) throw Errors.notFound('الكشفية');
    const n = (x: unknown) => (x === null ? null : Number(x));
    return { id: Number(r.id), branch_id: Number(r.branch_id), visit_id: Number(r.visit_id), customer_id: Number(r.customer_id), doctor_id: Number(r.doctor_id), kind: r.kind as string,
      parent_consultation_id: n(r.parent_consultation_id), status: r.status as string, visit_date: r.visit_date as string, seq_no: Number(r.seq_no), visit_status: r.visit_status as string };
  }

  /** الدفع والدخول بيوم الحجز نفسه بس (اليوم هو يوم الأسبقية بالرقم). غير هيج الكاشير ينقل الحجز لليوم أول. */
  private async assertToday(q: Queryable, c: { visit_date: string }) {
    const today = (await q.query(`select clinic_today()::text as d`)).rows[0].d;
    if (c.visit_date !== today) throw Errors.conflictWith('NOT_TODAY', c.visit_date > today ? 'موعد الحجز مو اليوم: انقل الحجز لليوم أول' : 'موعد الحجز مضى: انقل الحجز لليوم أول', { visit_date: c.visit_date, today });
  }

  /** المراجعة المجانية تبقى مجانية إذا كشفيتها الأصلية سارية (مدفوعة وما انرجعت) وضمن المدة، أو انتقل موعدها بسبب إغلاق من العيادة. */
  private async followupEligible(q: Queryable, c: { id: number; branch_id: number; visit_id: number; visit_date: string; parent_consultation_id: number | null }): Promise<boolean> {
    if (c.parent_consultation_id === null) return false;
    const windowDays = await this.settings.effective<number>(q, c.branch_id, 'booking.free_followup_days');
    const parent = (await q.query(
      `select p.status, ($2::date - v.visit_date) as diff from consultations p join visits v on v.id = p.visit_id where p.id = $1`, [c.parent_consultation_id, c.visit_date])).rows[0];
    if (!parent || !['paid', 'with_doctor', 'finished'].includes(parent.status)) return false;
    if (Number(parent.diff) <= windowDays) return true;
    return (await q.query(`select 1 from booking_events where visit_id = $1 and event = 'moved_by_closure' limit 1`, [c.visit_id])).rowCount! > 0;
  }

  private async validateTenders(q: Queryable, branchId: number, tenders: { method_id: number; amount: number }[], net: number) {
    const ids = tenders.map((t) => t.method_id);
    if (new Set(ids).size !== ids.length) throw Errors.badRequest('DUPLICATE_METHOD', 'طريقة الدفع مكررة بالوصل');
    const sum = tenders.reduce((a, t) => a + t.amount, 0);
    if (net === 0) {
      if (tenders.length) throw Errors.badRequest('TENDER_MISMATCH', 'الصافي صفر: ما يتسجل دفع');
      return new Map<number, any>();
    }
    if (!tenders.length) throw Errors.badRequest('TENDER_REQUIRED', 'حدد طريقة الدفع');
    if (sum !== net) throw Errors.conflictWith('TENDER_MISMATCH', 'مجموع طرق الدفع لازم يساوي صافي الوصل', { net_amount: net, tendered: sum });
    const { rows } = await q.query(`select id, name_ar, kind, device_label from payment_methods where id = any($1::bigint[]) and branch_id = $2 and is_active`, [ids, branchId]);
    const map = new Map(rows.map((r) => [Number(r.id), { ...r, id: Number(r.id) }]));
    if (map.size !== ids.length) throw Errors.conflict('METHOD_INVALID', 'طريقة دفع غير موجودة أو معطلة بهذا الفرع');
    return map;
  }

  /** رقم الوصل: عداد بالفرع والسنة، يتقفل داخل المعاملة فالرقم والوصل يثبتان أو يتراجعان سوا (بدون فجوات). */
  private async nextReceiptNo(q: Queryable, branchId: number): Promise<string> {
    const year = Number((await q.query(`select extract(year from clinic_today())::int as y`)).rows[0].y);
    const n = Number((await q.query(
      `insert into number_counters (branch_id, kind, year, last_value) values ($1,'receipt',$2,1)
       on conflict (branch_id, kind, year) do update set last_value = number_counters.last_value + 1 returning last_value`, [branchId, year])).rows[0].last_value);
    return `${year}-${String(n).padStart(5, '0')}`;
  }

  private async clinicSnapshot(q: Queryable, branchId: number) {
    const get = (k: string) => this.settings.effective<string | number | null>(q, branchId, k);
    const name = await get('receipt.clinic_name'); const address = await get('receipt.address'); const phone = await get('receipt.phone'); const logo = await get('receipt.logo_attachment_id');
    return { name, address, phone, logo_attachment_id: logo };
  }

  private async receiptQ(q: Queryable, id: number) {
    const p = (await q.query(
      `select p.*, p.business_date::text as business_date_text, c.full_name as customer_name, c.public_code, c.points_balance, u.full_name as cashier_name
         from payments p join customers c on c.id = p.customer_id join users u on u.id = p.cashier_id where p.id = $1`, [id])).rows[0];
    if (!p) return null;
    const items = (await q.query(`select * from payment_items where payment_id = $1 order by id`, [id])).rows;
    const tenders = (await q.query(`select * from payment_tenders where payment_id = $1 order by id`, [id])).rows;
    const prints = Number((await q.query(`select count(*)::int as n from receipt_prints where payment_id = $1`, [id])).rows[0].n);
    const refunds = (await q.query(`select id, refund_no, total_amount, refunded_at from refunds where payment_id = $1 order by id`, [id])).rows;
    return {
      id: Number(p.id), branch_id: Number(p.branch_id), receipt_no: p.receipt_no, kind: p.kind, status: p.status,
      customer: { id: Number(p.customer_id), full_name: p.customer_name, public_code: p.public_code },
      cashier: { id: Number(p.cashier_id), full_name: p.cashier_name }, shift_id: Number(p.shift_id), visit_id: p.visit_id === null ? null : Number(p.visit_id),
      paid_at: p.paid_at, business_date: p.business_date_text as string,
      gross_amount: Number(p.gross_amount), offer_discount: Number(p.offer_discount), manual_discount: Number(p.manual_discount), points_discount: Number(p.points_discount),
      rounding_amount: Number(p.rounding_amount), net_amount: Number(p.net_amount),
      points_used: p.points_used, points_earned: p.points_earned, points_balance_now: Number(p.points_balance),
      clinic: p.clinic_snapshot,
      items: items.map((i) => ({ id: Number(i.id), item_type: i.item_type, consultation_id: i.consultation_id === null ? null : Number(i.consultation_id), session_id: i.session_id === null ? null : Number(i.session_id),
        service_id: Number(i.service_id), service_name: i.service_name, quantity: Number(i.quantity), list_price: Number(i.list_price), offer_id: i.offer_id === null ? null : Number(i.offer_id), offer_percent: i.offer_percent === null ? null : Number(i.offer_percent), offer_discount: Number(i.offer_discount),
        manual_discount_share: Number(i.manual_discount_share), points_discount_share: Number(i.points_discount_share), points_used_share: i.points_used_share, rounding_share: Number(i.rounding_share),
        net_amount: Number(i.net_amount), status: i.status })),
      tenders: tenders.map((t) => ({ method_id: Number(t.method_id), method_name: t.method_name, method_kind: t.method_kind, device_label: t.device_label, amount: Number(t.amount), reference: t.reference })),
      print_count: prints,
      refunded_total: refunds.reduce((a, r) => a + Number(r.total_amount), 0),
      refunds: refunds.map((r) => ({ id: Number(r.id), refund_no: r.refund_no, total_amount: Number(r.total_amount), refunded_at: r.refunded_at })),
    };
  }
}

