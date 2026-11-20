import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { RatingsService } from '../src/nurse/ratings.service';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

interface World { id: number; code: string; mgr: string; mgrId: number; cash: string; nurse: string; nurseId: number; docA: string; docAId: number; cashMethod: number }
interface Svc { id: number; mat: number }

describe('الممرض: «اكتملت» والخصم FIFO والتراجع والتقييم', () => {
  let app: INestApplication; let db: Pool; let today: string; let owner: string; let ratings: RatingsService;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  let phoneSeq = 0; let seq = 0;
  const key = () => `nk-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const cashT = (w: World, amount: number) => ({ tenders: [{ method_id: w.cashMethod, amount }] });

  async function world(code: string): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name) values ($1,$1) returning id`, [code])).rows[0].id);
    await db.query(`insert into safes (branch_id) values ($1)`, [id]);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id); await seedUser(db, `cash_${code}`, 'cashier', id);
    const nurseId = await seedUser(db, `nurse_${code}`, 'nurse', id);
    const docAId = await seedUser(db, `docA_${code}`, 'doctor', id);
    await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',100000000,'opening_balance','تجربة',$2)`, [id, mgrId]);
    const [mgr, cash, nurse, docA] = await Promise.all([`mgr_${code}`, `cash_${code}`, `nurse_${code}`, `docA_${code}`].map((u) => tokenFor(app, u)));
    expect((await put(mgr, `/schedule/doctors/${docAId}/weekly`, { days: [1, 2, 3, 4, 5, 6, 7].map((x) => ({ weekday: x, start_time: '09:00', end_time: '13:00' })), effective_from: today })).status).toBe(200);
    const cur = (await get(mgr, '/settings')).body.settings.find((s: any) => s.key === 'booking.daily_limit');
    expect((await put(mgr, '/settings/booking.daily_limit', { value: 1000, expected_version: cur.version })).status).toBe(200);
    const cs = Number((await db.query(`insert into services (branch_id, name_ar, kind, pricing_model, is_active) values ($1,'كشفية','consultation','fixed',true) returning id`, [id])).rows[0].id);
    await db.query(`insert into service_prices (service_id, price, set_by) values ($1,30000,$2)`, [cs, mgrId]);
    const cashMethod = Number((await db.query(`insert into payment_methods (branch_id, name_ar, kind, sort_order) values ($1,'كاش','cash',0) returning id`, [id])).rows[0].id);
    expect((await post(cash, '/shifts/open', { opening_float: 0 })).status).toBe(201);
    return { id, code, mgr, mgrId, cash, nurse, nurseId, docA, docAId, cashMethod };
  }
  /** خدمة بوتكس جديدة بمادتها (50,000 للـ cc) */
  async function newSvc(w: World, name = `بوتكس ${++seq}`): Promise<Svc> {
    const mat = Number((await db.query(`insert into materials (branch_id, name, base_unit, pack_unit) values ($1,$2,'cc','كرتون') returning id`, [w.id, `مادة ${name}`])).rows[0].id);
    const bs = (await post(w.mgr, '/services', { name_ar: name, pricing_model: 'per_unit', price: 50000 })).body;
    const bf = (await post(w.mgr, `/services/${bs.id}/fields`, { field_key: 'cc', label_ar: 'كم cc', field_type: 'number', unit_label: 'cc', pricing_role: 'quantity', is_required: true })).body.fields[0];
    expect((await put(w.mgr, `/services/${bs.id}/materials`, { items: [{ material_id: mat, formula: 'per_field_value', field_id: bf.id, factor: '1' }] })).status).toBe(200);
    expect((await post(w.mgr, `/services/${bs.id}/activate`)).status).toBe(200);
    return { id: bs.id, mat };
  }
  async function fixedSvc(w: World): Promise<number> {
    const fx = (await post(w.mgr, '/services', { name_ar: `تنظيف ${++seq}`, pricing_model: 'fixed', price: 40000 })).body;
    expect((await post(w.mgr, `/services/${fx.id}/activate`)).status).toBe(200); return fx.id;
  }
  async function customer(w: World): Promise<number> {
    phoneSeq++;
    const r = await post(w.cash, '/customers', { full_name: `زبون ممرض ${phoneSeq}`, phone: `0796${String(phoneSeq).padStart(7, '0')}` });
    expect(r.status).toBe(201); return r.body.id;
  }
  /** دفعة مخزون: تاريخ الانتهاء بعد (أيام) من اليوم؛ تنضاف بحركة افتتاحية */
  async function batch(w: World, mat: number, qty: number, cost: number, days: number): Promise<number> {
    const b = Number((await db.query(`insert into material_batches (branch_id, material_id, source, received_on, expiry_date, unit_cost, qty_initial, qty_on_hand) values ($1,$2,'opening',clinic_today(),clinic_today() + $3::int,$4,$5,0) returning id`, [w.id, mat, days, cost, qty])).rows[0].id);
    await db.query(`insert into stock_movements (branch_id, material_id, batch_id, movement_type, qty_delta, unit_cost, cost_amount) values ($1,$2,$3,'opening',$4,$5,$6)`, [w.id, mat, b, String(qty), cost, qty * cost]);
    return b;
  }
  /** زبون عنده جلسة بوتكس مدفوعة اليوم بكمية cc (الجلسة الأولى بزيارة الكشفية) */
  async function paidSession(w: World, svc: Svc, cc: number, cust?: number, amount = Math.round(cc * 50000)) {
    const c = cust ?? (await customer(w));
    const b = await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docAId, date: today });
    expect(b.status).toBe(201);
    expect((await http().post('/payments/consultation').set(auth(w.cash)).set('Idempotency-Key', key()).send({ consultation_id: b.body.consultation.id, ...cashT(w, 30000) })).status).toBe(201);
    expect((await post(w.docA, `/consultations/${b.body.consultation.id}/enter`)).status).toBe(201);
    const pl = await post(w.docA, `/consultations/${b.body.consultation.id}/plan`, { items: [{ service_id: svc.id, values: { cc }, sessions_count: 2, interval_days: 7, first_session_date: today }] });
    expect(pl.status).toBe(201);
    const sessions = pl.body.items[0].sessions;
    const pr = await http().post('/payments/sessions').set(auth(w.cash)).set('Idempotency-Key', key()).send({ session_ids: [sessions[0].id], ...cashT(w, amount) });
    if (pr.status !== 201) throw new Error(JSON.stringify(pr.body));
    return { sid: sessions[0].id as number, second: sessions[1].id as number, paymentId: pr.body.id as number, customer: c, visitId: b.body.id as number };
  }
  const complete = (t: string, sid: number) => post(t, `/sessions/${sid}/complete`);
  const moves = async (sid: number) => (await db.query(`select id::int as id, movement_type, batch_id::int as b, qty_delta::float as q, unit_cost::float as c, cost_amount::int as a, reverses_movement_id::int as rv, note from stock_movements where treatment_session_id = $1 order by id`, [sid])).rows;
  const stock = async (mat: number) => { const r = await one(`select on_hand::float as on_hand, reserved::float as reserved, available::float as available, is_negative from v_material_stock where material_id = $1`, [mat]); return { onHand: Number(r.on_hand), reserved: Number(r.reserved), available: Number(r.available), negative: r.is_negative as boolean }; };
  const bq = async (id: number) => Number((await one(`select qty_on_hand::float as q from material_batches where id = $1`, [id])).q);
  const sess = async (sid: number) => one(`select status, completed_at, completed_by::int as completed_by from treatment_sessions where id = $1`, [sid]);
  const refund = (t: string, pid: number, body: object) => http().post(`/payments/${pid}/refund`).set(auth(t)).set('Idempotency-Key', key()).send(body);
  async function holdSession(sid: number, ...mutate: string[]) {
    const c = await db.connect(); let done = false;
    await c.query('begin'); await c.query(`select 1 from treatment_sessions where id = $1 for update`, [sid]);
    for (const m of mutate) await c.query(m, [sid]);
    return { release: async () => { if (done) return; done = true; try { await c.query('commit'); } finally { c.release(); } } };
  }

  let w: World; let wb: World;
  beforeAll(async () => {
    app = await makeApp(); db = pool(); ratings = app.get(RatingsService);
    today = (await db.query(`select clinic_today()::text as d`)).rows[0].d;
    owner = await tokenFor(app, 'owner');
    w = await world('NRA'); wb = await world('NRB');
  });
  afterAll(async () => { await app.close(); await db.end(); });

  // ------------------------------------------------------------------------------------------------
  describe('قائمة الممرض', () => {
    it('جلسات اليوم المدفوعة فقط، مع التنبيه الصحي والمواد المخططة، وبفرعه بس، وما تظهر المكتملة', async () => {
      const svc = await newSvc(w); await batch(w, svc.mat, 10, 1000, 100);
      const a = await paidSession(w, svc, 2);
      const alert = await db.query(`insert into customer_health (customer_id, recorded_by, allergies, pregnancy, chronic_conditions) values ($1,$2,'حساسية بنسلين','yes','سكري') returning id`, [a.customer, w.docAId]);
      expect(alert.rowCount).toBe(1);
      const b = await paidSession(w, svc, 1);                                       // بدون معلومات صحية
      const q = await get(w.nurse, '/nurse/queue');
      expect(q.status).toBe(200);
      expect(q.body.date).toBe(today);
      const ids = q.body.sessions.map((s: any) => s.session_id);
      expect(ids).toEqual(expect.arrayContaining([a.sid, b.sid]));
      expect(ids).not.toContain(a.second);                                           // الثانية بعد أسبوع وغير مدفوعة
      const sa = q.body.sessions.find((s: any) => s.session_id === a.sid);
      expect(sa).toMatchObject({ seq_no: 1, of: 2, has_health_alert: true, customer: { id: a.customer }, health: { allergies: 'حساسية بنسلين', pregnancy: 'yes', chronic_conditions: 'سكري' } });
      expect(sa.planned_materials).toEqual([{ material_id: svc.mat, name: expect.any(String), unit: 'cc', qty: 2 }]);
      expect(q.body.sessions.find((s: any) => s.session_id === b.sid)).toMatchObject({ has_health_alert: false, health: null });
      expect(q.body.sessions.every((s: any) => typeof s.visit_seq_no === 'number')).toBe(true);
      expect((await get(wb.nurse, '/nurse/queue')).body.sessions.map((s: any) => s.session_id)).not.toContain(a.sid);   // فرع ثاني
      expect((await complete(w.nurse, a.sid)).status).toBe(201);
      expect((await get(w.nurse, '/nurse/queue')).body.sessions.map((s: any) => s.session_id)).not.toContain(a.sid);
    });
    it('كل عامل صحي لحاله يشعل التنبيه (حمل، حساسية، مزمن، أدوية)، والملاحظات وحدها ما تشعله، و«لا/غير معروف» ما تشعل', async () => {
      const svc = await newSvc(w); await batch(w, svc.mat, 50, 1000, 100);
      const cases: [string, Record<string, string>, boolean][] = [
        ['pregnancy', { pregnancy: 'yes' }, true], ['allergies', { allergies: 'غبار' }, true], ['chronic', { chronic_conditions: 'ضغط' }, true], ['meds', { medications: 'اسبرين' }, true],
        ['notes only', { notes: 'ملاحظة' }, false], ['no pregnancy', { pregnancy: 'no' }, false], ['unknown', { pregnancy: 'unknown' }, false], ['blank allergies', { allergies: '   ' }, false],
      ];
      const sids: [number, boolean, string][] = [];
      for (const [name, h, expected] of cases) {
        const a = await paidSession(w, svc, 1);
        await db.query(`insert into customer_health (customer_id, recorded_by, allergies, pregnancy, chronic_conditions, medications, notes) values ($1,$2,$3,$4,$5,$6,$7)`,
          [a.customer, w.docAId, h.allergies ?? null, h.pregnancy ?? 'unknown', h.chronic_conditions ?? null, h.medications ?? null, h.notes ?? null]);
        sids.push([a.sid, expected, name]);
      }
      const q = (await get(w.nurse, '/nurse/queue')).body.sessions;
      for (const [sid, expected, name] of sids) expect([name, q.find((s: any) => s.session_id === sid).has_health_alert]).toEqual([name, expected]);
    });
    it('آخر سجل صحي هو المعتمد (التحديث يلغي تنبيه قديم)', async () => {
      const svc = await newSvc(w); await batch(w, svc.mat, 50, 1000, 100);
      const a = await paidSession(w, svc, 1);
      await db.query(`insert into customer_health (customer_id, recorded_by, allergies) values ($1,$2,'قديمة')`, [a.customer, w.docAId]);
      await db.query(`insert into customer_health (customer_id, recorded_by, allergies) values ($1,$2,null)`, [a.customer, w.docAId]);
      expect((await get(w.nurse, '/nurse/queue')).body.sessions.find((s: any) => s.session_id === a.sid)).toMatchObject({ has_health_alert: false });
    });
    it('الجلسة المدفوعة المنقولة ليوم ثاني ما تظهر اليوم، والصلاحيات: الممرض بس', async () => {
      const svc = await newSvc(w); await batch(w, svc.mat, 10, 1000, 100);
      const a = await paidSession(w, svc, 1);
      await db.query(`update treatment_sessions set scheduled_date = clinic_today() + 3 where id = $1`, [a.sid]);
      expect((await get(w.nurse, '/nurse/queue')).body.sessions.map((s: any) => s.session_id)).not.toContain(a.sid);
      for (const t of [w.cash, w.mgr, w.docA, owner]) expect((await get(t, '/nurse/queue')).status).toBe(403);
      expect((await http().get('/nurse/queue')).status).toBe(401);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('«اكتملت» والخصم التلقائي FIFO', () => {
    it('الخصم من الأقرب انتهاءً أول (حتى لو انضافت متأخرة)، والكلفة من الدفعة، والمحجوز يتحرر، وطلب التقييم بدون اسم العلاج', async () => {
      const svc = await newSvc(w, 'بوتكس سري'); const b1 = await batch(w, svc.mat, 3, 1000, 60); const b2 = await batch(w, svc.mat, 2, 2000, 10);
      const a = await paidSession(w, svc, 4);
      expect(await stock(svc.mat)).toMatchObject({ onHand: 5, reserved: 4, available: 1 });
      const r = await complete(w.nurse, a.sid);
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ session_id: a.sid, status: 'completed', cost_amount: 6000, shortages: [] });
      expect(r.body.consumed).toEqual([{ material_id: svc.mat, qty: 4, cost_amount: 6000 }]);
      expect((await moves(a.sid)).map((m) => [m.movement_type, m.b, m.q, m.c, m.a])).toEqual([['consume', b2, -2, 2000, -4000], ['consume', b1, -2, 1000, -2000]]);
      expect([await bq(b1), await bq(b2)]).toEqual([1, 0]);
      expect(await sess(a.sid)).toMatchObject({ status: 'completed', completed_by: w.nurseId });
      expect((await sess(a.sid)).completed_at).not.toBeNull();
      expect(await stock(svc.mat)).toMatchObject({ onHand: 1, reserved: 0, available: 1 });             // المحجوز تحرر لأن الجلسة ما عادت «مدفوعة»
      expect(Number((await one(`select count(*)::int as n from session_material_needs where treatment_session_id = $1`, [a.sid])).n)).toBe(1);   // السجل يبقى (للتراجع)
      const n = (await db.query(`select kind, title, body, data, status, customer_id::int as c from notifications where treatment_session_id = $1`, [a.sid])).rows;
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({ kind: 'rating_request', status: 'pending', c: a.customer, data: { session_id: a.sid } });
      expect(`${n[0].title} ${n[0].body}`).not.toContain('بوتكس');
      expect(`${n[0].title} ${n[0].body}`).not.toContain('سري');
      expect((await one(`select count(*)::int as n from audit_log where action = 'session.complete' and entity_id = $1`, [a.sid])).n).toBe(1);
    });
    it('الدفعة المنتهية تنستبعد: الخصم يروح للصالحة، وما تنلمس المنتهية', async () => {
      const svc = await newSvc(w); const exp = await batch(w, svc.mat, 5, 500, 5); const ok = await batch(w, svc.mat, 5, 900, 50);
      await db.query(`update material_batches set expiry_date = clinic_today() - 1 where id = $1`, [exp]);
      const a = await paidSession(w, svc, 2);
      expect((await complete(w.nurse, a.sid)).status).toBe(201);
      expect((await moves(a.sid)).map((m) => [m.b, m.q, m.a])).toEqual([[ok, -2, -1800]]);
      expect([await bq(exp), await bq(ok)]).toEqual([5, 3]);
    });
    it('ما تكفي الدفعات: ما يمنع. الجزء الناقص بحركة بدون دفعة بآخر سعر شراء، والمخزون سالب، ويطلع بتنبيهات المدير', async () => {
      const svc = await newSvc(w); const b1 = await batch(w, svc.mat, 1.5, 1000, 30);
      await db.query(`update materials set last_unit_cost = 1200 where id = $1`, [svc.mat]);
      const a = await paidSession(w, svc, 4);
      const r = await complete(w.nurse, a.sid);
      expect(r.status).toBe(201);
      expect(r.body.shortages).toEqual([{ material_id: svc.mat, qty: 2.5 }]);
      expect(r.body.cost_amount).toBe(1500 + 3000);
      expect((await moves(a.sid)).map((m) => [m.b, m.q, m.c, m.a])).toEqual([[b1, -1.5, 1000, -1500], [null, -2.5, 1200, -3000]]);
      expect(await bq(b1)).toBe(0);
      expect(await stock(svc.mat)).toMatchObject({ onHand: -2.5, negative: true });
      const al = await get(w.mgr, '/stock/alerts');
      expect(al.body.negative.map((x: any) => [x.material.id, x.on_hand])).toContainEqual([svc.mat, -2.5]);
      expect((await sess(a.sid)).status).toBe('completed');
    });
    it('كل الدفعات منتهية وما أكو آخر سعر: الكلفة صفر وتتسجل سالب كامل', async () => {
      const svc = await newSvc(w); const e = await batch(w, svc.mat, 9, 700, 5);
      await db.query(`update material_batches set expiry_date = clinic_today() - 3 where id = $1`, [e]);
      const a = await paidSession(w, svc, 1);
      const r = await complete(w.nurse, a.sid);
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ cost_amount: 0, shortages: [{ material_id: svc.mat, qty: 1 }] });
      expect((await moves(a.sid)).map((m) => [m.b, m.q, m.c, m.a])).toEqual([[null, -1, 0, 0]]);
      expect(await bq(e)).toBe(9);
    });
    it('كسور الكمية والكلفة: 0.333 cc × 1,500 يتقرب بالدينار، والدفعات بأعشار ما تضيع', async () => {
      const svc = await newSvc(w); const b1 = await batch(w, svc.mat, 0.2, 1500, 20); const b2 = await batch(w, svc.mat, 5, 1500, 40);
      const a = await paidSession(w, svc, 0.333, undefined, 16500);       // التقريب للأسفل لأقرب 250
      const r = await complete(w.nurse, a.sid);
      expect(r.status).toBe(201);
      expect((await moves(a.sid)).map((m) => [m.b, m.q, m.a])).toEqual([[b1, -0.2, -300], [b2, -0.133, -200]]);   // 0.133×1500 = 199.5 → 200
      expect([await bq(b1), await bq(b2)]).toEqual([0, 4.867]);
      expect(r.body.cost_amount).toBe(500);
    });
    it('خدمة بدون مواد: تكتمل بدون حركات مخزون', async () => {
      const fx = await fixedSvc(w);
      const c = await customer(w);
      const b = await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docAId, date: today });
      await http().post('/payments/consultation').set(auth(w.cash)).set('Idempotency-Key', key()).send({ consultation_id: b.body.consultation.id, ...cashT(w, 30000) });
      await post(w.docA, `/consultations/${b.body.consultation.id}/enter`);
      const pl = await post(w.docA, `/consultations/${b.body.consultation.id}/plan`, { items: [{ service_id: fx, sessions_count: 1, interval_days: 0, first_session_date: today }] });
      const sid = pl.body.items[0].sessions[0].id;
      expect((await http().post('/payments/sessions').set(auth(w.cash)).set('Idempotency-Key', key()).send({ session_ids: [sid], ...cashT(w, 40000) })).status).toBe(201);
      const r = await complete(w.nurse, sid);
      expect(r.status).toBe(201); expect(r.body).toMatchObject({ cost_amount: 0, consumed: [], shortages: [] });
      expect(await moves(sid)).toEqual([]);
    });
    it('الحالات الممنوعة: غير مدفوعة، مؤكدة مسبقاً، مو اليوم، فرع ثاني، غير الممرض، غير موجودة', async () => {
      const svc = await newSvc(w); await batch(w, svc.mat, 20, 1000, 100);
      const a = await paidSession(w, svc, 1);
      const r0 = await complete(w.nurse, a.second);                                                   // الثانية غير مدفوعة (حالتها booked أو awaiting)
      expect(r0.status).toBe(409); expect(r0.body.code).toBe('NOT_PAID');
      for (const t of [w.cash, w.mgr, w.docA, owner]) expect((await complete(t, a.sid)).status).toBe(403);
      expect((await complete(wb.nurse, a.sid)).status).toBe(404);
      expect((await complete(w.nurse, 99999999)).status).toBe(404);
      await db.query(`update treatment_sessions set scheduled_date = clinic_today() - 1 where id = $1`, [a.sid]);
      const r1 = await complete(w.nurse, a.sid);
      expect(r1.status).toBe(409); expect(r1.body).toMatchObject({ code: 'NOT_TODAY', scheduled_date: expect.any(String) });
      await db.query(`update treatment_sessions set scheduled_date = clinic_today() + 1 where id = $1`, [a.sid]);
      expect((await complete(w.nurse, a.sid)).body.code).toBe('NOT_TODAY');
      await db.query(`update treatment_sessions set scheduled_date = clinic_today() where id = $1`, [a.sid]);
      expect((await complete(w.nurse, a.sid)).status).toBe(201);
      const again = await complete(w.nurse, a.sid);
      expect(again.status).toBe(409); expect(again.body.code).toBe('ALREADY_COMPLETED');
      expect(await moves(a.sid)).toHaveLength(1);                                                     // ما تكررت الحركات
      expect((await refund(w.cash, a.paymentId, { full_receipt: true, reason: 'بعد التأكيد' })).body.code).toBe('SESSION_COMPLETED');
    });
    it('ضغطتين بنفس اللحظة على نفس الجلسة: وحدة تنجح والثانية ALREADY_COMPLETED، والخصم مرة وحدة', async () => {
      const svc = await newSvc(w); const b = await batch(w, svc.mat, 10, 1000, 60);
      const a = await paidSession(w, svc, 3);
      const rs = await Promise.all([complete(w.nurse, a.sid), complete(w.nurse, a.sid), complete(w.nurse, a.sid)]);
      expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(rs.filter((r) => r.status === 409).every((r) => r.body.code === 'ALREADY_COMPLETED')).toBe(true);
      expect(await bq(b)).toBe(7); expect(await moves(a.sid)).toHaveLength(1);
      expect(Number((await one(`select count(*)::int as n from notifications where treatment_session_id = $1`, [a.sid])).n)).toBe(1);
    });
    it('جلستين من زبونين تستهلكان نفس المادة بنفس اللحظة: مجموع الخصم صحيح، بدون تشابك، والدفعات ما تنزل تحت صفر', async () => {
      const svc = await newSvc(w); const b1 = await batch(w, svc.mat, 3, 1000, 20); const b2 = await batch(w, svc.mat, 3, 1000, 30);
      const xs = []; for (let i = 0; i < 4; i++) xs.push(await paidSession(w, svc, 2));
      const rs = await Promise.all(xs.map((x) => complete(w.nurse, x.sid)));
      expect(rs.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      expect(await stock(svc.mat)).toMatchObject({ onHand: -2, negative: true });                    // 8 مطلوب من 6
      expect([await bq(b1), await bq(b2)]).toEqual([0, 0]);
      const neg = Number((await one(`select coalesce(sum(-qty_delta),0)::float as q from stock_movements where material_id = $1 and movement_type = 'consume' and batch_id is null`, [svc.mat])).q);
      expect(neg).toBe(2);
    });
    it('الاسترجاع والتأكيد بنفس اللحظة: واحد بس يفوز، والحالة والمخزون والوصل متسقين (3 جولات)', async () => {
      const svc = await newSvc(w); const b = await batch(w, svc.mat, 50, 1000, 90);
      for (let i = 0; i < 3; i++) {
        const a = await paidSession(w, svc, 1);
        const [c, r] = await Promise.all([complete(w.nurse, a.sid), refund(w.cash, a.paymentId, { full_receipt: true, reason: 'سباق' })]);
        expect([c.status, r.status].filter((s) => s >= 500)).toHaveLength(0);
        expect([c.status === 201, r.status === 201].filter(Boolean)).toHaveLength(1);
        const m = await moves(a.sid);
        if (c.status === 201) { expect((await sess(a.sid)).status).toBe('completed'); expect(m).toHaveLength(1); expect(r.body.code).toBe('SESSION_COMPLETED'); expect((await one(`select status from payments where id = $1`, [a.paymentId])).status).toBe('paid'); }
        else { expect((await sess(a.sid)).status).toBe('awaiting_booking'); expect(m).toEqual([]); expect(c.body.code).toBe('NOT_PAID'); expect((await one(`select status from payments where id = $1`, [a.paymentId])).status).toBe('refunded'); }
      }
      expect(await bq(b)).toBeGreaterThan(46);
    });
    it('قفل الجلسة (حتمي): استرجاع جاري → التأكيد ينتظر ويرفض NOT_PAID بدون أي خصم', async () => {
      const svc = await newSvc(w); const b = await batch(w, svc.mat, 10, 1000, 60);
      const a = await paidSession(w, svc, 2);
      const hold = await holdSession(a.sid, `update treatment_sessions set status = 'awaiting_booking', visit_id = null, scheduled_date = null where id = $1`, `update payment_items set status = 'refunded' where session_id = $1`);   // يحاكي استرجاع كامل
      let res: any; let held = true;
      try {
        const p = complete(w.nurse, a.sid).then((r) => { res = r; return r; });
        await new Promise((r) => setTimeout(r, 400));
        expect(res).toBeUndefined();                                                                  // ينتظر القفل فعلاً
        await hold.release(); held = false; await p;
      } finally { if (held) await hold.release(); }
      expect(res.status).toBe(409); expect(res.body.code).toBe('NOT_PAID');
      expect(await moves(a.sid)).toEqual([]); expect(await bq(b)).toBe(10);
    });
    it('قفل الجلسة (حتمي): تأكيد جاري من جهة ثانية → ينتظر ويرفض ALREADY_COMPLETED بدون حركات إضافية', async () => {
      const svc = await newSvc(w); const b = await batch(w, svc.mat, 10, 1000, 60);
      const a = await paidSession(w, svc, 2);
      const hold = await holdSession(a.sid, `update treatment_sessions set status = 'completed', completed_at = now(), completed_by = ${w.nurseId} where id = $1`);
      let res: any; let held = true;
      try {
        const p = complete(w.nurse, a.sid).then((r) => { res = r; return r; });
        await new Promise((r) => setTimeout(r, 400));
        await hold.release(); held = false; await p;
      } finally { if (held) await hold.release(); }
      expect(res.status).toBe(409); expect(res.body.code).toBe('ALREADY_COMPLETED');
      expect(await moves(a.sid)).toEqual([]); expect(await bq(b)).toBe(10);
    });
    it('قفل المادة (حتمي): عملية على المادة جارية (مثل تالف) → التأكيد ينتظرها ويقرأ الدفعات بعدها (ما يخصم من كمية قديمة)', async () => {
      const svc = await newSvc(w); const b = await batch(w, svc.mat, 5, 1000, 60); const b2 = await batch(w, svc.mat, 5, 1000, 90);
      const a = await paidSession(w, svc, 4);
      const c = await db.connect(); let res: any; let held = true;
      try {
        await c.query('begin');
        await c.query(`select 1 from materials where id = $1 for update`, [svc.mat]);
        await c.query(`insert into stock_movements (branch_id, material_id, batch_id, movement_type, qty_delta, unit_cost, cost_amount) values ($1,$2,$3,'count_adjust',-4,1000,-4000)`, [w.id, svc.mat, b]);
        const p = complete(w.nurse, a.sid).then((r) => { res = r; return r; });
        await new Promise((r) => setTimeout(r, 400));
        expect(res).toBeUndefined();
        await c.query('commit'); held = false; await p;
      } finally { if (held) await c.query('rollback'); c.release(); }
      expect(res.status).toBe(201);
      expect((await moves(a.sid)).map((m) => [m.b, m.q])).toEqual([[b, -1], [b2, -3]]);              // الدفعة الأولى صارت 1 بعد النقص
      expect([await bq(b), await bq(b2)]).toEqual([0, 2]);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('استهلاك إضافي يسجله المدير', () => {
    it('خصم FIFO إضافي على نفس الجلسة المكتملة بكلفة الدفعات، لمادة الخدمة ومادة ثانية، والكلفة الكلية للجلسة تزيد', async () => {
      const svc = await newSvc(w); const b1 = await batch(w, svc.mat, 2, 1000, 20); const b2 = await batch(w, svc.mat, 5, 1500, 40);
      const other = Number((await db.query(`insert into materials (branch_id, name, base_unit, pack_unit) values ($1,'خيط','قطعة','علبة') returning id`, [w.id])).rows[0].id);
      const ob = await batch(w, other, 10, 300, 90);
      const a = await paidSession(w, svc, 1);
      expect((await complete(w.nurse, a.sid)).status).toBe(201);                                          // 1 من b1
      const r = await post(w.mgr, `/sessions/${a.sid}/extra-usage`, { items: [{ material_id: other, qty: 2 }, { material_id: svc.mat, qty: 1.5 }], reason: 'انصرف أكثر من المكتوب' });
      expect(r.status).toBe(201);
      expect(r.body.cost_amount).toBe(1000 + 750 + 600);                                                   // b1 المتبقي 1×1000 + b2 0.5×1500 + 2×300
      expect(r.body.consumed.map((c: any) => [c.material_id, c.qty, c.cost_amount, c.negative_stock]).sort()).toEqual([[svc.mat, 1.5, 1750, false], [other, 2, 600, false]].sort());
      expect([await bq(b1), await bq(b2), await bq(ob)]).toEqual([0, 4.5, 8]);
      const m = await moves(a.sid);
      expect(m).toHaveLength(1 + 2 + 1);
      expect(m.filter((x) => x.note?.startsWith('استهلاك إضافي')).length).toBe(3);
      expect((await one(`select count(*)::int as n from audit_log where action = 'session.extra_usage' and entity_id = $1 and reason = 'انصرف أكثر من المكتوب'`, [a.sid])).n).toBe(1);
    });
    it('يسمح بالسالب (المادة انصرفت فعلاً) بآخر سعر شراء', async () => {
      const svc = await newSvc(w); await batch(w, svc.mat, 1, 1000, 20);
      await db.query(`update materials set last_unit_cost = 800 where id = $1`, [svc.mat]);
      const a = await paidSession(w, svc, 1); expect((await complete(w.nurse, a.sid)).status).toBe(201);
      const r = await post(w.mgr, `/sessions/${a.sid}/extra-usage`, { items: [{ material_id: svc.mat, qty: 2 }], reason: 'زيادة' });
      expect(r.status).toBe(201); expect(r.body.cost_amount).toBe(1600); expect(r.body.consumed[0].negative_stock).toBe(true);
      expect(await stock(svc.mat)).toMatchObject({ onHand: -2, negative: true });
    });
    it('الرفض: غير مكتملة، سبب ناقص، مادة مكررة أو كمية صفر أو فارغ، مادة فرع ثاني، جلسة فرع ثاني، وغير المدير (المالك مسموح)', async () => {
      const svc = await newSvc(w); await batch(w, svc.mat, 10, 1000, 20);
      const foreign = Number((await db.query(`insert into materials (branch_id, name, base_unit, pack_unit) values ($1,'غريبة','cc','علبة') returning id`, [wb.id])).rows[0].id);
      const a = await paidSession(w, svc, 1);
      const item = { material_id: svc.mat, qty: 1 };
      let r = await post(w.mgr, `/sessions/${a.sid}/extra-usage`, { items: [item], reason: 'سبب' });
      expect(r.status).toBe(409); expect(r.body.code).toBe('NOT_COMPLETED');                              // مدفوعة بس
      expect((await complete(w.nurse, a.sid)).status).toBe(201);
      expect((await post(w.mgr, `/sessions/${a.sid}/extra-usage`, { items: [item], reason: '  ' })).status).toBe(400);
      expect((await post(w.mgr, `/sessions/${a.sid}/extra-usage`, { items: [item] })).status).toBe(400);
      r = await post(w.mgr, `/sessions/${a.sid}/extra-usage`, { items: [item], reason: '     ' });
      expect(r.status).toBe(400); expect(r.body.code).toBe('REASON_REQUIRED');
      expect((await post(w.mgr, `/sessions/${a.sid}/extra-usage`, { items: [], reason: 'سبب' })).status).toBe(400);
      expect((await post(w.mgr, `/sessions/${a.sid}/extra-usage`, { items: [{ material_id: svc.mat, qty: 0 }], reason: 'سبب' })).status).toBe(400);
      expect((await post(w.mgr, `/sessions/${a.sid}/extra-usage`, { items: [{ material_id: svc.mat, qty: 0.0001 }], reason: 'سبب' })).status).toBe(400);
      r = await post(w.mgr, `/sessions/${a.sid}/extra-usage`, { items: [item, item], reason: 'سبب' });
      expect(r.status).toBe(400); expect(r.body.code).toBe('DUPLICATE_MATERIAL');
      expect((await post(w.mgr, `/sessions/${a.sid}/extra-usage`, { items: [{ material_id: foreign, qty: 1 }], reason: 'سبب' })).status).toBe(404);
      expect((await post(w.mgr, `/sessions/${a.sid}/extra-usage`, { items: [{ material_id: 99999999, qty: 1 }], reason: 'سبب' })).status).toBe(404);
      expect((await post(wb.mgr, `/sessions/${a.sid}/extra-usage`, { items: [item], reason: 'سبب' })).status).toBe(404);
      for (const t of [w.nurse, w.cash, w.docA]) expect((await post(t, `/sessions/${a.sid}/extra-usage`, { items: [item], reason: 'سبب' })).status).toBe(403);
      expect(await moves(a.sid)).toHaveLength(1);                                                         // ولا رفض ترك حركة
      expect((await post(owner, `/sessions/${a.sid}/extra-usage`, { items: [item], reason: 'المالك يسجل' })).status).toBe(201);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('التراجع عن ضغطة غلط', () => {
    it('المواد ترجع لنفس الدفعات بحركات عكس، الجلسة ترجع «مدفوعة»، المحجوز يرجع، لقطة التأكيد الأصلي تنحفظ، وطلب التقييم ينلغي', async () => {
      const svc = await newSvc(w); const b1 = await batch(w, svc.mat, 3, 1000, 60); const b2 = await batch(w, svc.mat, 2, 2000, 10);
      const a = await paidSession(w, svc, 4);
      expect((await complete(w.nurse, a.sid)).status).toBe(201);
      const done = await sess(a.sid);
      await post(w.mgr, `/sessions/${a.sid}/extra-usage`, { items: [{ material_id: svc.mat, qty: 0.5 }], reason: 'زيادة' });   // 0.5 من b1 (الباقي)
      const before = await moves(a.sid);
      const r = await post(w.mgr, `/sessions/${a.sid}/revert-confirmation`, { reason: 'ضغطة غلط، الجلسة ما تنفذت' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ session_id: a.sid, status: 'paid', returned_movements: 3, returned_cost: 4000 + 2000 + 500 });
      expect(await sess(a.sid)).toEqual({ status: 'paid', completed_at: null, completed_by: null });
      const m = await moves(a.sid);
      expect(m).toHaveLength(6);
      const rev = m.filter((x) => x.movement_type === 'consume_reversal');
      expect(rev.map((x) => [x.b, x.q, x.c, x.a, x.rv])).toEqual(before.map((x) => [x.b, -x.q, x.c, -x.a, x.id]));        // نفس الدفعة ونفس الكلفة بالعكس
      expect([await bq(b1), await bq(b2)]).toEqual([3, 2]);
      expect(m.reduce((t, x) => t + x.q, 0)).toBe(0); expect(m.reduce((t, x) => t + x.a, 0)).toBe(0);
      expect(await stock(svc.mat)).toMatchObject({ onHand: 5, reserved: 4 });                                                // الحجز رجع
      const cr = await one(`select reason, reverted_by::int as by, original_completed_at, original_completed_by::int as ocb from confirmation_reverts where session_id = $1`, [a.sid]);
      expect(cr).toMatchObject({ reason: 'ضغطة غلط، الجلسة ما تنفذت', by: w.mgrId, ocb: w.nurseId });
      expect(new Date(cr.original_completed_at).getTime()).toBe(new Date(done.completed_at).getTime());
      expect((await one(`select status from notifications where treatment_session_id = $1 and kind = 'rating_request'`, [a.sid])).status).toBe('cancelled');
      expect((await one(`select count(*)::int as n from audit_log where action = 'session.revert_confirmation' and entity_id = $1 and reason = 'ضغطة غلط، الجلسة ما تنفذت'`, [a.sid])).n).toBe(1);
    });
    it('بعد التراجع الاسترجاع ممكن (الوصل ينسترجع والجلسة ترجع تنتظر حجز)، والمخزون ما ينلمس', async () => {
      const svc = await newSvc(w); const b = await batch(w, svc.mat, 5, 1000, 60);
      const a = await paidSession(w, svc, 2);
      expect((await complete(w.nurse, a.sid)).status).toBe(201);
      expect((await refund(w.cash, a.paymentId, { full_receipt: true, reason: 'قبل التراجع' })).body.code).toBe('SESSION_COMPLETED');
      expect((await post(owner, `/sessions/${a.sid}/revert-confirmation`, { reason: 'المالك يتراجع' })).status).toBe(201);
      const rf = await refund(w.cash, a.paymentId, { full_receipt: true, reason: 'الزبون ما انفذت جلسته' });
      expect(rf.status).toBe(201);
      expect((await sess(a.sid)).status).toBe('awaiting_booking');
      expect(await bq(b)).toBe(5);
    });
    it('تأكيد من جديد بعد التراجع: يخصم من جديد ويصدر طلب تقييم جديد، والتراجع مرة ثانية ممكن (كل مرة بسجل)', async () => {
      const svc = await newSvc(w); const b = await batch(w, svc.mat, 5, 1000, 60);
      const a = await paidSession(w, svc, 2);
      expect((await complete(w.nurse, a.sid)).status).toBe(201);
      expect((await post(w.mgr, `/sessions/${a.sid}/revert-confirmation`, { reason: 'أول مرة' })).status).toBe(201);
      expect(await bq(b)).toBe(5);
      expect((await complete(w.nurse, a.sid)).status).toBe(201);
      expect(await bq(b)).toBe(3);
      expect((await db.query(`select status from notifications where treatment_session_id = $1 order by id`, [a.sid])).rows.map((x) => x.status)).toEqual(['cancelled', 'pending']);
      expect((await post(w.mgr, `/sessions/${a.sid}/revert-confirmation`, { reason: 'ثاني مرة' })).status).toBe(201);
      expect(await bq(b)).toBe(5);
      const m = await moves(a.sid);
      expect(m.reduce((t, x) => t + x.q, 0)).toBe(0);
      expect(Number((await one(`select count(*)::int as n from confirmation_reverts where session_id = $1`, [a.sid])).n)).toBe(2);
      expect(m.filter((x) => x.movement_type === 'consume_reversal').map((x) => x.rv).sort()).toEqual(m.filter((x) => x.movement_type === 'consume').map((x) => x.id).sort());   // كل حركة انعكست مرة وحدة
    });
    it('الحركة بدون دفعة (سالب) ترجع بدون دفعة وتصلّح الرصيد', async () => {
      const svc = await newSvc(w); const b = await batch(w, svc.mat, 1, 1000, 60);
      await db.query(`update materials set last_unit_cost = 900 where id = $1`, [svc.mat]);
      const a = await paidSession(w, svc, 3);
      expect((await complete(w.nurse, a.sid)).status).toBe(201);
      expect(await stock(svc.mat)).toMatchObject({ onHand: -2, negative: true });
      const r = await post(w.mgr, `/sessions/${a.sid}/revert-confirmation`, { reason: 'غلط' });
      expect(r.status).toBe(201); expect(r.body.returned_cost).toBe(1000 + 1800);
      expect(await stock(svc.mat)).toMatchObject({ onHand: 1, reserved: 3, negative: false });
      expect(await bq(b)).toBe(1);
      expect((await moves(a.sid)).filter((x) => x.movement_type === 'consume_reversal').map((x) => [x.b, x.q])).toEqual([[b, 1], [null, 2]]);
    });
    it('التقييم المقدم قبل التراجع يبقى، وما يصدر طلب تقييم ثاني عند إعادة التأكيد', async () => {
      const svc = await newSvc(w); await batch(w, svc.mat, 9, 1000, 60);
      const a = await paidSession(w, svc, 1);
      expect((await complete(w.nurse, a.sid)).status).toBe(201);
      expect((await ratings.submit(a.customer, a.sid, { stars: 4 })).stars).toBe(4);
      expect((await post(w.mgr, `/sessions/${a.sid}/revert-confirmation`, { reason: 'غلط' })).status).toBe(201);
      expect(Number((await one(`select count(*)::int as n from session_ratings where session_id = $1`, [a.sid])).n)).toBe(1);
      expect((await complete(w.nurse, a.sid)).status).toBe(201);
      expect(Number((await one(`select count(*)::int as n from notifications where treatment_session_id = $1 and status = 'pending'`, [a.sid])).n)).toBe(0);
    });
    it('الرفض: غير مكتملة، تراجع مرتين، سبب ناقص أو قصير، غير المدير/المالك، فرع ثاني، غير موجودة', async () => {
      const svc = await newSvc(w); const b = await batch(w, svc.mat, 9, 1000, 60);
      const a = await paidSession(w, svc, 1);
      let r = await post(w.mgr, `/sessions/${a.sid}/revert-confirmation`, { reason: 'غلط' });
      expect(r.status).toBe(409); expect(r.body.code).toBe('NOT_COMPLETED');
      expect((await complete(w.nurse, a.sid)).status).toBe(201);
      for (const t of [w.nurse, w.cash, w.docA]) expect((await post(t, `/sessions/${a.sid}/revert-confirmation`, { reason: 'غلط' })).status).toBe(403);
      expect((await post(w.mgr, `/sessions/${a.sid}/revert-confirmation`, {})).status).toBe(400);
      expect((await post(w.mgr, `/sessions/${a.sid}/revert-confirmation`, { reason: '  ' })).status).toBe(400);
      expect((await post(w.mgr, `/sessions/${a.sid}/revert-confirmation`, { reason: 'ab' })).status).toBe(400);
      r = await post(w.mgr, `/sessions/${a.sid}/revert-confirmation`, { reason: '     ' });
      expect(r.status).toBe(400); expect(r.body.code).toBe('REASON_REQUIRED');
      expect((await post(wb.mgr, `/sessions/${a.sid}/revert-confirmation`, { reason: 'غلط' })).status).toBe(404);
      expect((await post(w.mgr, `/sessions/99999999/revert-confirmation`, { reason: 'غلط' })).status).toBe(404);
      expect(await sess(a.sid)).toMatchObject({ status: 'completed' }); expect(await bq(b)).toBe(8);
      expect((await post(w.mgr, `/sessions/${a.sid}/revert-confirmation`, { reason: 'غلط فعلاً' })).status).toBe(201);
      r = await post(w.mgr, `/sessions/${a.sid}/revert-confirmation`, { reason: 'مرة ثانية' });
      expect(r.status).toBe(409); expect(r.body.code).toBe('NOT_COMPLETED');
      expect(Number((await one(`select count(*)::int as n from confirmation_reverts where session_id = $1`, [a.sid])).n)).toBe(1);
    });
    it('تراجعين متزامنين: واحد ينجح والثاني NOT_COMPLETED، والمواد ترجع مرة وحدة', async () => {
      const svc = await newSvc(w); const b = await batch(w, svc.mat, 9, 1000, 60);
      const a = await paidSession(w, svc, 2);
      expect((await complete(w.nurse, a.sid)).status).toBe(201);
      const rs = await Promise.all([post(w.mgr, `/sessions/${a.sid}/revert-confirmation`, { reason: 'أ ب ج' }), post(owner, `/sessions/${a.sid}/revert-confirmation`, { reason: 'د هـ و' })]);
      expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await bq(b)).toBe(9); expect((await moves(a.sid)).filter((x) => x.movement_type === 'consume_reversal')).toHaveLength(1);
    });
    it('التراجع والاستهلاك الإضافي بنفس اللحظة: كل حركة استهلاك تنعكس أو تنرفض، وصافي الجلسة صفر أو إضافي مسجل صحيح', async () => {
      const svc = await newSvc(w); const b = await batch(w, svc.mat, 20, 1000, 60);
      for (let i = 0; i < 3; i++) {
        const a = await paidSession(w, svc, 1);
        expect((await complete(w.nurse, a.sid)).status).toBe(201);
        const [rv, ex] = await Promise.all([post(w.mgr, `/sessions/${a.sid}/revert-confirmation`, { reason: 'سباق' }), post(w.mgr, `/sessions/${a.sid}/extra-usage`, { items: [{ material_id: svc.mat, qty: 1 }], reason: 'سباق' })]);
        expect(rv.status).toBe(201); expect([201, 409]).toContain(ex.status);
        const m = await moves(a.sid); const net = m.reduce((t, x) => t + x.q, 0);
        if (ex.status === 201) expect(m.some((x) => x.note?.startsWith('استهلاك إضافي'))).toBe(true);
        const unreversed = m.filter((x) => x.movement_type === 'consume' && !m.some((y) => y.rv === x.id));
        if (ex.status === 409) expect(net).toBe(0);
        else if (unreversed.length === 0) expect(net).toBe(0);                                                  // الإضافي سبق التراجع فانعكس معاه
        else expect(unreversed).toHaveLength(1);                                                                // الإضافي لحق بعد التراجع: جلسة مدفوعة بس (ما تنقبل → 409)، ما يصير
      }
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('التقييم', () => {
    it('الزبون يقيّم جلسته المكتملة مرة وحدة، ولقطة الممرض والخدمة تنحفظ، وطلب التقييم يتسكر', async () => {
      const svc = await newSvc(w, 'خدمة تقييم'); await batch(w, svc.mat, 9, 1000, 60);
      const a = await paidSession(w, svc, 1);
      await expect(ratings.submit(a.customer, a.sid, { stars: 5 })).rejects.toMatchObject({ response: { code: 'NOT_COMPLETED' } });
      expect((await complete(w.nurse, a.sid)).status).toBe(201);
      await expect(ratings.submit(a.customer + 99999, a.sid, { stars: 5 })).rejects.toMatchObject({ status: 404 });
      for (const stars of [0, 6, 2.5, NaN]) await expect(ratings.submit(a.customer, a.sid, { stars })).rejects.toMatchObject({ response: { code: 'INVALID_STARS' } });
      const r = await ratings.submit(a.customer, a.sid, { stars: 3, comment: '  كانت تمام  ' });
      expect(r).toMatchObject({ session_id: a.sid, stars: 3, comment: 'كانت تمام' });
      await expect(ratings.submit(a.customer, a.sid, { stars: 5 })).rejects.toMatchObject({ response: { code: 'ALREADY_RATED' } });
      const row = await one(`select stars, comment, nurse_id::int as nurse, service_id::int as service, customer_id::int as customer from session_ratings where session_id = $1`, [a.sid]);
      expect(row).toMatchObject({ stars: 3, comment: 'كانت تمام', nurse: w.nurseId, service: svc.id, customer: a.customer });
      const n = await one(`select status, read_at from notifications where treatment_session_id = $1 and kind = 'rating_request'`, [a.sid]);
      expect(n.status).toBe('cancelled'); expect(n.read_at).not.toBeNull();
    });
    it('تقييمين متزامنين لنفس الجلسة: واحد يدخل والثاني ALREADY_RATED', async () => {
      const svc = await newSvc(w); await batch(w, svc.mat, 9, 1000, 60);
      const a = await paidSession(w, svc, 1); expect((await complete(w.nurse, a.sid)).status).toBe(201);
      const rs = await Promise.allSettled([ratings.submit(a.customer, a.sid, { stars: 5 }), ratings.submit(a.customer, a.sid, { stars: 1 })]);
      expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(Number((await one(`select count(*)::int as n from session_ratings where session_id = $1`, [a.sid])).n)).toBe(1);
    });
    it('قفل الجلسة (حتمي): تقييم جاري من جهة ثانية → الثاني ينتظر ويرفض ALREADY_RATED (مو خطأ قاعدة بيانات)', async () => {
      const svc = await newSvc(w); await batch(w, svc.mat, 9, 1000, 60);
      const a = await paidSession(w, svc, 1); expect((await complete(w.nurse, a.sid)).status).toBe(201);
      const info = await one(`select i.service_id::int as sv from treatment_sessions s join plan_items i on i.id = s.plan_item_id where s.id = $1`, [a.sid]);
      const hold = await holdSession(a.sid, `insert into session_ratings (session_id, customer_id, service_id, nurse_id, stars) values ($1, ${a.customer}, ${info.sv}, ${w.nurseId}, 5)`);
      let res: any; let held = true;
      try {
        const p = ratings.submit(a.customer, a.sid, { stars: 1 }).then((r) => { res = { ok: r }; }, (e) => { res = { err: e }; });
        await new Promise((r) => setTimeout(r, 400));
        expect(res).toBeUndefined();                                                                      // ينتظر قفل الجلسة فعلاً
        await hold.release(); held = false; await p;
      } finally { if (held) await hold.release(); }
      expect(res.err?.response?.code).toBe('ALREADY_RATED');
      expect((await one(`select stars from session_ratings where session_id = $1`, [a.sid])).stars).toBe(5);
    });
    it('المالك بس يشوف التقييمات: متوسط وعدد لكل خدمة ولكل ممرض، وتصفية بالخدمة والممرض والتاريخ', async () => {
      const w2 = await world('NRC'); const nurse2 = await seedUser(db, 'nurse2_NRC', 'nurse', w2.id); const n2t = await tokenFor(app, 'nurse2_NRC');
      const sA = await newSvc(w2, 'خدمة أ'); const sB = await newSvc(w2, 'خدمة ب'); await batch(w2, sA.mat, 50, 100, 60); await batch(w2, sB.mat, 50, 100, 60);
      const give = async (svc: Svc, nurseTok: string, stars: number, comment?: string) => { const a = await paidSession(w2, svc, 1); expect((await complete(nurseTok, a.sid)).status).toBe(201); await ratings.submit(a.customer, a.sid, { stars, comment }); return a; };
      await give(sA, w2.nurse, 5, 'ممتاز'); await give(sA, w2.nurse, 4); await give(sB, n2t, 2, 'بطيء'); await give(sA, n2t, 3);
      const q = `branch_id=${w2.id}`;
      const r = await get(owner, `/ratings?${q}`);
      expect(r.status).toBe(200);
      expect(r.body.by_service.map((x: any) => [x.service_name, x.count, x.average])).toEqual([['خدمة أ', 3, 4], ['خدمة ب', 1, 2]]);
      expect(r.body.by_nurse.map((x: any) => [x.nurse_id, x.count, x.average]).sort()).toEqual([[w2.nurseId, 2, 4.5], [nurse2, 2, 2.5]].sort());
      expect(r.body.ratings).toHaveLength(4);
      expect(r.body.ratings[0]).toMatchObject({ stars: 3, nurse: { id: nurse2 }, service: { name: 'خدمة أ' } });      // الأحدث أول
      expect(r.body.ratings.map((x: any) => x.comment).filter(Boolean).sort()).toEqual(['بطيء', 'ممتاز']);
      expect((await get(owner, `/ratings?${q}&nurse_id=${nurse2}`)).body.ratings).toHaveLength(2);
      expect((await get(owner, `/ratings?${q}&service_id=${sB.id}`)).body.ratings).toHaveLength(1);
      expect((await get(owner, `/ratings?${q}&from=2099-01-01`)).body.ratings).toHaveLength(0);
      expect((await get(owner, `/ratings?${q}&to=2000-01-01`)).body.ratings).toHaveLength(0);
      expect((await get(owner, `/ratings?from=غلط`)).status).toBe(400);
      expect((await get(owner, `/ratings?${`branch_id=${wb.id}`}`)).body.ratings).toHaveLength(0);
      for (const t of [w2.mgr, w2.cash, w2.nurse, w2.docA]) expect((await get(t, '/ratings')).status).toBe(403);
      expect((await http().get('/ratings')).status).toBe(401);
    });
  });
});
