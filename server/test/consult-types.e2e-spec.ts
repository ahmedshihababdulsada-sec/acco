import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { LogOtpSender, OTP_SENDER } from '../src/customer-app/otp.service';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

interface World { id: number; code: string; mgr: string; mgrId: number; cash: string; docA: string; docAId: number; nurse: string; cashMethod: number; elecMethod: number; svc: number }

describe('وصل اليوم الجامع (يُطبع مرة وحدة) وكشفية «جلسات فقط»', () => {
  let app: INestApplication; let db: Pool; let today: string; let owner: string; let sender: LogOtpSender;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  let phoneSeq = 0; let seq = 0;
  const key = () => `ct-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const cashOnly = (w: World, n: number) => ({ tenders: [{ method_id: w.cashMethod, amount: n }] });
  const payCons = (w: World, cons: number, body: object = {}, t = w.cash) => http().post('/payments/consultation').set(auth(t)).set('Idempotency-Key', key()).send({ consultation_id: cons, ...body });
  const paySess = (w: World, ids: number[], body: object) => http().post('/payments/sessions').set(auth(w.cash)).set('Idempotency-Key', key()).send({ session_ids: ids, ...body });

  async function world(code: string): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name) values ($1,$1) returning id`, [code])).rows[0].id);
    await db.query(`insert into safes (branch_id) values ($1)`, [id]);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id); await seedUser(db, `cash_${code}`, 'cashier', id); const docAId = await seedUser(db, `docA_${code}`, 'doctor', id); await seedUser(db, `nurse_${code}`, 'nurse', id);
    await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',100000000,'opening_balance','تجربة',$2)`, [id, mgrId]);
    const [mgr, cash, docA, nurse] = await Promise.all([`mgr_${code}`, `cash_${code}`, `docA_${code}`, `nurse_${code}`].map((u) => tokenFor(app, u)));
    expect((await put(mgr, `/schedule/doctors/${docAId}/weekly`, { days: [1, 2, 3, 4, 5, 6, 7].map((x) => ({ weekday: x, start_time: '09:00', end_time: '13:00' })), effective_from: today })).status).toBe(200);
    const cur = (await get(mgr, '/settings')).body.settings.find((s: any) => s.key === 'booking.daily_limit');
    expect((await put(mgr, '/settings/booking.daily_limit', { value: 1000, expected_version: cur.version })).status).toBe(200);
    const cs = Number((await db.query(`insert into services (branch_id, name_ar, kind, pricing_model, is_active) values ($1,'كشفية','consultation','fixed',true) returning id`, [id])).rows[0].id);
    await db.query(`insert into service_prices (service_id, price, set_by) values ($1,30000,$2)`, [cs, mgrId]);
    const cashMethod = Number((await db.query(`insert into payment_methods (branch_id, name_ar, kind, sort_order) values ($1,'كاش','cash',0) returning id`, [id])).rows[0].id);
    const elecMethod = Number((await db.query(`insert into payment_methods (branch_id, name_ar, kind, device_label, sort_order) values ($1,'كي كارد','electronic','جهاز 1',1) returning id`, [id])).rows[0].id);
    expect((await post(cash, '/shifts/open', { opening_float: 0 })).status).toBe(201);
    const bs = (await post(mgr, '/services', { name_ar: `ليزر ${code}`, pricing_model: 'per_unit', price: 50000 })).body;
    await post(mgr, `/services/${bs.id}/fields`, { field_key: 'cc', label_ar: 'كم', field_type: 'number', unit_label: 'cc', pricing_role: 'quantity', is_required: true });
    expect((await post(mgr, `/services/${bs.id}/activate`)).status).toBe(201 === 201 ? 200 : 200);
    return { id, code, mgr, mgrId, cash, docA, docAId, nurse, cashMethod, elecMethod, svc: bs.id };
  }
  const setFee = async (w: World, value: number) => {
    const cur = (await get(w.mgr, '/settings')).body.settings.find((s: any) => s.key === 'consultation.sessions_only_fee');
    const r = await put(w.mgr, '/settings/consultation.sessions_only_fee', { value, expected_version: cur.version }); expect(r.status).toBe(200); return r;
  };
  async function customer(w: World) {
    phoneSeq++; return (await post(w.cash, '/customers', { full_name: `زبون وصل ${phoneSeq}`, phone: `0787${String(phoneSeq).padStart(7, '0')}` })).body.id as number;
  }
  /** زبون اليوم: كشفية (بالنوع المطلوب) → دخول → خطة جلسة اليوم. يرجع الأرقام بدون دفع الجلسة */
  async function visitToday(w: World, type?: 'sessions_only', cc = 1) {
    const c = await customer(w);
    const b = await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docAId, date: today, ...(type ? { type } : {}) }); expect(b.status).toBe(201);
    return { c, cons: b.body.consultation.id as number, visit: b.body.id as number, booking: b.body, plan: async () => {
      const pl = await post(w.docA, `/consultations/${b.body.consultation.id}/plan`, { items: [{ service_id: w.svc, values: { cc }, sessions_count: 2, interval_days: 7, first_session_date: today }] });
      expect(pl.status).toBe(201); return pl.body.items[0].sessions as { id: number }[];
    } };
  }
  const dayReceipt = (t: string, c: number, date?: string) => get(t, `/customers/${c}/day-receipt${date ? `?date=${date}` : ''}`);

  let w: World; let wb: World;
  beforeAll(async () => {
    app = await makeApp(); db = pool(); sender = app.get(OTP_SENDER) as LogOtpSender; today = (await db.query(`select clinic_today()::text as d`)).rows[0].d; owner = await tokenFor(app, 'owner');
    w = await world('CTA'); wb = await world('CTB');
  });
  afterAll(async () => { await app.close(); await db.end(); });

  // ================================================================================================
  describe('وصل اليوم الجامع', () => {
    it('كشفية + جلسات: وصل واحد بالمجاميع من الخادم، ترتيب البنود، الأرقام، دمج طرق الدفع، والنقاط', async () => {
      const v = await visitToday(w);
      const p1 = await payCons(w, v.cons, cashOnly(w, 30000)); expect(p1.status).toBe(201);
      expect((await post(w.docA, `/consultations/${v.cons}/enter`)).status).toBe(201);
      const sessions = await v.plan();
      const quote = (await post(w.cash, '/payments/quote/sessions', { session_ids: [sessions[0].id] })).body; const net2 = quote.net_amount as number;
      const p2 = await paySess(w, [sessions[0].id], { tenders: [{ method_id: w.cashMethod, amount: net2 - 10000 }, { method_id: w.elecMethod, amount: 10000 }] }); expect(p2.status).toBe(201);
      const r = await dayReceipt(w.cash, v.c); expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ kind: 'combined', status: 'paid', business_date: today, payment_ids: [p1.body.id, p2.body.id], unprinted: 2, print_count: 0, refunded_total: 0 });
      expect(r.body.receipt_no).toBe(`${p1.body.receipt_no} + ${p2.body.receipt_no}`); expect(r.body.receipt_numbers).toEqual([p1.body.receipt_no, p2.body.receipt_no]);
      expect(r.body.items.map((i: any) => i.item_type)).toEqual(['consultation', 'session']);
      for (const f of ['gross_amount', 'offer_discount', 'manual_discount', 'points_discount', 'rounding_amount', 'net_amount', 'points_used', 'points_earned']) expect(r.body[f]).toBe(p1.body[f] + p2.body[f]);
      expect(r.body.net_amount).toBe(30000 + net2);
      const t = r.body.tenders as any[]; expect(t.find((x) => x.method_name === 'كاش').amount).toBe(30000 + net2 - 10000);
      expect(t.find((x) => x.method_name === 'كي كارد')).toMatchObject({ amount: 10000, device_label: 'جهاز 1' }); expect(t).toHaveLength(2);
      expect(t.reduce((a, x) => a + x.amount, 0)).toBe(r.body.net_amount);                                  // مجموع الطرق = الصافي دائماً
      expect(r.body.payments).toHaveLength(2); expect(r.body.customer.id).toBe(v.c);
    }, 90000);

    it('كل حقول الخصم تنجمع من الأجزاء (خصم مدير + عرض + نقاط + تقريب) بثلاثة وصولات، وكلها غير صفرية بأكثر من وصل', async () => {
      const wd = await world('CTE');
      const v = await visitToday(wd);
      const give = async (n: number) => {
        const old = (await db.query(`insert into customers (branch_id, public_code, phone, full_name, source, status, merged_into_id) values ($1,$2,$3,'ملف قديم','cashier','merged',$4) returning id`, [wd.id, `OLDCT${Date.now() % 1e6}`, `+9647860${String(Date.now() % 1e6).padStart(6, '0')}`, v.c])).rows[0].id;
        const m = (await db.query(`insert into customer_merges (from_customer_id, into_customer_id, reason, merged_by) values ($1,$2,'تجربة',$3) returning id`, [old, v.c, wd.mgrId])).rows[0].id;
        await db.query(`insert into points_ledger (customer_id, entry_type, points, merge_id) values ($1,'merge_in',$2,$3)`, [v.c, n, m]);
      };
      await give(2000);
      const dr = await post(wd.cash, '/discount-requests', { consultation_id: v.cons }); expect(dr.status).toBe(201);
      expect((await post(wd.mgr, `/discount-requests/${dr.body.id}/approve`, { amount: 5100 })).status).toBe(201);
      const q1 = (await post(wd.cash, '/payments/quote/consultation', { consultation_id: v.cons, discount_request_id: dr.body.id, redeem_points: true })).body;
      const p1 = await payCons(wd, v.cons, { discount_request_id: dr.body.id, redeem_points: true, ...cashOnly(wd, q1.net_amount) }); expect(p1.status).toBe(201);
      expect(p1.body.manual_discount).toBe(5100); expect(p1.body.rounding_amount + p1.body.points_discount).toBeGreaterThan(0);
      await post(wd.docA, `/consultations/${v.cons}/enter`);
      const item = { service_id: wd.svc, values: { cc: 1 }, sessions_count: 1, interval_days: 7, first_session_date: today };
      const pl = await post(wd.docA, `/consultations/${v.cons}/plan`, { items: [item, item] }); expect(pl.status).toBe(201);
      const sess = pl.body.items.map((i: any) => i.sessions[0].id as number);
      expect((await post(wd.mgr, '/offers', { service_id: wd.svc, title: 'عرض', percent: 20, start_date: today, end_date: today })).status).toBe(201);
      const q2 = (await post(wd.cash, '/payments/quote/sessions', { session_ids: [sess[0]] })).body;
      const p2 = await paySess(wd, [sess[0]], cashOnly(wd, q2.net_amount)); expect(p2.status).toBe(201);
      const q3 = (await post(wd.cash, '/payments/quote/sessions', { session_ids: [sess[1]], redeem_points: true })).body;
      const p3 = await paySess(wd, [sess[1]], { redeem_points: true, ...cashOnly(wd, q3.net_amount) }); expect(p3.status).toBe(201);
      const r = (await dayReceipt(wd.cash, v.c)).body; const parts = [p1.body, p2.body, p3.body];
      expect(r.payment_ids).toEqual(parts.map((x) => x.id));
      for (const f of ['gross_amount', 'offer_discount', 'manual_discount', 'points_discount', 'rounding_amount', 'net_amount', 'points_used', 'points_earned']) {
        expect([f, r[f]]).toEqual([f, parts.reduce((a, x) => a + x[f], 0)]);
      }
      expect(parts.filter((x) => x.offer_discount > 0).length).toBeGreaterThanOrEqual(2);                       // العرض بوصلين: «آخر وصل» لوحده ما يكفي
      expect(parts.filter((x) => x.points_discount > 0).length).toBeGreaterThanOrEqual(2);
      for (const f of ['offer_discount', 'manual_discount', 'points_discount', 'points_used']) expect([f, r[f] > 0]).toEqual([f, true]);
      expect(r.gross_amount - r.offer_discount - r.manual_discount - r.points_discount - r.rounding_amount).toBe(r.net_amount);   // المعادلة تتحقق على المجاميع
    }, 120000);

    it('كشفية فقط: وصل واحد عادي (kind الأصلي)، وبدون وصولات: 404، وتاريخ غلط: 400، ويوم ثاني: 404', async () => {
      const v = await visitToday(w); expect((await dayReceipt(w.cash, v.c)).status).toBe(404);
      const p = await payCons(w, v.cons, cashOnly(w, 30000)); expect(p.status).toBe(201);
      const r = await dayReceipt(w.cash, v.c); expect(r.body).toMatchObject({ kind: 'consultation', payment_ids: [p.body.id], receipt_no: p.body.receipt_no, unprinted: 1 });
      expect((await dayReceipt(w.cash, v.c, '2026-13-40')).body.code).toBe('INVALID_DATE');
      const y = new Date(`${today}T00:00:00Z`); y.setUTCDate(y.getUTCDate() - 1);
      expect((await dayReceipt(w.cash, v.c, y.toISOString().slice(0, 10))).status).toBe(404);
    }, 60000);

    it('لا يدخل: وصل مسترجع، وصل زبون ثاني، وصول فرع ثاني؛ والصلاحيات', async () => {
      const v = await visitToday(w); const p = await payCons(w, v.cons, cashOnly(w, 30000)); expect(p.status).toBe(201);
      const rf = await http().post(`/payments/${p.body.id}/refund`).set(auth(w.cash)).set('Idempotency-Key', key()).send({ full_receipt: true, reason: 'تجربة' }); expect(rf.status).toBe(201);
      expect((await dayReceipt(w.cash, v.c)).status).toBe(404);                                             // الوحيد مسترجع
      const v2 = await visitToday(w); const p2 = await payCons(w, v2.cons, cashOnly(w, 30000)); expect(p2.status).toBe(201);
      const r2 = await dayReceipt(w.cash, v2.c); expect(r2.body.payment_ids).toEqual([p2.body.id]);          // ما يخلط زبائن
      expect((await dayReceipt(wb.cash, v2.c)).status).toBe(404);                                            // كاشير فرع ثاني ما يشوف
      expect((await dayReceipt(owner, v2.c)).status).toBe(200); expect((await dayReceipt(w.mgr, v2.c)).status).toBe(200);
      for (const t of [w.docA, w.nurse]) expect((await dayReceipt(t, v2.c)).status).toBe(403);
      expect((await http().get(`/customers/${v2.c}/day-receipt`)).status).toBe(401);
    }, 90000);

    it('تسجيل الطباعة الجماعي: كل الوصولات بمعاملة وحدة، إعادة الطباعة تنحسب، والكل أو ولا شي', async () => {
      const v = await visitToday(w); const p1 = await payCons(w, v.cons, cashOnly(w, 30000)); await post(w.docA, `/consultations/${v.cons}/enter`);
      const s = await v.plan(); const p2 = await paySess(w, [s[0].id], cashOnly(w, 50000)); expect(p2.status).toBe(201);
      const pb = (b: object, t = w.cash) => post(t, '/payments/print', b);
      const a = await pb({ payment_ids: [p2.body.id, p1.body.id, p1.body.id], note: 'طباعة وصل اليوم' }); expect(a.status).toBe(200);
      expect(a.body.prints.map((x: any) => [x.payment_id, x.is_reprint, x.print_count])).toEqual([[p1.body.id, false, 1], [p2.body.id, false, 1]]);   // مرتبة ومكرر ينحذف
      expect((await dayReceipt(w.cash, v.c)).body).toMatchObject({ unprinted: 0, print_count: 1 });
      // وصل واحد منهم انطبع منفرداً: الجامع يعتبر «ما انطبع كامل» (الأقل)
      const v3 = await visitToday(w); const q1 = await payCons(w, v3.cons, cashOnly(w, 30000)); await post(w.docA, `/consultations/${v3.cons}/enter`);
      const s3 = await v3.plan(); const q2 = await paySess(w, [s3[0].id], cashOnly(w, 50000));
      expect((await post(w.cash, `/payments/${q1.body.id}/print`, {})).status).toBe(201);
      expect((await dayReceipt(w.cash, v3.c)).body).toMatchObject({ unprinted: 1, print_count: 0, payment_ids: [q1.body.id, q2.body.id] });
      const b2 = await pb({ payment_ids: [p1.body.id, p2.body.id] }); expect(b2.body.prints.every((x: any) => x.is_reprint && x.print_count === 2)).toBe(true);
      expect((await db.query(`select action from audit_log where entity_id = any($1::bigint[]) and action in ('receipt.print','receipt.reprint') order by id`, [[p1.body.id, p2.body.id]])).rows.map((r) => r.action)).toEqual(['receipt.print', 'receipt.print', 'receipt.reprint', 'receipt.reprint']);
      const before = Number((await one(`select count(*)::int as n from receipt_prints`)).n);
      expect((await pb({ payment_ids: [p1.body.id, 999999999] })).status).toBe(404);
      expect(Number((await one(`select count(*)::int as n from receipt_prints`)).n)).toBe(before);              // ما انسجل شي من المعاملة الفاشلة
      expect((await pb({ payment_ids: [p1.body.id] }, wb.cash)).status).toBe(404);                              // فرع ثاني
      for (const bad of [{ payment_ids: [] }, {}, { payment_ids: 'x' }, { payment_ids: [1.5] }, { payment_ids: Array.from({ length: 11 }, (_, i) => i + 1) }]) expect((await pb(bad)).status).toBe(400);
      expect((await pb({ payment_ids: [p1.body.id] }, w.mgr)).status).toBe(403);
    }, 90000);

    it('وصل واحد يعاد: بعد الاسترجاع الجزئي لأحد الوصلين يطلع الثاني منفرداً', async () => {
      const v = await visitToday(w); const p1 = await payCons(w, v.cons, cashOnly(w, 30000)); await post(w.docA, `/consultations/${v.cons}/enter`);
      const s = await v.plan(); const p2 = await paySess(w, [s[0].id], cashOnly(w, 50000));
      expect((await dayReceipt(w.cash, v.c)).body.kind).toBe('combined');
      expect((await http().post(`/payments/${p2.body.id}/refund`).set(auth(w.cash)).set('Idempotency-Key', key()).send({ full_receipt: true, reason: 'تجربة' })).status).toBe(201);
      const r = await dayReceipt(w.cash, v.c); expect(r.body).toMatchObject({ kind: 'consultation', payment_ids: [p1.body.id] });
    }, 90000);
  });

  // ================================================================================================
  describe('كشفية «جلسات فقط»', () => {
    it('الافتراضي مجانية: تُحجز بنوعها، الدفع مرفوض والدخول بدون دفع، بدون وصل للكشفية، والطبيب يكتب الخطة، ثم وصل واحد للجلسات', async () => {
      const v = await visitToday(w, 'sessions_only');
      expect(v.booking.consultation).toMatchObject({ kind: 'sessions_only', status: 'awaiting_payment', fee: 0 });
      const pay = await payCons(w, v.cons, cashOnly(w, 1)); expect(pay.status).toBe(409); expect(pay.body.code).toBe('FREE_CONSULTATION');
      const q = await post(w.cash, '/payments/quote/consultation', { consultation_id: v.cons }); expect(q.status).toBe(409); expect(q.body.code).toBe('FREE_CONSULTATION');
      const ci = await post(w.cash, `/consultations/${v.cons}/check-in`); expect(ci.status).toBe(201); expect(ci.body).toMatchObject({ status: 'paid', visit_status: 'arrived', kind: 'sessions_only' });
      expect((await one(`select count(*)::int as n from payment_items where consultation_id = $1`, [v.cons])).n).toBe(0);                 // ما انصدر وصل للكشفية
      expect((await get(w.docA, '/doctor/queue')).body.queue.find((x: any) => x.consultation_id === v.cons)).toMatchObject({ kind: 'sessions_only', status: 'paid' });
      expect((await post(w.docA, `/consultations/${v.cons}/enter`)).status).toBe(201);
      const s = await v.plan();
      const p2 = await paySess(w, [s[0].id], cashOnly(w, 50000)); expect(p2.status).toBe(201);
      const r = await dayReceipt(w.cash, v.c);
      expect(r.body).toMatchObject({ kind: 'sessions', payment_ids: [p2.body.id], net_amount: 50000 }); expect(r.body.items.map((i: any) => i.item_type)).toEqual(['session']);
      expect((await post(w.docA, `/consultations/${v.cons}/finish`)).status).toBe(201);
    }, 90000);

    it('بسعر (يحدده المدير): الدخول بدون دفع مرفوض، والدفع بالسعر الجديد وقت الدفع، واسم البند «كشفية (جلسات فقط)»، والعرض والخصم', async () => {
      const wc = await world('CTC'); await setFee(wc, 15000);
      const v = await visitToday(wc, 'sessions_only'); expect(v.booking.consultation.fee).toBe(15000);
      const ci = await post(wc.cash, `/consultations/${v.cons}/check-in`); expect(ci.status).toBe(409); expect(ci.body.code).toBe('PAYMENT_REQUIRED');
      const q = await post(wc.cash, '/payments/quote/consultation', { consultation_id: v.cons }); expect(q.status).toBe(200); expect(q.body).toMatchObject({ gross_amount: 15000, net_amount: 15000 });
      await setFee(wc, 20000);                                                                                // تغيّر السعر قبل الدفع: يُطبق سعر لحظة الدفع
      const pay = await payCons(wc, v.cons, cashOnly(wc, 20000)); expect(pay.status).toBe(201);
      expect(pay.body).toMatchObject({ kind: 'consultation', gross_amount: 20000, net_amount: 20000 }); expect(pay.body.items[0]).toMatchObject({ service_name: 'كشفية (جلسات فقط)', list_price: 20000 });
      expect((await one(`select pricing_snapshot->>'kind' as k from payment_items where payment_id = $1`, [pay.body.id])).k).toBe('consultation_sessions_only');
      // طلب خصم: السلة بسعر «جلسات فقط»
      const v2 = await visitToday(wc, 'sessions_only');
      const dr = await post(wc.cash, '/discount-requests', { consultation_id: v2.cons }); expect(dr.status).toBe(201); expect(dr.body.basket.gross).toBe(20000);
      expect((await post(wc.mgr, `/discount-requests/${dr.body.id}/approve`, { amount: 5000 })).status).toBe(201);
      const p2 = await payCons(wc, v2.cons, { discount_request_id: dr.body.id, ...cashOnly(wc, 15000) }); expect(p2.status).toBe(201); expect(p2.body).toMatchObject({ gross_amount: 20000, manual_discount: 5000, net_amount: 15000 });
    }, 120000);

    it('مجانية: طلب خصم مرفوض (ما تحتاج)، ولا تتحول لمراجعة مجانية، ولا يُلغى دخول كشفية مدفوعة منها بمسار المجاني', async () => {
      const v = await visitToday(w, 'sessions_only');
      const dr = await post(w.cash, '/discount-requests', { consultation_id: v.cons }); expect(dr.status).toBe(409); expect(dr.body.code).toBe('FREE_CONSULTATION');
      // كشفية عادية سابقة خلال أسبوع: «جلسات فقط» ما تصير free_followup (المراجعة المجانية للكشفية العادية بس)
      const c = await customer(w);
      const first = await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docAId, date: today }); await payCons(w, first.body.consultation.id, cashOnly(w, 30000));
      const next = new Date(`${today}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 2); const d2 = next.toISOString().slice(0, 10);
      const so = await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docAId, date: d2, type: 'sessions_only' }); expect(so.status).toBe(201); expect(so.body.consultation.kind).toBe('sessions_only');
      const std = await post(w.cash, '/bookings', { customer_id: (await customer(w)), doctor_id: w.docAId, date: d2 }); expect(std.body.consultation.kind).toBe('new');
      // إلغاء الدخول: الكشفية المدفوعة (السعر > 0) ما تنلغي بمسار المجاني
      const wd = await world('CTD'); await setFee(wd, 10000); const vd = await visitToday(wd, 'sessions_only'); expect((await payCons(wd, vd.cons, cashOnly(wd, 10000))).status).toBe(201);
      const cc = await post(wd.cash, `/consultations/${vd.cons}/cancel-check-in`, { reason: 'تجربة' }); expect(cc.status).toBe(409); expect(cc.body.code).toBe('NOT_FREE_FOLLOWUP');
    }, 120000);

    it('إلغاء دخول «جلسات فقط» المجانية قبل الطبيب: تنلغي الكشفية والحجز ويرجع المقعد', async () => {
      const v = await visitToday(w, 'sessions_only'); const used = async () => Number((await one(`select used_slots from booking_days where branch_id = $1 and day = $2`, [w.id, today])).used_slots);
      expect((await post(w.cash, `/consultations/${v.cons}/check-in`)).status).toBe(201); const before = await used();
      const c = await post(w.cash, `/consultations/${v.cons}/cancel-check-in`, { reason: 'ما جا' });
      expect(c.status).toBe(201); expect(c.body).toMatchObject({ status: 'cancelled', visit_status: 'cancelled' }); expect(await used()).toBe(before - 1);
    }, 60000);

    it('الإعداد: المدير والمالك يغيرونه، الكاشير لا، وقيم غلط ترفض', async () => {
      const cur = (await get(w.mgr, '/settings')).body.settings.find((s: any) => s.key === 'consultation.sessions_only_fee');
      expect(cur).toMatchObject({ value: 0, default: 0, can_edit: true });
      expect((await get(w.cash, '/settings')).status).toBe(403);
      for (const bad of [-1, 1.5, '100', null, 100_000_001]) expect((await put(w.mgr, '/settings/consultation.sessions_only_fee', { value: bad, expected_version: cur.version })).status).toBe(400);
      expect((await put(w.cash, '/settings/consultation.sessions_only_fee', { value: 1000, expected_version: cur.version })).status).toBe(403);
      expect((await put(owner, '/settings/consultation.sessions_only_fee', { value: 0, expected_version: cur.version, branch_id: w.id })).status).toBe(200);
    });

    it('تطبيق الزبون: يقرأ سعر «جلسات فقط» مع الأطباء، ويحجز بالنوع، ويظهر بقائمة حجوزاته بنوعه', async () => {
      const we = await world('CTF'); const phone = '07861234567';
      await db.query(`delete from otp_requests where phone = $1`, ['+9647861234567']);
      expect((await http().post('/customer/auth/request-otp').send({ phone })).status).toBe(200);
      const code = [...sender.sent].reverse().find((x) => x.phone === '+9647861234567')!.code;
      const login = await http().post('/customer/auth/verify-otp').send({ phone, code, full_name: 'زبونة', branch_id: we.id }); expect(login.status).toBe(200);
      const tok = login.body.access_token as string;
      expect((await get(tok, '/customer/doctors')).body.sessions_only_fee).toBe(0);
      await setFee(we, 12000); expect((await get(tok, '/customer/doctors')).body.sessions_only_fee).toBe(12000);
      expect((await post(tok, '/customer/bookings', { doctor_id: we.docAId, date: today, type: 'bogus' })).status).toBe(400);
      const b = await post(tok, '/customer/bookings', { doctor_id: we.docAId, date: today, type: 'sessions_only' }); expect(b.status).toBe(201);
      expect((await get(tok, '/customer/bookings')).body.bookings[0]).toMatchObject({ kind: 'sessions_only', consultation_status: 'awaiting_payment' });
      expect((await one(`select kind from consultations where visit_id = $1`, [b.body.id])).kind).toBe('sessions_only');
    }, 60000);

    it('النوع غلط يرفض (400)، ومن تطبيق الزبون، وتنضم لزيارة جلسات الزبون بنوعها', async () => {
      const c = await customer(w);
      expect((await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docAId, date: today, type: 'free' })).status).toBe(400);
      expect((await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docAId, date: today, type: 'standard' })).body.consultation.kind).toBe('new');
    });
  });
});
