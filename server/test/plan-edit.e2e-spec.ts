import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { BookingsService } from '../src/bookings/bookings.service';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

interface World { id: number; code: string; mgr: string; mgrId: number; cash: string; nurse: string; docA: string; docAId: number; docB: string; docBId: number; cashMethod: number; botox: number; fixed: number; mat: number }

describe('تعديل الخطة الفعالة: إضافة بند وإيقاف بند', () => {
  let app: INestApplication; let db: Pool; let today: string; let bookings: BookingsService;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  let seq = 0; let phoneSeq = 0;
  const key = () => `pk-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const cashT = (w: World, amount: number) => ({ tenders: [{ method_id: w.cashMethod, amount }] });

  async function world(code: string): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name) values ($1,$1) returning id`, [code])).rows[0].id);
    await db.query(`insert into safes (branch_id) values ($1)`, [id]);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id); await seedUser(db, `cash_${code}`, 'cashier', id); await seedUser(db, `nurse_${code}`, 'nurse', id);
    const docAId = await seedUser(db, `docA_${code}`, 'doctor', id); const docBId = await seedUser(db, `docB_${code}`, 'doctor', id);
    await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',100000000,'opening_balance','تجربة',$2)`, [id, mgrId]);
    const [mgr, cash, nurse, docA, docB] = await Promise.all([`mgr_${code}`, `cash_${code}`, `nurse_${code}`, `docA_${code}`, `docB_${code}`].map((u) => tokenFor(app, u)));
    for (const d of [docAId, docBId]) expect((await put(mgr, `/schedule/doctors/${d}/weekly`, { days: [1, 2, 3, 4, 5, 6, 7].map((x) => ({ weekday: x, start_time: '09:00', end_time: '13:00' })), effective_from: today })).status).toBe(200);
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
    return { id, code, mgr, mgrId, cash, nurse, docA, docAId, docB, docBId, cashMethod, botox: bs.id, fixed: fx.id, mat };
  }
  /** كشفية مدفوعة، والطبيب يدخل الملف ويكتب خطة بوتكس (2 جلسة، أول جلسة اليوم) */
  async function planned(w: World, sessions = 2) {
    phoneSeq++;
    const c = (await post(w.cash, '/customers', { full_name: `زبون خطة ${phoneSeq}`, phone: `0784${String(phoneSeq).padStart(7, '0')}` })).body.id as number;
    const b = await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docAId, date: today });
    const cons = b.body.consultation.id as number;
    expect((await http().post('/payments/consultation').set(auth(w.cash)).set('Idempotency-Key', key()).send({ consultation_id: cons, ...cashT(w, 30000) })).status).toBe(201);
    expect((await post(w.docA, `/consultations/${cons}/enter`)).status).toBe(201);
    const pl = await post(w.docA, `/consultations/${cons}/plan`, { items: [{ service_id: w.botox, values: { cc: 1 }, sessions_count: sessions, interval_days: 7, first_session_date: today }] });
    expect(pl.status).toBe(201);
    return { customer: c, cons, plan: pl.body.id as number, item: pl.body.items[0].id as number, sessions: pl.body.items[0].sessions.map((s: any) => s.id as number) };
  }
  const fixedItem = (w: World, over: Record<string, unknown> = {}) => ({ service_id: w.fixed, sessions_count: 2, interval_days: 7, first_session_date: day(1), ...over });
  const statuses = async (ids: number[]) => (await db.query(`select id::int as id, status from treatment_sessions where id = any($1::bigint[]) order by id`, [ids])).rows.map((r) => r.status);
  const usedTotal = async (b: number) => Number((await one(`select coalesce(sum(used_slots),0)::int as n from booking_days where branch_id = $1`, [b])).n);

  let w: World; let wb: World;
  beforeAll(async () => {
    app = await makeApp(); db = pool(); bookings = app.get(BookingsService);
    today = (await db.query(`select clinic_today()::text as d`)).rows[0].d;
    w = await world('PEA'); wb = await world('PEB');
  });
  afterAll(async () => { await app.close(); await db.end(); });

  describe('إضافة بند', () => {
    it('يضاف لخطة فعالة بجلساته المحجوزة تلقائياً بالفرق، ويظهر بالخطة، وبسجل الحركات ونسخة الخطة تزيد', async () => {
      const x = await planned(w);
      const before = await usedTotal(w.id);
      const r = await post(w.docA, `/plans/${x.plan}/items`, fixedItem(w, { note: 'إضافة', first_session_date: day(2) }));
      expect(r.status).toBe(201);
      expect(r.body.items).toHaveLength(2);
      const added = r.body.items[1];
      expect(added).toMatchObject({ service: { name: 'تنظيف بشرة' }, sessions_count: 2, interval_days: 7, note: 'إضافة', first_session_date: day(2) });
      expect(added.sessions.map((s: any) => [s.seq_no, s.status, s.scheduled_date])).toEqual([[1, 'booked', day(2)], [2, 'booked', day(9)]]);
      expect(r.body.version).toBe(2);
      expect(await usedTotal(w.id)).toBe(before + 2);                                                         // مقعدين جديدين (يومين مختلفين)
      expect((await one(`select count(*)::int as n from audit_log where action = 'plan.add_item' and entity_id = $1`, [x.plan])).n).toBe(1);
      expect(Number((await one(`select count(*)::int as n from booking_events where treatment_session_id = any($1::bigint[]) and event = 'booked'`, [added.sessions.map((s: any) => s.id)])).n)).toBe(2);
      expect((await get(w.docA, `/consultations/${x.cons}/plan`)).body.items).toHaveLength(2);
    });
    it('بند ثاني بنفس يوم جلسة موجودة للزبون يشارك زيارتها (مقعد وحد)، وبنفس نوع الخدمة مسموح (بوتكس ثاني)', async () => {
      const x = await planned(w, 1);                                                                        // جلسة بوتكس اليوم بزيارة الكشفية
      const before = await usedTotal(w.id);
      const r = await post(w.docA, `/plans/${x.plan}/items`, { service_id: w.botox, values: { cc: 3 }, sessions_count: 1, interval_days: 0, first_session_date: today });
      expect(r.status).toBe(201);
      expect(r.body.items[1].sessions[0].visit_id).toBe(r.body.items[0].sessions[0].visit_id);               // نفس الزيارة
      expect(r.body.items[1].values).toEqual([{ field_key: 'cc', label: 'كم cc', number: 3, text: null, bool: null, option_ids: [] }]);   // القيم انحفظت
      expect(r.body.items[1].estimate).toEqual({ per_session: 150000, total: 150000 });
      expect((await db.query(`select sort_order::int as o from plan_items where plan_id = $1 order by id`, [x.plan])).rows.map((q) => q.o)).toEqual([0, 1]);
      expect(await usedTotal(w.id)).toBe(before);
    });
    it('الرفض: غير صاحب الخطة، طبيب ثاني، خطة موقوفة، خدمة غلط، تواريخ غلط، قيم ناقصة', async () => {
      const x = await planned(w);
      for (const t of [w.cash, w.nurse, w.mgr]) expect((await post(t, `/plans/${x.plan}/items`, fixedItem(w))).status).toBe(403);
      expect((await post(w.docB, `/plans/${x.plan}/items`, fixedItem(w))).status).toBe(404);               // خطة طبيب ثاني
      expect((await post(wb.docA, `/plans/${x.plan}/items`, fixedItem(wb))).status).toBe(404);              // فرع ثاني
      expect((await post(w.docA, `/plans/99999999/items`, fixedItem(w))).status).toBe(404);
      expect((await http().post(`/plans/${x.plan}/items`).send(fixedItem(w))).status).toBe(401);
      const cs = Number((await one(`select id from services where branch_id = $1 and kind = 'consultation'`, [w.id])).id);
      let r = await post(w.docA, `/plans/${x.plan}/items`, fixedItem(w, { service_id: cs })); expect(r.status).toBe(400); expect(r.body.code).toBe('SERVICE_INVALID');
      r = await post(w.docA, `/plans/${x.plan}/items`, fixedItem(wb, {})); expect(r.status).toBe(400); expect(r.body.code).toBe('SERVICE_INVALID');             // خدمة فرع ثاني
      r = await post(w.docA, `/plans/${x.plan}/items`, fixedItem(w, { first_session_date: day(-1) })); expect(r.status).toBe(400); expect(r.body.code).toBe('DATE_IN_PAST');
      r = await post(w.docA, `/plans/${x.plan}/items`, fixedItem(w, { first_session_date: undefined })); expect(r.status).toBe(400); expect(r.body.code).toBe('DATES_OR_FIRST');
      r = await post(w.docA, `/plans/${x.plan}/items`, fixedItem(w, { first_session_date: undefined, dates: [day(1)] })); expect(r.body.code).toBe('DATES_COUNT_MISMATCH');
      r = await post(w.docA, `/plans/${x.plan}/items`, fixedItem(w, { first_session_date: undefined, dates: [day(3), day(2)] })); expect(r.body.code).toBe('DATES_NOT_INCREASING');
      r = await post(w.docA, `/plans/${x.plan}/items`, { service_id: w.botox, sessions_count: 1, interval_days: 0, first_session_date: day(1) }); expect(r.status).toBe(400);      // cc ناقص
      expect((await post(w.docA, `/plans/${x.plan}/items`, fixedItem(w, { sessions_count: 0 }))).status).toBe(400);
      await db.query(`update services set is_active = false where id = $1`, [w.fixed]);
      r = await post(w.docA, `/plans/${x.plan}/items`, fixedItem(w)); expect(r.status).toBe(409); expect(r.body.code).toBe('SERVICE_INACTIVE');
      await db.query(`update services set is_active = true where id = $1`, [w.fixed]);
      expect((await post(w.docA, `/plans/${x.plan}/stop`, { reason: 'إيقاف تجربة' })).status).toBe(201);
      r = await post(w.docA, `/plans/${x.plan}/items`, fixedItem(w)); expect(r.status).toBe(409); expect(r.body.code).toBe('NOT_ACTIVE');
      expect((await one(`select count(*)::int as n from plan_items where plan_id = $1`, [x.plan])).n).toBe(1);                              // ما انضاف شي بأي رفض
    });
    it('قفل الخطة (حتمي): إيقاف جاري للخطة → الإضافة تنتظر وترفض NOT_ACTIVE', async () => {
      const x = await planned(w);
      const c = await db.connect(); let res: any; let held = true;
      try {
        await c.query('begin'); await c.query(`select 1 from treatment_plans where id = $1 for update`, [x.plan]);
        await c.query(`update treatment_plans set status = 'stopped', stopped_at = now(), stopped_by = ${w.docAId}, stop_reason = 'سباق' where id = $1`, [x.plan]);
        const p = post(w.docA, `/plans/${x.plan}/items`, fixedItem(w)).then((r) => { res = r; });
        await new Promise((r) => setTimeout(r, 400));
        expect(res).toBeUndefined();
        await c.query('commit'); held = false; await p;
      } finally { if (held) await c.query('rollback'); c.release(); }
      expect(res.status).toBe(409); expect(res.body.code).toBe('NOT_ACTIVE');
      expect(Number((await one(`select count(*)::int as n from plan_items where plan_id = $1`, [x.plan])).n)).toBe(1);
    });
    it('فشل الحجز بنص الطريق: كل شي يرجع (ما يبقى بند ولا جلسة ولا مقعد) والخطة تبقى فعالة', async () => {
      const x = await planned(w);
      const before = await usedTotal(w.id); const sessionsBefore = Number((await one(`select count(*)::int as n from treatment_sessions where customer_id = $1`, [x.customer])).n);
      const real = bookings.reserveDayForSession.bind(bookings); let calls = 0;
      const spy = jest.spyOn(bookings, 'reserveDayForSession').mockImplementation(async (...a: Parameters<BookingsService['reserveDayForSession']>) => (++calls === 2 ? null : real(...a)));
      const r = await post(w.docA, `/plans/${x.plan}/items`, fixedItem(w, { sessions_count: 3 }));
      spy.mockRestore();
      expect(r.status).toBe(409); expect(r.body.code).toBe('PLAN_BOOKING_FAILED'); expect(r.body.reason).toEqual(expect.any(String));
      expect(Number((await one(`select count(*)::int as n from plan_items where plan_id = $1`, [x.plan])).n)).toBe(1);
      expect(Number((await one(`select count(*)::int as n from treatment_sessions where customer_id = $1`, [x.customer])).n)).toBe(sessionsBefore);
      expect(await usedTotal(w.id)).toBe(before);
      expect((await one(`select status from treatment_plans where id = $1`, [x.plan])).status).toBe('active');
      expect((await post(w.docA, `/plans/${x.plan}/items`, fixedItem(w))).status).toBe(201);                                                // وبعدها ينجح عادي
    });
  });

  describe('إيقاف بند', () => {
    it('جلساته غير المدفوعة تنلغي ومقاعد الزيارات اللي فضت ترجع، والمدفوعة تروح للمتابعة، والمكتملة تبقى، وباقي البنود ما تتأثر', async () => {
      await db.query(`insert into material_batches (branch_id, material_id, source, received_on, expiry_date, unit_cost, qty_initial, qty_on_hand) values ($1,$2,'opening',clinic_today(),clinic_today() + 90,1000,50,0)`, [w.id, w.mat]).then(async () => {
        const b = Number((await one(`select max(id) as id from material_batches where branch_id = $1`, [w.id])).id);
        await db.query(`insert into stock_movements (branch_id, material_id, batch_id, movement_type, qty_delta, unit_cost, cost_amount) values ($1,$2,$3,'opening',50,1000,50000)`, [w.id, w.mat, b]);
      });
      const x = await planned(w, 3);                                                                        // بوتكس: اليوم، +7، +14
      const add = await post(w.docA, `/plans/${x.plan}/items`, fixedItem(w, { first_session_date: day(3), sessions_count: 2 }));
      const fixedSessions: number[] = add.body.items[1].sessions.map((s: any) => s.id);
      expect((await http().post('/payments/sessions').set(auth(w.cash)).set('Idempotency-Key', key()).send({ session_ids: [x.sessions[0]], ...cashT(w, 50000) })).status).toBe(201);
      expect((await post(w.nurse, `/sessions/${x.sessions[0]}/complete`)).status).toBe(201);               // الأولى مكتملة
      expect((await http().post('/payments/sessions').set(auth(w.cash)).set('Idempotency-Key', key()).send({ session_ids: [x.sessions[1]], ...cashT(w, 50000) })).status).toBe(409);   // +7 مو اليوم: ما تندفع
      await db.query(`update treatment_sessions set status = 'paid' where id = $1`, [x.sessions[1]]);       // نحاكي مدفوعة (حيلة اختبار)
      const used = await usedTotal(w.id);
      const r = await post(w.docA, `/plans/items/${x.item}/stop`, { reason: 'الزبونة اكتفت' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ cancelled_sessions: 1, paid_sessions_to_follow_up: [x.sessions[1]] });
      expect(await statuses(x.sessions)).toEqual(['completed', 'paid', 'cancelled']);
      expect(await statuses(fixedSessions)).toEqual(['booked', 'booked']);                                   // البند الثاني ما تأثر
      expect(r.body.released_visits).toBe(1); expect(await usedTotal(w.id)).toBe(used - 1);                   // زيارة +14 فضت
      expect((await one(`select cancel_reason from treatment_sessions where id = $1`, [x.sessions[2]])).cancel_reason).toBe('إيقاف بند: الزبونة اكتفت');
      expect((await one(`select count(*)::int as n from audit_log where action = 'plan.stop_item' and entity_id = $1 and reason = 'الزبونة اكتفت'`, [x.plan])).n).toBe(1);
      expect((await one(`select status from treatment_plans where id = $1`, [x.plan])).status).toBe('active');
      const again = await post(w.docA, `/plans/items/${x.item}/stop`, { reason: 'مرة ثانية' });
      expect(again.status).toBe(201); expect(again.body.cancelled_sessions).toBe(0);                          // المدفوعة تبقى بالمتابعة (ما يرفض لأن أكو مدفوعة)
    });
    it('الرفض: سبب إلزامي، غير الطبيب صاحب الخطة، بند غير موجود، خطة موقوفة، وبند كله منفذ', async () => {
      const x = await planned(w, 1);
      for (const reason of ['', '  ', 'ab', '     ']) expect([reason, (await post(w.docA, `/plans/items/${x.item}/stop`, { reason })).status]).toEqual([reason, 400]);
      expect((await post(w.docA, `/plans/items/${x.item}/stop`, {})).status).toBe(400);
      for (const t of [w.cash, w.nurse, w.mgr]) expect((await post(t, `/plans/items/${x.item}/stop`, { reason: 'سبب' })).status).toBe(403);
      expect((await post(w.docB, `/plans/items/${x.item}/stop`, { reason: 'سبب' })).status).toBe(404);
      expect((await post(wb.docA, `/plans/items/${x.item}/stop`, { reason: 'سبب' })).status).toBe(404);
      expect((await post(w.docA, `/plans/items/99999999/stop`, { reason: 'سبب' })).status).toBe(404);
      expect((await http().post(`/plans/items/${x.item}/stop`).send({ reason: 'سبب' })).status).toBe(401);
      expect((await one(`select status from treatment_sessions where id = $1`, [x.sessions[0]])).status).toBe('booked');
      // بند كله منفذ: ما أكو شي يتوقف
      await db.query(`update treatment_sessions set status = 'completed', completed_at = now(), completed_by = (select id from users where username = $2) where id = $1`, [x.sessions[0], `nurse_${w.code}`]);
      const done = await post(w.docA, `/plans/items/${x.item}/stop`, { reason: 'سبب' });
      expect(done.status).toBe(409); expect(done.body.code).toBe('NOTHING_TO_STOP');
      expect((await post(w.docA, `/plans/${x.plan}/stop`, { reason: 'إيقاف الخطة' })).status).toBe(201);
      const stopped = await post(w.docA, `/plans/items/${x.item}/stop`, { reason: 'سبب' });
      expect(stopped.status).toBe(409); expect(stopped.body.code).toBe('NOT_ACTIVE');
    });
    it('إيقاف بند وإضافة بند بنفس اللحظة على نفس الخطة: كلاهما ينجح بدون تلف أو تكرار', async () => {
      const x = await planned(w, 3);
      const rs = await Promise.all([post(w.docA, `/plans/items/${x.item}/stop`, { reason: 'تزامن' }), post(w.docA, `/plans/${x.plan}/items`, fixedItem(w, { first_session_date: day(5), sessions_count: 1 }))]);
      expect(rs.map((r) => r.status)).toEqual([201, 201]);
      expect(Number((await one(`select count(*)::int as n from plan_items where plan_id = $1`, [x.plan])).n)).toBe(2);
      expect((await one(`select version from treatment_plans where id = $1`, [x.plan])).version).toBe(3);
      expect((await db.query(`select bd.day from booking_days bd where bd.branch_id = $1 and bd.used_slots <> (select count(*)::int from visits v where v.branch_id = bd.branch_id and v.visit_date = bd.day and v.status in ('booked','arrived'))`, [w.id])).rows).toEqual([]);
    });
  });
});
