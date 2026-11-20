import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

interface World { id: number; code: string; mgr: string; mgrId: number; cash: string; cashId: number; cash2: string; docId: number; serviceId: number; cashMethod: number; cardMethod: number; card2Method: number }

describe('الدفع (الكشفية)', () => {
  let app: INestApplication; let db: Pool; let today: string; let year: number; let owner: string; let nurse: string; let doc1: string;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const closeOwnerShifts = () => db.query(`update shifts set status = 'closed', closed_at = now() where status = 'open' and cashier_id = (select id from users where username = 'owner')`);
  let seq = 0; let phoneSeq = 0;
  const key = () => `k-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const pay = (t: string, body: object, k: string | null = key()) => {
    const r = http().post('/payments/consultation').set(auth(t)).send(body);
    return k === null ? r : r.set('Idempotency-Key', k);
  };

  async function world(code: string, opts: { service?: boolean; price?: number } = {}): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name) values ($1,$1) returning id`, [code])).rows[0].id);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id); const cashId = await seedUser(db, `cash_${code}`, 'cashier', id); await seedUser(db, `cashB_${code}`, 'cashier', id);
    const docId = await seedUser(db, `doc_${code}`, 'doctor', id);
    await db.query(`insert into safes (branch_id) values ($1) on conflict do nothing`, [id]);
    await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',100000000,'opening_balance','تجربة',$2)`, [id, mgrId]);   // رصيد افتتاحي حتى تنفتح الشفتات (الفكة تطلع من الخزنة)
    const [mgr, cash, cash2] = await Promise.all([`mgr_${code}`, `cash_${code}`, `cashB_${code}`].map((u) => tokenFor(app, u)));
    expect((await put(mgr, `/schedule/doctors/${docId}/weekly`, { days: [1, 2, 3, 4, 5, 6, 7].map((w) => ({ weekday: w, start_time: '09:00', end_time: '13:00' })), effective_from: today })).status).toBe(200);
    await setSetting(mgr, 'booking.daily_limit', 1000);
    let serviceId = 0;
    if (opts.service !== false) {
      serviceId = Number((await db.query(`insert into services (branch_id, name_ar, kind, pricing_model, is_active) values ($1,'كشفية','consultation','fixed',true) returning id`, [id])).rows[0].id);
      await db.query(`insert into service_prices (service_id, price, set_by) values ($1,$2,$3)`, [serviceId, opts.price ?? 30000, mgrId]);
    }
    const cashMethod = Number((await db.query(`insert into payment_methods (branch_id, name_ar, kind, sort_order) values ($1,'كاش','cash',0) returning id`, [id])).rows[0].id);
    const cardMethod = Number((await db.query(`insert into payment_methods (branch_id, name_ar, kind, device_label, sort_order) values ($1,'كي كارد','electronic','جهاز 1',1) returning id`, [id])).rows[0].id);
    const card2Method = Number((await db.query(`insert into payment_methods (branch_id, name_ar, kind, device_label, sort_order) values ($1,'سويتش','electronic','جهاز 2',2) returning id`, [id])).rows[0].id);
    return { id, code, mgr, mgrId, cash, cashId, cash2, docId, serviceId, cashMethod, cardMethod, card2Method };
  }
  async function setSetting(t: string, k: string, value: number, branch?: number) {
    const q = branch ? `?branch_id=${branch}` : '';
    const cur = (await get(t, `/settings${q}`)).body.settings.find((s: any) => s.key === k);
    expect((await put(t, `/settings/${k}`, { value, expected_version: cur.version, ...(branch ? { branch_id: branch } : {}) })).status).toBe(200);
  }
  async function openShift(w: World, t = w.cash, float = 50000) { const r = await post(t, '/shifts/open', { opening_float: float }); expect(r.status).toBe(201); return r.body; }
  async function newCust(w: World, name = 'زبون دفع'): Promise<number> {
    phoneSeq++;
    const r = await post(w.cash, '/customers', { full_name: `${name} ${phoneSeq}`, phone: `0791${String(phoneSeq).padStart(7, '0')}` });
    expect(r.status).toBe(201); return r.body.id;
  }
  /** زبون + حجز كشفية اليوم. يرجع معرفات الكشفية والزيارة. */
  async function visit(w: World, customer?: number, date = today) {
    const c = customer ?? (await newCust(w));
    const r = await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docId, date });
    expect(r.status).toBe(201);
    return { customer: c, visitId: r.body.id as number, consId: r.body.consultation.id as number, seq: r.body.seq_no as number, kind: r.body.consultation.kind as string };
  }
  const cashTender = (w: World, amount: number) => ({ tenders: [{ method_id: w.cashMethod, amount }] });
  /** يعطي الزبون رصيد نقاط حقيقي (بالسجل) عن طريق دمج ملف قديم فيه */
  async function givePoints(w: World, customer: number, points: number) {
    phoneSeq++;
    const old = (await db.query(`insert into customers (branch_id, public_code, phone, full_name, source, status, merged_into_id) values ($1,$2,$3,'ملف قديم','cashier','merged',$4) returning id`, [w.id, `OLD${phoneSeq}${Date.now() % 1e5}`, `+9647${String(700000000 + phoneSeq)}`, customer])).rows[0].id;
    const m = (await db.query(`insert into customer_merges (from_customer_id, into_customer_id, reason, merged_by) values ($1,$2,'تجربة',$3) returning id`, [old, customer, w.mgrId])).rows[0].id;
    await db.query(`insert into points_ledger (customer_id, entry_type, points, merge_id) values ($1,'merge_in',$2,$3)`, [customer, points, m]);
  }
  const balance = async (c: number) => Number((await db.query(`select points_balance from customers where id = $1`, [c])).rows[0].points_balance);
  const payCount = async (w: World) => Number((await db.query(`select count(*)::int as n from payments where branch_id = $1`, [w.id])).rows[0].n);
  const discount = async (w: World, customer: number, amount: number, status = 'approved', visitId: number | null = null) =>
    Number((await db.query(`insert into discount_requests (branch_id, customer_id, visit_id, basket, status, requested_by, amount, decided_by) values ($1,$2,$3,'[]',$4,$5,$6,$7) returning id`,
      [w.id, customer, visitId, status, w.cashId, status === 'pending' ? null : amount, status === 'pending' ? null : w.mgrId])).rows[0].id);

  beforeAll(async () => {
    app = await makeApp(); db = pool();
    const r = (await db.query(`select clinic_today()::text as d, extract(year from clinic_today())::int as y`)).rows[0]; today = r.d; year = r.y;
    [owner, nurse, doc1] = await Promise.all(['owner', 'nurse1', 'doc1'].map((u) => tokenFor(app, u)));
  });
  afterAll(async () => { await app.close(); await db.end(); });

  // ------------------------------------------------------------------------------------------------
  describe('الشفت', () => {
    let w: World;
    beforeAll(async () => { w = await world('PYS'); });
    it('الكاشير يفتح شفت بفكة، والثاني 409، وشفته الحالي يظهر، ومن بلا شفت null', async () => {
      expect((await get(w.cash, '/shifts/current')).body).toEqual({});                                          // null يرجع كجسم فاضي
      const r = await post(w.cash, '/shifts/open', { opening_float: 75000, float_given_by: w.mgrId });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ branch_id: w.id, opening_float: 75000, float_given_by: w.mgrId, receipts_count: 0, collected: [] });
      expect((await post(w.cash, '/shifts/open', { opening_float: 0 })).body.code).toBe('SHIFT_ALREADY_OPEN');
      expect((await get(w.cash, '/shifts/current')).body.id).toBe(r.body.id);
      expect((await get(w.cash2, '/shifts/current')).body).toEqual({});
      expect((await db.query(`select 1 from audit_log where action = 'shift.open' and entity_id = $1`, [r.body.id])).rowCount).toBe(1);
    });
    it('فكة سالبة أو كسر أو سلسلة 400، ومسلّم فكة غير صالح 400، والمدير/الطبيب/الممرض ما يفتحون', async () => {
      for (const v of [-1, 1.5, 'x', null]) expect((await post(w.cash2, '/shifts/open', { opening_float: v })).status).toBe(400);
      expect((await post(w.cash2, '/shifts/open', { opening_float: 0, float_given_by: w.cashId })).body.code).toBe('INVALID_FLOAT_GIVER');         // كاشير مو مدير
      expect((await post(w.cash2, '/shifts/open', { opening_float: 0, float_given_by: 99999999 })).body.code).toBe('INVALID_FLOAT_GIVER');
      const otherMgr = await seedUser(db, 'mgr_other_PYS', 'manager', (await db.query(`select id from branches where code = 'B1'`)).rows[0].id);
      expect((await post(w.cash2, '/shifts/open', { opening_float: 0, float_given_by: otherMgr })).body.code).toBe('INVALID_FLOAT_GIVER');         // مدير فرع ثاني
      for (const t of [w.mgr, doc1, nurse]) expect((await post(t, '/shifts/open', { opening_float: 0 })).status).toBe(403);
      expect((await http().post('/shifts/open').send({ opening_float: 0 })).status).toBe(401);
    });
    it('فتح متزامن للكاشير نفسه: شفت واحد بس', async () => {
      const rs = await Promise.all(Array.from({ length: 6 }, () => post(w.cash2, '/shifts/open', { opening_float: 1000 })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409)).toHaveLength(5);
      expect((await db.query(`select count(*)::int as n from shifts where cashier_id = (select id from users where username = $1) and status = 'open'`, ['cashB_PYS'])).rows[0].n).toBe(1);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('شروط الدفع الأساسية', () => {
    let w: World; let w2: World; let noSvc: World;
    beforeAll(async () => { w = await world('PYB'); w2 = await world('PYB2'); noSvc = await world('PYB3', { service: false }); await openShift(w); await openShift(w2); await openShift(noSvc); });
    it('بدون مفتاح أو بمفتاح غلط 400، الممرض/الطبيب/المدير 403، بدون توكن 401', async () => {
      const v = await visit(w);
      expect((await pay(w.cash, { consultation_id: v.consId, ...cashTender(w, 30000) }, null)).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect((await pay(w.cash, { consultation_id: v.consId, ...cashTender(w, 30000) }, 'short')).body.code).toBe('IDEMPOTENCY_KEY_INVALID');
      expect((await pay(w.cash, { consultation_id: v.consId, ...cashTender(w, 30000) }, 'bad key with spaces!!')).status).toBe(400);
      for (const t of [nurse, doc1, w.mgr]) expect((await pay(t, { consultation_id: v.consId, ...cashTender(w, 30000) })).status).toBe(403);
      expect((await http().post('/payments/consultation').send({})).status).toBe(401);
      expect(await payCount(w)).toBe(0);
    });
    it('بدون شفت مفتوح 409، وشفت بفرع ثاني 409', async () => {
      const v = await visit(w);
      expect((await pay(w.cash2, { consultation_id: v.consId, ...cashTender(w, 30000) })).body.code).toBe('NO_OPEN_SHIFT');
      await closeOwnerShifts();                                                                                 // حساب المالك مشترك بين ملفات الاختبار
      const o = await post(owner, '/shifts/open', { opening_float: 0, branch_id: w2.id });                     // المالك شفته بالفرع الثاني
      expect(o.status).toBe(201);
      const r = await pay(owner, { consultation_id: v.consId, ...cashTender(w, 30000) });
      expect(r.body.code).toBe('SHIFT_BRANCH_MISMATCH');
      await closeOwnerShifts();
      expect(await payCount(w)).toBe(0);
    });
    it('كشفية غير موجودة 404، وكاشير فرع ثاني 404، والجسم ناقص أو فيه حقل زايد 400', async () => {
      const v = await visit(w);
      expect((await pay(w.cash, { consultation_id: 99999999, ...cashTender(w, 30000) })).status).toBe(404);
      expect((await pay(w2.cash, { consultation_id: v.consId, ...cashTender(w, 30000) })).status).toBe(404);
      expect((await pay(w.cash, { ...cashTender(w, 30000) })).status).toBe(400);
      expect((await pay(w.cash, { consultation_id: v.consId, net_amount: 1 })).status).toBe(400);                // ما أحد يحدد المبلغ من الواجهة
      expect((await pay(w.cash, { consultation_id: v.consId, gross_amount: 1, ...cashTender(w, 30000) })).status).toBe(400);
    });
    it('الكشفية غير مفعلة (بدون سعر) → 409 وما ينحرق رقم وصل', async () => {
      const v = await visit(noSvc);
      const r = await pay(noSvc.cash, { consultation_id: v.consId, ...cashTender(noSvc, 30000) });
      expect(r.body.code).toBe('CONSULTATION_NOT_CONFIGURED');
      expect((await db.query(`select count(*)::int as n from number_counters where branch_id = $1`, [noSvc.id])).rows[0].n).toBe(0);
    });
    it('الحجز مو اليوم → NOT_TODAY، وبعد نقله لليوم ينندفع، والمنقول للماضي (فات) والملغى ما ينندفع', async () => {
      const c = await newCust(w);
      const v = await visit(w, c, addDays(today, 1));
      const early = await pay(w.cash, { consultation_id: v.consId, ...cashTender(w, 30000) });
      expect(early.status).toBe(409);
      expect(early.body).toMatchObject({ code: 'NOT_TODAY', visit_date: addDays(today, 1), today });
      expect((await post(w.cash, `/bookings/${v.visitId}/move`, { date: today })).status).toBe(201);
      expect((await pay(w.cash, { consultation_id: v.consId, ...cashTender(w, 30000) })).status).toBe(201);
      const gone = await visit(w);
      await post(w.cash, `/bookings/${gone.visitId}/cancel`, { reason: 'تجربة' });
      expect((await pay(w.cash, { consultation_id: gone.consId, ...cashTender(w, 30000) })).body.code).toBe('CONSULTATION_NOT_PAYABLE');
      const old = await visit(w);
      await db.query(`update visits set visit_date = $2 where id = $1`, [old.visitId, addDays(today, -1)]);
      expect((await pay(w.cash, { consultation_id: old.consId, ...cashTender(w, 30000) })).body.code).toBe('NOT_TODAY');
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('الوصل والحساب', () => {
    let w: World;
    beforeAll(async () => {
      w = await world('PYR');
      await setSetting(w.mgr, 'receipt.clinic_name', 0 as any).catch(() => undefined);
      await openShift(w);
    });
    it('دفع كاش كامل: وصل برقم 00001، النقاط تنكسب، الكشفية مدفوعة والزيارة «حضر»، وكل السجلات', async () => {
      const cur = (await get(w.mgr, '/settings')).body.settings.find((s: any) => s.key === 'receipt.clinic_name');
      expect((await put(w.mgr, '/settings/receipt.clinic_name', { value: 'عيادة التجربة', expected_version: cur.version })).status).toBe(200);
      const v = await visit(w);
      const r = await pay(w.cash, { consultation_id: v.consId, ...cashTender(w, 30000) });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ receipt_no: `${year}-00001`, kind: 'consultation', status: 'paid', gross_amount: 30000, net_amount: 30000, manual_discount: 0, points_discount: 0, rounding_amount: 0,
        points_used: 0, points_earned: 750, points_balance_now: 750, business_date: today, customer: { id: v.customer }, cashier: { id: w.cashId }, print_count: 0 });
      expect(r.body.clinic).toMatchObject({ name: 'عيادة التجربة' });
      expect(r.body.items).toHaveLength(1);
      expect(r.body.items[0]).toMatchObject({ item_type: 'consultation', consultation_id: v.consId, service_name: 'كشفية', list_price: 30000, net_amount: 30000, status: 'paid' });
      expect(r.body.tenders).toEqual([{ method_id: w.cashMethod, method_name: 'كاش', method_kind: 'cash', device_label: null, amount: 30000, reference: null }]);
      expect((await db.query(`select status from consultations where id = $1`, [v.consId])).rows[0].status).toBe('paid');
      expect((await db.query(`select status from visits where id = $1`, [v.visitId])).rows[0].status).toBe('arrived');
      expect((await db.query(`select 1 from booking_events where visit_id = $1 and event = 'arrived'`, [v.visitId])).rowCount).toBe(1);
      expect((await db.query(`select entry_type, points from points_ledger where payment_id = $1`, [r.body.id])).rows).toEqual([{ entry_type: 'earn', points: 750 }]);
      expect(await balance(v.customer)).toBe(750);
      expect((await db.query(`select 1 from audit_log where action = 'payment.consultation' and entity_id = $1`, [r.body.id])).rowCount).toBe(1);
      expect(Number((await db.query(`select cashier_id from payments where id = $1`, [r.body.id])).rows[0].cashier_id)).toBe(w.cashId);
    });
    it('الأرقام متسلسلة بدون فجوات حتى مع محاولات فاشلة بينها', async () => {
      const a = await visit(w); const b = await visit(w); const c = await visit(w);
      const r1 = await pay(w.cash, { consultation_id: a.consId, ...cashTender(w, 30000) });
      expect((await pay(w.cash, { consultation_id: b.consId, ...cashTender(w, 1) })).status).toBe(409);          // فشل بعد ما انحجز رقم داخل المعاملة
      expect((await pay(w.cash, { consultation_id: b.consId })).status).toBe(400);
      const r2 = await pay(w.cash, { consultation_id: b.consId, ...cashTender(w, 30000) });
      const r3 = await pay(w.cash, { consultation_id: c.consId, ...cashTender(w, 30000) });
      const nums = [r1, r2, r3].map((r) => Number(r.body.receipt_no.split('-')[1]));
      expect(nums[1]).toBe(nums[0] + 1); expect(nums[2]).toBe(nums[1] + 1);
    });
    it('السعر المحفوظ بالوصل ما يتغير لما يتغير سعر الكشفية، والوصل الجديد بسعر يوم الدفع', async () => {
      const a = await visit(w); const b = await visit(w);
      const r1 = await pay(w.cash, { consultation_id: a.consId, ...cashTender(w, 30000) });
      expect((await put(w.mgr, `/services/${w.serviceId}/price`, { price: 45000 })).status).toBe(200);
      const r2 = await pay(w.cash, { consultation_id: b.consId, ...cashTender(w, 45000) });
      expect(r2.status).toBe(201);
      expect(r2.body.gross_amount).toBe(45000);
      expect((await get(w.cash, `/payments/${r1.body.id}`)).body.gross_amount).toBe(30000);
      const stale = await visit(w);
      expect((await pay(w.cash, { consultation_id: stale.consId, ...cashTender(w, 30000) })).body).toMatchObject({ code: 'TENDER_MISMATCH', net_amount: 45000, tendered: 30000 });   // الكاشير لازم يشوف السعر الجديد
      expect((await put(w.mgr, `/services/${w.serviceId}/price`, { price: 30000 })).status).toBe(200);
    });
    it('التقريب لصالح الزبون: 16,667 → صافي 16,500 وتقريب 167، والنقاط على المدفوع', async () => {
      expect((await put(w.mgr, `/services/${w.serviceId}/price`, { price: 16667 })).status).toBe(200);
      const v = await visit(w);
      const bad = await pay(w.cash, { consultation_id: v.consId, ...cashTender(w, 16667) });
      expect(bad.body).toMatchObject({ code: 'TENDER_MISMATCH', net_amount: 16500 });
      const r = await pay(w.cash, { consultation_id: v.consId, ...cashTender(w, 16500) });
      expect(r.body).toMatchObject({ gross_amount: 16667, rounding_amount: 167, net_amount: 16500, points_earned: 250 });
      expect(r.body.items[0]).toMatchObject({ list_price: 16667, rounding_share: 167, net_amount: 16500 });
      await put(w.mgr, `/services/${w.serviceId}/price`, { price: 30000 });
    });
    it('خطوة التقريب إعداد: مع خطوة 1000 يصير 16,667 → 16,000', async () => {
      await setSetting(owner, 'money.rounding_step', 1000, w.id);
      expect((await put(w.mgr, `/services/${w.serviceId}/price`, { price: 16667 })).status).toBe(200);
      const v = await visit(w);
      const r = await pay(w.cash, { consultation_id: v.consId, ...cashTender(w, 16000) });
      expect(r.body).toMatchObject({ rounding_amount: 667, net_amount: 16000 });
      await setSetting(owner, 'money.rounding_step', 250, w.id);
      await put(w.mgr, `/services/${w.serviceId}/price`, { price: 30000 });
    });
    it('الدفع بأكثر من طريقة: كاش + جهاز، والاسم والجهاز ينحفظون مع المرجع', async () => {
      const v = await visit(w);
      const r = await pay(w.cash, { consultation_id: v.consId, tenders: [{ method_id: w.cashMethod, amount: 10000 }, { method_id: w.cardMethod, amount: 15000, reference: ' TXN-991 ' }, { method_id: w.card2Method, amount: 5000 }] });
      expect(r.status).toBe(201);
      expect(r.body.tenders).toEqual([
        { method_id: w.cashMethod, method_name: 'كاش', method_kind: 'cash', device_label: null, amount: 10000, reference: null },
        { method_id: w.cardMethod, method_name: 'كي كارد', method_kind: 'electronic', device_label: 'جهاز 1', amount: 15000, reference: 'TXN-991' },
        { method_id: w.card2Method, method_name: 'سويتش', method_kind: 'electronic', device_label: 'جهاز 2', amount: 5000, reference: null }]);
      // تغيير اسم الجهاز بعدين ما يغير الوصل القديم
      await db.query(`update payment_methods set name_ar = 'اسم جديد' where id = $1`, [w.cardMethod]);
      expect((await get(w.cash, `/payments/${r.body.id}`)).body.tenders[1].method_name).toBe('كي كارد');
      await db.query(`update payment_methods set name_ar = 'كي كارد' where id = $1`, [w.cardMethod]);
      const cur = (await get(w.cash, '/shifts/current')).body;
      expect(cur.collected.find((x: any) => x.method_id === w.cardMethod).collected).toBeGreaterThanOrEqual(15000);
    });
    it('طرق دفع غلط: ما تساوي الصافي، مكررة، معطلة، من فرع ثاني، بدون طريقة، مبلغ صفر/سالب/كسر', async () => {
      const v = await visit(w);
      const base = { consultation_id: v.consId };
      expect((await pay(w.cash, { ...base, tenders: [{ method_id: w.cashMethod, amount: 20000 }] })).body.code).toBe('TENDER_MISMATCH');
      expect((await pay(w.cash, { ...base, tenders: [{ method_id: w.cashMethod, amount: 40000 }] })).body.code).toBe('TENDER_MISMATCH');
      expect((await pay(w.cash, { ...base, tenders: [{ method_id: w.cashMethod, amount: 15000 }, { method_id: w.cashMethod, amount: 15000 }] })).body.code).toBe('DUPLICATE_METHOD');
      expect((await pay(w.cash, { ...base, tenders: [] })).body.code).toBe('TENDER_REQUIRED');
      expect((await pay(w.cash, base)).body.code).toBe('TENDER_REQUIRED');
      for (const amount of [0, -5, 1.5, '30000']) expect((await pay(w.cash, { ...base, tenders: [{ method_id: w.cashMethod, amount }] })).status).toBe(400);
      const foreign = Number((await db.query(`select id from payment_methods where kind = 'cash' and branch_id <> $1 limit 1`, [w.id])).rows[0].id);
      expect((await pay(w.cash, { ...base, ...cashTender({ ...w, cashMethod: foreign }, 30000) })).body.code).toBe('METHOD_INVALID');
      await db.query(`update payment_methods set is_active = false where id = $1`, [w.card2Method]);
      expect((await pay(w.cash, { ...base, tenders: [{ method_id: w.card2Method, amount: 30000 }] })).body.code).toBe('METHOD_INVALID');
      await db.query(`update payment_methods set is_active = true where id = $1`, [w.card2Method]);
      expect((await pay(w.cash, { ...base, tenders: new Array(6).fill({ method_id: w.cashMethod, amount: 5000 }) })).status).toBe(400);
      expect((await db.query(`select status from consultations where id = $1`, [v.consId])).rows[0].status).toBe('awaiting_payment');
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('النقاط', () => {
    let w: World;
    beforeAll(async () => { w = await world('PYP', { price: 40000 }); await openShift(w); });
    it('استخدام النقاط: يخصم لحد الرصيد، والنقاط تنكسب على المدفوع، ونقاط الوصل ما تنصرف عليه', async () => {
      const v = await visit(w); await givePoints(w, v.customer, 1000);
      const r = await pay(w.cash, { consultation_id: v.consId, redeem_points: true, ...cashTender(w, 39000) });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ gross_amount: 40000, points_used: 1000, points_discount: 1000, rounding_amount: 0, net_amount: 39000, points_earned: 750, points_balance_now: 750 });
      expect(r.body.items[0]).toMatchObject({ points_used_share: 1000, points_discount_share: 1000, net_amount: 39000 });
      expect((await db.query(`select entry_type, points from points_ledger where payment_id = $1 order by id`, [r.body.id])).rows).toEqual([{ entry_type: 'redeem', points: -1000 }, { entry_type: 'earn', points: 750 }]);
      expect(await balance(v.customer)).toBe(750);
    });
    it('السقف 50% من المبلغ: رصيد كبير يخصم 20,000 بس', async () => {
      const v = await visit(w); await givePoints(w, v.customer, 50000);
      const r = await pay(w.cash, { consultation_id: v.consId, redeem_points: true, ...cashTender(w, 20000) });
      expect(r.body).toMatchObject({ points_used: 20000, points_discount: 20000, net_amount: 20000, points_earned: 500 });
      expect(await balance(v.customer)).toBe(30000 + 500);
    });
    it('بدون موافقة الزبون (redeem_points غير موجود/false) ما تنصرف النقاط وتتجمع', async () => {
      const v = await visit(w); await givePoints(w, v.customer, 1000);
      const r = await pay(w.cash, { consultation_id: v.consId, redeem_points: false, ...cashTender(w, 40000) });
      expect(r.body).toMatchObject({ points_used: 0, points_discount: 0, net_amount: 40000, points_earned: 1000 });
      expect(await balance(v.customer)).toBe(2000);
    });
    it('رصيد صفر أو سالب أو تحت الحد الأدنى → 409 والكشفية تبقى بانتظار الدفع', async () => {
      const a = await visit(w);
      expect((await pay(w.cash, { consultation_id: a.consId, redeem_points: true, ...cashTender(w, 40000) })).body.code).toBe('POINTS_NOT_AVAILABLE');
      const b = await visit(w); await db.query(`update customers set points_balance = -300 where id = $1`, [b.customer]);                  // سالب بعد استرجاع
      expect((await pay(w.cash, { consultation_id: b.consId, redeem_points: true, ...cashTender(w, 40000) })).body.code).toBe('POINTS_NOT_AVAILABLE');
      await db.query(`update customers set points_balance = 0 where id = $1`, [b.customer]);
      await setSetting(owner, 'points.min_redeem', 500, w.id);
      const c = await visit(w); await givePoints(w, c.customer, 400);
      expect((await pay(w.cash, { consultation_id: c.consId, redeem_points: true, ...cashTender(w, 39600) })).body.code).toBe('POINTS_NOT_AVAILABLE');
      await givePoints(w, c.customer, 100);
      expect((await pay(w.cash, { consultation_id: c.consId, redeem_points: true, ...cashTender(w, 39500) })).status).toBe(201);
      await setSetting(owner, 'points.min_redeem', 0, w.id);
      expect((await db.query(`select status from consultations where id = $1`, [a.consId])).rows[0].status).toBe('awaiting_payment');
    });
    it('قيمة النقطة وقواعد الكسب إعدادات المالك: النقطة بدينارين، والكسب 100 لكل 20,000', async () => {
      await setSetting(owner, 'points.point_value', 2, w.id);
      const v = await visit(w); await givePoints(w, v.customer, 1000);
      const r = await pay(w.cash, { consultation_id: v.consId, redeem_points: true, ...cashTender(w, 38000) });
      expect(r.body).toMatchObject({ points_used: 1000, points_discount: 2000, net_amount: 38000, points_earned: 750 });
      expect(r.body.items[0]).toMatchObject({ points_used_share: 1000, points_discount_share: 2000 });
      await setSetting(owner, 'points.point_value', 1, w.id);
      await setSetting(owner, 'points.earn_per_amount', 20000, w.id); await setSetting(owner, 'points.earn_points', 100, w.id);
      const x = await visit(w);
      expect((await pay(w.cash, { consultation_id: x.consId, ...cashTender(w, 40000) })).body.points_earned).toBe(200);
      await setSetting(owner, 'points.earn_per_amount', 10000, w.id); await setSetting(owner, 'points.earn_points', 250, w.id);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('الخصم اليدوي والوصل الصفري', () => {
    let w: World;
    beforeAll(async () => { w = await world('PYD'); await openShift(w); });
    it('خصم معتمد 5,000: الصافي 25,000، والطلب يصير «مستخدم» ولا ينستخدم مرتين', async () => {
      const v = await visit(w); const d = await discount(w, v.customer, 5000, 'approved', v.visitId);
      const r = await pay(w.cash, { consultation_id: v.consId, discount_request_id: d, ...cashTender(w, 25000) });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ gross_amount: 30000, manual_discount: 5000, net_amount: 25000, points_earned: 500 });
      expect(r.body.items[0]).toMatchObject({ manual_discount_share: 5000, net_amount: 25000 });
      expect((await db.query(`select status from discount_requests where id = $1`, [d])).rows[0].status).toBe('used');
      const v2 = await visit(w);
      expect((await pay(w.cash, { consultation_id: v2.consId, discount_request_id: d, ...cashTender(w, 25000) })).body.code).toBe('DISCOUNT_NOT_USABLE');
    });
    it('طلب غير صالح: معلّق، مرفوض، لزبون ثاني، لزيارة ثانية، من فرع ثاني، غير موجود، أكبر من المبلغ', async () => {
      const v = await visit(w); const other = await visit(w);
      const body = (d: number) => ({ consultation_id: v.consId, discount_request_id: d, ...cashTender(w, 25000) });
      expect((await pay(w.cash, body(await discount(w, v.customer, 5000, 'pending')))).body.code).toBe('DISCOUNT_NOT_USABLE');
      expect((await pay(w.cash, body(await discount(w, v.customer, 5000, 'rejected')))).body.code).toBe('DISCOUNT_NOT_USABLE');
      expect((await pay(w.cash, body(await discount(w, other.customer, 5000)))).body.code).toBe('DISCOUNT_NOT_USABLE');
      expect((await pay(w.cash, body(await discount(w, v.customer, 5000, 'approved', other.visitId)))).body.code).toBe('DISCOUNT_NOT_USABLE');
      expect((await pay(w.cash, body(99999999))).body.code).toBe('DISCOUNT_NOT_USABLE');
      expect((await pay(w.cash, body(await discount(w, v.customer, 30001)))).body.code).toBe('DISCOUNT_TOO_LARGE');
      const w2 = await world('PYD2'); const foreignReq = await discount(w2, v.customer, 5000);
      expect((await pay(w.cash, body(foreignReq))).body.code).toBe('DISCOUNT_NOT_USABLE');
      expect((await db.query(`select status from consultations where id = $1`, [v.consId])).rows[0].status).toBe('awaiting_payment');
    });
    it('الوصل الصفري: خصم = كامل المبلغ ← بدون طرق دفع وبدون نقاط، وبنده ظاهر، والنقاط ما تنصرف عليه', async () => {
      const v = await visit(w); await givePoints(w, v.customer, 1000);
      const d = await discount(w, v.customer, 30000);
      const withTender = await pay(w.cash, { consultation_id: v.consId, discount_request_id: d, ...cashTender(w, 1) });
      expect(withTender.body.code).toBe('TENDER_MISMATCH');
      const pts = await pay(w.cash, { consultation_id: v.consId, discount_request_id: d, redeem_points: true });
      expect(pts.body.code).toBe('POINTS_NOT_AVAILABLE');
      const r = await pay(w.cash, { consultation_id: v.consId, discount_request_id: d });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ gross_amount: 30000, manual_discount: 30000, net_amount: 0, points_earned: 0, tenders: [], status: 'paid' });
      expect(r.body.items[0]).toMatchObject({ list_price: 30000, manual_discount_share: 30000, net_amount: 0 });
      expect((await db.query(`select count(*)::int as n from points_ledger where payment_id = $1`, [r.body.id])).rows[0].n).toBe(0);
      expect(await balance(v.customer)).toBe(1000);
      expect((await db.query(`select status from consultations where id = $1`, [v.consId])).rows[0].status).toBe('paid');
    });
    it('خصم + نقاط + تقريب معاً: 30,000 − 5,000 − نقاط 12,500 = 12,500', async () => {
      const v = await visit(w); await givePoints(w, v.customer, 20000);
      const d = await discount(w, v.customer, 5000);
      const r = await pay(w.cash, { consultation_id: v.consId, discount_request_id: d, redeem_points: true, ...cashTender(w, 12500) });
      expect(r.body).toMatchObject({ manual_discount: 5000, points_used: 12500, points_discount: 12500, net_amount: 12500, points_earned: 250 });
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('منع التكرار والتزامن', () => {
    let w: World;
    beforeAll(async () => { w = await world('PYI'); await openShift(w); });
    it('نفس المفتاح ونفس الطلب: نفس الوصل بالضبط، علامة الإعادة، ووصل واحد بالقاعدة', async () => {
      const v = await visit(w); const k = key(); const body = { consultation_id: v.consId, ...cashTender(w, 30000) };
      const a = await pay(w.cash, body, k); const b = await pay(w.cash, body, k);
      expect(a.status).toBe(201); expect(b.status).toBe(201);
      expect(b.body).toEqual(a.body);
      expect(a.headers['idempotent-replay']).toBeUndefined(); expect(b.headers['idempotent-replay']).toBe('true');
      expect(Number((await db.query(`select count(*)::int as n from payments where visit_id = $1`, [v.visitId])).rows[0].n)).toBe(1);
      expect(Number((await db.query(`select count(*)::int as n from points_ledger where payment_id = $1`, [a.body.id])).rows[0].n)).toBe(1);
    });
    it('الإعادة ترجع نفس الرد حتى لو تغير ترتيب حقول الجسم، ومن ديناميكية الأسعار ما تتغير', async () => {
      const v = await visit(w); const k = key();
      const a = await pay(w.cash, { consultation_id: v.consId, redeem_points: false, tenders: [{ method_id: w.cashMethod, amount: 30000 }] }, k);
      const b = await pay(w.cash, { tenders: [{ amount: 30000, method_id: w.cashMethod }], redeem_points: false, consultation_id: v.consId }, k);
      expect(b.body).toEqual(a.body); expect(b.headers['idempotent-replay']).toBe('true');
    });
    it('نفس المفتاح بطلب مختلف → 422 (كشفية ثانية أو طرق دفع ثانية)', async () => {
      const v1 = await visit(w); const v2 = await visit(w); const k = key();
      expect((await pay(w.cash, { consultation_id: v1.consId, ...cashTender(w, 30000) }, k)).status).toBe(201);
      expect((await pay(w.cash, { consultation_id: v2.consId, ...cashTender(w, 30000) }, k)).body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await pay(w.cash, { consultation_id: v1.consId, tenders: [{ method_id: w.cardMethod, amount: 30000 }] }, k)).status).toBe(422);
      expect((await db.query(`select status from consultations where id = $1`, [v2.consId])).rows[0].status).toBe('awaiting_payment');
    });
    it('المحاولة الفاشلة ما تحرق المفتاح: نفس المفتاح بجسم مصحح ينجح', async () => {
      const v = await visit(w); const k = key();
      expect((await pay(w.cash, { consultation_id: v.consId, ...cashTender(w, 100) }, k)).status).toBe(409);
      expect((await db.query(`select 1 from idempotency_keys where key = $1`, [k])).rowCount).toBe(0);
      expect((await pay(w.cash, { consultation_id: v.consId, ...cashTender(w, 30000) }, k)).status).toBe(201);
    });
    it('المفتاح خاص بالمستخدم: كاشير ثاني بنفس المفتاح يعتبر طلب جديد', async () => {
      const v1 = await visit(w); const v2 = await visit(w); const k = key();
      await openShift(w, w.cash2, 0);
      expect((await pay(w.cash, { consultation_id: v1.consId, ...cashTender(w, 30000) }, k)).status).toBe(201);
      const r = await pay(w.cash2, { consultation_id: v2.consId, ...cashTender(w, 30000) }, k);
      expect(r.status).toBe(201);
      expect(r.headers['idempotent-replay']).toBeUndefined();
    });
    it('7 طلبات متزامنة بنفس المفتاح: وصل واحد والكل يرجع نفس الجسم', async () => {
      const v = await visit(w); const k = key(); const body = { consultation_id: v.consId, redeem_points: false, ...cashTender(w, 30000) };
      const before = await payCount(w);
      const rs = await Promise.all(Array.from({ length: 7 }, () => pay(w.cash, body, k)));
      expect(rs.map((r) => r.status)).toEqual(new Array(7).fill(201));
      for (const r of rs) expect(r.body).toEqual(rs[0].body);                                  // مقارنة عميقة (ترتيب مفاتيح jsonb ممكن يختلف)
      expect(rs.filter((r) => r.headers['idempotent-replay'] === 'true')).toHaveLength(6);
      expect(await payCount(w)).toBe(before + 1);
    });
    it('8 طلبات متزامنة بمفاتيح مختلفة لنفس الكشفية: واحد ينجح والباقي ALREADY_PAID، وبدون فجوة بالأرقام', async () => {
      const v = await visit(w); const before = await payCount(w);
      const rs = await Promise.all(Array.from({ length: 8 }, () => pay(w.cash, { consultation_id: v.consId, ...cashTender(w, 30000) })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'ALREADY_PAID')).toHaveLength(7);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(await payCount(w)).toBe(before + 1);
      const nextV = await visit(w);
      const n = await pay(w.cash, { consultation_id: nextV.consId, ...cashTender(w, 30000) });
      expect(Number(n.body.receipt_no.split('-')[1])).toBe(Number(rs.find((r) => r.status === 201)!.body.receipt_no.split('-')[1]) + 1);
      expect(Number((await db.query(`select count(*)::int as n from points_ledger where payment_id = $1`, [rs.find((r) => r.status === 201)!.body.id])).rows[0].n)).toBe(1);
    });
    it('دفعات متزامنة لـ 10 زبائن مختلفين: 10 وصولات بأرقام مختلفة متتالية', async () => {
      const vs = await Promise.all(Array.from({ length: 10 }, () => visit(w)));
      const rs = await Promise.all(vs.map((v) => pay(w.cash, { consultation_id: v.consId, ...cashTender(w, 30000) })));
      expect(rs.map((r) => r.status)).toEqual(new Array(10).fill(201));
      const nums = rs.map((r) => Number(r.body.receipt_no.split('-')[1])).sort((a, b) => a - b);
      expect(new Set(nums).size).toBe(10);
      expect(nums[9] - nums[0]).toBe(9);
    });
    it('دفع وإلغاء الحجز بنفس اللحظة: واحد بس ينجح والحالة سليمة', async () => {
      for (let i = 0; i < 4; i++) {
        const v = await visit(w);
        const [p, c] = await Promise.all([pay(w.cash, { consultation_id: v.consId, ...cashTender(w, 30000) }), post(w.cash, `/bookings/${v.visitId}/cancel`, { reason: 'سباق' })]);
        expect([p.status, c.status].filter((s) => s >= 500)).toHaveLength(0);
        expect([p.status === 201, c.status === 201].filter(Boolean)).toHaveLength(1);
        const st = (await db.query(`select v.status as vs, c.status as cs from visits v join consultations c on c.visit_id = v.id where v.id = $1`, [v.visitId])).rows[0];
        expect(p.status === 201 ? { vs: 'arrived', cs: 'paid' } : { vs: 'cancelled', cs: 'cancelled' }).toEqual(st);
      }
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('المراجعة المجانية', () => {
    let w: World;
    beforeAll(async () => { w = await world('PYF'); await openShift(w); });
    /** كشفية مدفوعة قبل `ago` أيام ثم حجز مراجعة اليوم */
    async function followup(ago = 2) {
      const parent = await visit(w);
      const p = await pay(w.cash, { consultation_id: parent.consId, ...cashTender(w, 30000) });
      expect(p.status).toBe(201);
      await db.query(`update visits set visit_date = $2 where id = $1`, [parent.visitId, addDays(today, -ago)]);
      const f = await visit(w, parent.customer);
      expect(f.kind).toBe('free_followup');
      return { parent, f };
    }
    it('المراجعة المجانية: الدفع مرفوض (FREE_FOLLOWUP)، والدخول بدون دفع ينجح مرة وحدة وبدون وصل', async () => {
      const { f } = await followup();
      const before = await payCount(w);
      expect((await pay(w.cash, { consultation_id: f.consId, ...cashTender(w, 30000) })).body.code).toBe('FREE_FOLLOWUP');
      const r = await post(w.cash, `/consultations/${f.consId}/check-in`);
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ consultation_id: f.consId, status: 'paid', visit_status: 'arrived', kind: 'free_followup' });
      expect((await post(w.cash, `/consultations/${f.consId}/check-in`)).body.code).toBe('NOT_CHECKABLE');
      expect(await payCount(w)).toBe(before);
      expect((await db.query(`select status from visits where id = $1`, [f.visitId])).rows[0].status).toBe('arrived');
      expect((await db.query(`select 1 from booking_events where visit_id = $1 and event = 'arrived' and reason = 'مراجعة مجانية'`, [f.visitId])).rowCount).toBe(1);
    });
    it('كشفية جديدة ما تنفتح بدون دفع (PAYMENT_REQUIRED)، وكاشير فرع ثاني 404، والممرض 403', async () => {
      const v = await visit(w);
      expect((await post(w.cash, `/consultations/${v.consId}/check-in`)).body.code).toBe('PAYMENT_REQUIRED');
      const { f } = await followup();
      const other = await world('PYF2'); await openShift(other);
      expect((await post(other.cash, `/consultations/${f.consId}/check-in`)).status).toBe(404);
      expect((await post(nurse, `/consultations/${f.consId}/check-in`)).status).toBe(403);
      expect((await post(w.cash, '/consultations/99999999/check-in')).status).toBe(404);
    });
    it('الكشفية الأصلية انرجعت (ملغاة): ما تنطبق المجانية → الدخول يرفض، والدفع يحولها كشفية جديدة وتنحسب', async () => {
      const { parent, f } = await followup();
      await db.query(`update consultations set status = 'cancelled' where id = $1`, [parent.consId]);
      expect((await post(w.cash, `/consultations/${f.consId}/check-in`)).body.code).toBe('FOLLOWUP_NOT_ELIGIBLE');
      const r = await pay(w.cash, { consultation_id: f.consId, ...cashTender(w, 30000) });
      expect(r.status).toBe(201);
      expect(r.body.net_amount).toBe(30000);
      const c = (await db.query(`select kind, parent_consultation_id from consultations where id = $1`, [f.consId])).rows[0];
      expect(c).toEqual({ kind: 'new', parent_consultation_id: null });
      expect((await db.query(`select 1 from audit_log where action = 'consultation.followup_to_new' and entity_id = $1`, [f.consId])).rowCount).toBe(1);
    });
    it('انتهت المدة بعد الحجز (إعداد المالك نزل): تنحسب كشفية، إلا إذا الموعد انتقل بسبب إغلاق من العيادة', async () => {
      const { f } = await followup(5);
      await setSetting(owner, 'booking.free_followup_days', 3, w.id);
      expect((await post(w.cash, `/consultations/${f.consId}/check-in`)).body.code).toBe('FOLLOWUP_NOT_ELIGIBLE');
      await db.query(`insert into booking_events (visit_id, consultation_id, event, from_date, to_date, reason) values ($1,$2,'moved_by_closure',$3,$4,'عطلة')`, [f.visitId, f.consId, addDays(today, -1), today]);
      expect((await post(w.cash, `/consultations/${f.consId}/check-in`)).status).toBe(201);
      await setSetting(owner, 'booking.free_followup_days', 7, w.id);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('عرض الوصولات وطباعتها', () => {
    let w: World; let w2: World; let rid: number; let rno: string; let cust: number;
    beforeAll(async () => {
      w = await world('PYV'); w2 = await world('PYV2'); await openShift(w); await openShift(w2);
      const v = await visit(w); cust = v.customer;
      const r = await pay(w.cash, { consultation_id: v.consId, ...cashTender(w, 30000) }); rid = r.body.id; rno = r.body.receipt_no;
    });
    it('الكاشير والمدير والمالك يشوفون، الطبيب والممرض لا، وفرع ثاني 404', async () => {
      for (const t of [w.cash, w.mgr, owner]) expect((await get(t, `/payments/${rid}`)).status).toBe(200);
      for (const t of [doc1, nurse]) expect((await get(t, `/payments/${rid}`)).status).toBe(403);
      expect((await get(w2.cash, `/payments/${rid}`)).status).toBe(404);
      expect((await get(w2.mgr, `/payments/${rid}`)).status).toBe(404);
      expect((await get(w.cash, '/payments/99999999')).status).toBe(404);
    });
    it('البحث برقم الوصل أو الزبون أو الشفت أو اليوم، وبدون فلتر 400، وفرع ثاني ما يشوف', async () => {
      expect((await get(w.cash, `/payments?receipt_no=${rno}`)).body.map((p: any) => p.id)).toEqual([rid]);
      expect((await get(w.cash, `/payments?customer_id=${cust}`)).body.map((p: any) => p.id)).toEqual([rid]);
      expect((await get(w.cash, `/payments?date=${today}`)).body.map((p: any) => p.id)).toContain(rid);
      const shift = (await get(w.cash, '/shifts/current')).body.id;
      expect((await get(w.cash, `/payments?shift_id=${shift}`)).body.map((p: any) => p.id)).toContain(rid);
      expect((await get(w.cash, '/payments')).status).toBe(400);
      expect((await get(w.cash, '/payments?date=x')).status).toBe(400);
      expect((await get(w2.cash, `/payments?receipt_no=${rno}`)).body).toEqual([]);
      expect((await get(owner, `/payments?receipt_no=${rno}&branch_id=${w.id}`)).body).toHaveLength(1);
    });
    it('الطباعة: الأولى طباعة والباقي إعادة طبع، مع عدّاد وسجل، وفرع ثاني 404، والمدير 403', async () => {
      const a = await post(w.cash, `/payments/${rid}/print`, {});
      const b = await post(w.cash, `/payments/${rid}/print`, { note: 'الطابعة عطلانة' });
      expect(a.body).toMatchObject({ is_reprint: false, print_count: 1 }); expect(b.body).toMatchObject({ is_reprint: true, print_count: 2 });
      expect((await get(w.cash, `/payments/${rid}`)).body.print_count).toBe(2);
      expect((await db.query(`select is_reprint, note from receipt_prints where payment_id = $1 order by id`, [rid])).rows).toEqual([{ is_reprint: false, note: null }, { is_reprint: true, note: 'الطابعة عطلانة' }]);   // المخزن بالقاعدة مو بس الرد
      expect((await post(w2.cash, `/payments/${rid}/print`, {})).status).toBe(404);
      expect((await post(w.mgr, `/payments/${rid}/print`, {})).status).toBe(403);
      expect((await db.query(`select action from audit_log where entity_id = $1 and action like 'receipt.%' order by id`, [rid])).rows.map((r) => r.action)).toEqual(['receipt.print', 'receipt.reprint']);
    });
    it('5 طباعات متزامنة: وحدة بس «أولى»', async () => {
      const v = await visit(w); const p = await pay(w.cash, { consultation_id: v.consId, ...cashTender(w, 30000) });
      const rs = await Promise.all(Array.from({ length: 5 }, () => post(w.cash, `/payments/${p.body.id}/print`, {})));
      expect(rs.filter((r) => r.body.is_reprint === false)).toHaveLength(1);
      expect(rs.map((r) => r.body.print_count).sort()).toEqual([1, 2, 3, 4, 5]);
    });
  });

  it('فحص نهائي: الوصولات سليمة حسابياً، والنقاط مطابقة للسجل، وأرقام الوصل بدون فجوات أو تكرار', async () => {
    const bad = await db.query(`select * from v_integrity_checks where check_name in ('payment_tenders_sum_mismatch','payment_items_sum_mismatch','points_balance_mismatch')`);
    expect(bad.rows).toEqual([]);
    const { rows } = await db.query(`select branch_id, array_agg(receipt_no order by receipt_no) as nos from payments where receipt_no ~ '^[0-9]{4}-[0-9]{5}$' group by branch_id`);
    for (const r of rows) r.nos.forEach((n: string, i: number) => expect(n).toBe(`${year}-${String(i + 1).padStart(5, '0')}`));
    const counters = await db.query(`select c.branch_id, c.last_value, (select count(*)::int from payments p where p.branch_id = c.branch_id and p.receipt_no ~ '^[0-9]{4}-[0-9]{5}$') as n from number_counters c where c.kind = 'receipt'`);
    for (const c of counters.rows) expect(c.n).toBe(c.last_value);
  });
});
