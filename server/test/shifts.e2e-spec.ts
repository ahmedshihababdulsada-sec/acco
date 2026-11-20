import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

interface World { id: number; code: string; mgr: string; mgrId: number; cashiers: { token: string; id: number }[]; docId: number; serviceId: number; cashMethod: number; cardMethod: number; card2Method: number }

describe('الشفت والخزنة', () => {
  let app: INestApplication; let db: Pool; let today: string; let owner: string; let nurse: string; let doc1: string;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  let seq = 0; let phoneSeq = 0;
  const key = () => `sk-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const pay = (t: string, body: object) => http().post('/payments/consultation').set(auth(t)).set('Idempotency-Key', key()).send(body);
  const refund = (t: string, id: number, body: object) => http().post(`/payments/${id}/refund`).set(auth(t)).set('Idempotency-Key', key()).send(body);
  const closeOwnerShifts = () => db.query(`update shifts set status = 'closed', closed_at = now() where status = 'open' and cashier_id = (select id from users where username = 'owner')`);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

  /** فرع معزول بدون رصيد بالخزنة (كل اختبار يموّلها حسب حاجته) وثلاث كاشيرية */
  async function world(code: string, opts: { cashiers?: number } = {}): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name) values ($1,$1) returning id`, [code])).rows[0].id);
    await db.query(`insert into safes (branch_id) values ($1)`, [id]);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id);
    const n = opts.cashiers ?? 3;
    const cashiers: { token: string; id: number }[] = [];
    for (let i = 0; i < n; i++) { const uid = await seedUser(db, `c${i}_${code}`, 'cashier', id); cashiers.push({ id: uid, token: await tokenFor(app, `c${i}_${code}`) }); }
    const docId = await seedUser(db, `doc_${code}`, 'doctor', id);
    const mgr = await tokenFor(app, `mgr_${code}`);
    expect((await put(mgr, `/schedule/doctors/${docId}/weekly`, { days: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ weekday: d, start_time: '09:00', end_time: '13:00' })), effective_from: today })).status).toBe(200);
    const cur = (await get(mgr, '/settings')).body.settings.find((s: any) => s.key === 'booking.daily_limit');
    expect((await put(mgr, '/settings/booking.daily_limit', { value: 1000, expected_version: cur.version })).status).toBe(200);
    const serviceId = Number((await db.query(`insert into services (branch_id, name_ar, kind, pricing_model, is_active) values ($1,'كشفية','consultation','fixed',true) returning id`, [id])).rows[0].id);
    await db.query(`insert into service_prices (service_id, price, set_by) values ($1,30000,$2)`, [serviceId, mgrId]);
    const cashMethod = Number((await db.query(`insert into payment_methods (branch_id, name_ar, kind, sort_order) values ($1,'كاش','cash',0) returning id`, [id])).rows[0].id);
    const cardMethod = Number((await db.query(`insert into payment_methods (branch_id, name_ar, kind, device_label, sort_order) values ($1,'كي كارد','electronic','جهاز 1',1) returning id`, [id])).rows[0].id);
    const card2Method = Number((await db.query(`insert into payment_methods (branch_id, name_ar, kind, device_label, sort_order) values ($1,'سويتش','electronic','جهاز 2',2) returning id`, [id])).rows[0].id);
    return { id, code, mgr, mgrId, cashiers, docId, serviceId, cashMethod, cardMethod, card2Method };
  }
  const fundSafe = (w: World, amount: number) => db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',$2,'opening_balance','تجربة',$3)`, [w.id, amount, w.mgrId]);
  const safeBalance = async (w: World) => Number((await one(`select balance from safes where branch_id = $1`, [w.id])).balance);
  const openShift = async (t: string, float = 0, extra: object = {}) => { const r = await post(t, '/shifts/open', { opening_float: float, ...extra }); expect(r.status).toBe(201); return r.body; };
  async function newCust(w: World): Promise<number> {
    phoneSeq++;
    const r = await post(w.cashiers[0].token, '/customers', { full_name: `زبون شفت ${phoneSeq}`, phone: `0793${String(phoneSeq).padStart(7, '0')}` });
    expect(r.status).toBe(201); return r.body.id;
  }
  async function visit(w: World, customer?: number) {
    const c = customer ?? (await newCust(w));
    const r = await post(w.cashiers[0].token, '/bookings', { customer_id: c, doctor_id: w.docId, date: today });
    expect(r.status).toBe(201);
    return { customer: c, visitId: r.body.id as number, consId: r.body.consultation.id as number };
  }
  /** دفع كشفية بالطرق المحددة (الافتراضي كاش 30,000) بكاشير معين */
  async function paid(w: World, cashier = 0, tenders?: { method_id: number; amount: number }[]) {
    const v = await visit(w);
    const r = await pay(w.cashiers[cashier].token, { consultation_id: v.consId, tenders: tenders ?? [{ method_id: w.cashMethod, amount: 30000 }] });
    expect(r.status).toBe(201);
    return { ...v, payment: r.body };
  }
  const detail = async (t: string, id: number) => (await get(t, `/shifts/${id}`)).body;
  const closeBody = (w: World, counts: [number, number][]) => ({ counts: counts.map(([method_id, counted]) => ({ method_id, counted })) });

  beforeAll(async () => {
    app = await makeApp(); db = pool();
    today = (await db.query(`select clinic_today()::text as d`)).rows[0].d;
    [owner, nurse, doc1] = await Promise.all(['owner', 'nurse1', 'doc1'].map((u) => tokenFor(app, u)));
  });
  afterAll(async () => { await app.close(); await db.end(); });

  // ------------------------------------------------------------------------------------------------
  describe('رصيد الخزنة الافتتاحي والفكة', () => {
    let w: World; let w2: World;
    beforeAll(async () => { w = await world('SHA'); w2 = await world('SHA2'); });
    it('الرصيد الافتتاحي للمالك بس ومرة وحدة، ومبلغ صحيح موجب، والمالك يحدد الفرع', async () => {
      for (const t of [w.mgr, w.cashiers[0].token, doc1, nurse]) expect((await post(t, '/safe/opening-balance', { amount: 1000 })).status).toBe(403);
      expect((await post(owner, '/safe/opening-balance', { amount: 1000 })).status).toBe(400);                         // أكثر من فرع: لازم يحدد
      for (const amount of [0, -5, 1.5, '100']) expect((await post(owner, '/safe/opening-balance', { amount, branch_id: w.id })).status).toBe(400);
      const r = await post(owner, '/safe/opening-balance', { amount: 500000, branch_id: w.id, note: 'رأس مال' });
      expect(r.status).toBe(201); expect(r.body).toMatchObject({ branch_id: w.id, balance: 500000 });
      expect((await post(owner, '/safe/opening-balance', { amount: 1000, branch_id: w.id })).body.code).toBe('OPENING_ALREADY_SET');
      expect(await safeBalance(w)).toBe(500000);
      expect((await db.query(`select 1 from audit_log where action = 'safe.opening_balance' and entity_id = $1`, [r.body.movement_id])).rowCount).toBe(1);
    });
    it('المدير والمالك يشوفون الخزنة، والكاشير والطبيب لا، وفرع ثاني ما يشوف', async () => {
      const r = await get(w.mgr, '/safe');
      expect(r.status).toBe(200);
      expect(r.body.balance).toBe(500000);
      expect(r.body.movements[0]).toMatchObject({ direction: 'in', amount: 500000, kind: 'opening_balance', note: 'رأس مال' });
      for (const t of [w.cashiers[0].token, doc1, nurse]) expect((await get(t, '/safe')).status).toBe(403);
      expect((await get(w2.mgr, '/safe')).body).toMatchObject({ balance: 0, movements: [] });
      expect((await get(owner, `/safe?branch_id=${w.id}&limit=1`)).body.movements).toHaveLength(1);
    });
    it('فتح الشفت يسحب الفكة من الخزنة بحركة shift_float، وفكة صفر بدون حركة', async () => {
      const s = await openShift(w.cashiers[0].token, 100000, { float_given_by: w.mgrId });
      expect(await safeBalance(w)).toBe(400000);
      expect(await one(`select direction, amount::int as amount, kind, shift_id::int as shift_id from safe_movements where shift_id = $1`, [s.id])).toEqual({ direction: 'out', amount: 100000, kind: 'shift_float', shift_id: s.id });
      await openShift(w.cashiers[1].token, 0);
      expect(await safeBalance(w)).toBe(400000);
      expect((await db.query(`select 1 from safe_movements where shift_id = (select id from shifts where cashier_id = $1)`, [w.cashiers[1].id])).rowCount).toBe(0);
    });
    it('فكة أكبر من الرصيد → 409 والشفت ما ينفتح والخزنة ما تتغير، وبفكة أصغر ينفتح', async () => {
      const r = await post(w.cashiers[2].token, '/shifts/open', { opening_float: 400001 });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: 'SAFE_INSUFFICIENT', safe_balance: 400000, requested: 400001 });
      expect((await get(w.cashiers[2].token, '/shifts/current')).body).toEqual({});
      expect(await safeBalance(w)).toBe(400000);
      await openShift(w.cashiers[2].token, 400000);
      expect(await safeBalance(w)).toBe(0);
    });
    it('5 كاشيرية يفتحون شفت بنفس اللحظة والرصيد يكفي 3: ثلاثة ينجحون واثنين SAFE_INSUFFICIENT والرصيد بالضبط', async () => {
      const x = await world('SHC', { cashiers: 5 });
      await fundSafe(x, 100000);
      const rs = await Promise.all(x.cashiers.map((c) => post(c.token, '/shifts/open', { opening_float: 30000 })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(3);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'SAFE_INSUFFICIENT')).toHaveLength(2);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(await safeBalance(x)).toBe(10000);
      expect(Number((await one(`select count(*)::int as n from shifts where branch_id = $1`, [x.id])).n)).toBe(3);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('تسكير الشفت', () => {
    let w: World;
    beforeAll(async () => { w = await world('SHB'); await fundSafe(w, 10000000); });
    it('بدون شفت مفتوح 409، والمدير/الطبيب/الممرض 403', async () => {
      expect((await post(w.cashiers[0].token, '/shifts/current/close', closeBody(w, [[w.cashMethod, 0]]))).body.code).toBe('NO_OPEN_SHIFT');
      for (const t of [w.mgr, doc1, nurse]) expect((await post(t, '/shifts/current/close', closeBody(w, [[w.cashMethod, 0]]))).status).toBe(403);
    });
    it('شفت بدون حركة: لازم عدّ الكاش بس، والمتوقع = الفكة، وبعد التسكير الشفت مسكر ويقدر يفتح جديد', async () => {
      const s = await openShift(w.cashiers[0].token, 50000);
      expect(s.methods_to_count).toEqual([{ method_id: w.cashMethod, method_name: 'كاش', method_kind: 'cash', device_label: null, collected: 0, refunded: 0 }]);
      const r = await post(w.cashiers[0].token, '/shifts/current/close', closeBody(w, [[w.cashMethod, 50000]]));
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ id: s.id, status: 'closed', counts: [{ method_id: w.cashMethod, collected: 0, refunded: 0, counted: 50000 }] });
      expect(JSON.stringify(r.body)).not.toContain('expected');                                         // العدّ أعمى: الكاشير ما يشوف المتوقع
      const d = await detail(w.mgr, s.id);
      expect(d).toMatchObject({ status: 'closed', opening_float: 50000, methods: [{ method_id: w.cashMethod, expected: 50000, counted: 50000, confirmed: null, difference: null }] });
      expect((await one(`select status, closed_at is not null as c from shifts where id = $1`, [s.id]))).toEqual({ status: 'closed', c: true });
      expect((await get(w.cashiers[0].token, '/shifts/current')).body).toEqual({});
      await openShift(w.cashiers[0].token, 0);                                                          // شفت جديد ينفتح عادي
      await post(w.cashiers[0].token, '/shifts/current/close', closeBody(w, [[w.cashMethod, 0]]));
    });
    it('عدّ ناقص، طريقة زايدة أو مكررة أو غلط، مبلغ سالب أو كسر → ما ينسكر الشفت', async () => {
      const s = await openShift(w.cashiers[0].token, 10000);
      await paid(w, 0, [{ method_id: w.cashMethod, amount: 10000 }, { method_id: w.cardMethod, amount: 20000 }]);
      const cur = (await get(w.cashiers[0].token, '/shifts/current')).body;
      expect(cur.methods_to_count.map((m: any) => m.method_id)).toEqual([w.cashMethod, w.cardMethod]);
      const bad = async (counts: [number, number][]) => post(w.cashiers[0].token, '/shifts/current/close', closeBody(w, counts));
      const a = await bad([[w.cashMethod, 20000]]);                                                     // ناقص كشف الجهاز
      expect(a.status).toBe(409); expect(a.body.code).toBe('COUNTS_MISMATCH');
      expect(a.body.required_methods.map((m: any) => m.method_id)).toEqual([w.cashMethod, w.cardMethod]);
      expect((await bad([[w.cardMethod, 20000]])).body.code).toBe('COUNTS_MISMATCH');                  // ناقص الكاش
      expect((await bad([[w.cashMethod, 20000], [w.cardMethod, 20000], [w.card2Method, 0]])).body.code).toBe('COUNTS_MISMATCH');   // جهاز ما صار عليه حركة
      expect((await bad([[w.cashMethod, 20000], [99999999, 0], [w.cardMethod, 20000]])).body.code).toBe('COUNTS_MISMATCH');
      expect((await bad([[w.cashMethod, 1], [w.cashMethod, 2], [w.cardMethod, 20000]])).body.code).toBe('DUPLICATE_METHOD');
      for (const v of [-1, 1.5, '5']) expect((await post(w.cashiers[0].token, '/shifts/current/close', { counts: [{ method_id: w.cashMethod, counted: v }, { method_id: w.cardMethod, counted: 1 }] })).status).toBe(400);
      expect((await post(w.cashiers[0].token, '/shifts/current/close', { counts: [] })).status).toBe(400);
      expect((await one(`select status from shifts where id = $1`, [s.id])).status).toBe('open');
      expect(Number((await one(`select count(*)::int as n from shift_method_totals where shift_id = $1`, [s.id])).n)).toBe(0);
      expect((await post(w.cashiers[0].token, '/shifts/current/close', closeBody(w, [[w.cashMethod, 20000], [w.cardMethod, 20000]]))).status).toBe(201);
    });
    it('المتوقع لكل طريقة لحالها: كاش = فكة + مقبوض − مرتجع، جهاز = مقبوض − مرتجع، والرجوع بجهاز من دفعة كاش ينخصم من الجهاز مو الكاش', async () => {
      const s = await openShift(w.cashiers[0].token, 50000);
      const a = await paid(w, 0);                                                                       // كاش 30,000
      await paid(w, 0, [{ method_id: w.cashMethod, amount: 10000 }, { method_id: w.cardMethod, amount: 20000 }]);   // كاش 10,000 + جهاز 20,000
      const b = await refund(w.cashiers[0].token, a.payment.id, { full_receipt: true, reason: 'تجربة', payout: [{ method_id: w.cardMethod, amount: 30000 }] });
      expect(b.status).toBe(201);
      const c = await paid(w, 0);
      const r2 = await refund(w.cashiers[0].token, c.payment.id, { full_receipt: true, reason: 'تجربة' });              // كاش 30,000 يرجع كاش
      expect(r2.status).toBe(201);
      const closed = await post(w.cashiers[0].token, '/shifts/current/close', closeBody(w, [[w.cashMethod, 90000], [w.cardMethod, 0]]));
      expect(closed.status).toBe(201);
      const d = await detail(w.mgr, s.id);
      const m = Object.fromEntries(d.methods.map((x: any) => [x.method_id, x]));
      expect(m[w.cashMethod]).toMatchObject({ collected: 70000, refunded: 30000, expected: 50000 + 70000 - 30000, counted: 90000 });
      expect(m[w.cardMethod]).toMatchObject({ collected: 20000, refunded: 30000, expected: -10000, counted: 0 });      // النقص بمصدره، ما يتعوض من الكاش
    });
    it('تسكير متزامن 6 مرات: واحد ينجح والباقي 409، وصف واحد للطريقة', async () => {
      const s = await openShift(w.cashiers[1].token, 0);
      const rs = await Promise.all(Array.from({ length: 6 }, () => post(w.cashiers[1].token, '/shifts/current/close', closeBody(w, [[w.cashMethod, 0]]))));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'NO_OPEN_SHIFT')).toHaveLength(5);
      expect(Number((await one(`select count(*)::int as n from shift_method_totals where shift_id = $1`, [s.id])).n)).toBe(1);
    });
    it('بعد التسكير الدفع والاسترجاع يرفضون (لازم شفت مفتوح)', async () => {
      await openShift(w.cashiers[2].token, 0);
      const p = await paid(w, 2);
      expect((await post(w.cashiers[2].token, '/shifts/current/close', closeBody(w, [[w.cashMethod, 30000]]))).status).toBe(201);
      const v = await visit(w);
      expect((await pay(w.cashiers[2].token, { consultation_id: v.consId, tenders: [{ method_id: w.cashMethod, amount: 30000 }] })).body.code).toBe('NO_OPEN_SHIFT');
      expect((await refund(w.cashiers[2].token, p.payment.id, { full_receipt: true, reason: 'تجربة' })).body.code).toBe('NO_OPEN_SHIFT');
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('تأكيد المدير ودخول الكاش للخزنة', () => {
    let w: World; let w2: World;
    beforeAll(async () => { w = await world('SHD'); w2 = await world('SHD2'); await fundSafe(w, 1000000); await fundSafe(w2, 1000000); });
    /** شفت مسكر: فكة 50,000، دفعة كاش 30,000، دفعة 10,000 كاش + 20,000 جهاز. المتوقع: كاش 90,000، جهاز 20,000 */
    async function closedShift(x: World, cashier = 0) {
      const s = await openShift(x.cashiers[cashier].token, 50000);
      await paid(x, cashier);
      await paid(x, cashier, [{ method_id: x.cashMethod, amount: 10000 }, { method_id: x.cardMethod, amount: 20000 }]);
      expect((await post(x.cashiers[cashier].token, '/shifts/current/close', closeBody(x, [[x.cashMethod, 90000], [x.cardMethod, 20000]]))).status).toBe(201);
      return s.id as number;
    }
    const lines = (x: World, cash: number, card: number, notes: { cash?: string; card?: string } = {}) => ({ lines: [{ method_id: x.cashMethod, confirmed: cash, note: notes.cash }, { method_id: x.cardMethod, confirmed: card, note: notes.card }] });

    it('الصلاحيات: المدير والمالك بس، فرع ثاني 404، غير موجود 404، وقبل التسكير 409', async () => {
      const open = await openShift(w.cashiers[0].token, 0);
      expect((await post(w.mgr, `/shifts/${open.id}/confirm`, lines(w, 0, 0))).body.code).toBe('NOT_CLOSED');
      await post(w.cashiers[0].token, '/shifts/current/close', closeBody(w, [[w.cashMethod, 0]]));
      for (const t of [w.cashiers[0].token, doc1, nurse]) expect((await post(t, `/shifts/${open.id}/confirm`, lines(w, 0, 0))).status).toBe(403);
      expect((await post(w2.mgr, `/shifts/${open.id}/confirm`, lines(w, 0, 0))).status).toBe(404);
      expect((await post(w.mgr, '/shifts/99999999/confirm', lines(w, 0, 0))).status).toBe(404);
      expect((await get(w2.mgr, `/shifts/${open.id}`)).status).toBe(404);
      for (const t of [w.cashiers[0].token, doc1, nurse]) { expect((await get(t, `/shifts/${open.id}`)).status).toBe(403); expect((await get(t, '/shifts')).status).toBe(403); }
    });
    it('تأكيد مطابق: الشفت «مؤكد» والكاش المؤكد كله يدخل الخزنة (مو الإلكتروني) بحركة استلام واحدة', async () => {
      const before = await safeBalance(w);
      const id = await closedShift(w);
      expect(await safeBalance(w)).toBe(before - 50000);                                                  // الفكة طلعت
      const r = await post(w.mgr, `/shifts/${id}/confirm`, lines(w, 90000, 20000));
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ status: 'confirmed', confirmed_by: { full_name: expect.any(String) } });
      expect(r.body.methods.map((m: any) => [m.method_id, m.expected, m.confirmed, m.difference])).toEqual([[w.cashMethod, 90000, 90000, 0], [w.cardMethod, 20000, 20000, 0]]);
      expect(await safeBalance(w)).toBe(before - 50000 + 90000);                                          // +90,000 كاش فقط
      expect(await db.query(`select direction, amount::int as amount, kind from safe_movements where shift_id = $1 order by id`, [id]).then((x) => x.rows)).toEqual([{ direction: 'out', amount: 50000, kind: 'shift_float' }, { direction: 'in', amount: 90000, kind: 'shift_handover' }]);
      expect((await db.query(`select 1 from audit_log where action = 'shift.confirm' and entity_id = $1`, [id])).rowCount).toBe(1);
    });
    it('نقص بالكاش وزيادة بالجهاز مع ملاحظة: يدخل الخزنة المؤكد (مو المتوقع) والفرق يظهر بمصدره', async () => {
      const before = await safeBalance(w); const id = await closedShift(w, 1);
      const r = await post(w.mgr, `/shifts/${id}/confirm`, lines(w, 85000, 21000, { cash: 'نقص 5,000 بالدرج', card: 'زيادة بكشف الجهاز' }));
      expect(r.status).toBe(201);
      const m = Object.fromEntries(r.body.methods.map((x: any) => [x.method_id, x]));
      expect(m[w.cashMethod]).toMatchObject({ expected: 90000, counted: 90000, confirmed: 85000, difference: -5000, note: 'نقص 5,000 بالدرج' });
      expect(m[w.cardMethod]).toMatchObject({ expected: 20000, confirmed: 21000, difference: 1000, note: 'زيادة بكشف الجهاز' });
      expect(await safeBalance(w)).toBe(before - 50000 + 85000);                                          // 85,000 مو 90,000، ومو 106,000
      const a = await one(`select after_values from audit_log where action = 'shift.confirm' and entity_id = $1`, [id]);
      expect(a.after_values.differences).toHaveLength(2); expect(a.after_values.cash_to_safe).toBe(85000);
    });
    it('الفرق بدون ملاحظة → 409 NOTE_REQUIRED وما ينكتب شي ولا يدخل للخزنة', async () => {
      const before = await safeBalance(w); const id = await closedShift(w, 2);
      const r = await post(w.mgr, `/shifts/${id}/confirm`, lines(w, 89000, 20000));
      expect(r.status).toBe(409); expect(r.body).toMatchObject({ code: 'NOTE_REQUIRED', method_id: w.cashMethod, expected: 90000, confirmed: 89000 });
      expect((await post(w.mgr, `/shifts/${id}/confirm`, lines(w, 90000, 20000, { card: '   ' }))).status).toBe(201);        // مطابق: ما يحتاج ملاحظة والملاحظة الفاضية تنهمل
      expect(before).toBeGreaterThan(0);
      const id2 = await closedShift(w, 0);
      const bal = await safeBalance(w);
      expect((await post(w.mgr, `/shifts/${id2}/confirm`, lines(w, 90000, 19999))).body.code).toBe('NOTE_REQUIRED');
      expect(await safeBalance(w)).toBe(bal);
      expect((await one(`select status from shifts where id = $1`, [id2])).status).toBe('closed');
      expect(Number((await one(`select count(*)::int as n from shift_method_totals where shift_id = $1 and confirmed is not null`, [id2])).n)).toBe(0);
    });
    it('أسطر ناقصة أو زايدة أو مكررة أو مبالغ سالبة → ما يتأكد', async () => {
      const id = await closedShift(w, 1);
      const bal = await safeBalance(w);
      expect((await post(w.mgr, `/shifts/${id}/confirm`, { lines: [{ method_id: w.cashMethod, confirmed: 90000 }] })).body.code).toBe('LINES_MISMATCH');
      expect((await post(w.mgr, `/shifts/${id}/confirm`, { lines: [{ method_id: w.cashMethod, confirmed: 90000 }, { method_id: w.cardMethod, confirmed: 20000 }, { method_id: w.card2Method, confirmed: 0 }] })).body.code).toBe('LINES_MISMATCH');
      expect((await post(w.mgr, `/shifts/${id}/confirm`, { lines: [{ method_id: w.cashMethod, confirmed: 90000 }, { method_id: w.cashMethod, confirmed: 90000 }] })).body.code).toBe('DUPLICATE_METHOD');
      for (const v of [-1, 1.5, '1']) expect((await post(w.mgr, `/shifts/${id}/confirm`, { lines: [{ method_id: w.cashMethod, confirmed: v }, { method_id: w.cardMethod, confirmed: 20000 }] })).status).toBe(400);
      expect((await post(w.mgr, `/shifts/${id}/confirm`, { lines: [] })).status).toBe(400);
      expect(await safeBalance(w)).toBe(bal);
      expect((await one(`select status from shifts where id = $1`, [id])).status).toBe('closed');
    });
    it('تأكيد مرتين 409، وكاش مؤكد صفر ما يسوي حركة، والمالك يأكد أي فرع', async () => {
      const id = await closedShift(w, 0);
      expect((await post(w.mgr, `/shifts/${id}/confirm`, lines(w, 90000, 20000))).status).toBe(201);
      expect((await post(w.mgr, `/shifts/${id}/confirm`, lines(w, 90000, 20000))).body.code).toBe('ALREADY_CONFIRMED');
      expect((await post(owner, `/shifts/${id}/confirm`, lines(w, 90000, 20000))).status).toBe(409);
      const z = await openShift(w2.cashiers[0].token, 0);
      await post(w2.cashiers[0].token, '/shifts/current/close', closeBody(w2, [[w2.cashMethod, 0]]));
      const before = await safeBalance(w2);
      expect((await post(owner, `/shifts/${z.id}/confirm`, { lines: [{ method_id: w2.cashMethod, confirmed: 0 }] })).status).toBe(201);
      expect(await safeBalance(w2)).toBe(before);
      expect((await db.query(`select 1 from safe_movements where shift_id = $1 and kind = 'shift_handover'`, [z.id])).rowCount).toBe(0);
    });
    it('تأكيد متزامن لنفس الشفت 6 مرات: واحد ينجح وحركة استلام وحدة والخزنة صحيحة', async () => {
      const id = await closedShift(w, 1);
      const before = await safeBalance(w);
      const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => post(i % 2 ? w.mgr : owner, `/shifts/${id}/confirm`, lines(w, 90000, 20000))));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'ALREADY_CONFIRMED')).toHaveLength(5);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(await safeBalance(w)).toBe(before + 90000);
      expect(Number((await one(`select count(*)::int as n from safe_movements where shift_id = $1 and kind = 'shift_handover'`, [id])).n)).toBe(1);
    });
    it('تأكيد 3 شفتات مختلفة بنفس اللحظة: الخزنة = مجموع المؤكد', async () => {
      const ids = [await closedShift(w, 0), await closedShift(w, 1), await closedShift(w, 2)];
      const before = await safeBalance(w);
      const rs = await Promise.all(ids.map((id) => post(w.mgr, `/shifts/${id}/confirm`, lines(w, 90000, 20000))));
      expect(rs.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(await safeBalance(w)).toBe(before + 270000);
    });
    it('قائمة الشفتات: تفلتر بالحالة، والمدير يشوف فرعه بس', async () => {
      const closed = (await get(w.mgr, '/shifts?status=closed')).body;
      expect(closed.every((s: any) => s.status === 'closed' && s.branch_id === w.id)).toBe(true);
      expect((await get(w.mgr, '/shifts?status=confirmed')).body.length).toBeGreaterThan(0);
      expect((await get(w.mgr, '/shifts?status=nope')).status).toBe(400);
      expect((await get(w.mgr, '/shifts?date=x')).status).toBe(400);
      expect((await get(w2.mgr, '/shifts')).body.every((s: any) => s.branch_id === w2.id)).toBe(true);
      expect((await get(w.mgr, `/shifts?date=${today}`)).body.length).toBeGreaterThan(0);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('التسكير مقابل الدفع والاسترجاع بنفس اللحظة', () => {
    let w: World;
    beforeAll(async () => { w = await world('SHR'); await fundSafe(w, 100000000); });
    it('6 دفعات متزامنة مع التسكير (3 مرات): كل وصل انقبل داخل مجاميع الشفت، وغير هيج يرفض NO_OPEN_SHIFT', async () => {
      for (let round = 0; round < 3; round++) {
        const s = await openShift(w.cashiers[0].token, 1000);
        const vs = await Promise.all(Array.from({ length: 6 }, () => visit(w)));
        const [closeRes, ...pays] = await Promise.all([
          post(w.cashiers[0].token, '/shifts/current/close', closeBody(w, [[w.cashMethod, 0]])).then((r) => r),
          ...vs.map((v) => pay(w.cashiers[0].token, { consultation_id: v.consId, tenders: [{ method_id: w.cashMethod, amount: 30000 }] })),
        ]);
        // التسكير بعدّ ثابت قد يرفضه COUNTS_MISMATCH إذا ما كان الكاش ضمن المطلوب: الكاش دائماً مطلوب، فلازم ينجح
        expect(closeRes.status).toBe(201);
        expect(pays.filter((r) => r.status >= 500)).toHaveLength(0);
        expect(pays.every((r) => r.status === 201 || (r.status === 409 && r.body.code === 'NO_OPEN_SHIFT'))).toBe(true);
        const okPays = pays.filter((r) => r.status === 201).length;
        const row = await one(`select collected::int as collected, expected::int as expected from shift_method_totals where shift_id = $1 and method_id = $2`, [s.id, w.cashMethod]);
        const real = await one(`select coalesce(sum(t.amount),0)::int as s, count(distinct p.id)::int as n from payment_tenders t join payments p on p.id = t.payment_id where p.shift_id = $1`, [s.id]);
        expect(row.collected).toBe(real.s);                                                             // ولا وصل فلت من مجموع الشفت
        expect(real.n).toBe(okPays);
        expect(row.expected).toBe(1000 + real.s);
      }
    });
    it('استرجاعات متزامنة مع التسكير (3 مرات): كل استرجاع انحسب بمجاميع شفته أو انرفض', async () => {
      for (let round = 0; round < 3; round++) {
        const s = await openShift(w.cashiers[1].token, 0);
        const ps = []; for (let i = 0; i < 5; i++) ps.push(await paid(w, 1));
        const [closeRes, ...refs] = await Promise.all([
          post(w.cashiers[1].token, '/shifts/current/close', closeBody(w, [[w.cashMethod, 0]])),
          ...ps.map((p) => refund(w.cashiers[1].token, p.payment.id, { full_receipt: true, reason: 'سباق' })),
        ]);
        expect(closeRes.status).toBe(201);
        expect(refs.filter((r) => r.status >= 500)).toHaveLength(0);
        expect(refs.every((r) => r.status === 201 || (r.status === 409 && r.body.code === 'NO_OPEN_SHIFT'))).toBe(true);
        const row = await one(`select collected::int as collected, refunded::int as refunded from shift_method_totals where shift_id = $1 and method_id = $2`, [s.id, w.cashMethod]);
        const real = await one(`select coalesce(sum(rt.amount),0)::int as s from refund_tenders rt join refunds r on r.id = rt.refund_id where r.shift_id = $1`, [s.id]);
        expect(row.collected).toBe(150000);
        expect(row.refunded).toBe(real.s);
        expect(real.s).toBe(refs.filter((r) => r.status === 201).length * 30000);
      }
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('قفل الشفت: التسكير ينتظر العملية الجارية (حتمي، بدون الاعتماد على الحظ)', () => {
    let w: World;
    beforeAll(async () => { w = await world('SHL'); await fundSafe(w, 100000000); });
    /** نمسك قفل عداد الأرقام (receipt/refund) فتوقف العملية بعد ما تاخذ قفل الشفت، ونشغّل التسكير، ونتأكد التسكير ينتظرها وما يفوتها */
    for (const kind of ['receipt', 'refund'] as const) {
      it(`تسكير يوصل أثناء ${kind === 'receipt' ? 'دفع' : 'استرجاع'} جاري: التسكير ينتظر والمجاميع تشمل العملية`, async () => {
        const cashier = w.cashiers[kind === 'receipt' ? 0 : 1];
        const s = await openShift(cashier.token, 0);
        const toRefund = kind === 'refund' ? await paid(w, kind === 'refund' ? 1 : 0) : null;
        const toPay = kind === 'receipt' ? await visit(w) : null;
        const year = Number((await one(`select extract(year from clinic_today())::int as y`)).y);
        await db.query(`insert into number_counters (branch_id, kind, year, last_value) values ($1,$2,$3,0) on conflict do nothing`, [w.id, kind, year]);
        const blocker = await db.connect();
        let released = false;
        const release = async () => { if (released) return; released = true; try { await blocker.query('commit'); } finally { blocker.release(); } };   // دائماً نفك القفل حتى لو فشل التأكيد (وإلا الاختبار يعلق)
        await blocker.query('begin');
        await blocker.query(`select 1 from number_counters where branch_id = $1 and kind = $2 and year = $3 for update`, [w.id, kind, year]);
        const op = kind === 'receipt'
          ? pay(cashier.token, { consultation_id: toPay!.consId, tenders: [{ method_id: w.cashMethod, amount: 30000 }] }).then((r) => r)
          : refund(cashier.token, toRefund!.payment.id, { full_receipt: true, reason: 'قفل' }).then((r) => r);
        await new Promise((r) => setTimeout(r, 400));                                                  // العملية صارت محجوزة عند العداد وماسكة قفل الشفت
        let closeDone = false;
        const closing = post(cashier.token, '/shifts/current/close', closeBody(w, [[w.cashMethod, 0]])).then((r) => { closeDone = true; return r; });
        await new Promise((r) => setTimeout(r, 400));
        const stillWaiting = !closeDone;                                                                // التسكير لازم واقف ينتظر
        await release();
        const [o, c] = await Promise.all([op, closing]);
        expect(stillWaiting).toBe(true);
        expect(o.status).toBe(201);
        expect(c.status).toBe(201);
        const row = await one(`select collected::int as collected, refunded::int as refunded from shift_method_totals where shift_id = $1 and method_id = $2`, [s.id, w.cashMethod]);
        if (kind === 'receipt') expect(row.collected).toBe(30000); else expect(row).toEqual({ collected: 30000, refunded: 30000 });
      });
    }
  });

  // ------------------------------------------------------------------------------------------------
  describe('التسكير الإجباري من المدير (شفت منسي)', () => {
    let w: World; let w2: World;
    beforeAll(async () => { w = await world('SHZ'); w2 = await world('SHZ2'); await fundSafe(w, 10000000); await fundSafe(w2, 1000000); });
    const force = (t: string, id: number, body: object = { reason: 'الكاشير نسي يسكّر' }) => post(t, `/shifts/${id}/force-close`, body);
    it('المدير يسكّر شفت منسي: المتوقع يتحسب، العدّ فاضي، الكاشير ما يقدر يسكّر ولا يدفع، ويقدر يفتح شفت جديد', async () => {
      const s = await openShift(w.cashiers[0].token, 50000);
      await paid(w, 0);
      const r = await force(w.mgr, s.id);
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ id: s.id, status: 'closed', methods: [{ method_id: w.cashMethod, collected: 30000, refunded: 0, expected: 80000, counted: null, confirmed: null }] });
      expect((await db.query(`select 1 from audit_log where action = 'shift.force_close' and entity_id = $1 and reason = 'الكاشير نسي يسكّر'`, [s.id])).rowCount).toBe(1);
      expect((await post(w.cashiers[0].token, '/shifts/current/close', closeBody(w, [[w.cashMethod, 80000]]))).body.code).toBe('NO_OPEN_SHIFT');
      const v = await visit(w);
      expect((await pay(w.cashiers[0].token, { consultation_id: v.consId, tenders: [{ method_id: w.cashMethod, amount: 30000 }] })).body.code).toBe('NO_OPEN_SHIFT');
      await openShift(w.cashiers[0].token, 0);
      await post(w.cashiers[0].token, '/shifts/current/close', closeBody(w, [[w.cashMethod, 0]]));
    });
    it('بعد التسكير الإجباري المدير يأكد اللي استلمه فعلاً: الفرق يحتاج ملاحظة والخزنة تاخذ المؤكد', async () => {
      const s = await openShift(w.cashiers[1].token, 20000);
      await paid(w, 1);
      await force(w.mgr, s.id);
      const before = await safeBalance(w);
      const noNote = await post(w.mgr, `/shifts/${s.id}/confirm`, { lines: [{ method_id: w.cashMethod, confirmed: 45000 }] });
      expect(noNote.body.code).toBe('NOTE_REQUIRED'); expect(noNote.body.expected).toBe(50000);
      const ok = await post(w.mgr, `/shifts/${s.id}/confirm`, { lines: [{ method_id: w.cashMethod, confirmed: 45000, note: 'الكاشير ما سلّم 5,000' }] });
      expect(ok.status).toBe(201);
      expect(ok.body.methods[0]).toMatchObject({ expected: 50000, counted: null, confirmed: 45000, difference: -5000 });
      expect(await safeBalance(w)).toBe(before + 45000);
    });
    it('الصلاحيات: الكاشير والطبيب والممرض 403، فرع ثاني 404، والمالك ينفع، وغير موجود 404', async () => {
      const s = await openShift(w.cashiers[2].token, 0);
      for (const t of [w.cashiers[0].token, w.cashiers[2].token, doc1, nurse]) expect((await force(t, s.id)).status).toBe(403);
      expect((await force(w2.mgr, s.id)).status).toBe(404);
      expect((await force(w.mgr, 99999999)).status).toBe(404);
      expect((await get(w.cashiers[2].token, '/shifts/current')).body.id).toBe(s.id);                    // ما انسكر
      expect((await force(owner, s.id)).status).toBe(201);
    });
    it('السبب إلزامي، وشفت مو مفتوح (مسكر أو مؤكد) 409', async () => {
      const s = await openShift(w.cashiers[0].token, 0);
      expect((await force(w.mgr, s.id, {})).status).toBe(400);
      expect((await force(w.mgr, s.id, { reason: '     ' })).status).toBe(400);
      expect((await get(w.cashiers[0].token, '/shifts/current')).body.id).toBe(s.id);
      await post(w.cashiers[0].token, '/shifts/current/close', closeBody(w, [[w.cashMethod, 0]]));
      expect((await force(w.mgr, s.id)).body.code).toBe('NOT_OPEN');
      await post(w.mgr, `/shifts/${s.id}/confirm`, { lines: [{ method_id: w.cashMethod, confirmed: 0 }] });
      expect((await force(w.mgr, s.id)).body.code).toBe('NOT_OPEN');
    });
    it('4 تسكيرات إجبارية متزامنة: واحد ينجح وصف واحد للطريقة', async () => {
      const s = await openShift(w.cashiers[1].token, 0);
      const rs = await Promise.all([w.mgr, owner, w.mgr, owner].map((t) => force(t, s.id)));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'NOT_OPEN')).toHaveLength(4 - 1);
      expect(Number((await one(`select count(*)::int as n from shift_method_totals where shift_id = $1`, [s.id])).n)).toBe(1);
    });
    it('تسكير الكاشير مع التسكير الإجباري بنفس اللحظة: واحد يفوز، وصفوف الإجماليات متسقة', async () => {
      for (let i = 0; i < 3; i++) {
        const s = await openShift(w.cashiers[2].token, 0);
        const [a, b] = await Promise.all([post(w.cashiers[2].token, '/shifts/current/close', closeBody(w, [[w.cashMethod, 0]])), force(w.mgr, s.id)]);
        expect([a.status, b.status].filter((x) => x >= 500)).toHaveLength(0);
        expect([a.status === 201, b.status === 201].filter(Boolean)).toHaveLength(1);
        const row = await one(`select counted from shift_method_totals where shift_id = $1`, [s.id]);
        expect(row.counted === null).toBe(b.status === 201);                                             // العدّ فاضي بس إذا فاز التسكير الإجباري
      }
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('إلغاء دخول المراجعة المجانية', () => {
    let w: World;
    beforeAll(async () => { w = await world('SHF'); await fundSafe(w, 1000000); await openShift(w.cashiers[0].token, 0); });
    const cancel = (t: string, id: number, body: object = { reason: 'الزبون ما أراد' }) => post(t, `/consultations/${id}/cancel-check-in`, body);
    async function checkedInFollowup() {
      const parent = await paid(w, 0);
      await db.query(`update visits set visit_date = $2 where id = $1`, [parent.visitId, addDays(today, -2)]);
      const f = await visit(w, parent.customer);
      expect((await post(w.cashiers[0].token, `/consultations/${f.consId}/check-in`)).status).toBe(201);
      return { parent, f };
    }
    it('يلغي الكشفية والحجز، المكان يرجع، حدث وسجل، وبعده الزبون يرجع يحجز مراجعة مجانية (الحق رجع)', async () => {
      const { f } = await checkedInFollowup();
      const used = Number((await one(`select used_slots from booking_days where branch_id = $1 and day = $2`, [w.id, today])).used_slots);
      const r = await cancel(w.cashiers[0].token, f.consId);
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ consultation_id: f.consId, status: 'cancelled', visit_status: 'cancelled' });
      expect(await one(`select status from consultations where id = $1`, [f.consId])).toEqual({ status: 'cancelled' });
      expect(await one(`select status, cancel_reason from visits where id = $1`, [f.visitId])).toEqual({ status: 'cancelled', cancel_reason: 'الزبون ما أراد' });
      expect(Number((await one(`select used_slots from booking_days where branch_id = $1 and day = $2`, [w.id, today])).used_slots)).toBe(used - 1);
      expect((await db.query(`select 1 from booking_events where visit_id = $1 and event = 'cancelled' and reason like 'إلغاء دخول مجاني%'`, [f.visitId])).rowCount).toBe(1);
      expect((await db.query(`select 1 from audit_log where action = 'consultation.free_checkin_cancel' and entity_id = $1`, [f.consId])).rowCount).toBe(1);
      expect((await cancel(w.cashiers[0].token, f.consId)).body.code).toBe('NOT_CANCELLABLE');
      const again = await visit(w, f.customer);
      expect((await one(`select kind from consultations where id = $1`, [again.consId])).kind).toBe('free_followup');
    });
    it('بعد دخول الطبيب 409، والكشفية المدفوعة بوصل تنلغي بالاسترجاع بس، والسبب إلزامي، وفرع ثاني 404، والمدير 403', async () => {
      const { f } = await checkedInFollowup();
      const p = await paid(w, 0);
      expect((await cancel(w.cashiers[0].token, p.consId)).body.code).toBe('NOT_FREE_FOLLOWUP');
      expect((await cancel(w.cashiers[0].token, f.consId, {})).status).toBe(400);
      expect((await cancel(w.cashiers[0].token, f.consId, { reason: '      ' })).status).toBe(400);
      expect((await cancel(w.mgr, f.consId)).status).toBe(403);
      expect((await cancel(nurse, f.consId)).status).toBe(403);
      const other = await world('SHF2');
      await openShift(other.cashiers[0].token, 0);
      expect((await cancel(other.cashiers[0].token, f.consId)).status).toBe(404);
      expect((await cancel(w.cashiers[0].token, 99999999)).status).toBe(404);
      await db.query(`update consultations set status = 'with_doctor', entered_at = now() where id = $1`, [f.consId]);
      expect((await cancel(w.cashiers[0].token, f.consId)).body.code).toBe('CONSULTATION_ENTERED');
      expect((await one(`select status from visits where id = $1`, [f.visitId])).status).toBe('arrived');
    });
    it('مراجعة ما انفتحت بعد (بانتظار الدفع) ما تنلغي من هنا (من الحجز)', async () => {
      const parent = await paid(w, 0);
      await db.query(`update visits set visit_date = $2 where id = $1`, [parent.visitId, addDays(today, -2)]);
      const f = await visit(w, parent.customer);
      expect((await cancel(w.cashiers[0].token, f.consId)).body.code).toBe('NOT_CANCELLABLE');
    });
    it('إلغاء متزامن 6 مرات: واحد ينجح والمكان ينزل مرة وحدة', async () => {
      const { f } = await checkedInFollowup();
      const used = Number((await one(`select used_slots from booking_days where branch_id = $1 and day = $2`, [w.id, today])).used_slots);
      const rs = await Promise.all(Array.from({ length: 6 }, () => cancel(w.cashiers[0].token, f.consId)));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(Number((await one(`select used_slots from booking_days where branch_id = $1 and day = $2`, [w.id, today])).used_slots)).toBe(used - 1);
    });
  });

  it('فحص نهائي: رصيد الخزنة = مجموع حركاتها، واستلام الشفت = الكاش المؤكد، وكل شفت مؤكد عنده صفوف مؤكدة', async () => {
    await closeOwnerShifts();
    const bad = await db.query(`select * from v_integrity_checks where check_name in ('safe_balance_mismatch','payment_tenders_sum_mismatch','payment_items_sum_mismatch','points_balance_mismatch','refund_tenders_sum_mismatch')`);
    expect(bad.rows).toEqual([]);
    const handovers = await db.query(
      `select m.shift_id, m.amount::bigint as amount, (select coalesce(sum(t.confirmed),0) from shift_method_totals t where t.shift_id = m.shift_id and t.method_kind = 'cash')::bigint as confirmed
         from safe_movements m where m.kind = 'shift_handover'`);
    for (const h of handovers.rows) expect(Number(h.amount)).toBe(Number(h.confirmed));
    const confirmedNoRows = await db.query(`select id from shifts s where status = 'confirmed' and (select count(*) from shift_method_totals t where t.shift_id = s.id and t.confirmed is null) > 0`);
    expect(confirmedNoRows.rows).toEqual([]);
    const floats = await db.query(`select s.id from shifts s where s.opening_float > 0 and not exists (select 1 from safe_movements m where m.shift_id = s.id and m.kind = 'shift_float' and m.amount = s.opening_float)`);
    expect(floats.rows).toEqual([]);
  });
});
