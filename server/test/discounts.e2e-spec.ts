import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

interface World { id: number; code: string; mgr: string; cash: string; cash2: string; nurse: string; docA: string; docAId: number; cashMethod: number; botox: number }

describe('طلبات الخصم اليدوي', () => {
  let app: INestApplication; let db: Pool; let today: string; let owner: string;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  let phoneSeq = 0; let seq = 0;
  const key = () => `dk-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const cashT = (w: World, amount: number) => ({ tenders: [{ method_id: w.cashMethod, amount }] });

  async function world(code: string): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name) values ($1,$1) returning id`, [code])).rows[0].id);
    await db.query(`insert into safes (branch_id) values ($1)`, [id]);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id); await seedUser(db, `cash_${code}`, 'cashier', id); await seedUser(db, `cashB_${code}`, 'cashier', id);
    await seedUser(db, `nurse_${code}`, 'nurse', id);
    const docAId = await seedUser(db, `docA_${code}`, 'doctor', id);
    await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',100000000,'opening_balance','تجربة',$2)`, [id, mgrId]);
    const [mgr, cash, cash2, nurse, docA] = await Promise.all([`mgr_${code}`, `cash_${code}`, `cashB_${code}`, `nurse_${code}`, `docA_${code}`].map((u) => tokenFor(app, u)));
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
    expect((await post(cash, '/shifts/open', { opening_float: 0 })).status).toBe(201);
    expect((await post(cash2, '/shifts/open', { opening_float: 0 })).status).toBe(201);
    return { id, code, mgr, cash, cash2, nurse, docA, docAId, cashMethod, botox: bs.id };
  }
  async function customer(w: World): Promise<number> {
    phoneSeq++;
    const r = await post(w.cash, '/customers', { full_name: `زبون خصم ${phoneSeq}`, phone: `0797${String(phoneSeq).padStart(7, '0')}` });
    expect(r.status).toBe(201); return r.body.id;
  }
  /** حجز كشفية لزبون (اليوم افتراضياً) بدون دفع */
  async function booking(w: World, cust?: number, date = today) {
    const c = cust ?? (await customer(w));
    const b = await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docAId, date });
    expect(b.status).toBe(201);
    return { customer: c, consId: b.body.consultation.id as number, visitId: b.body.id as number };
  }
  /** زبون بكشفية مدفوعة وخطة بوتكس: الجلسة الأولى محجوزة اليوم (غير مدفوعة) */
  async function withSession(w: World, cc = 2) {
    const v = await booking(w);
    expect((await http().post('/payments/consultation').set(auth(w.cash)).set('Idempotency-Key', key()).send({ consultation_id: v.consId, ...cashT(w, 30000) })).status).toBe(201);
    expect((await post(w.docA, `/consultations/${v.consId}/enter`)).status).toBe(201);
    const pl = await post(w.docA, `/consultations/${v.consId}/plan`, { items: [{ service_id: w.botox, values: { cc }, sessions_count: 2, interval_days: 7, first_session_date: today }] });
    expect(pl.status).toBe(201);
    return { ...v, sid: pl.body.items[0].sessions[0].id as number, second: pl.body.items[0].sessions[1].id as number };
  }
  const request_ = (t: string, body: object) => post(t, '/discount-requests', body);
  const payCons = (t: string, body: object) => http().post('/payments/consultation').set(auth(t)).set('Idempotency-Key', key()).send(body);
  const paySess = (t: string, body: object) => http().post('/payments/sessions').set(auth(t)).set('Idempotency-Key', key()).send(body);
  const status = async (id: number) => (await one(`select status from discount_requests where id = $1`, [id])).status;

  let w: World; let wb: World;
  beforeAll(async () => {
    app = await makeApp(); db = pool();
    today = (await db.query(`select clinic_today()::text as d`)).rows[0].d;
    owner = await tokenFor(app, 'owner');
    w = await world('DRA'); wb = await world('DRB');
  });
  afterAll(async () => { await app.close(); await db.end(); });

  // ------------------------------------------------------------------------------------------------
  describe('المسار الكامل', () => {
    it('كشفية: الكاشير يطلب بدون مبلغ، المدير يدخل المبلغ ويوافق، الكاشير يدفع بالخصم، والطلب يصير «مستخدم» مرة وحدة', async () => {
      const v = await booking(w);
      const r = await request_(w.cash, { consultation_id: v.consId, note: 'زبونة قديمة' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ status: 'pending', amount: null, visit_id: v.visitId, customer: { id: v.customer }, basket: { kind: 'consultation', gross: 30000, note: 'زبونة قديمة' }, decided_by: null });
      expect(r.body.basket.items).toEqual([{ name: 'كشفية', price: 30000, ref: { consultation_id: v.consId } }]);
      expect((await post(w.mgr, `/discount-requests/${r.body.id}/approve`, { amount: 5000, note: 'تخفيض' })).body).toMatchObject({ status: 'approved', amount: 5000, decision_note: 'تخفيض', decided_by: { name: expect.any(String) } });
      const p = await payCons(w.cash, { consultation_id: v.consId, discount_request_id: r.body.id, ...cashT(w, 25000) });
      expect(p.status).toBe(201); expect(p.body).toMatchObject({ gross_amount: 30000, manual_discount: 5000, net_amount: 25000 });
      expect(await status(r.body.id)).toBe('used');
      expect((await get(w.cash, `/discount-requests/${r.body.id}`)).body.status).toBe('used');
      const log = (await db.query(`select action from audit_log where entity_type = 'discount_request' and entity_id = $1 order by id`, [r.body.id])).rows.map((x) => x.action);
      expect(log).toEqual(['discount.request', 'discount.approve']);
    });
    it('جلسات: السلة بأسعار لحظة الطلب، والمدير (أو المالك) يوافق، والدفع بالخصم يوزعه على الجلسات', async () => {
      const x = await withSession(w, 2);
      const r = await request_(w.cash, { session_ids: [x.sid] });
      expect(r.status).toBe(201);
      expect(r.body.basket).toMatchObject({ kind: 'sessions', gross: 100000, items: [{ name: 'بوتكس', price: 100000, ref: { session_id: x.sid } }] });
      expect((await post(owner, `/discount-requests/${r.body.id}/approve`, { amount: 10000 })).body).toMatchObject({ status: 'approved', amount: 10000 });
      const p = await paySess(w.cash, { session_ids: [x.sid], discount_request_id: r.body.id, ...cashT(w, 90000) });
      expect(p.status).toBe(201); expect(p.body).toMatchObject({ gross_amount: 100000, manual_discount: 10000, net_amount: 90000 });
      expect(await status(r.body.id)).toBe('used');
    });
    it('خصم بكامل المبلغ مسموح (وصل صفري)، وأكبر من المبلغ مرفوض مع المبلغ الأصلي', async () => {
      const v = await booking(w);
      const r = await request_(w.cash, { consultation_id: v.consId });
      const big = await post(w.mgr, `/discount-requests/${r.body.id}/approve`, { amount: 30001 });
      expect(big.status).toBe(409); expect(big.body).toMatchObject({ code: 'DISCOUNT_TOO_LARGE', gross: 30000 });
      expect(await status(r.body.id)).toBe('pending');
      expect((await post(w.mgr, `/discount-requests/${r.body.id}/approve`, { amount: 30000 })).body.status).toBe('approved');
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('إنشاء الطلب', () => {
    it('الرفض: لا كشفية ولا جلسات، الاثنين معاً، صلاحيات غير الكاشير، فرع ثاني، غير موجود', async () => {
      const v = await booking(w);
      const x = await withSession(w);
      let r = await request_(w.cash, {});
      expect(r.status).toBe(400); expect(r.body.code).toBe('CONSULTATION_OR_SESSIONS');
      expect((await request_(w.cash, { consultation_id: v.consId, session_ids: [x.sid] })).body.code).toBe('CONSULTATION_OR_SESSIONS');
      expect((await request_(w.cash, { session_ids: [] })).status).toBe(400);
      for (const t of [w.mgr, owner, w.nurse, w.docA]) expect((await request_(t, { consultation_id: v.consId })).status).toBe(403);
      expect((await request_(wb.cash, { consultation_id: v.consId })).status).toBe(404);
      expect((await request_(wb.cash, { session_ids: [x.sid] })).status).toBe(404);
      expect((await request_(w.cash, { consultation_id: 99999999 })).status).toBe(404);
      expect((await http().post('/discount-requests').send({ consultation_id: v.consId })).status).toBe(401);
      expect(Number((await one(`select count(*)::int as n from discount_requests where customer_id = $1`, [v.customer])).n)).toBe(0);
    });
    it('الكشفية المدفوعة أو بيوم ثاني أو المراجعة المجانية ما يطلب لها خصم', async () => {
      const paid = await booking(w);
      expect((await payCons(w.cash, { consultation_id: paid.consId, ...cashT(w, 30000) })).status).toBe(201);
      let r = await request_(w.cash, { consultation_id: paid.consId });
      expect(r.status).toBe(409); expect(r.body.code).toBe('NOT_PAYABLE');
      const future = await booking(w, undefined, new Date(Date.parse(`${today}T00:00:00Z`) + 86400_000 * 3).toISOString().slice(0, 10));
      r = await request_(w.cash, { consultation_id: future.consId });
      expect(r.status).toBe(409); expect(r.body.code).toBe('NOT_TODAY');
      const parent = await booking(w);                                                              // مراجعة مجانية: الكشفية الأصلية مدفوعة قبل يومين
      expect((await payCons(w.cash, { consultation_id: parent.consId, ...cashT(w, 30000) })).status).toBe(201);
      await db.query(`update visits set visit_date = clinic_today() - 2 where id = $1`, [parent.visitId]);
      const fu = await booking(w, parent.customer);
      r = await request_(w.cash, { consultation_id: fu.consId });
      expect(r.status).toBe(409); expect(r.body.code).toBe('FREE_FOLLOWUP');
    });
    it('الجلسات: غير محجوزة (مدفوعة)، يوم ثاني، زبونين مختلفين', async () => {
      const x = await withSession(w); const y = await withSession(w);
      expect((await paySess(w.cash, { session_ids: [x.sid], ...cashT(w, 100000) })).status).toBe(201);
      let r = await request_(w.cash, { session_ids: [x.sid] });
      expect(r.status).toBe(409); expect(r.body.code).toBe('SESSION_NOT_PAYABLE');
      r = await request_(w.cash, { session_ids: [x.second] });                                    // الثانية بعد أسبوع
      expect(r.status).toBe(409);
      r = await request_(w.cash, { session_ids: [y.sid, x.sid] });
      expect(r.status).toBe(400); expect(r.body.code).toBe('MIXED_CUSTOMERS');
      await db.query(`update treatment_sessions set scheduled_date = clinic_today() where id = $1`, [y.second]);   // لعمل حالة زبونين: نستخدم جلسات اليوم
      expect((await request_(w.cash, { session_ids: [y.sid] })).status).toBe(201);
    });
    it('طلب فعال واحد لكل زبون باليوم: المكرر 409 مع رقم الطلب، وبعد الرفض أو الإلغاء يصير طلب جديد', async () => {
      const v = await booking(w);
      const a = await request_(w.cash, { consultation_id: v.consId });
      expect(a.status).toBe(201);
      let dup = await request_(w.cash2, { consultation_id: v.consId });
      expect(dup.status).toBe(409); expect(dup.body).toMatchObject({ code: 'REQUEST_EXISTS', request_id: a.body.id, status: 'pending' });
      expect((await post(w.mgr, `/discount-requests/${a.body.id}/reject`, { note: 'ما أكو مبرر' })).body.status).toBe('rejected');
      const b = await request_(w.cash, { consultation_id: v.consId });
      expect(b.status).toBe(201);
      expect((await post(w.mgr, `/discount-requests/${b.body.id}/approve`, { amount: 1000 })).status).toBe(201);
      dup = await request_(w.cash, { consultation_id: v.consId });
      expect(dup.status).toBe(409); expect(dup.body).toMatchObject({ code: 'REQUEST_EXISTS', status: 'approved' });
      expect((await post(w.cash, `/discount-requests/${b.body.id}/cancel`)).body.status).toBe('cancelled');
      expect((await request_(w.cash, { consultation_id: v.consId })).status).toBe(201);
    });
    it('طلبين متزامنين لنفس الزبون: واحد ينجح (بدون خطأ قاعدة بيانات)', async () => {
      const v = await booking(w);
      const rs = await Promise.all([request_(w.cash, { consultation_id: v.consId }), request_(w.cash2, { consultation_id: v.consId }), request_(w.cash, { consultation_id: v.consId })]);
      expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(Number((await one(`select count(*)::int as n from discount_requests where customer_id = $1`, [v.customer])).n)).toBe(1);
    });
    it('طلب قديم (من أمس) ما انتهى بعد بالقاعدة ما يمنع طلب اليوم الجديد', async () => {
      const v = await booking(w);
      const old = (await request_(w.cash, { consultation_id: v.consId })).body;
      await db.query(`update discount_requests set requested_at = now() - interval '2 days' where id = $1`, [old.id]);
      const n = await request_(w.cash, { consultation_id: v.consId });                              // بدون أي قراءة تنهي القديم أول
      expect(n.status).toBe(201); expect(n.body.id).not.toBe(old.id);
    });
    it('سلة جلستين: المجموع بأسعار الجلسات كلها (مو الأولى بس)', async () => {
      const v = await booking(w);
      expect((await payCons(w.cash, { consultation_id: v.consId, ...cashT(w, 30000) })).status).toBe(201);
      expect((await post(w.docA, `/consultations/${v.consId}/enter`)).status).toBe(201);
      const pl = await post(w.docA, `/consultations/${v.consId}/plan`, { items: [{ service_id: w.botox, values: { cc: 1 }, sessions_count: 2, interval_days: 0, first_session_date: today }] });
      const ids = pl.body.items[0].sessions.map((s: any) => s.id);
      const r = await request_(w.cash, { session_ids: ids });
      expect(r.status).toBe(201); expect(r.body.basket.gross).toBe(100000); expect(r.body.basket.items).toHaveLength(2);
    });
    it('مبلغ السلة صفر: ما ينطلب خصم (NOTHING_TO_DISCOUNT)', async () => {
      const wz = await world('DRZ');
      await db.query(`insert into service_prices (service_id, price, set_by) select id, 0, (select id from users where username = $2) from services where branch_id = $1 and kind = 'consultation'`, [wz.id, 'mgr_DRZ']);
      const v = await booking(wz);
      const r = await request_(wz.cash, { consultation_id: v.consId });
      expect(r.status).toBe(409); expect(r.body.code).toBe('NOTHING_TO_DISCOUNT');
    });
    it('قفل الكشفية (حتمي): إلغاء حجز جاري → الطلب ينتظر ويرفض NOT_PAYABLE', async () => {
      const v = await booking(w);
      const c = await db.connect(); let res: any; let held = true;
      try {
        await c.query('begin'); await c.query(`select 1 from consultations where id = $1 for update`, [v.consId]);
        await c.query(`update consultations set status = 'cancelled' where id = $1`, [v.consId]);
        const p = request_(w.cash, { consultation_id: v.consId }).then((r) => { res = r; });
        await new Promise((r) => setTimeout(r, 400));
        expect(res).toBeUndefined();
        await c.query('commit'); held = false; await p;
      } finally { if (held) await c.query('rollback'); c.release(); }
      expect(res.status).toBe(409); expect(res.body.code).toBe('NOT_PAYABLE');
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('القرار: موافقة ورفض وإلغاء', () => {
    async function pending() { const v = await booking(w); const r = await request_(w.cash, { consultation_id: v.consId }); expect(r.status).toBe(201); return { ...v, id: r.body.id as number }; }
    it('الموافقة: المدير والمالك بس، المبلغ دينار صحيح موجب، فرع ثاني 404، ومرتين NOT_PENDING', async () => {
      const x = await pending();
      for (const t of [w.cash, w.cash2, w.nurse, w.docA]) expect((await post(t, `/discount-requests/${x.id}/approve`, { amount: 1000 })).status).toBe(403);
      expect((await post(wb.mgr, `/discount-requests/${x.id}/approve`, { amount: 1000 })).status).toBe(404);
      for (const amount of [0, -5, 1.5, 'abc', null]) expect((await post(w.mgr, `/discount-requests/${x.id}/approve`, { amount })).status).toBe(400);
      expect((await post(w.mgr, `/discount-requests/${x.id}/approve`, {})).status).toBe(400);
      expect((await post(w.mgr, `/discount-requests/99999999/approve`, { amount: 1000 })).status).toBe(404);
      expect(await status(x.id)).toBe('pending');
      expect((await post(w.mgr, `/discount-requests/${x.id}/approve`, { amount: 2000 })).status).toBe(201);
      const again = await post(owner, `/discount-requests/${x.id}/approve`, { amount: 3000 });
      expect(again.status).toBe(409); expect(again.body.code).toBe('NOT_PENDING');
      expect((await post(w.mgr, `/discount-requests/${x.id}/reject`, { note: 'متأخر' })).body.code).toBe('NOT_PENDING');
      expect(Number((await one(`select amount from discount_requests where id = $1`, [x.id])).amount)).toBe(2000);
    });
    it('الرفض: السبب إلزامي (بعد التقليم)، وبعده ما تصير موافقة', async () => {
      const x = await pending();
      for (const t of [w.cash, w.nurse]) expect((await post(t, `/discount-requests/${x.id}/reject`, { note: 'سبب' })).status).toBe(403);
      expect((await post(w.mgr, `/discount-requests/${x.id}/reject`, {})).status).toBe(400);
      const blank = await post(w.mgr, `/discount-requests/${x.id}/reject`, { note: '     ' });
      expect(blank.status).toBe(400); expect(blank.body.code).toBe('NOTE_REQUIRED');
      expect((await post(wb.mgr, `/discount-requests/${x.id}/reject`, { note: 'سبب' })).status).toBe(404);
      const r = await post(w.mgr, `/discount-requests/${x.id}/reject`, { note: 'سياسة العيادة' });
      expect(r.body).toMatchObject({ status: 'rejected', decision_note: 'سياسة العيادة', amount: null });
      expect((await post(w.mgr, `/discount-requests/${x.id}/approve`, { amount: 1000 })).body.code).toBe('NOT_PENDING');
    });
    it('موافقتين مختلفتين بنفس اللحظة: واحدة تنجح والثانية NOT_PENDING', async () => {
      const x = await pending();
      const rs = await Promise.all([post(w.mgr, `/discount-requests/${x.id}/approve`, { amount: 1000 }), post(owner, `/discount-requests/${x.id}/approve`, { amount: 2000 }), post(w.mgr, `/discount-requests/${x.id}/reject`, { note: 'سباق' })]);
      expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(['approved', 'rejected']).toContain(await status(x.id));
    });
    it('الإلغاء: الكاشير صاحب الطلب (معلّق أو موافق عليه)، غيره 404، المستخدم والملغى ما ينلغي، والملغى ما يندفع به', async () => {
      const x = await pending();
      expect((await post(w.cash2, `/discount-requests/${x.id}/cancel`)).status).toBe(404);
      for (const t of [w.nurse, w.docA]) expect((await post(t, `/discount-requests/${x.id}/cancel`)).status).toBe(403);
      expect((await post(wb.cash, `/discount-requests/${x.id}/cancel`)).status).toBe(404);
      expect((await post(w.mgr, `/discount-requests/${x.id}/approve`, { amount: 1000 })).status).toBe(201);
      expect((await post(w.cash, `/discount-requests/${x.id}/cancel`)).body.status).toBe('cancelled');
      const again = await post(w.cash, `/discount-requests/${x.id}/cancel`);
      expect(again.status).toBe(409); expect(again.body.code).toBe('NOT_CANCELLABLE');
      expect((await payCons(w.cash, { consultation_id: x.consId, discount_request_id: x.id, ...cashT(w, 29000) })).body.code).toBe('DISCOUNT_NOT_USABLE');
      const y = await pending();
      expect((await post(w.mgr, `/discount-requests/${y.id}/approve`, { amount: 1000 })).status).toBe(201);
      expect((await payCons(w.cash, { consultation_id: y.consId, discount_request_id: y.id, ...cashT(w, 29000) })).status).toBe(201);
      expect((await post(w.cash, `/discount-requests/${y.id}/cancel`)).body.code).toBe('NOT_CANCELLABLE');
      expect(await status(y.id)).toBe('used');
      expect((await post(w.mgr, `/discount-requests/${y.id}/cancel`)).status).toBe(409);
    });
    it('الإلغاء والدفع بنفس اللحظة: واحد يفوز بس (الدفع بالخصم أو الإلغاء)', async () => {
      for (let i = 0; i < 3; i++) {
        const x = await pending();
        expect((await post(w.mgr, `/discount-requests/${x.id}/approve`, { amount: 1000 })).status).toBe(201);
        const [c, p] = await Promise.all([post(w.cash, `/discount-requests/${x.id}/cancel`), payCons(w.cash, { consultation_id: x.consId, discount_request_id: x.id, ...cashT(w, 29000) })]);
        expect([c.status, p.status].filter((s) => s >= 500)).toHaveLength(0);
        expect([c.status === 201, p.status === 201].filter(Boolean)).toHaveLength(1);
        expect(await status(x.id)).toBe(p.status === 201 ? 'used' : 'cancelled');
        expect(Number((await one(`select count(*)::int as n from payments where discount_request_id = $1`, [x.id])).n)).toBe(p.status === 201 ? 1 : 0);
      }
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('القوائم والانتهاء', () => {
    it('الكاشير يشوف طلباته بس، والمدير والمالك كل طلبات الفرع، والتصفية بالحالة، وما يتسرب فرع ثاني', async () => {
      const wl = await world('DRL');
      const a = await booking(wl); const b = await booking(wl);
      const ra = (await request_(wl.cash, { consultation_id: a.consId })).body; const rb = (await request_(wl.cash2, { consultation_id: b.consId })).body;
      expect((await post(wl.mgr, `/discount-requests/${rb.id}/approve`, { amount: 500 })).status).toBe(201);
      expect((await get(wl.cash, '/discount-requests')).body.requests.map((r: any) => r.id)).toEqual([ra.id]);
      expect((await get(wl.cash2, '/discount-requests')).body.requests.map((r: any) => r.id)).toEqual([rb.id]);
      expect((await get(wl.mgr, '/discount-requests')).body.requests.map((r: any) => r.id)).toEqual([rb.id, ra.id]);
      expect((await get(wl.mgr, '/discount-requests?status=pending')).body.requests.map((r: any) => r.id)).toEqual([ra.id]);
      expect((await get(wl.mgr, '/discount-requests?status=approved')).body.requests.map((r: any) => r.id)).toEqual([rb.id]);
      expect((await get(wl.mgr, '/discount-requests?status=zzz')).status).toBe(400);
      expect((await get(owner, `/discount-requests?branch_id=${wl.id}`)).body.requests).toHaveLength(2);
      expect((await get(wb.mgr, '/discount-requests')).body.requests.map((r: any) => r.id)).not.toContain(ra.id);
      expect((await get(wl.cash, `/discount-requests/${rb.id}`)).status).toBe(404);              // طلب كاشير ثاني
      expect((await get(wb.mgr, `/discount-requests/${ra.id}`)).status).toBe(404);
      expect((await get(wl.mgr, `/discount-requests/${ra.id}`)).status).toBe(200);
      for (const t of [wl.nurse, wl.docA]) expect((await get(t, '/discount-requests')).status).toBe(403);
    });
    it('طلب من يوم سابق ينتهي: يظهر «منتهي»، الموافقة REQUEST_EXPIRED، والدفع به مرفوض، وبعده يصير طلب جديد', async () => {
      const v = await booking(w);
      const r = (await request_(w.cash, { consultation_id: v.consId })).body;
      await db.query(`update discount_requests set requested_at = now() - interval '2 days' where id = $1`, [r.id]);
      const ap = await post(w.mgr, `/discount-requests/${r.id}/approve`, { amount: 1000 });
      expect(ap.status).toBe(409); expect(ap.body.code).toBe('REQUEST_EXPIRED');
      expect((await get(w.mgr, '/discount-requests?status=expired')).body.requests.map((x: any) => x.id)).toContain(r.id);   // القائمة تنهي القديم أول
      expect((await get(w.cash, `/discount-requests/${r.id}`)).body.status).toBe('expired');
      expect((await request_(w.cash, { consultation_id: v.consId })).status).toBe(201);        // الطلب القديم ما يمنع طلب اليوم
      // موافق عليه بالأمس: الدفع به مرفوض
      const v2 = await booking(w);
      const r2 = (await request_(w.cash, { consultation_id: v2.consId })).body;
      expect((await post(w.mgr, `/discount-requests/${r2.id}/approve`, { amount: 1000 })).status).toBe(201);
      await db.query(`update discount_requests set requested_at = now() - interval '2 days' where id = $1`, [r2.id]);
      const p = await payCons(w.cash, { consultation_id: v2.consId, discount_request_id: r2.id, ...cashT(w, 29000) });
      expect(p.status).toBe(409); expect(p.body.code).toBe('DISCOUNT_NOT_USABLE');
      expect(await status(r2.id)).toBe('approved');
      const c = await post(w.cash, `/discount-requests/${r2.id}/cancel`);
      expect(c.status).toBe(409); expect(c.body.code).toBe('REQUEST_EXPIRED');
      expect((await get(w.cash, `/discount-requests/${r2.id}`)).body.status).toBe('expired');
    });
  });
});
