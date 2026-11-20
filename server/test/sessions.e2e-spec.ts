import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

interface World {
  id: number; code: string; mgr: string; mgrId: number; cash: string; cash2: string; docA: string; docAId: number; cashMethod: number;
  botox: { id: number }; fixed: number; botoxMat: number;
}

describe('جلسات الخطة: الدفع والاسترجاع والنقل والفوات', () => {
  let app: INestApplication; let db: Pool; let today: string; let owner: string; let nurse: string; let doc1: string;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  let phoneSeq = 0; let seq = 0;
  const key = () => `sk-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const d = (n: number) => addDays(today, n);

  async function world(code: string): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name) values ($1,$1) returning id`, [code])).rows[0].id);
    await db.query(`insert into safes (branch_id) values ($1)`, [id]);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id); await seedUser(db, `cash_${code}`, 'cashier', id); await seedUser(db, `cashB_${code}`, 'cashier', id);
    const docAId = await seedUser(db, `docA_${code}`, 'doctor', id);
    await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',100000000,'opening_balance','تجربة',$2)`, [id, mgrId]);
    const [mgr, cash, cash2, docA] = await Promise.all([`mgr_${code}`, `cash_${code}`, `cashB_${code}`, `docA_${code}`].map((u) => tokenFor(app, u)));
    expect((await put(mgr, `/schedule/doctors/${docAId}/weekly`, { days: [1, 2, 3, 4, 5, 6, 7].map((x) => ({ weekday: x, start_time: '09:00', end_time: '13:00' })), effective_from: today })).status).toBe(200);
    const cur = (await get(mgr, '/settings')).body.settings.find((s: any) => s.key === 'booking.daily_limit');
    expect((await put(mgr, '/settings/booking.daily_limit', { value: 1000, expected_version: cur.version })).status).toBe(200);
    const cs = Number((await db.query(`insert into services (branch_id, name_ar, kind, pricing_model, is_active) values ($1,'كشفية','consultation','fixed',true) returning id`, [id])).rows[0].id);
    await db.query(`insert into service_prices (service_id, price, set_by) values ($1,30000,$2)`, [cs, mgrId]);
    const cashMethod = Number((await db.query(`insert into payment_methods (branch_id, name_ar, kind, sort_order) values ($1,'كاش','cash',0) returning id`, [id])).rows[0].id);
    const botoxMat = Number((await db.query(`insert into materials (branch_id, name, base_unit, pack_unit) values ($1,'بوتكس','cc','كرتون') returning id`, [id])).rows[0].id);
    const bs = (await post(mgr, '/services', { name_ar: 'بوتكس', pricing_model: 'per_unit', price: 50000 })).body;
    const bf = (await post(mgr, `/services/${bs.id}/fields`, { field_key: 'cc', label_ar: 'كم cc', field_type: 'number', unit_label: 'cc', pricing_role: 'quantity', is_required: true })).body.fields[0];
    expect((await put(mgr, `/services/${bs.id}/materials`, { items: [{ material_id: botoxMat, formula: 'per_field_value', field_id: bf.id, factor: '1' }] })).status).toBe(200);
    expect((await post(mgr, `/services/${bs.id}/activate`)).status).toBe(200);
    const fx = (await post(mgr, '/services', { name_ar: 'تنظيف بشرة', pricing_model: 'fixed', price: 40000 })).body;
    expect((await post(mgr, `/services/${fx.id}/activate`)).status).toBe(200);
    expect((await post(cash, '/shifts/open', { opening_float: 0 })).status).toBe(201);
    expect((await post(cash2, '/shifts/open', { opening_float: 0 })).status).toBe(201);
    return { id, code, mgr, mgrId, cash, cash2, docA, docAId, cashMethod, botox: { id: bs.id }, fixed: fx.id, botoxMat };
  }
  async function customer(w: World): Promise<number> {
    phoneSeq++;
    const r = await post(w.cash, '/customers', { full_name: `زبون جلسات ${phoneSeq}`, phone: `0795${String(phoneSeq).padStart(7, '0')}` });
    expect(r.status).toBe(201); return r.body.id;
  }
  const cashT = (w: World, amount: number) => ({ tenders: [{ method_id: w.cashMethod, amount }] });
  /** زبون بخطة: كشفية مدفوعة ومفتوحة، وخطة بالبنود المعطاة. يرجع الخطة وجلساتها. */
  async function planned(w: World, items: object[], cust?: number) {
    const c = cust ?? (await customer(w));
    const b = await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docAId, date: today });
    expect(b.status).toBe(201);
    const p = await http().post('/payments/consultation').set(auth(w.cash)).set('Idempotency-Key', key()).send({ consultation_id: b.body.consultation.id, ...cashT(w, 30000) });
    expect(p.status).toBe(201);
    expect((await post(w.docA, `/consultations/${b.body.consultation.id}/enter`)).status).toBe(201);
    const pl = await post(w.docA, `/consultations/${b.body.consultation.id}/plan`, { items });
    expect(pl.status).toBe(201);
    const sessions = pl.body.items.flatMap((i: any) => i.sessions.map((s: any) => ({ ...s, item_id: i.id })));
    return { customer: c, consId: b.body.consultation.id as number, visitId: b.body.id as number, plan: pl.body, sessions, items: pl.body.items };
  }
  /** ينقل زيارة (وجلساتها) ليوم بالقاعدة ويصلّح عدّاد الأيام القديم والجديد (يحاكي مرور الوقت) */
  async function shiftVisit(visitId: number, offset: number) {
    const v = (await db.query(`select branch_id, visit_date::text as d from visits where id = $1`, [visitId])).rows[0];
    const nd = d(offset);
    await db.query(`update visits set visit_date = $2, seq_no = $3 where id = $1`, [visitId, nd, 9000 + (++seq)]);
    await db.query(`update treatment_sessions set scheduled_date = $2 where visit_id = $1 and status in ('booked','paid')`, [visitId, nd]);
    await db.query(`insert into booking_days (branch_id, day, used_slots, last_seq) values ($1, $2, 0, 0) on conflict do nothing`, [v.branch_id, nd]);
    await db.query(`update booking_days bd set used_slots = (select count(*)::int from visits x where x.branch_id = bd.branch_id and x.visit_date = bd.day and x.status in ('booked','arrived')) where bd.branch_id = $1 and bd.day in ($2::date, $3::date)`, [v.branch_id, v.d, nd]);
  }
  /** يجيب جلسة مستقبلية لليوم: الكشفية تروح لأمس أول (الزبون ما يكون عنده زيارتين باليوم) */
  async function bringToToday(x: { visitId: number }, sessionVisitId: number) { await shiftVisit(x.visitId, -1); await shiftVisit(sessionVisitId, 0); }
  const botox = (w: World, over: Record<string, unknown> = {}) => ({ service_id: w.botox.id, values: { cc: 2 }, sessions_count: 3, interval_days: 7, first_session_date: today, ...over });
  const fixedItem = (w: World, over: Record<string, unknown> = {}) => ({ service_id: w.fixed, sessions_count: 2, interval_days: 7, first_session_date: today, ...over });
  const pay = (t: string, body: object, k: string | null = key()) => { const r = http().post('/payments/sessions').set(auth(t)).send(body); return k === null ? r : r.set('Idempotency-Key', k); };
  const refund = (t: string, pid: number, body: object) => http().post(`/payments/${pid}/refund`).set(auth(t)).set('Idempotency-Key', key()).send(body);
  const sessionRow = async (id: number) => one(`select status, visit_id::int as visit_id, scheduled_date::text as d, version from treatment_sessions where id = $1`, [id]);
  const needs = async (sid: number) => (await db.query(`select material_id::int as m, qty_base::float as q from session_material_needs where treatment_session_id = $1`, [sid])).rows;
  async function givePoints(w: World, customerId: number, points: number) {
    phoneSeq++;
    const old = (await db.query(`insert into customers (branch_id, public_code, phone, full_name, source, status, merged_into_id) values ($1,$2,$3,'ملف قديم','cashier','merged',$4) returning id`, [w.id, `OLS${phoneSeq}${Date.now() % 1e5}`, `+9647${String(400000000 + phoneSeq)}`, customerId])).rows[0].id;
    const m = (await db.query(`insert into customer_merges (from_customer_id, into_customer_id, reason, merged_by) values ($1,$2,'تجربة',$3) returning id`, [old, customerId, w.mgrId])).rows[0].id;
    await db.query(`insert into points_ledger (customer_id, entry_type, points, merge_id) values ($1,'merge_in',$2,$3)`, [customerId, points, m]);
  }
  const balance = async (c: number) => Number((await one(`select points_balance from customers where id = $1`, [c])).points_balance);
  const assertConsistent = async (w: World) => {
    expect((await db.query(`select bd.day::text from booking_days bd where bd.branch_id = $1 and bd.used_slots <> (select count(*)::int from visits v where v.branch_id = bd.branch_id and v.visit_date = bd.day and v.status in ('booked','arrived'))`, [w.id])).rows).toEqual([]);
    expect((await db.query(`select s.id from treatment_sessions s left join visits v on v.id = s.visit_id where s.branch_id = $1 and s.status in ('booked','paid') and (v.id is null or v.status not in ('booked','arrived') or v.visit_date <> s.scheduled_date)`, [w.id])).rows).toEqual([]);
    expect((await db.query(`select id from treatment_sessions where branch_id = $1 and status = 'awaiting_booking' and (visit_id is not null or scheduled_date is not null)`, [w.id])).rows).toEqual([]);
    expect((await db.query(`select n.treatment_session_id from session_material_needs n join treatment_sessions s on s.id = n.treatment_session_id where s.branch_id = $1 and s.status in ('awaiting_booking','booked','cancelled')`, [w.id])).rows).toEqual([]);
  };

  beforeAll(async () => {
    app = await makeApp(); db = pool();
    today = (await db.query(`select clinic_today()::text as d`)).rows[0].d;
    [owner, nurse, doc1] = await Promise.all(['owner', 'nurse1', 'doc1'].map((u) => tokenFor(app, u)));
  });
  afterAll(async () => { await app.close(); await db.end(); });

  // ------------------------------------------------------------------------------------------------
  describe('دفع الجلسات', () => {
    let w: World;
    beforeAll(async () => { w = await world('SSA'); });
    it('جلسة اليوم: سعر لحظة الدفع من قيم الخطة، وصل kind=sessions، الجلسة «مدفوعة»، والمواد المحجوزة تنحفظ، والزيارة تبقى «حضر»', async () => {
      const x = await planned(w, [botox(w, { values: { cc: 2.5 } })]);                                   // 125,000 للجلسة، الأولى اليوم
      const s0 = x.sessions[0];
      expect(s0.visit_id).toBe(x.visitId);
      const r = await pay(w.cash, { session_ids: [s0.id], ...cashT(w, 125000) });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ kind: 'sessions', status: 'paid', gross_amount: 125000, net_amount: 125000, points_earned: 3000, visit_id: x.visitId, customer: { id: x.customer } });
      expect(r.body.items).toHaveLength(1);
      expect(r.body.items[0]).toMatchObject({ item_type: 'session', session_id: s0.id, service_name: 'بوتكس', quantity: 2.5, list_price: 125000, net_amount: 125000, status: 'paid', consultation_id: null });
      expect(await sessionRow(s0.id)).toMatchObject({ status: 'paid', visit_id: x.visitId, d: today });
      expect(await needs(s0.id)).toEqual([{ m: w.botoxMat, q: 2.5 }]);
      expect((await one(`select status from visits where id = $1`, [x.visitId])).status).toBe('arrived');
      expect(Number((await one(`select unit_price from (select (pricing_snapshot->>'unit_price')::int as unit_price from payment_items where session_id = $1) t`, [s0.id])).unit_price)).toBe(50000);
      expect((await db.query(`select 1 from audit_log where action = 'payment.sessions' and entity_id = $1`, [r.body.id])).rowCount).toBe(1);
      await assertConsistent(w);
    });
    it('جلسة بزيارة جلسات بس (يوم ثاني): الدفع يخلي الزيارة «حضر» وحدث arrived، وجلستين بوصل واحد بتوزيع الأسعار', async () => {
      const x = await planned(w, [botox(w, { first_session_date: d(3), sessions_count: 1 }), fixedItem(w, { first_session_date: d(3), sessions_count: 1 })]);
      const vid = x.sessions[0].visit_id; expect(x.sessions[1].visit_id).toBe(vid); expect(vid).not.toBe(x.visitId);
      await bringToToday(x, vid);
      const r = await pay(w.cash, { session_ids: x.sessions.map((s: any) => s.id), ...cashT(w, 100000 + 40000) });      // 2 cc = 100,000 + 40,000
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ gross_amount: 140000, net_amount: 140000, visit_id: vid });
      expect(r.body.items.map((i: any) => [i.service_name, i.list_price, i.net_amount])).toEqual([['بوتكس', 100000, 100000], ['تنظيف بشرة', 40000, 40000]]);
      expect((await one(`select status from visits where id = $1`, [vid])).status).toBe('arrived');
      expect((await db.query(`select 1 from booking_events where visit_id = $1 and event = 'arrived'`, [vid])).rowCount).toBe(1);
    });
    it('الخصم المعتمد والنقاط والتقريب تتوزع على الجلسات بأكبر البواقي (مثال 1: 10,000/20,000/30,000)', async () => {
      const p1 = 10000; void p1;
      // ثلاث جلسات بمبالغ 40,000 (تنظيف) ×... نستخدم الخدمة الثابتة بسعر 40,000 لثلاث جلسات بنفس اليوم: الأسعار متساوية
      const x = await planned(w, [fixedItem(w, { sessions_count: 3, interval_days: 0 })]);
      const ids = x.sessions.map((s: any) => s.id);                                                       // 3 جلسات اليوم بنفس زيارة الكشفية
      expect(new Set(x.sessions.map((s: any) => s.visit_id))).toEqual(new Set([x.visitId]));
      await givePoints(w, x.customer, 3250);                                                              // + 750 اكتسبها من الكشفية = رصيد 4,000
      const dr = Number((await one(`insert into discount_requests (branch_id, customer_id, visit_id, basket, status, requested_by, amount, decided_by) values ($1,$2,$3,'[]','approved',$4,10000,$5) returning id`, [w.id, x.customer, x.visitId, w.mgrId, w.mgrId])).id);
      // الإجمالي 120,000 − خصم 10,000 = 110,000 − نقاط 4,000 = 106,000 (مضاعف 250؟ 106,000/250 = 424 ✓) 
      const r = await pay(w.cash, { session_ids: ids, discount_request_id: dr, redeem_points: true, ...cashT(w, 106000) });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ gross_amount: 120000, manual_discount: 10000, points_used: 4000, points_discount: 4000, rounding_amount: 0, net_amount: 106000 });
      const shares = r.body.items;
      expect(shares.map((i: any) => i.manual_discount_share)).toEqual([3334, 3333, 3333]);                // أكبر البواقي: الباقي للأول
      expect(shares.map((i: any) => i.points_used_share)).toEqual([1333, 1334, 1333]);                        // أكبر البواقي على أساس المتبقي بعد الخصم
      expect(shares.map((i: any) => i.points_used_share).reduce((a: number, b: number) => a + b, 0)).toBe(4000);
      expect(shares.map((i: any) => i.net_amount).reduce((a: number, b: number) => a + b, 0)).toBe(106000);
      for (const i of shares) expect(i.net_amount).toBe(i.list_price - i.manual_discount_share - i.points_discount_share - i.rounding_share);
      expect(await balance(x.customer)).toBe(Math.floor(106000 / 10000) * 250);                           // الكسب على المدفوع
    });
    it('تقريب لصالح الزبون على جلسات (2 × 33,333 ← صافي بمضاعف 250) وحصة التقريب بكل بند', async () => {
      expect((await put(w.mgr, `/services/${w.fixed}/price`, { price: 33333 })).status).toBe(200);
      const x = await planned(w, [fixedItem(w, { sessions_count: 2, interval_days: 0 })]);
      const ids = x.sessions.map((s: any) => s.id);
      const bad = await pay(w.cash, { session_ids: ids, ...cashT(w, 66666) });
      expect(bad.body).toMatchObject({ code: 'TENDER_MISMATCH', net_amount: 66500 });
      const r = await pay(w.cash, { session_ids: ids, ...cashT(w, 66500) });
      expect(r.body).toMatchObject({ gross_amount: 66666, rounding_amount: 166, net_amount: 66500 });
      expect(r.body.items.map((i: any) => i.rounding_share)).toEqual([83, 83]);                                   // تتوزع بالنسبة مو على الأول
      expect(r.body.items.map((i: any) => i.net_amount)).toEqual([33250, 33250]);
      expect(r.body.items.map((i: any) => i.rounding_share).reduce((a: number, b: number) => a + b, 0)).toBe(166);
      expect(r.body.items.map((i: any) => i.net_amount).reduce((a: number, b: number) => a + b, 0)).toBe(66500);
      await put(w.mgr, `/services/${w.fixed}/price`, { price: 40000 });
    });
    it('الدفع بسعر اليوم: تغير سعر البوتكس بعد كتابة الخطة ينحسب بالجديد، والكاشير يشوف الفرق (TENDER_MISMATCH)', async () => {
      const x = await planned(w, [botox(w, { values: { cc: 2 }, sessions_count: 1 })]);
      expect((await put(w.mgr, `/services/${w.botox.id}/price`, { price: 60000 })).status).toBe(200);
      const r = await pay(w.cash, { session_ids: [x.sessions[0].id], ...cashT(w, 100000) });
      expect(r.body).toMatchObject({ code: 'TENDER_MISMATCH', net_amount: 120000 });
      expect((await pay(w.cash, { session_ids: [x.sessions[0].id], ...cashT(w, 120000) })).status).toBe(201);
      await put(w.mgr, `/services/${w.botox.id}/price`, { price: 50000 });
    });
    it('الجلسة لازم محجوزة وموعدها اليوم: غداً NOT_TODAY، مدفوعة ALREADY_PAID، تنتظر حجز NOT_PAYABLE، ملغاة، ومختلطة بزبائن 400', async () => {
      const x = await planned(w, [botox(w, { first_session_date: today, sessions_count: 3, interval_days: 7 })]);
      expect((await pay(w.cash, { session_ids: [x.sessions[1].id], ...cashT(w, 100000) })).body).toMatchObject({ code: 'NOT_TODAY', scheduled_date: x.sessions[1].scheduled_date });
      expect((await pay(w.cash, { session_ids: [x.sessions[0].id, x.sessions[1].id], ...cashT(w, 200000) })).body.code).toBe('NOT_TODAY');
      expect((await pay(w.cash, { session_ids: [x.sessions[0].id], ...cashT(w, 100000) })).status).toBe(201);
      expect((await pay(w.cash, { session_ids: [x.sessions[0].id], ...cashT(w, 100000) })).body.code).toBe('SESSION_ALREADY_PAID');
      await db.query(`update treatment_sessions set status = 'awaiting_booking', visit_id = null, scheduled_date = null where id = $1`, [x.sessions[2].id]);
      expect((await pay(w.cash, { session_ids: [x.sessions[2].id], ...cashT(w, 100000) })).body.code).toBe('SESSION_NOT_PAYABLE');
      const y = await planned(w, [fixedItem(w, { sessions_count: 1 })]);
      expect((await pay(w.cash, { session_ids: [x.sessions[1].id, y.sessions[0].id], ...cashT(w, 1) })).body.code).toBe('MIXED_CUSTOMERS');
      await db.query(`update treatment_sessions set status = 'cancelled', cancelled_at = now() where id = $1`, [y.sessions[0].id]);
      expect((await pay(w.cash, { session_ids: [y.sessions[0].id], ...cashT(w, 40000) })).body.code).toBe('SESSION_NOT_PAYABLE');
      expect((await pay(w.cash, { session_ids: [99999999], ...cashT(w, 1) })).status).toBe(404);
    });
    it('طلب خصم مربوط بزيارة ثانية → DISCOUNT_NOT_USABLE، ونفس المفتاح لجلسات مختلفة → 422 (الطلب غير الطلب)', async () => {
      const x = await planned(w, [fixedItem(w, { sessions_count: 1 })]); const other = await planned(w, [fixedItem(w, { sessions_count: 1 })]);
      const wrongVisit = Number((await one(`insert into discount_requests (branch_id, customer_id, visit_id, basket, status, requested_by, amount, decided_by) values ($1,$2,$3,'[]','approved',$4,5000,$5) returning id`, [w.id, x.customer, other.visitId, w.mgrId, w.mgrId])).id);
      expect((await pay(w.cash, { session_ids: [x.sessions[0].id], discount_request_id: wrongVisit, ...cashT(w, 35000) })).body.code).toBe('DISCOUNT_NOT_USABLE');
      expect((await one(`select status from treatment_sessions where id = $1`, [x.sessions[0].id])).status).toBe('booked');
      const k = key();
      expect((await pay(w.cash, { session_ids: [x.sessions[0].id], ...cashT(w, 40000) }, k)).status).toBe(201);
      expect((await pay(w.cash, { session_ids: [other.sessions[0].id], ...cashT(w, 40000) }, k)).status).toBe(422);
      expect((await one(`select status from treatment_sessions where id = $1`, [other.sessions[0].id])).status).toBe('booked');
    });
    it('الصلاحيات والتحقق: مفتاح التكرار إلزامي، الممرض والطبيب والمدير 403، فرع ثاني 404، بدون شفت 409، ومدخلات غلط 400', async () => {
      const x = await planned(w, [fixedItem(w, { sessions_count: 1 })]); const sid = x.sessions[0].id;
      expect((await pay(w.cash, { session_ids: [sid], ...cashT(w, 40000) }, null)).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      for (const t of [nurse, doc1, w.mgr, w.docA]) expect((await pay(t, { session_ids: [sid], ...cashT(w, 40000) })).status).toBe(403);
      const other = await world('SSA2');
      expect((await pay(other.cash, { session_ids: [sid], ...cashT(w, 40000) })).status).toBe(404);
      await post(w.cash2, '/shifts/current/close', { counts: [{ method_id: w.cashMethod, counted: 0 }] });
      expect((await pay(w.cash2, { session_ids: [sid], ...cashT(w, 40000) })).body.code).toBe('NO_OPEN_SHIFT');
      for (const bad of [{ session_ids: [] }, { session_ids: [sid, sid] }, { session_ids: ['x'] }, { session_ids: [sid], net_amount: 1 }, {}]) expect((await pay(w.cash, bad)).status).toBe(400);
      expect((await one(`select status from treatment_sessions where id = $1`, [sid])).status).toBe('booked');
      await post(w.cash2, '/shifts/open', { opening_float: 0 });
    });
    it('منع التكرار: نفس المفتاح = نفس الوصل، و7 دفعات متزامنة لنفس الجلسة بمفاتيح مختلفة = واحد، والمواد ما تنحجز مرتين', async () => {
      const x = await planned(w, [botox(w, { sessions_count: 1 })]); const sid = x.sessions[0].id; const k = key();
      const a = await pay(w.cash, { session_ids: [sid], ...cashT(w, 100000) }, k); const b = await pay(w.cash, { session_ids: [sid], ...cashT(w, 100000) }, k);
      expect(b.body).toEqual(a.body); expect(b.headers['idempotent-replay']).toBe('true');
      const y = await planned(w, [botox(w, { sessions_count: 1 })]);
      const rs = await Promise.all(Array.from({ length: 7 }, () => pay(w.cash, { session_ids: [y.sessions[0].id], ...cashT(w, 100000) })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'SESSION_ALREADY_PAID')).toHaveLength(6);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(await needs(y.sessions[0].id)).toEqual([{ m: w.botoxMat, q: 2 }]);
      expect(Number((await one(`select count(*)::int as n from payment_items where session_id = $1`, [y.sessions[0].id])).n)).toBe(1);
    });
    it('المحجوز يظهر بالمخزون: المتاح = الموجود − المحجوز، والتالف ما ياخذ المحجوز', async () => {
      const x = await world('SSB');
      const batch = (await one(`insert into material_batches (branch_id, material_id, source, received_on, expiry_date, unit_cost, qty_initial, qty_on_hand) values ($1,$2,'opening',clinic_today(),clinic_today() + 300,1000,10,0) returning id`, [x.id, x.botoxMat])).id;
      await db.query(`insert into stock_movements (branch_id, material_id, batch_id, movement_type, qty_delta, unit_cost, cost_amount) values ($1,$2,$3,'opening',10,1000,10000)`, [x.id, x.botoxMat, batch]);
      const p = await planned(x, [botox(x, { values: { cc: 6 }, sessions_count: 1 })]);
      expect((await pay(x.cash, { session_ids: [p.sessions[0].id], ...cashT(x, 300000) })).status).toBe(201);
      const mat = (await get(x.mgr, `/materials/${x.botoxMat}`)).body;
      expect(mat.stock).toMatchObject({ on_hand: 10, reserved: 6, available: 4 });
      expect((await post(x.mgr, '/stock/waste', { batch_id: Number(batch), qty: 5, reason: 'damaged' })).body.code).toBe('WASTE_RESERVED');
      expect((await post(x.mgr, '/stock/waste', { batch_id: Number(batch), qty: 4, reason: 'damaged' })).status).toBe(201);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('استرجاع الجلسة', () => {
    let w: World;
    beforeAll(async () => { w = await world('SSC'); });
    it('قبل التأكيد: تنسترجع، ترجع «تنتظر حجز» بدون زيارة وموعد، المحجوز ينحذف، والنقاط، وزيارتها الفارغة تنلغي ويرجع مقعدها', async () => {
      const x = await planned(w, [botox(w, { first_session_date: d(2), sessions_count: 2, interval_days: 7 })]);
      const s = x.sessions[0];
      await bringToToday(x, s.visit_id);
      const pr = await pay(w.cash, { session_ids: [s.id], ...cashT(w, 100000) });
      expect(pr.status).toBe(201); expect(pr.body.points_earned).toBe(2500);
      const used0 = Number((await one(`select used_slots from booking_days where branch_id = $1 and day = clinic_today()`, [w.id])).used_slots);
      const r = await refund(w.cash, pr.body.id, { full_receipt: true, reason: 'الزبون تراجع' });
      expect(r.status).toBe(201); expect(r.body).toMatchObject({ total_amount: 100000, points_clawed_back: 2500, payment_status: 'refunded' });
      expect(await sessionRow(s.id)).toMatchObject({ status: 'awaiting_booking', visit_id: null, d: null });
      expect(await needs(s.id)).toEqual([]);
      expect((await one(`select status from visits where id = $1`, [s.visit_id])).status).toBe('cancelled');
      expect(Number((await one(`select used_slots from booking_days where branch_id = $1 and day = clinic_today()`, [w.id])).used_slots)).toBe(used0 - 1);
      expect((await one(`select status from treatment_sessions where id = $1`, [x.sessions[1].id])).status).toBe('booked');          // اللي بعدها ما تتأثر
      expect((await db.query(`select 1 from booking_events where treatment_session_id = $1 and event = 'cancelled' and reason like 'استرجاع%'`, [s.id])).rowCount).toBe(1);
      await assertConsistent(w);
    });
    it('جلسة بزيارة الكشفية: الزيارة تبقى، وبعد تأكيد الممرض (مكتملة) الاسترجاع ممنوع، ومرتين 409', async () => {
      const x = await planned(w, [botox(w, { sessions_count: 2 })]);
      const pr = await pay(w.cash, { session_ids: [x.sessions[0].id], ...cashT(w, 100000) });
      const r = await refund(w.cash, pr.body.id, { full_receipt: true, reason: 'تجربة' });
      expect(r.status).toBe(201);
      expect((await one(`select status from visits where id = $1`, [x.visitId])).status).toBe('arrived');                              // فيها الكشفية
      expect((await refund(w.cash, pr.body.id, { full_receipt: true, reason: 'مرة ثانية' })).body.code).toBe('ALREADY_REFUNDED');
      const y = await planned(w, [botox(w, { sessions_count: 1 })]);
      const py = await pay(w.cash, { session_ids: [y.sessions[0].id], ...cashT(w, 100000) });
      await db.query(`update treatment_sessions set status = 'completed', completed_at = now(), completed_by = (select id from users where username = 'nurse1') where id = $1`, [y.sessions[0].id]);
      const bad = await refund(w.cash, py.body.id, { full_receipt: true, reason: 'تجربة' });
      expect(bad.status).toBe(409); expect(bad.body.code).toBe('SESSION_COMPLETED');
      expect((await one(`select status from payments where id = $1`, [py.body.id])).status).toBe('paid');
    });
    it('استرجاع جلسة من وصل بجلستين: الثانية تبقى مدفوعة، والمواد المحجوزة للمسترجعة بس تنحذف، والوصل «مسترجع جزئياً»', async () => {
      const x = await planned(w, [botox(w, { values: { cc: 2 }, sessions_count: 1 }), fixedItem(w, { sessions_count: 1 })]);
      const [a, b] = x.sessions;
      const pr = await pay(w.cash, { session_ids: [a.id, b.id], ...cashT(w, 140000) });
      const itemA = pr.body.items.find((i: any) => i.session_id === a.id).id;
      const r = await refund(w.cash, pr.body.id, { items: [itemA], reason: 'جلسة وحدة' });
      expect(r.body).toMatchObject({ total_amount: 100000, payment_status: 'partially_refunded' });
      expect((await sessionRow(a.id)).status).toBe('awaiting_booking'); expect((await sessionRow(b.id)).status).toBe('paid');
      expect(await needs(a.id)).toEqual([]);
      expect((await one(`select status from visits where id = $1`, [x.visitId])).status).toBe('arrived');                              // الجلسة الثانية والكشفية فيها
      await assertConsistent(w);
    });
    it('زيارة جلسات بس فيها جلستين: استرجاع وحدة ما يلغي الزيارة (فيها الثانية)، واسترجاع الثانية تلغيها ويرجع المقعد', async () => {
      const x = await planned(w, [fixedItem(w, { first_session_date: d(6), sessions_count: 1 }), botox(w, { first_session_date: d(6), sessions_count: 1 })]);
      const vid = x.sessions[0].visit_id; expect(x.sessions[1].visit_id).toBe(vid);
      await bringToToday(x, vid);
      const pr = await pay(w.cash, { session_ids: x.sessions.map((q: any) => q.id), ...cashT(w, 140000) });
      expect(pr.status).toBe(201);
      const used = Number((await one(`select used_slots from booking_days where branch_id = $1 and day = clinic_today()`, [w.id])).used_slots);
      const it = (sid: number) => pr.body.items.find((i: any) => i.session_id === sid).id;
      expect((await refund(w.cash, pr.body.id, { items: [it(x.sessions[0].id)], reason: 'الأولى' })).status).toBe(201);
      expect((await one(`select status from visits where id = $1`, [vid])).status).toBe('arrived');
      expect(Number((await one(`select used_slots from booking_days where branch_id = $1 and day = clinic_today()`, [w.id])).used_slots)).toBe(used);
      expect((await refund(w.cash, pr.body.id, { items: [it(x.sessions[1].id)], reason: 'الثانية' })).status).toBe(201);
      expect((await one(`select status from visits where id = $1`, [vid])).status).toBe('cancelled');
      expect(Number((await one(`select used_slots from booking_days where branch_id = $1 and day = clinic_today()`, [w.id])).used_slots)).toBe(used - 1);
      await assertConsistent(w);
    });
    it('قفل الجلسة بالاسترجاع (حتمي): تأكيد جاري (اكتملت) والاسترجاع يوصل → ينتظر ويرفض SESSION_COMPLETED ولا يكتب فوق الاكتمال', async () => {
      const x = await planned(w, [botox(w, { sessions_count: 1 })]);
      const pr = await pay(w.cash, { session_ids: [x.sessions[0].id], ...cashT(w, 100000) });
      const hold = await db.connect(); let res: any; let held = true;
      try {
        await hold.query('begin');
        await hold.query(`select 1 from treatment_sessions where id = $1 for update`, [x.sessions[0].id]);
        await hold.query(`update treatment_sessions set status = 'completed', completed_at = now(), completed_by = (select id from users where username = 'nurse1') where id = $1`, [x.sessions[0].id]);
        const p = refund(w.cash, pr.body.id, { full_receipt: true, reason: 'سباق' }).then((r) => { res = r; return r; });
        await new Promise((r) => setTimeout(r, 400));
        await hold.query('commit'); held = false;
        await p;
      } finally { if (held) await hold.query('rollback'); hold.release(); }
      expect(res.status).toBe(409); expect(res.body.code).toBe('SESSION_COMPLETED');
      expect((await sessionRow(x.sessions[0].id)).status).toBe('completed');
      expect((await one(`select status from payments where id = $1`, [pr.body.id])).status).toBe('paid');
    });
    it('استرجاع الجلسة وتأكيدها (اكتملت) بنفس اللحظة: واحد يفوز والحالة سليمة', async () => {
      for (let i = 0; i < 3; i++) {
        const x = await planned(w, [botox(w, { sessions_count: 1 })]);
        const pr = await pay(w.cash, { session_ids: [x.sessions[0].id], ...cashT(w, 100000) });
        const complete = (async () => {                                           // نفس وصفة قفل وحدة الممرض: الجلسة بقفل ثم فحص الحالة
          const c = await db.connect();
          try { await c.query('begin'); await c.query(`select 1 from treatment_sessions where id = $1 for update`, [x.sessions[0].id]);
            const r = await c.query(`update treatment_sessions set status = 'completed', completed_at = now(), completed_by = (select id from users where username = 'nurse1') where id = $1 and status = 'paid'`, [x.sessions[0].id]);
            await c.query('commit'); return r.rowCount === 1; } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
        })();
        const [r, done] = await Promise.all([refund(w.cash, pr.body.id, { full_receipt: true, reason: 'سباق' }), complete]);
        expect([r.status].filter((s) => s >= 500)).toHaveLength(0);
        expect([r.status === 201, done].filter(Boolean)).toHaveLength(1);
        expect((await sessionRow(x.sessions[0].id)).status).toBe(r.status === 201 ? 'awaiting_booking' : 'completed');
      }
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('نقل الجلسة وتغيير موعدها', () => {
    let w: World;
    beforeAll(async () => { w = await world('SSD'); });
    it('جلسة غير مدفوعة: تنتقل بأي وقت لليوم المطلوب برقم جديد، وزيارتها القديمة (اللي فيها هي بس) تنلغي ويرجع المقعد', async () => {
      const x = await planned(w, [fixedItem(w, { first_session_date: d(5), sessions_count: 2, interval_days: 7 })]);
      const s = x.sessions[0];
      const used5 = Number((await one(`select used_slots from booking_days where branch_id = $1 and day = $2`, [w.id, d(5)])).used_slots);
      const r = await post(w.cash, `/sessions/${s.id}/move`, { date: d(8), reason: 'طلب الزبون' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ id: s.id, status: 'booked', scheduled_date: d(8), planned_date: d(5) });
      expect((await one(`select status from visits where id = $1`, [s.visit_id])).status).toBe('cancelled');
      expect(Number((await one(`select used_slots from booking_days where branch_id = $1 and day = $2`, [w.id, d(5)])).used_slots)).toBe(used5 - 1);
      expect(await one(`select event, from_date::text as f, to_date::text as t from booking_events where treatment_session_id = $1 and event = 'moved_by_cashier'`, [s.id])).toEqual({ event: 'moved_by_cashier', f: d(5), t: d(8) });
      expect((await db.query(`select 1 from audit_log where action = 'session.move' and entity_id = $1 and reason = 'طلب الزبون'`, [s.id])).rowCount).toBe(1);
      await assertConsistent(w);
    });
    it('الجلسات غير المدفوعة اللي بعدها تنزاح بالفرق (3 جلسات كل 7 أيام: نقل الأولى لـ +20 يزيح الثانية لـ +27 والثالثة لـ +34)، والتقديم قبل الفرق مرفوض', async () => {
      const x = await planned(w, [fixedItem(w, { first_session_date: d(10), sessions_count: 3, interval_days: 7 })]);
      const [s1, s2, s3] = x.sessions;
      expect([s1, s2, s3].map((s: any) => s.scheduled_date)).toEqual([d(10), d(17), d(24)]);
      const r = await post(w.cash, `/sessions/${s1.id}/move`, { date: d(20) });
      expect(r.status).toBe(201);
      expect(r.body.cascaded.map((c: any) => c.scheduled_date)).toEqual([d(27), d(34)]);
      expect((await sessionRow(s2.id)).d).toBe(d(27)); expect((await sessionRow(s3.id)).d).toBe(d(34));
      const early = await post(w.cash, `/sessions/${s2.id}/move`, { date: d(26) });                     // أقل من 20+7
      expect(early.status).toBe(409); expect(early.body).toMatchObject({ code: 'TOO_EARLY', earliest_date: d(27), interval_days: 7 });
      expect((await post(w.cash, `/sessions/${s2.id}/move`, { date: d(27) })).body.code).toBe('SAME_DATE');
      expect((await post(w.cash, `/sessions/${s2.id}/move`, { date: d(28) })).status).toBe(201);          // تأخير مسموح
      expect((await sessionRow(s3.id)).d).toBe(d(35));                                                     // وتتحرك الثالثة وياها
      await assertConsistent(w);
    });
    it('النقل لأبكر من الجلسة اللي قبلها + الفرق مرفوض، وللتقديم (بدون ازاحة) مسموح لحد الفرق', async () => {
      const x = await planned(w, [fixedItem(w, { first_session_date: d(40), sessions_count: 2, interval_days: 14 })]);
      const [s1, s2] = x.sessions;
      expect((await post(w.cash, `/sessions/${s2.id}/move`, { date: d(53) })).body.code).toBe('TOO_EARLY');
      expect((await post(w.cash, `/sessions/${s2.id}/move`, { date: d(54) })).body.code).toBe('SAME_DATE');            // نفس موعدها (40+14)
      expect((await post(w.cash, `/sessions/${s2.id}/move`, { date: d(60) })).status).toBe(201);
      void s1;
    });
    it('الجلسة المدفوعة: الكاشير ينقلها ليوم ثاني بنفس الوصل (تبقى مدفوعة، المواد المحجوزة تبقى، الوصل ما يتغير)', async () => {
      const x = await planned(w, [botox(w, { sessions_count: 2, interval_days: 7 })]);
      const s = x.sessions[0];
      const pr = await pay(w.cash, { session_ids: [s.id], ...cashT(w, 100000) });
      const r = await post(w.cash2, `/sessions/${s.id}/move`, { date: d(3), reason: 'الزبون ما قدر يكمل' });
      expect(r.status).toBe(201); expect(r.body).toMatchObject({ status: 'paid', scheduled_date: d(3) });
      expect(await needs(s.id)).toEqual([{ m: w.botoxMat, q: 2 }]);
      expect((await one(`select visit_id from payments where id = $1`, [pr.body.id])).visit_id === null).toBe(false);          // الوصل يبقى مربوط بالزيارة الأصلية
      expect((await one(`select status from visits where id = $1`, [x.visitId])).status).toBe('arrived');                       // فيها الكشفية
      expect((await one(`select status from payment_items where session_id = $1`, [s.id])).status).toBe('paid');
      const later = await sessionRow(x.sessions[1].id);
      expect(later.d >= addDays(d(3), 7)).toBe(true);                                                                           // الجلسة غير المدفوعة اللي بعدها انزاحت
      expect((await pay(w.cash, { session_ids: [s.id], ...cashT(w, 100000) })).body.code).toBe('SESSION_ALREADY_PAID');
      await assertConsistent(w);
    });
    it('يوم ممتلئ → 409 DAY_FULL مع اقتراح، يوم مسكر → CLINIC_CLOSED، ماضي/بعيد، وتنضم لزيارة الزبون الموجودة بنفس اليوم بدون مقعد', async () => {
      const x = await world('SSD2');
      const lim = (await get(x.mgr, '/settings')).body.settings.find((s: any) => s.key === 'booking.daily_limit');
      expect((await put(x.mgr, '/settings/booking.daily_limit', { value: 2, expected_version: lim.version })).status).toBe(200);
      const p = await planned(x, [fixedItem(x, { first_session_date: d(3), sessions_count: 1 })]);
      for (let i = 0; i < 2; i++) { const c = await customer(x); expect((await post(x.cash, '/bookings', { customer_id: c, doctor_id: x.docAId, date: d(6) })).status).toBe(201); }
      const full = await post(x.cash, `/sessions/${p.sessions[0].id}/move`, { date: d(6) });
      expect(full.status).toBe(409); expect(full.body).toMatchObject({ code: 'DAY_FULL', next_available_date: d(7) });
      expect((await post(x.mgr, '/schedule/holidays', { date: d(8), name: 'عطلة' })).status).toBe(201);
      expect((await post(x.cash, `/sessions/${p.sessions[0].id}/move`, { date: d(8) })).body).toMatchObject({ code: 'CLINIC_CLOSED', next_available_date: d(9) });
      expect((await post(x.cash, `/sessions/${p.sessions[0].id}/move`, { date: d(-1) })).body.code).toBe('DATE_IN_PAST');
      expect((await post(x.cash, `/sessions/${p.sessions[0].id}/move`, { date: d(400) })).body.code).toBe('DATE_TOO_FAR');
      expect((await one(`select status from visits where id = $1`, [p.sessions[0].visit_id])).status).toBe('booked');             // ما تغير شي
      // ينضم لزيارة موجودة للزبون: له حجز كشفية بيوم d12 (مقعد واحد) ينتقل له بدون مقعد جديد
      const c2 = await customer(x); const bk = await post(x.cash, '/bookings', { customer_id: c2, doctor_id: x.docAId, date: d(12) });
      expect(bk.status).toBe(201);
      const seatsBefore = Number((await one(`select used_slots from booking_days where branch_id = $1 and day = $2`, [x.id, d(12)])).used_slots);
      expect(seatsBefore).toBe(1);
    });
    it('جلسة تنتظر حجز ما تنتقل، وملغاة، وخطة موقوفة، وصلاحيات الكاشير والمدير والمالك بس، وفرع ثاني 404', async () => {
      const x = await planned(w, [fixedItem(w, { first_session_date: d(15), sessions_count: 2 })]);
      const [s1] = x.sessions;
      await db.query(`update treatment_sessions set status = 'awaiting_booking', visit_id = null, scheduled_date = null where id = $1`, [s1.id]);
      expect((await post(w.cash, `/sessions/${s1.id}/move`, { date: d(20) })).body.code).toBe('NOT_MOVABLE');
      const y = await planned(w, [fixedItem(w, { first_session_date: d(15), sessions_count: 1 })]);
      for (const t of [nurse, doc1, w.docA]) expect((await post(t, `/sessions/${y.sessions[0].id}/move`, { date: d(20) })).status).toBe(403);
      const other = await world('SSD3');
      expect((await post(other.cash, `/sessions/${y.sessions[0].id}/move`, { date: d(20) })).status).toBe(404);
      expect((await post(w.mgr, `/sessions/${y.sessions[0].id}/move`, { date: d(20) })).status).toBe(201);
      expect((await post(owner, `/sessions/${y.sessions[0].id}/move`, { date: d(21) })).status).toBe(201);
      await post(w.docA, `/plans/${y.plan.id}/stop`, { reason: 'إيقاف' });
      expect((await post(w.cash, `/sessions/${y.sessions[0].id}/move`, { date: d(25) })).body.code).toBe('NOT_MOVABLE');                 // الملغاة
      expect((await post(w.cash, '/sessions/99999999/move', { date: d(20) })).status).toBe(404);
      expect((await post(w.cash, `/sessions/${y.sessions[0].id}/move`, { date: 'x' })).status).toBe(400);
    });
    it('الجلسة المدفوعة بخطة موقوفة ما تنتقل (PLAN_NOT_ACTIVE)', async () => {
      const x = await planned(w, [botox(w, { sessions_count: 2, interval_days: 7 })]);
      await pay(w.cash, { session_ids: [x.sessions[0].id], ...cashT(w, 100000) });
      expect((await post(w.docA, `/plans/${x.plan.id}/stop`, { reason: 'إيقاف' })).status).toBe(201);
      expect((await sessionRow(x.sessions[0].id)).status).toBe('paid');
      expect((await post(w.cash, `/sessions/${x.sessions[0].id}/move`, { date: d(5) })).body.code).toBe('PLAN_NOT_ACTIVE');
    });
    it('الإزاحة تتوقف عند جلسة مدفوعة (ما تنتقل ولا اللي بعدها)، وتتوقف أول جلسة ما تحتاج إزاحة (ما تتقدم)', async () => {
      const x = await planned(w, [fixedItem(w, { sessions_count: 3, interval_days: 7, first_session_date: d(10) })]);
      const [s1, s2, s3] = x.sessions;                                                                         // 10، 17، 24
      await db.query(`update treatment_sessions set status = 'paid' where id = $1`, [s2.id]);                  // الثانية مدفوعة (حيلة)
      expect((await post(w.cash, `/sessions/${s1.id}/move`, { date: d(20) })).body.cascaded).toEqual([]);
      expect((await sessionRow(s2.id)).d).toBe(d(17)); expect((await sessionRow(s3.id)).d).toBe(d(24));        // ما تأثرت
      await db.query(`update treatment_sessions set status = 'booked' where id = $1`, [s2.id]);
      const y = await planned(w, [{ service_id: w.fixed, sessions_count: 3, interval_days: 7, dates: [d(10), d(30), d(40)] }]);
      const mv = await post(w.cash, `/sessions/${y.sessions[0].id}/move`, { date: d(12) });
      expect(mv.body.cascaded).toEqual([]);                                                                    // 12+7 = 19 ≤ 30: ما تحتاج إزاحة
      expect((await sessionRow(y.sessions[1].id)).d).toBe(d(30)); expect((await sessionRow(y.sessions[2].id)).d).toBe(d(40));
      await assertConsistent(w);
    });
    it('قفل الجلسة بالنقل (حتمي): تأكيد جاري (اكتملت) والنقل يوصل → ينتظر ويرفض NOT_MOVABLE، والجلسة المكتملة ما تتحرك', async () => {
      const x = await planned(w, [fixedItem(w, { sessions_count: 1, first_session_date: d(9) })]);
      const sid = x.sessions[0].id; const date0 = x.sessions[0].scheduled_date;
      const hold = await db.connect(); let res: any; let held = true;
      try {
        await hold.query('begin');
        await hold.query(`select 1 from treatment_sessions where id = $1 for update`, [sid]);
        await hold.query(`update treatment_sessions set status = 'completed', completed_at = now(), completed_by = (select id from users where username = 'nurse1') where id = $1`, [sid]);
        const p = post(w.cash, `/sessions/${sid}/move`, { date: d(12) }).then((r) => { res = r; return r; });
        await new Promise((r) => setTimeout(r, 400));
        await hold.query('commit'); held = false;
        await p;
      } finally { if (held) await hold.query('rollback'); hold.release(); }
      expect(res.status).toBe(409); expect(res.body.code).toBe('NOT_MOVABLE');
      expect((await sessionRow(sid)).d).toBe(date0);
      await db.query(`update treatment_sessions set status = 'booked', completed_at = null, completed_by = null where id = $1`, [sid]);
    });
    it('نقلات متزامنة: 6 جلسات لـ 6 زبائن لنفس اليوم والحد 3: ثلاث تنجح والباقي DAY_FULL، والمقاعد = الحد', async () => {
      const x = await world('SSD4');
      const ps = []; for (let i = 0; i < 6; i++) ps.push(await planned(x, [fixedItem(x, { first_session_date: d(30 + i), sessions_count: 1 })]));
      const lim = (await get(x.mgr, '/settings')).body.settings.find((s: any) => s.key === 'booking.daily_limit');
      expect((await put(x.mgr, '/settings/booking.daily_limit', { value: 3, expected_version: lim.version })).status).toBe(200);
      const rs = await Promise.all(ps.map((p) => post(x.cash, `/sessions/${p.sessions[0].id}/move`, { date: d(50) })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(3);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'DAY_FULL')).toHaveLength(3);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(Number((await one(`select used_slots from booking_days where branch_id = $1 and day = $2`, [x.id, d(50)])).used_slots)).toBe(3);
      await assertConsistent(x);
    });
    it('نقل جلسة ودفعها بنفس اللحظة: واحد منطقي (إما اندفعت بيومها أو انتقلت) والحالة سليمة', async () => {
      for (let i = 0; i < 3; i++) {
        const x = await planned(w, [fixedItem(w, { sessions_count: 1 })]);
        const [m, p] = await Promise.all([post(w.cash, `/sessions/${x.sessions[0].id}/move`, { date: d(20 + i) }), pay(w.cash, { session_ids: [x.sessions[0].id], ...cashT(w, 40000) })]);
        expect([m.status, p.status].filter((s) => s >= 500)).toHaveLength(0);
        const st = await sessionRow(x.sessions[0].id);
        if (p.status === 201) expect(['paid']).toContain(st.status); else expect(st.d).toBe(d(20 + i));
      }
      await assertConsistent(w);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('تحرير الجلسات الفائتة وإعادة حجزها', () => {
    let w: World;
    beforeAll(async () => { w = await world('SSE'); });
    const ageVisit = (visitId: number) => shiftVisit(visitId, -1);
    it('إقفال اليوم: زيارة جلسة فاتت (غير مدفوعة) → الجلسة «تنتظر حجز» (ما تنلغي ولا تنحسب غياب) والجلسات اللي بعدها تتحرر وتنلغي زياراتها', async () => {
      const x = await planned(w, [fixedItem(w, { first_session_date: d(4), sessions_count: 3, interval_days: 7 })]);
      const [s1, s2, s3] = x.sessions;
      await ageVisit(s1.visit_id);
      const seats2 = Number((await one(`select used_slots from booking_days where branch_id = $1 and day = $2`, [w.id, s2.scheduled_date])).used_slots);
      const r = await post(w.mgr, '/bookings/close-past-days');
      expect(r.status).toBe(201); expect(r.body.missed).toBeGreaterThanOrEqual(1);
      expect(await sessionRow(s1.id)).toMatchObject({ status: 'awaiting_booking', visit_id: null, d: null });
      expect(await sessionRow(s2.id)).toMatchObject({ status: 'awaiting_booking', visit_id: null, d: null });
      expect(await sessionRow(s3.id)).toMatchObject({ status: 'awaiting_booking', visit_id: null, d: null });
      expect((await one(`select status from visits where id = $1`, [s1.visit_id])).status).toBe('missed');
      expect((await one(`select status from visits where id = $1`, [s2.visit_id])).status).toBe('cancelled');
      expect(Number((await one(`select used_slots from booking_days where branch_id = $1 and day = $2`, [w.id, s2.scheduled_date])).used_slots)).toBe(seats2 - 1);
      expect((await db.query(`select event from booking_events where treatment_session_id = any($1::bigint[]) and event in ('released_missed','released_chain') order by id`, [[s1.id, s2.id, s3.id]])).rows.map((e) => e.event)).toEqual(['released_missed', 'released_chain', 'released_chain']);
      await assertConsistent(w);
    });
    it('الجلسة المدفوعة اللي فات يومها ما تتحرر ولا تكتمل: تظهر بقائمة المتابعة، والكاشير ينقلها ليوم جديد بنفس الوصل', async () => {
      const x = await planned(w, [botox(w, { sessions_count: 2, interval_days: 7 })]);
      const pr = await pay(w.cash, { session_ids: [x.sessions[0].id], ...cashT(w, 100000) });
      await ageVisit(x.visitId);
      await post(w.mgr, '/bookings/close-past-days');
      expect((await sessionRow(x.sessions[0].id)).status).toBe('paid');
      const fu = (await get(w.cash, '/sessions/follow-up')).body;
      expect(fu.paid_not_executed.map((s: any) => s.session_id)).toContain(x.sessions[0].id);
      expect(fu.paid_not_executed.find((s: any) => s.session_id === x.sessions[0].id)).toMatchObject({ customer: { id: x.customer }, service_name: 'بوتكس', seq_no: 1 });
      const mv = await post(w.cash, `/sessions/${x.sessions[0].id}/move`, { date: d(2), reason: 'ما لحگ' });
      expect(mv.status).toBe(201); expect(mv.body).toMatchObject({ status: 'paid', scheduled_date: d(2) });
      expect((await get(w.cash, '/sessions/follow-up')).body.paid_not_executed.map((s: any) => s.session_id)).not.toContain(x.sessions[0].id);
      expect((await one(`select status from payments where id = $1`, [pr.body.id])).status).toBe('paid');
    });
    it('قائمة المتابعة ما تذكر جلسات تنتظر حجز بخطة موقوفة', async () => {
      const x = await planned(w, [fixedItem(w, { first_session_date: d(6), sessions_count: 1 })]);
      await db.query(`update treatment_sessions set status = 'awaiting_booking', visit_id = null, scheduled_date = null where id = $1`, [x.sessions[0].id]);
      expect((await get(w.cash, '/sessions/follow-up')).body.awaiting_booking.map((q: any) => q.session_id)).toContain(x.sessions[0].id);
      await db.query(`update treatment_plans set status = 'stopped', stopped_at = now(), stopped_by = $2, stop_reason = 'x' where id = $1`, [x.plan.id, w.docAId]);
      expect((await get(w.cash, '/sessions/follow-up')).body.awaiting_booking.map((q: any) => q.session_id)).not.toContain(x.sessions[0].id);
    });
    it('حجز الجلسة الفائتة: أقرب يوم صالح بعد التاريخ المطلوب، وتنحجز تلقائياً الجلسات المحررة اللي بعدها بالفرق', async () => {
      const x = await planned(w, [fixedItem(w, { first_session_date: d(4), sessions_count: 3, interval_days: 7 })]);
      const [s1, s2, s3] = x.sessions;
      await ageVisit(s1.visit_id); await post(w.mgr, '/bookings/close-past-days');
      const wait = (await get(w.cash, '/sessions/follow-up')).body.awaiting_booking.filter((s: any) => [s1.id, s2.id, s3.id].includes(s.session_id));
      expect(wait.map((s: any) => s.session_id)).toEqual([s1.id, s2.id, s3.id]);
      const cs = (await get(w.cash, `/customers/${x.customer}/sessions`)).body.sessions.filter((s: any) => [s1.id, s2.id, s3.id].includes(s.id));
      expect(cs.map((s: any) => [s.status, s.estimate_price, s.payable_today])).toEqual([['awaiting_booking', 40000, false], ['awaiting_booking', 40000, false], ['awaiting_booking', 40000, false]]);
      expect((await post(w.cash, `/sessions/${s2.id}/book`, { date: d(10) })).body).toMatchObject({ code: 'PREVIOUS_NOT_BOOKED', session_id: s1.id });
      expect((await post(w.cash, `/sessions/${s1.id}/book`, { date: d(-1) })).body.code).toBe('DATE_IN_PAST');
      await post(w.mgr, '/schedule/holidays', { date: d(6), name: 'عطلة' });
      const r = await post(w.cash, `/sessions/${s1.id}/book`, { date: d(6) });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ status: 'booked', scheduled_date: d(7), requested_date: d(6), moved_from_requested: true });          // d6 عطلة
      expect(r.body.rebooked.map((x: any) => [x.id, x.scheduled_date])).toEqual([[s2.id, d(14)], [s3.id, d(21)]]);
      expect((await sessionRow(s2.id)).status).toBe('booked'); expect((await sessionRow(s3.id)).d).toBe(d(21));
      expect((await post(w.cash, `/sessions/${s1.id}/book`, { date: d(8) })).body.code).toBe('NOT_AWAITING');
      await assertConsistent(w);
    });
    it('جلسة بعد تحرير ما تنحجز بأقل من الفرق عن اللي قبلها (المحجوزة)، والخطة الموقوفة، والصلاحيات والفرع', async () => {
      const x = await planned(w, [fixedItem(w, { first_session_date: d(4), sessions_count: 2, interval_days: 10 })]);
      const [s1, s2] = x.sessions;
      await db.query(`update treatment_sessions set status = 'awaiting_booking', visit_id = null, scheduled_date = null where id = $1`, [s2.id]);
      expect((await post(w.cash, `/sessions/${s2.id}/book`, { date: d(8) })).body).toMatchObject({ code: 'TOO_EARLY', earliest_date: d(14) });
      expect((await post(w.cash, `/sessions/${s2.id}/book`, { date: d(14) })).status).toBe(201);
      void s1;
      const y = await planned(w, [fixedItem(w, { first_session_date: d(4), sessions_count: 1 })]);
      await db.query(`update treatment_sessions set status = 'awaiting_booking', visit_id = null, scheduled_date = null where id = $1`, [y.sessions[0].id]);
      for (const t of [nurse, doc1, w.docA]) expect((await post(t, `/sessions/${y.sessions[0].id}/book`, { date: d(9) })).status).toBe(403);
      const other = await world('SSE2');
      expect((await post(other.cash, `/sessions/${y.sessions[0].id}/book`, { date: d(9) })).status).toBe(404);
      await db.query(`update treatment_plans set status = 'stopped', stopped_at = now(), stopped_by = $2, stop_reason = 'x' where id = $1`, [y.plan.id, w.docAId]);
      expect((await post(w.cash, `/sessions/${y.sessions[0].id}/book`, { date: d(9) })).body.code).toBe('PLAN_NOT_ACTIVE');
    });
    it('إلغاء زيارة جلسات من الحجوزات: جلساتها ترجع «تنتظر حجز» وتتحرر اللي بعدها، والزيارة اللي فيها جلسة مدفوعة ما تنلغي', async () => {
      const x = await planned(w, [fixedItem(w, { first_session_date: d(5), sessions_count: 2, interval_days: 7 })]);
      const [s1, s2] = x.sessions;
      const c = await post(w.cash, `/bookings/${s1.visit_id}/cancel`, { reason: 'الزبون اعتذر' });
      expect(c.status).toBe(201);
      expect((await sessionRow(s1.id)).status).toBe('awaiting_booking'); expect((await sessionRow(s2.id)).status).toBe('awaiting_booking');
      expect((await one(`select status from visits where id = $1`, [s2.visit_id])).status).toBe('cancelled');
      await assertConsistent(w);
      const y = await planned(w, [fixedItem(w, { first_session_date: d(6), sessions_count: 1 })]);
      await db.query(`update treatment_sessions set status = 'paid' where id = $1`, [y.sessions[0].id]);                  // حالة شاذة: زيارة محجوزة وفيها جلسة مدفوعة
      expect((await post(w.cash, `/bookings/${y.sessions[0].visit_id}/cancel`, { reason: 'تجربة' })).body.code).toBe('HAS_PAID_SESSIONS');
      await db.query(`update treatment_sessions set status = 'booked' where id = $1`, [y.sessions[0].id]);
    });
    it('نقل حجز الزيارة (من الحجوزات) يحرك جلساتها لنفس اليوم الجديد', async () => {
      const x = await planned(w, [fixedItem(w, { first_session_date: d(9), sessions_count: 1 })]);
      const s = x.sessions[0];
      const mv = await post(w.cash, `/bookings/${s.visit_id}/move`, { date: d(11) });
      expect(mv.status).toBe(201);
      expect((await sessionRow(s.id)).d).toBe(d(11));
      await assertConsistent(w);
    });
    it('عطلة جديدة تنقل زيارة جلسات: جلساتها تتحرك وياها بنفس اليوم الجديد', async () => {
      const x = await planned(w, [fixedItem(w, { first_session_date: d(33), sessions_count: 1 })]);
      const s = x.sessions[0];
      const h = await post(w.mgr, '/schedule/holidays', { date: d(33), name: 'عطلة طارئة' });
      expect(h.status).toBe(201); expect(h.body.moved_visits).toBeGreaterThanOrEqual(1);
      const row = await sessionRow(s.id);
      expect(row.d).not.toBe(d(33));
      expect((await one(`select visit_date::text as d from visits where id = $1`, [row.visit_id])).d).toBe(row.d);
      await assertConsistent(w);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('قائمة جلسات الزبون ومتابعة الكاشير', () => {
    let w: World;
    beforeAll(async () => { w = await world('SSF'); });
    it('تبين الحالة والموعد وهل تندفع اليوم وسعرها التقديري، والمدفوعة بدون تقدير، وصلاحيات الكاشير والمدير والمالك', async () => {
      const x = await planned(w, [botox(w, { values: { cc: 3 }, sessions_count: 2, interval_days: 7 })]);
      await pay(w.cash, { session_ids: [x.sessions[0].id], ...cashT(w, 150000) });
      const r = await get(w.cash, `/customers/${x.customer}/sessions`);
      expect(r.status).toBe(200);
      expect(r.body.sessions.map((s: any) => [s.seq_no, s.of, s.status, s.payable_today, s.estimate_price, s.service_name])).toEqual([[1, 2, 'paid', false, null, 'بوتكس'], [2, 2, 'booked', false, 150000, 'بوتكس']]);
      const y = await planned(w, [fixedItem(w, { sessions_count: 1 })]);
      expect((await get(w.cash, `/customers/${y.customer}/sessions`)).body.sessions[0]).toMatchObject({ payable_today: true, estimate_price: 40000, status: 'booked' });
      for (const t of [w.mgr, owner]) expect((await get(t, `/customers/${x.customer}/sessions`)).status).toBe(200);
      for (const t of [nurse, doc1, w.docA]) expect((await get(t, `/customers/${x.customer}/sessions`)).status).toBe(403);
      expect((await get(w.cash, '/customers/99999999/sessions')).status).toBe(404);
      const other = await world('SSF2');
      expect((await get(other.cash, `/customers/${x.customer}/sessions`)).body.sessions).toEqual([]);                                  // فرع ثاني ما يشوف جلسات فرعه
    });
  });

  it('فحص نهائي: الوصولات والنقاط والمحجوز متسقة، وما أكو جلسة مدفوعة بدون بند وصل أو بند مدفوع بدون جلسة مدفوعة', async () => {
    // جلسات الملفات الثانية مدفوعة بتعديل قاعدة (حيل اختبار)، فنفحص جلسات فروع هذا الملف (SS*) بس
    const bad = await db.query(
      `select * from v_integrity_checks c where c.check_name in ('paid_session_without_payment','payment_items_sum_mismatch','payment_tenders_sum_mismatch','points_balance_mismatch')
         and (c.check_name <> 'paid_session_without_payment' or c.entity_id in (select s.id from treatment_sessions s join branches b on b.id = s.branch_id where b.code like 'SS%'))`);
    expect(bad.rows).toEqual([]);
    const itemNoPaidSession = await db.query(`select i.id from payment_items i join treatment_sessions s on s.id = i.session_id where i.status = 'paid' and s.status not in ('paid','completed')`);
    expect(itemNoPaidSession.rows).toEqual([]);
    const needsNotPaid = await db.query(`select n.treatment_session_id from session_material_needs n join treatment_sessions s on s.id = n.treatment_session_id where s.status = 'cancelled'`);
    expect(needsNotPaid.rows).toEqual([]);
  });
});
