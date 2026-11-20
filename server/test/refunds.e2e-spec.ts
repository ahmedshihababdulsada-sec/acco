import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { allocate } from '../src/payments/allocation';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

interface World { id: number; code: string; mgr: string; mgrId: number; cash: string; cashId: number; cash2: string; cash2Id: number; docId: number; serviceId: number; cashMethod: number; cardMethod: number; card2Method: number }

describe('الاسترجاع', () => {
  let app: INestApplication; let db: Pool; let today: string; let year: number; let owner: string; let nurse: string; let doc1: string;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const closeOwnerShifts = () => db.query(`update shifts set status = 'closed', closed_at = now() where status = 'open' and cashier_id = (select id from users where username = 'owner')`);
  let seq = 0; let phoneSeq = 0; let fixSeq = 0;
  const key = () => `rk-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const pay = (t: string, body: object, k = key()) => http().post('/payments/consultation').set(auth(t)).set('Idempotency-Key', k).send(body);
  const refund = (t: string, paymentId: number, body: object, k: string | null = key()) => {
    const r = http().post(`/payments/${paymentId}/refund`).set(auth(t)).send(body);
    return k === null ? r : r.set('Idempotency-Key', k);
  };

  async function world(code: string, opts: { price?: number } = {}): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name) values ($1,$1) returning id`, [code])).rows[0].id);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id); const cashId = await seedUser(db, `cash_${code}`, 'cashier', id); const cash2Id = await seedUser(db, `cashB_${code}`, 'cashier', id);
    const docId = await seedUser(db, `doc_${code}`, 'doctor', id);
    await db.query(`insert into safes (branch_id) values ($1) on conflict do nothing`, [id]);
    await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',100000000,'opening_balance','تجربة',$2)`, [id, mgrId]);   // رصيد افتتاحي حتى تنفتح الشفتات (الفكة تطلع من الخزنة)
    const [mgr, cash, cash2] = await Promise.all([`mgr_${code}`, `cash_${code}`, `cashB_${code}`].map((u) => tokenFor(app, u)));
    expect((await put(mgr, `/schedule/doctors/${docId}/weekly`, { days: [1, 2, 3, 4, 5, 6, 7].map((w) => ({ weekday: w, start_time: '09:00', end_time: '13:00' })), effective_from: today })).status).toBe(200);
    await setSetting(mgr, 'booking.daily_limit', 1000);
    const serviceId = Number((await db.query(`insert into services (branch_id, name_ar, kind, pricing_model, is_active) values ($1,'كشفية','consultation','fixed',true) returning id`, [id])).rows[0].id);
    await db.query(`insert into service_prices (service_id, price, set_by) values ($1,$2,$3)`, [serviceId, opts.price ?? 30000, mgrId]);
    const cashMethod = Number((await db.query(`insert into payment_methods (branch_id, name_ar, kind, sort_order) values ($1,'كاش','cash',0) returning id`, [id])).rows[0].id);
    const cardMethod = Number((await db.query(`insert into payment_methods (branch_id, name_ar, kind, device_label, sort_order) values ($1,'كي كارد','electronic','جهاز 1',1) returning id`, [id])).rows[0].id);
    const card2Method = Number((await db.query(`insert into payment_methods (branch_id, name_ar, kind, device_label, sort_order) values ($1,'سويتش','electronic','جهاز 2',2) returning id`, [id])).rows[0].id);
    return { id, code, mgr, mgrId, cash, cashId, cash2, cash2Id, docId, serviceId, cashMethod, cardMethod, card2Method };
  }
  async function setSetting(t: string, k: string, value: number, branch?: number) {
    const q = branch ? `?branch_id=${branch}` : '';
    const cur = (await get(t, `/settings${q}`)).body.settings.find((s: any) => s.key === k);
    expect((await put(t, `/settings/${k}`, { value, expected_version: cur.version, ...(branch ? { branch_id: branch } : {}) })).status).toBe(200);
  }
  async function openShift(t: string, float = 0) { const r = await post(t, '/shifts/open', { opening_float: float }); expect(r.status).toBe(201); return r.body; }
  async function newCust(w: World): Promise<number> {
    phoneSeq++;
    const r = await post(w.cash, '/customers', { full_name: `زبون استرجاع ${phoneSeq}`, phone: `0792${String(phoneSeq).padStart(7, '0')}` });
    expect(r.status).toBe(201); return r.body.id;
  }
  async function visit(w: World, customer?: number) {
    const c = customer ?? (await newCust(w));
    const r = await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docId, date: today });
    expect(r.status).toBe(201);
    return { customer: c, visitId: r.body.id as number, consId: r.body.consultation.id as number };
  }
  const cashT = (w: World, amount: number) => ({ tenders: [{ method_id: w.cashMethod, amount }] });
  /** دفع حقيقي بالكاش للكشفية */
  async function paid(w: World, amount = 30000, extra: object = {}, customer?: number) {
    const v = await visit(w, customer);
    const r = await pay(w.cash, { consultation_id: v.consId, ...cashT(w, amount), ...extra });
    expect(r.status).toBe(201);
    return { ...v, payment: r.body };
  }
  async function givePoints(w: World, customer: number, points: number) {
    phoneSeq++;
    const old = (await db.query(`insert into customers (branch_id, public_code, phone, full_name, source, status, merged_into_id) values ($1,$2,$3,'ملف قديم','cashier','merged',$4) returning id`, [w.id, `OLD${phoneSeq}${Date.now() % 1e5}`, `+9647${String(600000000 + phoneSeq)}`, customer])).rows[0].id;
    const m = (await db.query(`insert into customer_merges (from_customer_id, into_customer_id, reason, merged_by) values ($1,$2,'تجربة',$3) returning id`, [old, customer, w.mgrId])).rows[0].id;
    await db.query(`insert into points_ledger (customer_id, entry_type, points, merge_id) values ($1,'merge_in',$2,$3)`, [customer, points, m]);
  }
  const balance = async (c: number) => Number((await db.query(`select points_balance from customers where id = $1`, [c])).rows[0].points_balance);
  const refundCount = async (w: World) => Number((await db.query(`select count(*)::int as n from refunds where branch_id = $1`, [w.id])).rows[0].n);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

  /**
   * وصل متعدد البنود مباشرة بالقاعدة (وصل الجلسات لسه ما انبنى): كل بند كشفية مدفوعة بزيارة ماضية.
   * الخصم اليدوي والنقاط ينوزعون بنفس محرك الدفع (أكبر البواقي)، قيمة النقطة 1.
   */
  async function fixture(w: World, shiftId: number, prices: number[], o: { manual?: number; pointsUsed?: number; tenders?: { method: number; amount: number }[] } = {}) {
    const customer = await newCust(w);
    const manual = o.manual ?? 0; const pointsUsed = o.pointsUsed ?? 0;
    if (pointsUsed) await givePoints(w, customer, pointsUsed);
    const mShare = allocate(manual, prices); const pShare = allocate(pointsUsed, prices);
    const nets = prices.map((p, i) => p - mShare[i] - pShare[i]);
    const net = nets.reduce((a, b) => a + b, 0); const gross = prices.reduce((a, b) => a + b, 0);
    const earned = Math.floor(net / 10000) * 250;
    const no = `FX-${++fixSeq}-${Date.now() % 1e6}`;
    const pay = (await db.query(
      `insert into payments (branch_id, receipt_no, customer_id, shift_id, cashier_id, kind, gross_amount, manual_discount, points_discount, net_amount, points_used, points_earned, clinic_snapshot)
       values ($1,$2,$3,$4,$5,'consultation',$6,$7,$8,$9,$10,$11,'{}') returning id`, [w.id, no, customer, shiftId, w.cashId, gross, manual, pointsUsed, net, pointsUsed, earned])).rows[0];
    const itemIds: number[] = []; const consIds: number[] = []; const visitIds: number[] = [];
    for (let i = 0; i < prices.length; i++) {
      const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - (i + 1));
      const v = (await db.query(`insert into visits (branch_id, customer_id, visit_date, seq_no, status, source, doctor_id) values ($1,$2,$3,$4,'arrived','cashier',$5) returning id`, [w.id, customer, d.toISOString().slice(0, 10), 900 + fixSeq * 10 + i, w.docId])).rows[0].id;
      const c = (await db.query(`insert into consultations (branch_id, visit_id, customer_id, doctor_id, status) values ($1,$2,$3,$4,'paid') returning id`, [w.id, v, customer, w.docId])).rows[0].id;
      const it = (await db.query(
        `insert into payment_items (payment_id, item_type, consultation_id, service_id, service_name, list_price, manual_discount_share, points_discount_share, points_used_share, net_amount)
         values ($1,'consultation',$2,$3,'كشفية',$4,$5,$6,$7,$8) returning id`, [pay.id, c, w.serviceId, prices[i], mShare[i], pShare[i], pShare[i], nets[i]])).rows[0].id;
      itemIds.push(Number(it)); consIds.push(Number(c)); visitIds.push(Number(v));
    }
    const tenders = o.tenders ?? [{ method: w.cashMethod, amount: net }];
    for (const t of tenders) {
      const m = (await db.query(`select name_ar, kind, device_label from payment_methods where id = $1`, [t.method])).rows[0];
      await db.query(`insert into payment_tenders (payment_id, method_id, method_name, method_kind, device_label, amount) values ($1,$2,$3,$4,$5,$6)`, [pay.id, t.method, m.name_ar, m.kind, m.device_label, t.amount]);
    }
    if (pointsUsed) await db.query(`insert into points_ledger (customer_id, entry_type, points, payment_id) values ($1,'redeem',$2,$3)`, [customer, -pointsUsed, pay.id]);
    if (earned) await db.query(`insert into points_ledger (customer_id, entry_type, points, payment_id) values ($1,'earn',$2,$3)`, [customer, earned, pay.id]);
    return { paymentId: Number(pay.id), customer, itemIds, consIds, visitIds, nets, net, earned };
  }

  beforeAll(async () => {
    app = await makeApp(); db = pool();
    const r = (await db.query(`select clinic_today()::text as d, extract(year from clinic_today())::int as y`)).rows[0]; today = r.d; year = r.y;
    [owner, nurse, doc1] = await Promise.all(['owner', 'nurse1', 'doc1'].map((u) => tokenFor(app, u)));
  });
  afterAll(async () => { await app.close(); await db.end(); });

  // ------------------------------------------------------------------------------------------------
  describe('الصلاحيات والتحقق', () => {
    let w: World; let w2: World; let p: any;
    beforeAll(async () => { w = await world('RFA'); w2 = await world('RFA2'); await openShift(w.cash); await openShift(w2.cash); p = await paid(w); });
    it('الممرض والطبيب والمدير 403، بدون توكن 401، بدون مفتاح أو بمفتاح غلط 400', async () => {
      for (const t of [nurse, doc1, w.mgr]) expect((await refund(t, p.payment.id, { full_receipt: true, reason: 'تجربة' })).status).toBe(403);
      expect((await http().post(`/payments/${p.payment.id}/refund`).send({})).status).toBe(401);
      expect((await refund(w.cash, p.payment.id, { full_receipt: true, reason: 'تجربة' }, null)).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect((await refund(w.cash, p.payment.id, { full_receipt: true, reason: 'تجربة' }, 'short')).body.code).toBe('IDEMPOTENCY_KEY_INVALID');
      expect(await refundCount(w)).toBe(0);
    });
    it('السبب إلزامي، والبنود أو الوصل الكامل (واحد منهم)، ووصل غير موجود 404، وفرع ثاني 404، وبند من وصل ثاني 400', async () => {
      const itemId = p.payment.items[0].id;
      expect((await refund(w.cash, p.payment.id, { full_receipt: true })).status).toBe(400);
      expect((await refund(w.cash, p.payment.id, { full_receipt: true, reason: '  ' })).status).toBe(400);
      expect((await refund(w.cash, p.payment.id, { full_receipt: true, reason: 'ab' })).status).toBe(400);
      expect((await refund(w.cash, p.payment.id, { full_receipt: true, reason: '          ' })).status).toBe(400);         // فراغات بس
      expect((await refund(w.cash, p.payment.id, { reason: 'تجربة' })).body.code).toBe('ITEMS_OR_FULL');
      expect((await refund(w.cash, p.payment.id, { items: [itemId], full_receipt: true, reason: 'تجربة' })).body.code).toBe('ITEMS_OR_FULL');
      expect((await refund(w.cash, p.payment.id, { items: [], reason: 'تجربة' })).status).toBe(400);
      expect((await refund(w.cash, p.payment.id, { items: ['x'], reason: 'تجربة' })).status).toBe(400);
      expect((await refund(w.cash, p.payment.id, { full_receipt: true, reason: 'تجربة', amount: 5 })).status).toBe(400);                  // المبلغ ما يجي من الواجهة
      expect((await refund(w.cash, 99999999, { full_receipt: true, reason: 'تجربة' })).status).toBe(404);
      expect((await refund(w2.cash, p.payment.id, { full_receipt: true, reason: 'تجربة' })).status).toBe(404);
      const other = await paid(w);
      expect((await refund(w.cash, p.payment.id, { items: [other.payment.items[0].id], reason: 'تجربة' })).body.code).toBe('ITEM_NOT_IN_PAYMENT');
      expect(await refundCount(w)).toBe(0);
    });
    it('بدون شفت مفتوح 409، وشفت بفرع ثاني 409', async () => {
      expect((await refund(w.cash2, p.payment.id, { full_receipt: true, reason: 'تجربة' })).body.code).toBe('NO_OPEN_SHIFT');
      await closeOwnerShifts();                                                // حساب المالك مشترك بين ملفات الاختبار
      const o = await post(owner, '/shifts/open', { opening_float: 0, branch_id: w2.id });
      expect(o.status).toBe(201);
      expect((await refund(owner, p.payment.id, { full_receipt: true, reason: 'تجربة' })).body.code).toBe('SHIFT_BRANCH_MISMATCH');
      await closeOwnerShifts();
      expect(await refundCount(w)).toBe(0);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('استرجاع الكشفية', () => {
    let w: World; let shift1: number; let shift2: number;
    beforeAll(async () => { w = await world('RFB'); shift1 = (await openShift(w.cash)).id; shift2 = (await openShift(w.cash2)).id; });
    it('استرجاع كامل: الوصل «مسترجع»، الكشفية والحجز ينلغون، المكان يرجع، النقاط المكتسبة تنسحب، والكاش بشفت المسترجِع', async () => {
      const p = await paid(w);
      expect(p.payment.points_earned).toBe(750);
      const usedBefore = Number((await one(`select used_slots from booking_days where branch_id = $1 and day = $2`, [w.id, today])).used_slots);
      const r = await refund(w.cash2, p.payment.id, { full_receipt: true, reason: 'الزبون رجع عن القرار' });         // كاشير ثاني بشفته، مو اللي دفع
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ refund_no: expect.stringMatching(new RegExp(`^R-${year}-\\d{5}$`)), payment_id: p.payment.id, receipt_no: p.payment.receipt_no, payment_status: 'refunded',
        shift_id: shift2, cashier: { id: w.cash2Id }, total_amount: 30000, points_returned: 0, points_clawed_back: 750, points_balance_now: 0, reason: 'الزبون رجع عن القرار', business_date: today });
      expect(r.body.items).toEqual([{ payment_item_id: p.payment.items[0].id, service_name: 'كشفية', amount: 30000 }]);
      expect(r.body.payouts).toEqual([{ original_method_id: w.cashMethod, payout_method_id: w.cashMethod, payout_method_name: 'كاش', payout_kind: 'cash', device_label: null, amount: 30000 }]);
      expect((await one(`select status from payments where id = $1`, [p.payment.id])).status).toBe('refunded');
      expect((await one(`select status from payment_items where id = $1`, [p.payment.items[0].id])).status).toBe('refunded');
      expect((await one(`select status from consultations where id = $1`, [p.consId])).status).toBe('cancelled');
      const v = await one(`select status, cancelled_at, cancel_reason from visits where id = $1`, [p.visitId]);
      expect(v.status).toBe('cancelled'); expect(v.cancelled_at).not.toBeNull(); expect(v.cancel_reason).toBe('استرجاع الكشفية');
      expect(Number((await one(`select used_slots from booking_days where branch_id = $1 and day = $2`, [w.id, today])).used_slots)).toBe(usedBefore - 1);
      expect((await db.query(`select 1 from booking_events where visit_id = $1 and event = 'cancelled' and reason like 'استرجاع%'`, [p.visitId])).rowCount).toBe(1);
      expect((await db.query(`select entry_type, points from points_ledger where refund_id = $1`, [r.body.id])).rows).toEqual([{ entry_type: 'earn_clawback', points: -750 }]);
      expect(await balance(p.customer)).toBe(0);
      expect(Number((await one(`select shift_id from refunds where id = $1`, [r.body.id])).shift_id)).toBe(shift2);
      expect((await db.query(`select 1 from audit_log where action = 'payment.refund' and entity_id = $1 and reason = 'الزبون رجع عن القرار'`, [r.body.id])).rowCount).toBe(1);
      const view = (await get(w.cash, `/payments/${p.payment.id}`)).body;
      expect(view).toMatchObject({ status: 'refunded', refunded_total: 30000 });
      expect(view.refunds).toHaveLength(1); expect(view.items[0].status).toBe('refunded');
      expect((await get(w.cash, `/refunds/${r.body.id}`)).body.refund_no).toBe(r.body.refund_no);
      expect(shift1).not.toBe(shift2);
    });
    it('بعد الاسترجاع الزبون يقدر يحجز نفس اليوم من جديد ويدفع', async () => {
      const p = await paid(w);
      expect((await refund(w.cash, p.payment.id, { full_receipt: true, reason: 'تجربة' })).status).toBe(201);
      const again = await visit(w, p.customer);
      const r = await pay(w.cash, { consultation_id: again.consId, ...cashT(w, 30000) });
      expect(r.status).toBe(201);
    });
    it('الاسترجاع بالبند نفسه (items) مثل الوصل الكامل لما يكون بند وحيد', async () => {
      const p = await paid(w);
      const r = await refund(w.cash, p.payment.id, { items: [p.payment.items[0].id], reason: 'تجربة' });
      expect(r.status).toBe(201); expect(r.body.payment_status).toBe('refunded'); expect(r.body.total_amount).toBe(30000);
    });
    it('استرجاع مرتين → 409 ALREADY_REFUNDED، وبعد دخول الطبيب CONSULTATION_ENTERED، وما يتغير شي', async () => {
      const p = await paid(w);
      const entered = await paid(w);
      await db.query(`update consultations set status = 'with_doctor', entered_at = now() where id = $1`, [entered.consId]);
      const e = await refund(w.cash, entered.payment.id, { full_receipt: true, reason: 'تجربة' });
      expect(e.status).toBe(409); expect(e.body.code).toBe('CONSULTATION_ENTERED');
      expect((await one(`select status from payments where id = $1`, [entered.payment.id])).status).toBe('paid');
      expect(await balance(entered.customer)).toBe(750);
      expect((await one(`select status from visits where id = $1`, [entered.visitId])).status).toBe('arrived');
      expect((await refund(w.cash, p.payment.id, { full_receipt: true, reason: 'تجربة' })).status).toBe(201);
      expect((await refund(w.cash, p.payment.id, { full_receipt: true, reason: 'تجربة' })).body.code).toBe('ALREADY_REFUNDED');
      expect((await refund(w.cash, p.payment.id, { items: [p.payment.items[0].id], reason: 'تجربة' })).body.code).toBe('ALREADY_REFUNDED');
    });
    it('الكشفية المنتهية (finished) ما تنسترجع أيضاً', async () => {
      const p = await paid(w);
      await db.query(`update consultations set status = 'finished', entered_at = now(), finished_at = now() where id = $1`, [p.consId]);
      expect((await refund(w.cash, p.payment.id, { full_receipt: true, reason: 'تجربة' })).body.code).toBe('CONSULTATION_ENTERED');
    });
    it('وصل صفري ما ينسترجع (ما أكو مبلغ)', async () => {
      const v = await visit(w);
      const d = Number((await db.query(`insert into discount_requests (branch_id, customer_id, visit_id, basket, status, requested_by, amount, decided_by) values ($1,$2,$3,'[]','approved',$4,30000,$5) returning id`, [w.id, v.customer, v.visitId, w.cashId, w.mgrId])).rows[0].id);
      const z = await pay(w.cash, { consultation_id: v.consId, discount_request_id: d });
      expect(z.status).toBe(201); expect(z.body.net_amount).toBe(0);
      expect((await refund(w.cash, z.body.id, { full_receipt: true, reason: 'تجربة' })).body.code).toBe('NOTHING_TO_REFUND');
    });
    it('استرجاع كشفية دُفعت بنقاط وتقريب: ترجع النقاط المصروفة بعددها، وتنسحب المكتسبة، والمبلغ = الصافي المدفوع بالضبط', async () => {
      expect((await put(w.mgr, `/services/${w.serviceId}/price`, { price: 16667 })).status).toBe(200);
      const v = await visit(w); await givePoints(w, v.customer, 1000);
      const pp = await pay(w.cash, { consultation_id: v.consId, redeem_points: true, ...cashT(w, 15500) });       // 16,667 − 1,000 نقاط = 15,667 ← 15,500
      expect(pp.status).toBe(201);
      expect(pp.body).toMatchObject({ points_used: 1000, rounding_amount: 167, net_amount: 15500, points_earned: 250 });
      expect(await balance(v.customer)).toBe(250);
      const r = await refund(w.cash, pp.body.id, { full_receipt: true, reason: 'تجربة' });
      expect(r.body).toMatchObject({ total_amount: 15500, points_returned: 1000, points_clawed_back: 250, points_balance_now: 1000 });
      expect((await db.query(`select entry_type, points from points_ledger where refund_id = $1 order by id`, [r.body.id])).rows).toEqual([{ entry_type: 'redeem_return', points: 1000 }, { entry_type: 'earn_clawback', points: -250 }]);
      expect(await put(w.mgr, `/services/${w.serviceId}/price`, { price: 30000 }).then((x) => x.status)).toBe(200);
    });
    it('قيمة النقطة بدينارين: ترجع النقاط المصروفة بعددها (1,000 نقطة) مو بقيمتها بالدينار (2,000)', async () => {
      await setSetting(owner, 'points.point_value', 2, w.id);
      const v = await visit(w); await givePoints(w, v.customer, 1000);
      const pp = await pay(w.cash, { consultation_id: v.consId, redeem_points: true, ...cashT(w, 28000) });
      expect(pp.body).toMatchObject({ points_used: 1000, points_discount: 2000, net_amount: 28000 });
      const r = await refund(w.cash, pp.body.id, { full_receipt: true, reason: 'تجربة' });
      expect(r.body).toMatchObject({ total_amount: 28000, points_returned: 1000 });
      await setSetting(owner, 'points.point_value', 1, w.id);
    });
    it('الرصيد يصير سالب لو الزبون صرف نقاطه بعد الدفع (يتعوض من الدفعات الجاية)', async () => {
      const p = await paid(w);                                                // كسب 750
      const other = await newCust(w);
      const m = (await one(`insert into customer_merges (from_customer_id, into_customer_id, reason, merged_by) values ($1,$2,'تجربة',$3) returning id`, [p.customer, other, w.mgrId])).id;
      await db.query(`insert into points_ledger (customer_id, entry_type, points, merge_id) values ($1,'merge_out',-700,$2)`, [p.customer, m]);     // خرجت منه 700 (الرصيد 50)
      expect(await balance(p.customer)).toBe(50);
      const r = await refund(w.cash, p.payment.id, { full_receipt: true, reason: 'تجربة' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ points_clawed_back: 750, points_balance_now: -700 });
      expect(await balance(p.customer)).toBe(-700);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('طرق الدفع الأصلية وطرق الإرجاع', () => {
    let w: World;
    beforeAll(async () => { w = await world('RFT'); await openShift(w.cash); });
    it('الرجوع كاش افتراضياً حتى لو الدفع كان بجهاز (مثال القسم 12 و)', async () => {
      const v = await visit(w);
      const pp = await pay(w.cash, { consultation_id: v.consId, tenders: [{ method_id: w.cardMethod, amount: 30000, reference: 'T-1' }] });
      const r = await refund(w.cash, pp.body.id, { full_receipt: true, reason: 'تجربة' });
      expect(r.body.payouts).toEqual([{ original_method_id: w.cardMethod, payout_method_id: w.cashMethod, payout_method_name: 'كاش', payout_kind: 'cash', device_label: null, amount: 30000 }]);
    });
    it('الرجوع على نفس الجهاز، أو مقسوم كاش + جهاز، والاسم والجهاز ينحفظون', async () => {
      const a = await paid(w);
      const r1 = await refund(w.cash, a.payment.id, { full_receipt: true, reason: 'تجربة', payout: [{ method_id: w.cardMethod, amount: 30000 }] });
      expect(r1.body.payouts).toEqual([{ original_method_id: w.cashMethod, payout_method_id: w.cardMethod, payout_method_name: 'كي كارد', payout_kind: 'electronic', device_label: 'جهاز 1', amount: 30000 }]);
      const b = await paid(w);
      const r2 = await refund(w.cash, b.payment.id, { full_receipt: true, reason: 'تجربة', payout: [{ method_id: w.cashMethod, amount: 10000 }, { method_id: w.card2Method, amount: 20000 }] });
      expect(r2.body.payouts.map((x: any) => [x.payout_method_name, x.device_label, x.amount])).toEqual([['كاش', null, 10000], ['سويتش', 'جهاز 2', 20000]]);
    });
    it('دفع مختلط (كاش 10,000 + جهاز 20,000) ورجوع كاش 30,000: صفّين أصلين بمبالغهم', async () => {
      const v = await visit(w);
      const pp = await pay(w.cash, { consultation_id: v.consId, tenders: [{ method_id: w.cashMethod, amount: 10000 }, { method_id: w.cardMethod, amount: 20000 }] });
      const r = await refund(w.cash, pp.body.id, { full_receipt: true, reason: 'تجربة' });
      expect(r.body.payouts.map((x: any) => [x.original_method_id, x.payout_method_id, x.amount])).toEqual([[w.cashMethod, w.cashMethod, 10000], [w.cardMethod, w.cashMethod, 20000]]);
    });
    it('مجموع الإرجاع ≠ المبلغ، مكرر، معطلة، من فرع ثاني، مبلغ صفر أو سالب → ما يتغير شي', async () => {
      const p = await paid(w); const body = { full_receipt: true, reason: 'تجربة' };
      expect((await refund(w.cash, p.payment.id, { ...body, payout: [{ method_id: w.cashMethod, amount: 20000 }] })).body).toMatchObject({ code: 'PAYOUT_MISMATCH', refund_total: 30000, payout_total: 20000 });
      expect((await refund(w.cash, p.payment.id, { ...body, payout: [{ method_id: w.cashMethod, amount: 31000 }] })).body.code).toBe('PAYOUT_MISMATCH');
      expect((await refund(w.cash, p.payment.id, { ...body, payout: [{ method_id: w.cashMethod, amount: 15000 }, { method_id: w.cashMethod, amount: 15000 }] })).body.code).toBe('DUPLICATE_METHOD');
      const foreign = Number((await db.query(`select id from payment_methods where kind = 'cash' and branch_id <> $1 limit 1`, [w.id])).rows[0].id);
      expect((await refund(w.cash, p.payment.id, { ...body, payout: [{ method_id: foreign, amount: 30000 }] })).body.code).toBe('METHOD_INVALID');
      await db.query(`update payment_methods set is_active = false where id = $1`, [w.card2Method]);
      expect((await refund(w.cash, p.payment.id, { ...body, payout: [{ method_id: w.card2Method, amount: 30000 }] })).body.code).toBe('METHOD_INVALID');
      await db.query(`update payment_methods set is_active = true where id = $1`, [w.card2Method]);
      for (const amount of [0, -1, 1.5]) expect((await refund(w.cash, p.payment.id, { ...body, payout: [{ method_id: w.cashMethod, amount }] })).status).toBe(400);
      expect((await one(`select status from payments where id = $1`, [p.payment.id])).status).toBe('paid');
      expect((await one(`select count(*)::int as n from refund_tenders where refund_id in (select id from refunds where payment_id = $1)`, [p.payment.id])).n).toBe(0);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('وصل متعدد البنود: أمثلة القواعد المحاسبية', () => {
    let w: World; let shift: number;
    beforeAll(async () => { w = await world('RFM'); shift = (await openShift(w.cash)).id; });
    it('مثال 1: بند 2 ← يرجع 16,667 ونقاطه 1,333 وتنسحب 500؛ بعدها بند 1 ثم 3 حتى النهاية: كسب صفر وكل النقاط المصروفة ترجع', async () => {
      const f = await fixture(w, shift, [10000, 20000, 30000], { manual: 6000, pointsUsed: 4000 });
      expect(f.nets).toEqual([8333, 16667, 25000]); expect(f.net).toBe(50000); expect(f.earned).toBe(1250);
      expect(await balance(f.customer)).toBe(1250);
      const r2 = await refund(w.cash, f.paymentId, { items: [f.itemIds[1]], reason: 'بند 2' });
      expect(r2.status).toBe(201);
      expect(r2.body).toMatchObject({ total_amount: 16667, points_returned: 1333, points_clawed_back: 500, payment_status: 'partially_refunded', points_balance_now: 1250 + 1333 - 500 });
      expect((await one(`select status from consultations where id = $1`, [f.consIds[1]])).status).toBe('cancelled');
      expect((await one(`select status from consultations where id = $1`, [f.consIds[0]])).status).toBe('paid');                       // البنود الباقية ما تأثرت
      expect((await one(`select status from visits where id = $1`, [f.visitIds[0]])).status).toBe('arrived');
      expect((await refund(w.cash, f.paymentId, { items: [f.itemIds[1]], reason: 'مرة ثانية' })).body.code).toBe('ALREADY_REFUNDED');
      expect(await balance(f.customer)).toBe(2083);                                                                                    // ما انسحبت نقاط مرتين
      const r1 = await refund(w.cash, f.paymentId, { items: [f.itemIds[0]], reason: 'بند 1' });
      expect(r1.body).toMatchObject({ total_amount: 8333, points_returned: 667, points_clawed_back: 250, payment_status: 'partially_refunded' });
      const r3 = await refund(w.cash, f.paymentId, { full_receipt: true, reason: 'الباقي' });                                          // الوصل كله = البنود المتبقية فقط
      expect(r3.body).toMatchObject({ total_amount: 25000, points_returned: 2000, points_clawed_back: 500, payment_status: 'refunded' });
      expect(r3.body.items).toHaveLength(1);
      expect(await balance(f.customer)).toBe(4000);                                                                                    // الرصيد الأصلي كامل: كسب صفر ونقاط مصروفة ترجع
      const sums = await one(`select coalesce(sum(points_returned),0)::int as r, coalesce(sum(points_clawed_back),0)::int as c, coalesce(sum(total_amount),0)::int as t from refunds where payment_id = $1`, [f.paymentId]);
      expect(sums).toEqual({ r: 4000, c: 1250, t: 50000 });
      expect((await get(w.cash, `/payments/${f.paymentId}`)).body).toMatchObject({ status: 'refunded', refunded_total: 50000 });
    });
    it('مثال 2: بندان 5,000 و15,000 (كسب 500): استرجاع الـ 5,000 ينسحب 250 مو 125، وبعدها الباقي 250', async () => {
      const f = await fixture(w, shift, [5000, 15000]);
      expect(f.earned).toBe(500);
      const a = await refund(w.cash, f.paymentId, { items: [f.itemIds[0]], reason: 'تجربة' });
      expect(a.body).toMatchObject({ total_amount: 5000, points_returned: 0, points_clawed_back: 250 });
      const b = await refund(w.cash, f.paymentId, { items: [f.itemIds[1]], reason: 'تجربة' });
      expect(b.body).toMatchObject({ total_amount: 15000, points_clawed_back: 250, payment_status: 'refunded' });
      expect(await balance(f.customer)).toBe(0);
    });
    it('استرجاع عدة بنود بطلب واحد، وكل بنود الوصل معاً', async () => {
      const f = await fixture(w, shift, [10000, 20000, 30000], { manual: 6000, pointsUsed: 4000 });
      const r = await refund(w.cash, f.paymentId, { items: [f.itemIds[0], f.itemIds[2], f.itemIds[0]], reason: 'اثنين' });       // التكرار بالمدخلات ينهمل
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ total_amount: 8333 + 25000, points_returned: 667 + 2000, payment_status: 'partially_refunded' });
      expect(r.body.items.map((x: any) => x.payment_item_id).sort()).toEqual([f.itemIds[0], f.itemIds[2]].sort());
    });
    it('الدفع مختلط (كاش 20,000 + جهاز 30,000) وإرجاع على دفعات: كل طريقة أصلية ما ينرجع منها أكثر من اللي انقبض بيها', async () => {
      const f = await fixture(w, shift, [10000, 20000, 30000], { manual: 6000, pointsUsed: 4000, tenders: [{ method: w.cashMethod, amount: 20000 }, { method: w.cardMethod, amount: 30000 }] });
      for (const id of [f.itemIds[1], f.itemIds[0], f.itemIds[2]]) expect((await refund(w.cash, f.paymentId, { items: [id], reason: 'تجربة' })).status).toBe(201);
      const per = (await db.query(`select rt.original_method_id as m, sum(rt.amount)::int as s from refund_tenders rt join refunds r on r.id = rt.refund_id where r.payment_id = $1 group by 1 order by 1`, [f.paymentId])).rows;
      expect(per.map((x) => [Number(x.m), x.s])).toEqual([[w.cashMethod, 20000], [w.cardMethod, 30000]].sort((a, b) => a[0] - b[0]));
      for (const r of (await db.query(`select id, total_amount from refunds where payment_id = $1`, [f.paymentId])).rows) {
        expect(Number((await one(`select sum(amount) as s from refund_tenders where refund_id = $1`, [r.id])).s)).toBe(Number(r.total_amount));
      }
    });
    it('دفع مختلط غير متوازن (كاش 1 + جهاز 49,999) وإرجاع بخمس دفعات: كل طريقة أصلية ترجع بالضبط اللي انقبض بيها، مو أكثر ولا أقل', async () => {
      const f = await fixture(w, shift, [10000, 10000, 10000, 10000, 10000], { tenders: [{ method: w.cashMethod, amount: 1 }, { method: w.cardMethod, amount: 49999 }] });
      for (const id of f.itemIds) expect((await refund(w.cash, f.paymentId, { items: [id], reason: 'تجربة' })).status).toBe(201);
      const per = (await db.query(`select rt.original_method_id as m, sum(rt.amount)::int as s from refund_tenders rt join refunds r on r.id = rt.refund_id where r.payment_id = $1 group by 1`, [f.paymentId])).rows;
      expect(Object.fromEntries(per.map((x) => [Number(x.m), x.s]))).toEqual({ [w.cashMethod]: 1, [w.cardMethod]: 49999 });
    });
    it('استرجاع جزئي يرجع من الشفت الحالي: الشفت المسجل هو شفت الكاشير الحالي مو شفت الدفع', async () => {
      const f = await fixture(w, shift, [10000, 10000]);
      const w2shift = (await openShift(w.cash2)).id;
      const r = await refund(w.cash2, f.paymentId, { items: [f.itemIds[0]], reason: 'تجربة' });
      expect(r.body.shift_id).toBe(w2shift);
      expect(Number((await one(`select shift_id from payments where id = $1`, [f.paymentId])).shift_id)).toBe(shift);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('منع التكرار والتزامن', () => {
    let w: World;
    beforeAll(async () => { w = await world('RFI'); await openShift(w.cash); });
    it('نفس المفتاح ونفس الطلب: نفس الاسترجاع، علامة الإعادة، واسترجاع واحد والنقاط مرة وحدة', async () => {
      const p = await paid(w); const k = key(); const body = { full_receipt: true, reason: 'تجربة' };
      const a = await refund(w.cash, p.payment.id, body, k); const b = await refund(w.cash, p.payment.id, body, k);
      expect(a.status).toBe(201); expect(b.status).toBe(201); expect(b.body).toEqual(a.body);
      expect(a.headers['idempotent-replay']).toBeUndefined(); expect(b.headers['idempotent-replay']).toBe('true');
      expect(Number((await one(`select count(*)::int as n from refunds where payment_id = $1`, [p.payment.id])).n)).toBe(1);
      expect(Number((await one(`select count(*)::int as n from points_ledger where refund_id = $1`, [a.body.id])).n)).toBe(1);
    });
    it('نفس المفتاح بطلب مختلف (وصل آخر أو سبب آخر) → 422', async () => {
      const p1 = await paid(w); const p2 = await paid(w); const k = key();
      expect((await refund(w.cash, p1.payment.id, { full_receipt: true, reason: 'تجربة' }, k)).status).toBe(201);
      expect((await refund(w.cash, p2.payment.id, { full_receipt: true, reason: 'تجربة' }, k)).body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await refund(w.cash, p1.payment.id, { full_receipt: true, reason: 'سبب ثاني' }, k)).status).toBe(422);
      expect((await one(`select status from payments where id = $1`, [p2.payment.id])).status).toBe('paid');
    });
    it('7 طلبات متزامنة بنفس المفتاح: استرجاع واحد، والكل يرجع نفس الجسم', async () => {
      const p = await paid(w); const k = key(); const body = { full_receipt: true, reason: 'تجربة' };
      const rs = await Promise.all(Array.from({ length: 7 }, () => refund(w.cash, p.payment.id, body, k)));
      expect(rs.map((r) => r.status)).toEqual(new Array(7).fill(201));
      for (const r of rs) expect(r.body).toEqual(rs[0].body);
      expect(Number((await one(`select count(*)::int as n from refunds where payment_id = $1`, [p.payment.id])).n)).toBe(1);
    });
    it('8 طلبات متزامنة بمفاتيح مختلفة لنفس الوصل: واحد ينجح والباقي ALREADY_REFUNDED، النقاط مرة وحدة، وأرقام الاسترجاع بدون فجوة', async () => {
      const p = await paid(w); const before = await refundCount(w);
      const rs = await Promise.all(Array.from({ length: 8 }, () => refund(w.cash, p.payment.id, { full_receipt: true, reason: 'تجربة' })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'ALREADY_REFUNDED')).toHaveLength(7);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(await refundCount(w)).toBe(before + 1);
      expect(await balance(p.customer)).toBe(0);
      const win = rs.find((r) => r.status === 201)!;
      const next = await paid(w);
      const n = await refund(w.cash, next.payment.id, { full_receipt: true, reason: 'تجربة' });
      expect(Number(n.body.refund_no.split('-')[2])).toBe(Number(win.body.refund_no.split('-')[2]) + 1);
    });
    it('استرجاع بنود مختلفة من نفس الوصل بنفس اللحظة: كل بند مرة، النقاط والمبالغ مطابقة', async () => {
      const f = await fixture(w, (await get(w.cash, '/shifts/current')).body.id, [10000, 20000, 30000], { manual: 6000, pointsUsed: 4000 });
      const rs = await Promise.all(f.itemIds.map((id) => refund(w.cash, f.paymentId, { items: [id], reason: 'تجربة' })));
      expect(rs.map((r) => r.status)).toEqual([201, 201, 201]);
      expect((await one(`select status from payments where id = $1`, [f.paymentId])).status).toBe('refunded');
      expect(await balance(f.customer)).toBe(4000);                                                                                   // نفس النتيجة بغض النظر عن الترتيب
      const sums = await one(`select sum(total_amount)::int as t, sum(points_returned)::int as r, sum(points_clawed_back)::int as c from refunds where payment_id = $1`, [f.paymentId]);
      expect(sums).toEqual({ t: 50000, r: 4000, c: 1250 });
    });
    it('استرجاع ودخول الطبيب بنفس اللحظة: واحد بس يفوز والحالة سليمة', async () => {
      for (let i = 0; i < 4; i++) {
        const p = await paid(w);
        const enter = (async () => {                                           // نفس وصفة وحدة الطبيب: قفل الكشفية ثم فحص الحالة ثم الدخول
          const c = await db.connect();
          try {
            await c.query('begin');
            await c.query(`select 1 from consultations where id = $1 for update`, [p.consId]);
            const r = await c.query(`update consultations set status = 'with_doctor', entered_at = now() where id = $1 and status = 'paid'`, [p.consId]);
            await c.query('commit');
            return r.rowCount === 1;
          } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
        })();
        const [r, entered] = await Promise.all([refund(w.cash, p.payment.id, { full_receipt: true, reason: 'سباق' }), enter]);
        expect(r.status).not.toBeGreaterThanOrEqual(500);
        expect([r.status === 201, entered].filter(Boolean)).toHaveLength(1);
        const st = await one(`select c.status as cs, pay.status as ps from consultations c, payments pay where c.id = $1 and pay.id = $2`, [p.consId, p.payment.id]);
        expect(r.status === 201 ? { cs: 'cancelled', ps: 'refunded' } : { cs: 'with_doctor', ps: 'paid' }).toEqual(st);
      }
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('تأثير الاسترجاع على المراجعة المجانية', () => {
    let w: World;
    beforeAll(async () => { w = await world('RFF'); await openShift(w.cash); });
    it('كشفية انرجعت ← مراجعتها المجانية ما عاد تنطبق: الدخول يرفض والدفع يحسبها كشفية جديدة', async () => {
      const parent = await paid(w);
      await db.query(`update visits set visit_date = $2 where id = $1`, [parent.visitId, new Date(Date.parse(`${today}T00:00:00Z`) - 2 * 86400000).toISOString().slice(0, 10)]);
      const f = await visit(w, parent.customer);
      const kind = (await one(`select kind from consultations where id = $1`, [f.consId])).kind;
      expect(kind).toBe('free_followup');
      expect((await refund(w.cash, parent.payment.id, { full_receipt: true, reason: 'تجربة' })).status).toBe(201);
      expect((await post(w.cash, `/consultations/${f.consId}/check-in`)).body.code).toBe('FOLLOWUP_NOT_ELIGIBLE');
      const r = await pay(w.cash, { consultation_id: f.consId, ...cashT(w, 30000) });
      expect(r.status).toBe(201); expect(r.body.net_amount).toBe(30000);
    });
  });

  it('فحص نهائي: الاسترجاعات سليمة حسابياً، والنقاط مطابقة للسجل، وأرقام الاسترجاع بدون فجوات', async () => {
    const bad = await db.query(`select * from v_integrity_checks where check_name in ('refund_tenders_sum_mismatch','refund_items_sum_mismatch','payment_tenders_sum_mismatch','payment_items_sum_mismatch','points_balance_mismatch')`);
    // الوصولات المبنية بالقاعدة مباشرة (fixture) تطابق قيودها، فلازم الفحص يطلع فاضي
    expect(bad.rows).toEqual([]);
    const { rows } = await db.query(`select branch_id, array_agg(refund_no order by refund_no) as nos from refunds group by branch_id`);
    for (const r of rows) r.nos.forEach((n: string, i: number) => expect(n).toBe(`R-${year}-${String(i + 1).padStart(5, '0')}`));
    for (const c of (await db.query(`select c.branch_id, c.last_value, (select count(*)::int from refunds r where r.branch_id = c.branch_id) as n from number_counters c where c.kind = 'refund'`)).rows) expect(c.n).toBe(c.last_value);
    const unpaid = await db.query(`select id from payments where status = 'refunded' and exists (select 1 from payment_items where payment_id = payments.id and status = 'paid')`);
    expect(unpaid.rows).toEqual([]);
  });
});
