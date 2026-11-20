import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

interface World { id: number; code: string; mgr: string; mgrId: number; cash: string; nurse: string; docA: string; docAId: number; cashMethod: number; botox: number; fixed: number }

describe('عرض السعر قبل الدفع (quote): نفس رقم الدفع بدون إصدار', () => {
  let app: INestApplication; let db: Pool; let today: string;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  let seq = 0; let phoneSeq = 0;
  const key = () => `qk-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const cashT = (w: World, amount: number) => ({ tenders: [{ method_id: w.cashMethod, amount }] });

  async function world(code: string): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name) values ($1,$1) returning id`, [code])).rows[0].id);
    await db.query(`insert into safes (branch_id) values ($1)`, [id]);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id); await seedUser(db, `cash_${code}`, 'cashier', id); await seedUser(db, `nurse_${code}`, 'nurse', id);
    const docAId = await seedUser(db, `docA_${code}`, 'doctor', id);
    await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',100000000,'opening_balance','تجربة',$2)`, [id, mgrId]);
    const [mgr, cash, nurse, docA] = await Promise.all([`mgr_${code}`, `cash_${code}`, `nurse_${code}`, `docA_${code}`].map((u) => tokenFor(app, u)));
    expect((await put(mgr, `/schedule/doctors/${docAId}/weekly`, { days: [1, 2, 3, 4, 5, 6, 7].map((x) => ({ weekday: x, start_time: '09:00', end_time: '13:00' })), effective_from: today })).status).toBe(200);
    const cur = (await get(mgr, '/settings')).body.settings.find((s: any) => s.key === 'booking.daily_limit');
    expect((await put(mgr, '/settings/booking.daily_limit', { value: 1000, expected_version: cur.version })).status).toBe(200);
    const cs = Number((await db.query(`insert into services (branch_id, name_ar, kind, pricing_model, is_active) values ($1,'كشفية','consultation','fixed',true) returning id`, [id])).rows[0].id);
    await db.query(`insert into service_prices (service_id, price, set_by) values ($1,30000,$2)`, [cs, mgrId]);
    const cashMethod = Number((await db.query(`insert into payment_methods (branch_id, name_ar, kind, sort_order) values ($1,'كاش','cash',0) returning id`, [id])).rows[0].id);
    const mat = Number((await db.query(`insert into materials (branch_id, name, base_unit, pack_unit) values ($1,'بوتكس','cc','كرتون') returning id`, [id])).rows[0].id);
    const bs = (await post(mgr, '/services', { name_ar: 'بوتكس', pricing_model: 'per_unit', price: 50000 })).body;
    const bf = (await post(mgr, `/services/${bs.id}/fields`, { field_key: 'cc', label_ar: 'كم cc', field_type: 'number', unit_label: 'cc', pricing_role: 'quantity', is_required: true })).body.fields[0];
    expect((await put(mgr, `/services/${bs.id}/materials`, { items: [{ material_id: mat, formula: 'per_field_value', field_id: bf.id, factor: '1' }] })).status).toBe(200);
    expect((await post(mgr, `/services/${bs.id}/activate`)).status).toBe(200);
    const fx = (await post(mgr, '/services', { name_ar: 'تنظيف بشرة', pricing_model: 'fixed', price: 40000 })).body;
    expect((await post(mgr, `/services/${fx.id}/activate`)).status).toBe(200);
    expect((await post(cash, '/shifts/open', { opening_float: 0 })).status).toBe(201);
    return { id, code, mgr, mgrId, cash, nurse, docA, docAId, cashMethod, botox: bs.id, fixed: fx.id };
  }
  async function customer(w: World, points = 0) {
    phoneSeq++; const c = (await post(w.cash, '/customers', { full_name: `زبون عرض سعر ${phoneSeq}`, phone: `0783${String(phoneSeq).padStart(7, '0')}` })).body.id as number;
    if (points) {
      const old = (await db.query(`insert into customers (branch_id, public_code, phone, full_name, source, status, merged_into_id) values ($1,$2,$3,'قديم','cashier','merged',$4) returning id`, [w.id, `OLQ${++seq}${Date.now() % 1e6}`, `+9647${String(340000000 + seq)}`, c])).rows[0].id;
      const m = (await db.query(`insert into customer_merges (from_customer_id, into_customer_id, reason, merged_by) values ($1,$2,'تجربة',$3) returning id`, [old, c, w.mgrId])).rows[0].id;
      await db.query(`insert into points_ledger (customer_id, entry_type, points, merge_id) values ($1,'merge_in',$2,$3)`, [c, points, m]);
    }
    return c;
  }
  const quoteC = (t: string, body: object) => post(t, '/payments/quote/consultation', body);
  const quoteS = (t: string, body: object) => post(t, '/payments/quote/sessions', body);
  const payC = (t: string, body: object) => http().post('/payments/consultation').set(auth(t)).set('Idempotency-Key', key()).send(body);
  const payS = (t: string, body: object) => http().post('/payments/sessions').set(auth(t)).set('Idempotency-Key', key()).send(body);
  async function withPlan(w: World, c: number) {
    const b = await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docAId, date: today });
    const cons = b.body.consultation.id as number;
    expect((await payC(w.cash, { consultation_id: cons, ...cashT(w, 30000) })).status).toBe(201);
    expect((await post(w.docA, `/consultations/${cons}/enter`)).status).toBe(201);
    const pl = await post(w.docA, `/consultations/${cons}/plan`, { items: [
      { service_id: w.botox, values: { cc: 2 }, sessions_count: 1, interval_days: 0, first_session_date: today }, { service_id: w.fixed, sessions_count: 1, interval_days: 0, first_session_date: today }] });
    expect(pl.status).toBe(201);
    return { botox: pl.body.items[0].sessions[0].id as number, fixed: pl.body.items[1].sessions[0].id as number };
  }
  const counts = async (w: World, c: number) => ({
    payments: Number((await one(`select count(*)::int as n from payments where branch_id = $1`, [w.id])).n),
    receiptCounter: (await db.query(`select * from number_counters where branch_id = $1 order by 1`, [w.id])).rows,
    points: Number((await one(`select points_balance from customers where id = $1`, [c])).points_balance),
    ledger: Number((await one(`select count(*)::int as n from points_ledger where customer_id = $1`, [c])).n),
    idem: Number((await one(`select count(*)::int as n from idempotency_keys`)).n),
  });

  let w: World;
  beforeAll(async () => {
    app = await makeApp(); db = pool(); today = (await db.query(`select clinic_today()::text as d`)).rows[0].d; w = await world('QTA');
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it('الكشفية: العرض يطابق الدفع بدون أي أثر (وصل، رقم، نقاط، مفتاح)، مع خصم معتمد ونقاط وتقريب', async () => {
    const c = await customer(w, 2000);
    const b = await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docAId, date: today });
    const cons = b.body.consultation.id as number;
    const dr = await post(w.cash, '/discount-requests', { consultation_id: cons });
    expect((await post(w.mgr, `/discount-requests/${dr.body.id}/approve`, { amount: 3333 })).status).toBe(201);
    const before = await counts(w, c);
    const body = { consultation_id: cons, discount_request_id: dr.body.id, redeem_points: true };
    const q = await quoteC(w.cash, body);
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({ gross_amount: 30000, offer_discount: 0, manual_discount: 3333, points_used: 2000, points_discount: 2000, points_balance: 2000, items: [{ service_name: 'كشفية', list_price: 30000, offer_discount: 0 }] });
    expect(q.body.net_amount + q.body.rounding_amount).toBe(30000 - 3333 - 2000);
    expect(await counts(w, c)).toEqual(before);                                                         // العرض ما غيّر شي
    expect((await one(`select status from discount_requests where id = $1`, [dr.body.id])).status).toBe('approved');
    const paid = await payC(w.cash, { ...body, ...cashT(w, q.body.net_amount) });
    expect(paid.status).toBe(201);
    expect(paid.body).toMatchObject({ gross_amount: q.body.gross_amount, manual_discount: q.body.manual_discount, points_used: q.body.points_used, points_discount: q.body.points_discount, rounding_amount: q.body.rounding_amount, net_amount: q.body.net_amount, points_earned: q.body.points_earned });
  });
  it('الجلسات: العرض (عرض %، خصم معتمد، نقاط، تقريب) يطابق الدفع بند ببند', async () => {
    await db.query(`insert into offers (branch_id, service_id, title, percent, start_date, end_date, status, created_by, notify_audience) values ($1,$2,'عرض',12.5,clinic_today(),clinic_today() + 3,'scheduled',$3,'none')`, [w.id, w.botox, w.mgrId]);
    const c = await customer(w, 5000); const s = await withPlan(w, c);
    const dr = await post(w.cash, '/discount-requests', { session_ids: [s.botox, s.fixed] });
    expect((await post(w.mgr, `/discount-requests/${dr.body.id}/approve`, { amount: 7777 })).status).toBe(201);
    const before = await counts(w, c);
    const body = { session_ids: [s.botox, s.fixed], discount_request_id: dr.body.id, redeem_points: true };
    const q = await quoteS(w.cash, body);
    expect(q.status).toBe(200);
    expect(q.body.items).toHaveLength(2);
    expect(q.body.items[0]).toMatchObject({ session_id: s.botox, service_name: 'بوتكس', list_price: 100000, offer_percent: 12.5, offer_discount: 12500 });
    expect(q.body.items[1]).toMatchObject({ session_id: s.fixed, list_price: 40000, offer_percent: null, offer_discount: 0 });
    expect(await counts(w, c)).toEqual(before);
    const paid = await payS(w.cash, { ...body, ...cashT(w, q.body.net_amount) });
    expect(paid.status).toBe(201);
    expect(paid.body).toMatchObject({ gross_amount: q.body.gross_amount, offer_discount: q.body.offer_discount, manual_discount: q.body.manual_discount, points_used: q.body.points_used, points_discount: q.body.points_discount, rounding_amount: q.body.rounding_amount, net_amount: q.body.net_amount, points_earned: q.body.points_earned });
    expect(paid.body.items.map((i: any) => [i.net_amount, i.offer_discount])).toEqual(q.body.items.map((i: any) => [i.net_amount, i.offer_discount]));
  });
  it('نفس شروط الدفع: خصم غير صالح، نقاط ما تكفي، جلسة مو اليوم، بدون شفت، وفرع ثاني (بنفس رموز الأخطاء)', async () => {
    const c = await customer(w, 0);
    const b = await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docAId, date: today });
    const cons = b.body.consultation.id as number;
    expect((await quoteC(w.cash, { consultation_id: cons, discount_request_id: 99999999 })).body.code).toBe('DISCOUNT_NOT_USABLE');
    const np = await quoteC(w.cash, { consultation_id: cons, redeem_points: true });
    expect(np.status).toBe(409); expect(np.body.code).toBe('POINTS_NOT_AVAILABLE');
    expect((await quoteC(w.cash, { consultation_id: 99999999 })).status).toBe(404);
    expect((await quoteS(w.cash, { session_ids: [99999999] })).status).toBe(404);
    const other = await world('QTB');
    expect((await quoteC(other.cash, { consultation_id: cons })).status).toBe(404);
    const noShift = await seedUser(db, `cash2_${seq}`, 'cashier', w.id); void noShift;
    const t2 = await tokenFor(app, `cash2_${seq}`);
    const ns = await quoteC(t2, { consultation_id: cons });
    expect(ns.status).toBe(409); expect(ns.body.code).toBe('NO_OPEN_SHIFT');
    expect((await quoteC(w.cash, {})).status).toBe(400);
    expect((await quoteS(w.cash, { session_ids: [] })).status).toBe(400);
  });
  it('الصلاحيات: الكاشير والمالك بس، وبدون توكن 401، وما يحتاج مفتاح منع التكرار', async () => {
    const c = await customer(w); const b = await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docAId, date: today });
    const body = { consultation_id: b.body.consultation.id };
    for (const t of [w.mgr, w.nurse, w.docA]) expect((await quoteC(t, body)).status).toBe(403);
    expect((await http().post('/payments/quote/consultation').send(body)).status).toBe(401);
    const q = await quoteC(w.cash, body);                                                                // بدون Idempotency-Key
    expect(q.status).toBe(200); expect(q.body).toMatchObject({ gross_amount: 30000, net_amount: 30000, rounding_amount: 0, points_earned: 750 });
    expect((await one(`select count(*)::int as n from payments where customer_id = $1`, [c])).n).toBe(0);
  });
});

describe('فروع المستخدم', () => {
  let app: INestApplication; let db: Pool;
  beforeAll(async () => { app = await makeApp(); db = pool(); });
  afterAll(async () => { await app.close(); await db.end(); });
  it('المالك كل الفروع الفعالة، والمدير فرعه فقط، والباقي ممنوع', async () => {
    const owner = await tokenFor(app, 'owner'); const mgr = await tokenFor(app, 'mgr1'); const cash = await tokenFor(app, 'cash1');
    const all = (await request(app.getHttpServer()).get('/branches').set(auth(owner))).body.branches;
    expect(all.map((b: any) => b.code)).toEqual(expect.arrayContaining(['B1', 'B2']));
    const mine = (await request(app.getHttpServer()).get('/branches').set(auth(mgr))).body.branches;
    expect(mine.map((b: any) => b.code)).toEqual(['B1']);
    expect((await request(app.getHttpServer()).get('/branches').set(auth(cash))).status).toBe(403);
    expect((await request(app.getHttpServer()).get('/branches')).status).toBe(401);
  });
});
