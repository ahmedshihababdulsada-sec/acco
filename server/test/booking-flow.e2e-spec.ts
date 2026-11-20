import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { LogOtpSender, OTP_SENDER } from '../src/customer-app/otp.service';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

interface World { id: number; code: string; mgr: string; mgrId: number; cash: string; cash2: string; cash2Id: number; docA: string; docAId: number; cashMethod: number; svc: number; svc2: number }

describe('تنظيم الحجز: ملاحظة الزبون، طور الزيارة، إيقاف الحجز، وترحيل من ما وصله الدور', () => {
  let app: INestApplication; let db: Pool; let today: string; let owner: string; let sender: LogOtpSender;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const addDays = (s: string, n: number) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const d = (n: number) => addDays(today, n);
  let phoneSeq = 0; let seq = 0; let hack = 0;
  const key = () => `bf-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const payCons = (w: World, cons: number) => http().post('/payments/consultation').set(auth(w.cash)).set('Idempotency-Key', key()).send({ consultation_id: cons, tenders: [{ method_id: w.cashMethod, amount: 30000 }] });
  const paySess = async (w: World, ids: number[], by = w.cash) => {
    const q = (await post(by, '/payments/quote/sessions', { session_ids: ids })).body.net_amount as number;
    return http().post('/payments/sessions').set(auth(by)).set('Idempotency-Key', key()).send({ session_ids: ids, tenders: [{ method_id: w.cashMethod, amount: q }] });
  };

  async function world(code: string): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name) values ($1,$1) returning id`, [code])).rows[0].id);
    await db.query(`insert into safes (branch_id) values ($1)`, [id]);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id); await seedUser(db, `cash_${code}`, 'cashier', id); const cash2Id = await seedUser(db, `cash2_${code}`, 'cashier', id); const docAId = await seedUser(db, `docA_${code}`, 'doctor', id);
    await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',100000000,'opening_balance','تجربة',$2)`, [id, mgrId]);
    const [mgr, cash, docA, cash2] = await Promise.all([`mgr_${code}`, `cash_${code}`, `docA_${code}`, `cash2_${code}`].map((u) => tokenFor(app, u)));
    expect((await put(mgr, `/schedule/doctors/${docAId}/weekly`, { days: [1, 2, 3, 4, 5, 6, 7].map((x) => ({ weekday: x, start_time: '09:00', end_time: '13:00' })), effective_from: today })).status).toBe(200);
    const cur = (await get(mgr, '/settings')).body.settings.find((s: any) => s.key === 'booking.daily_limit');
    expect((await put(mgr, '/settings/booking.daily_limit', { value: 1000, expected_version: cur.version })).status).toBe(200);
    const cs = Number((await db.query(`insert into services (branch_id, name_ar, kind, pricing_model, is_active) values ($1,'كشفية','consultation','fixed',true) returning id`, [id])).rows[0].id);
    await db.query(`insert into service_prices (service_id, price, set_by) values ($1,30000,$2)`, [cs, mgrId]);
    const cashMethod = Number((await db.query(`insert into payment_methods (branch_id, name_ar, kind, sort_order) values ($1,'كاش','cash',0) returning id`, [id])).rows[0].id);
    expect((await post(cash, '/shifts/open', { opening_float: 0 })).status).toBe(201);
    expect((await post(cash2, '/shifts/open', { opening_float: 0 })).status).toBe(201);
    const mk = async (name: string) => {
      const bs = (await post(mgr, '/services', { name_ar: `${name} ${code}`, pricing_model: 'per_unit', price: 50000 })).body;
      await post(mgr, `/services/${bs.id}/fields`, { field_key: 'cc', label_ar: 'كم', field_type: 'number', unit_label: 'cc', pricing_role: 'quantity', is_required: true });
      expect((await post(mgr, `/services/${bs.id}/activate`)).status).toBe(200);
      return bs.id as number;
    };
    return { id, code, mgr, mgrId, cash, cash2, cash2Id, docA, docAId, cashMethod, svc: await mk('ليزر'), svc2: await mk('بوتوكس') };
  }
  async function customer(w: World) {
    phoneSeq++; return (await post(w.cash, '/customers', { full_name: `زبون تنظيم ${phoneSeq}`, phone: `0782${String(phoneSeq).padStart(7, '0')}` })).body.id as number;
  }
  const book = (w: World, c: number, date: string, extra: object = {}) => post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docAId, date, ...extra });
  const bookOk = async (w: World, c: number, date: string, extra: object = {}) => { const r = await book(w, c, date, extra); expect(r.status).toBe(201); return r.body; };
  /** زبون بخطة جلسات: كشفية مدفوعة → دخول → خطة (أول جلسة بالتاريخ المطلوب) */
  async function withPlan(w: World, date = today, svc = w.svc) {
    const c = await customer(w); const b = await bookOk(w, c, today);
    expect((await payCons(w, b.consultation.id)).status).toBe(201);
    expect((await post(w.docA, `/consultations/${b.consultation.id}/enter`)).status).toBe(201);
    const pl = await post(w.docA, `/consultations/${b.consultation.id}/plan`, { items: [{ service_id: svc, values: { cc: 1 }, sessions_count: 2, interval_days: 7, first_session_date: date }] });
    expect(pl.status).toBe(201);
    return { c, b, sessions: pl.body.items[0].sessions as { id: number }[] };
  }
  /** نرجّع زيارة اليوم ليوم مضى (محاكاة: دفع وما انخدم) */
  async function backdate(visitId: number, ago = 1) {
    const v = await one(`select branch_id, visit_date::text as d from visits where id = $1`, [visitId]);
    const date = d(-ago); const sq = 9000 + (++hack);
    await db.query(`update booking_days set used_slots = greatest(used_slots - 1, 0) where branch_id = $1 and day = $2`, [v.branch_id, v.d]);
    await db.query(`insert into booking_days (branch_id, day, used_slots, last_seq) values ($1,$2,1,$3) on conflict (branch_id, day) do update set used_slots = booking_days.used_slots + 1, last_seq = greatest(booking_days.last_seq, $3)`, [v.branch_id, date, sq]);
    await db.query(`update visits set visit_date = $2, seq_no = $3 where id = $1`, [visitId, date, sq]);
    await db.query(`update treatment_sessions set scheduled_date = $2 where visit_id = $1 and status in ('booked','paid')`, [visitId, date]);
  }
  const visitRow = (id: number) => one(`select visit_date::text as date, seq_no, status from visits where id = $1`, [id]);
  const usedSlots = async (w: World, day: string) => Number((await one(`select coalesce((select used_slots from booking_days where branch_id = $1 and day = $2), 0) as n`, [w.id, day])).n);

  let w: World; let wb: World;
  beforeAll(async () => {
    app = await makeApp(); db = pool(); sender = app.get(OTP_SENDER) as LogOtpSender; today = (await db.query(`select clinic_today()::text as d`)).rows[0].d; owner = await tokenFor(app, 'owner');
    w = await world('BFA'); wb = await world('BFB');
  });
  afterAll(async () => { await app.close(); await db.end(); });

  // ================================================================================================
  describe('ملاحظة الزبون والخدمة المطلوبة', () => {
    it('الكاشير يحجز بملاحظة وخدمة: تنحفظ مقصوصة، تظهر بقائمة الحجوزات وقائمة الطبيب وملف الكشفية', async () => {
      const c = await customer(w);
      const b = await bookOk(w, c, today, { type: 'sessions_only', note: '  عندي حساسية من الليزر  ', service_id: w.svc2 });
      expect(b.consultation).toMatchObject({ note: 'عندي حساسية من الليزر', interest: { id: w.svc2 } });
      expect(b.consultation.interest.name).toContain('بوتوكس');
      expect((await get(w.cash, `/bookings?date=${today}`)).body.bookings.find((x: any) => x.id === b.id).consultation.note).toBe('عندي حساسية من الليزر');
      expect((await one(`select booking_note, interest_service_id from consultations where id = $1`, [b.consultation.id]))).toMatchObject({ booking_note: 'عندي حساسية من الليزر', interest_service_id: String(w.svc2) });
      expect((await post(w.cash, `/consultations/${b.consultation.id}/check-in`)).status).toBe(201);          // مجانية: تدخل بدون دفع
      const q = (await get(w.docA, '/doctor/queue')).body.queue.find((x: any) => x.consultation_id === b.consultation.id);
      expect(q).toMatchObject({ booking_note: 'عندي حساسية من الليزر', kind: 'sessions_only' });
    });

    it('بدون ملاحظة = null، ملاحظة فراغات = null، أطول من 500 يرفض، وخدمة غلط (فرع ثاني، كشفية، غير فعالة، غير موجودة) ترفض', async () => {
      const c1 = await customer(w); const c2 = await customer(w); const c3 = await customer(w);
      expect((await bookOk(w, c1, d(1))).consultation).toMatchObject({ note: null, interest: null });
      expect((await bookOk(w, c2, d(1), { note: '    ' })).consultation.note).toBeNull();
      expect((await book(w, c3, d(1), { note: 'ا'.repeat(501) })).status).toBe(400);
      expect((await bookOk(w, c3, d(1), { note: 'ا'.repeat(500) })).consultation.note).toHaveLength(500);
      const c4 = await customer(w);
      const cons = Number((await one(`select id from services where branch_id = $1 and kind = 'consultation'`, [w.id])).id);
      for (const bad of [wb.svc, cons, 99999999]) expect((await book(w, c4, d(2), { service_id: bad })).body.code).toBe('INVALID_SERVICE');
      await db.query(`update services set is_active = false where id = $1`, [w.svc]);
      expect((await book(w, c4, d(2), { service_id: w.svc })).body.code).toBe('INVALID_SERVICE');
      await db.query(`update services set is_active = true where id = $1`, [w.svc]);
      expect((await book(w, c4, d(2), { service_id: 'x' })).status).toBe(400);
      expect((await db.query(`select 1 from visits where customer_id = $1`, [c4])).rowCount).toBe(0);   // الرفض ما خلّى زيارة
    });

    it('طبيب: القائمة وملف الكشفية يعرضون الملاحظة والخدمة', async () => {
      const c = await customer(w);
      const b = await bookOk(w, c, today, { note: 'أريد بوتوكس', service_id: w.svc2 });
      expect((await payCons(w, b.consultation.id)).status).toBe(201);
      const q = (await get(w.docA, '/doctor/queue')).body.queue.find((x: any) => x.consultation_id === b.consultation.id);
      expect(q).toMatchObject({ booking_note: 'أريد بوتوكس' }); expect(q.interest_name).toContain('بوتوكس');
      const e = await post(w.docA, `/consultations/${b.consultation.id}/enter`);
      expect(e.body).toMatchObject({ booking_note: 'أريد بوتوكس' }); expect(e.body.interest_name).toContain('بوتوكس');
    });

    it('تطبيق الزبون: حجز بملاحظة وخدمة، قائمة الخدمات (علاجية فعالة لفرعه بس)، وأول مرة / راجع', async () => {
      const we = await world('BFC'); const phone = '07871234599';
      await db.query(`delete from otp_requests where phone = $1`, ['+9647871234599']);
      expect((await http().post('/customer/auth/request-otp').send({ phone })).status).toBe(200);
      const code = [...sender.sent].reverse().find((x) => x.phone === '+9647871234599')!.code;
      const login = await http().post('/customer/auth/verify-otp').send({ phone, code, full_name: 'زبونة تنظيم', branch_id: we.id }); expect(login.status).toBe(200);
      const tok = login.body.access_token as string; const cid = login.body.customer?.id ?? (await one(`select id from customers where phone = '+9647871234599'`)).id;
      const info = (await get(tok, '/customer/doctors')).body;
      expect(info.is_first_time).toBe(true);
      expect(info.services.map((s: any) => s.id).sort()).toEqual([we.svc, we.svc2].sort());
      expect(info.services.map((s: any) => s.id)).not.toContain(wb.svc);
      expect((await post(tok, '/customer/bookings', { doctor_id: we.docAId, date: today, note: 'x'.repeat(501) })).status).toBe(400);
      expect((await post(tok, '/customer/bookings', { doctor_id: we.docAId, date: today, service_id: wb.svc })).body.code).toBe('INVALID_SERVICE');
      const b = await post(tok, '/customer/bookings', { doctor_id: we.docAId, date: today, type: 'sessions_only', note: 'أريد بوتوكس', service_id: we.svc2 });
      expect(b.status).toBe(201); expect(b.body.consultation).toMatchObject({ note: 'أريد بوتوكس', interest: { id: we.svc2 } });
      expect((await get(tok, '/customer/doctors')).body.is_first_time).toBe(true);          // الحجز لوحده ما يخليه «راجع»
      void cid;
    }, 60000);

    it('الزبون الراجع (دفع كشفية قبل): is_first_time = false', async () => {
      const we = await world('BFD'); const phone = '07871234598';
      await db.query(`delete from otp_requests where phone = $1`, ['+9647871234598']);
      await http().post('/customer/auth/request-otp').send({ phone });
      const code = [...sender.sent].reverse().find((x) => x.phone === '+9647871234598')!.code;
      const login = await http().post('/customer/auth/verify-otp').send({ phone, code, full_name: 'زبونة راجعة', branch_id: we.id });
      const tok = login.body.access_token as string; const cid = Number((await one(`select id from customers where phone = '+9647871234598'`)).id);
      const b = await bookOk(we, cid, today); expect((await payCons(we, b.consultation.id)).status).toBe(201);
      expect((await get(tok, '/customer/doctors')).body.is_first_time).toBe(false);
    }, 60000);
  });

  // ================================================================================================
  describe('طور الزيارة بقائمة الكاشير (كشفية / جلسات)', () => {
    it('كشفية فعالة = طور «كشفية»، وبعد الإنهاء تنتقل لطور «جلسات» بجلساتها بكارت واحد', async () => {
      const c = await customer(w); const b = await bookOk(w, c, today);
      const list = async () => (await get(w.cash, `/bookings?date=${today}&customer_id=${c}`)).body.bookings as any[];
      expect(await list()).toHaveLength(1);
      expect((await list())[0]).toMatchObject({ phase: 'consultation', sessions: [] });
      expect((await payCons(w, b.consultation.id)).status).toBe(201);
      expect((await post(w.docA, `/consultations/${b.consultation.id}/enter`)).status).toBe(201);
      expect((await list())[0].phase).toBe('consultation');                                 // عند الطبيب = لسه كشفية
      const pl = await post(w.docA, `/consultations/${b.consultation.id}/plan`, { items: [{ service_id: w.svc, values: { cc: 1 }, sessions_count: 3, interval_days: 7, first_session_date: today }, { service_id: w.svc2, values: { cc: 1 }, sessions_count: 2, interval_days: 7, first_session_date: today }] });
      expect(pl.status).toBe(201);
      expect((await list())[0].phase).toBe('consultation');
      expect((await post(w.docA, `/consultations/${b.consultation.id}/finish`)).status).toBe(201);
      const l = await list(); expect(l).toHaveLength(1);                                     // زيارة وحدة = كارت وحد
      expect(l[0].phase).toBe('sessions');
      expect(l[0].sessions).toHaveLength(2);                                                 // جلسة اليوم لكل بند
      expect(l[0].sessions.map((s: any) => s.service_name).join('|')).toMatch(/ليزر.*\|.*بوتوكس|بوتوكس.*\|.*ليزر/);
      expect(l[0].sessions[0]).toMatchObject({ status: 'booked', seq_no: 1 }); expect(l[0].sessions[0].of).toBeGreaterThan(1);
    });

    it('الجلسة الملغاة ما تطلع بكارت الزيارة', async () => {
      const p = await withPlan(w, d(4));
      await db.query(`update treatment_sessions set status = 'cancelled', cancelled_at = now() where id = $1`, [p.sessions[0].id]);
      const l = (await get(w.cash, `/bookings?date=${d(4)}&customer_id=${p.c}`)).body.bookings as any[];
      expect(l.flatMap((x) => x.sessions.map((s: any) => s.id))).not.toContain(p.sessions[0].id);
    });

    it('زيارة جلسات بدون كشفية = «جلسات»، والكشفية الملغية ترجعها لـ«جلسات»، والكشفية الجديدة المنضمة ترجعها لـ«كشفية»', async () => {
      const day = d(3); const p = await withPlan(w, day);
      const l1 = (await get(w.cash, `/bookings?date=${day}&customer_id=${p.c}`)).body.bookings as any[];
      expect(l1).toHaveLength(1); expect(l1[0]).toMatchObject({ phase: 'sessions' });
      const visitId = l1[0].id;
      // كشفية جديدة تنضم لنفس زيارة اليوم
      const extra = await bookOk(w, p.c, day, { type: 'sessions_only', service_id: w.svc2, note: 'بوتوكس' });
      expect(extra.id).toBe(visitId);
      expect((await get(w.cash, `/bookings?date=${day}&customer_id=${p.c}`)).body.bookings[0]).toMatchObject({ phase: 'consultation' });
      expect((await post(w.cash, `/bookings/${visitId}/cancel`, { reason: 'تراجع الزبون' })).status).toBe(201);
      expect((await get(w.cash, `/bookings?date=${day}&customer_id=${p.c}`)).body.bookings[0]).toMatchObject({ phase: 'sessions' });
    });
  });

  // ================================================================================================
  describe('إيقاف الحجز ليوم', () => {
    it('المدير يوقف: الحجز الجديد 409 DAY_STOPPED مع أقرب يوم، الحجوزات الموجودة تبقى، والاستئناف يرجع الحجز', async () => {
      const day = d(10); const before = await customer(w); const kept = await bookOk(w, before, day); const usedBefore = await usedSlots(w, day);
      expect((await post(w.cash, `/bookings/days/${day}/stop`, {})).status).toBe(403);
      const s = await post(w.mgr, `/bookings/days/${day}/stop`, { reason: 'زحمة' }); expect(s.status).toBe(200);
      expect(s.body).toMatchObject({ date: day, stopped: true, stop_reason: 'زحمة' });
      expect((await post(w.mgr, `/bookings/days/${day}/stop`, {})).body.code).toBe('ALREADY_STOPPED');
      const c = await customer(w); const r = await book(w, c, day);
      expect(r.status).toBe(409); expect(r.body).toMatchObject({ code: 'DAY_STOPPED', next_available_date: d(11) });
      expect((await visitRow(kept.id)).status).toBe('booked');
      const days = (await get(w.cash, `/bookings/days?from=${day}&to=${d(11)}&doctor_id=${w.docAId}`)).body.days;
      expect(days[0]).toMatchObject({ date: day, stopped: true, stop_reason: 'زحمة', bookable: false }); expect(days[1]).toMatchObject({ stopped: false, bookable: true });
      expect((await get(w.cash, `/bookings?date=${day}`)).body.day).toMatchObject({ stopped: true });
      expect(await usedSlots(w, day)).toBe(usedBefore + 0);   // الحجز المرفوض ما أخذ مقعد
      expect((await post(w.mgr, `/bookings/days/${day}/resume`)).body).toMatchObject({ stopped: false, stop_reason: null });
      expect((await post(w.mgr, `/bookings/days/${day}/resume`)).body.code).toBe('NOT_STOPPED');
      expect((await book(w, c, day)).status).toBe(201);
      expect((await post(w.cash, `/bookings/days/${day}/resume`)).status).toBe(403);
    });

    it('أيام موقوفة متتالية: الاقتراح يتخطاها كلها', async () => {
      const wc = await world('BFV');
      for (const n of [30, 31]) expect((await post(wc.mgr, `/bookings/days/${d(n)}/stop`, {})).status).toBe(200);
      const r = await book(wc, await customer(wc), d(30));
      expect(r.body).toMatchObject({ code: 'DAY_STOPPED', next_available_date: d(32) });
    });

    it('تواريخ غلط: ماضي، بعيد، غير حقيقي. وما يأثر على فرع ثاني، والمالك يحدد الفرع', async () => {
      expect((await post(w.mgr, `/bookings/days/${d(-1)}/stop`, {})).status).toBe(400);
      expect((await post(w.mgr, `/bookings/days/${d(61)}/stop`, {})).status).toBe(400);
      expect((await post(w.mgr, `/bookings/days/2026-13-40/stop`, {})).body.code).toBe('INVALID_DATE');
      const day = d(12);
      expect((await post(w.mgr, `/bookings/days/${day}/stop`, {})).status).toBe(200);
      const cb = await customer(wb); expect((await book(wb, cb, day)).status).toBe(201);
      expect((await post(owner, `/bookings/days/${day}/stop`, { branch_id: wb.id })).status).toBe(200);
      expect((await book(wb, await customer(wb), day)).body.code).toBe('DAY_STOPPED');
    });

    it('الزبون بالتطبيق: اليوم الموقوف مو قابل للحجز، والجلسات الجديدة والنقل يتخطونه، والانضمام لزيارته الموجودة مسموح', async () => {
      const day = d(20);
      const p = await withPlan(w, day);                                  // زيارة جلسات الزبون باليوم
      expect((await post(w.mgr, `/bookings/days/${day}/stop`, {})).status).toBe(200);
      // الانضمام لزيارة الزبون الموجودة (ما ياخذ مقعد جديد) مسموح
      expect((await book(w, p.c, day, { type: 'sessions_only' })).status).toBe(201);
      // خطة جديدة تبدأ باليوم الموقوف: أول جلسة تنحجز لليوم اللي بعده
      const c2 = await customer(w); const b2 = await bookOk(w, c2, today);
      expect((await payCons(w, b2.consultation.id)).status).toBe(201); expect((await post(w.docA, `/consultations/${b2.consultation.id}/enter`)).status).toBe(201);
      const pl = await post(w.docA, `/consultations/${b2.consultation.id}/plan`, { items: [{ service_id: w.svc, values: { cc: 1 }, sessions_count: 1, interval_days: 1, first_session_date: day }] });
      expect(pl.status).toBe(201);
      expect((await one(`select scheduled_date::text as d from treatment_sessions where id = $1`, [pl.body.items[0].sessions[0].id])).d).toBe(d(21));
      // نقل جلسة (كاشير) لليوم الموقوف
      const p3 = await withPlan(w, d(22));
      const mv = await post(w.cash, `/sessions/${p3.sessions[0].id}/move`, { date: day });
      expect(mv.status).toBe(409); expect(mv.body.code).toBe('DAY_STOPPED'); expect(mv.body.next_available_date).toBe(d(21));
      // نقل الحجز نفسه
      const c4 = await customer(w); const b4 = await bookOk(w, c4, d(23));
      expect((await post(w.cash, `/bookings/${b4.id}/move`, { date: day })).body.code).toBe('DAY_STOPPED');
      expect((await visitRow(b4.id)).date).toBe(d(23));
    });

    it('إغلاق يوم دوام (نقل تلقائي) يتخطى الأيام الموقوفة', async () => {
      const wc = await world('BFE');
      const target = (() => { let x = 5; while (new Date(`${d(x)}T00:00:00Z`).getUTCDay() !== 1) x++; return d(x); })();   // اثنين قادم
      const c = await customer(wc); await bookOk(wc, c, target);
      const next = addDays(target, 1);
      expect((await post(wc.mgr, `/bookings/days/${next}/stop`, {})).status).toBe(200);
      const r = await put(wc.mgr, '/schedule/clinic-days', { days: [{ weekday: 1, is_open: false }] });
      expect(r.body).toMatchObject({ moved_visits: 1 });
      expect((await visitRow((await one(`select id from visits where customer_id = $1`, [c])).id)).date).toBe(addDays(target, 2));
    });
  });

  // ================================================================================================
  describe('ترحيل من دفع وما وصله الدور', () => {
    it('كشفية مدفوعة بيوم مضى: تنتقل لأقرب يوم فيه مكان برقم جديد بنهاية اليوم، وتظهر للطبيب باليوم الجديد وبقائمة المتابعة', async () => {
      const wr = await world('BFR');
      const c = await customer(wr); const b = await bookOk(wr, c, today);
      expect((await payCons(wr, b.consultation.id)).status).toBe(201);
      const other = await bookOk(wr, await customer(wr), today);      // واحد غيره باليوم: رقم 2
      await backdate(b.id);
      const r = await post(wr.mgr, '/bookings/close-past-days');
      expect(r.body).toMatchObject({ missed: 0, rolled_over: 1 });
      expect(await visitRow(b.id)).toMatchObject({ date: today, status: 'arrived', seq_no: 3 });     // آخر رقم باليوم
      expect(await usedSlots(wr, d(-1))).toBe(0); expect(await usedSlots(wr, today)).toBe(2);
      expect((await one(`select status from consultations where id = $1`, [b.consultation.id])).status).toBe('paid');
      const ev = await one(`select event, from_date::text as f, to_date::text as t, from_seq, to_seq, reason from booking_events where visit_id = $1 and event = 'rolled_over'`, [b.id]);
      expect(ev).toMatchObject({ f: d(-1), t: today, to_seq: 3 }); expect(ev.reason).toBeTruthy();
      expect((await get(wr.docA, '/doctor/queue')).body.queue.map((x: any) => x.consultation_id)).toContain(b.consultation.id);
      const fu = (await get(wr.cash, '/bookings/follow-up')).body;
      expect(fu.moved.find((m: any) => m.visit_id === b.id)).toMatchObject({ from_date: d(-1), to_date: today });
      expect((await post(wr.mgr, '/bookings/close-past-days')).body).toMatchObject({ missed: 0, rolled_over: 0 });   // مرة ثانية ما يسوي شي
      void other;
    });

    it('جلسة مدفوعة ما انفذت: الزيارة تنتقل وجلساتها وياها، وتنقفل حتى لو الكشفية خلصت', async () => {
      const p = await withPlan(w, today);
      expect((await post(w.docA, `/consultations/${p.b.consultation.id}/finish`)).status).toBe(201);
      expect((await paySess(w, [p.sessions[0].id])).status).toBe(201);
      await backdate(p.b.id, 2);
      const r = await post(w.mgr, '/bookings/close-past-days'); expect(r.body.rolled_over).toBeGreaterThanOrEqual(1);
      expect((await visitRow(p.b.id)).date).toBe(today);
      expect((await one(`select scheduled_date::text as d, status from treatment_sessions where id = $1`, [p.sessions[0].id]))).toMatchObject({ d: today, status: 'paid' });
    });

    it('كشفية مفتوحة عند الطبيب وبزيارتها جلسة مدفوعة: ما تنتقل (الطبيب يكملها)', async () => {
      const wr = await world('BFW');
      const p = await withPlan(wr, today);                                    // الكشفية with_doctor
      expect((await paySess(wr, [p.sessions[0].id])).status).toBe(201);
      await backdate(p.b.id);
      expect((await post(wr.mgr, '/bookings/close-past-days')).body.rolled_over).toBe(0);
      expect((await visitRow(p.b.id)).date).toBe(d(-1));
    });

    it('ما ينتقل: كشفية عند الطبيب لسه، منتهية بدون جلسات مدفوعة، وغير مدفوع (يصير فات)', async () => {
      const wr = await world('BFN');
      const open = await bookOk(wr, await customer(wr), today); await payCons(wr, open.consultation.id); await post(wr.docA, `/consultations/${open.consultation.id}/enter`);
      const done = await bookOk(wr, await customer(wr), today); await payCons(wr, done.consultation.id); await post(wr.docA, `/consultations/${done.consultation.id}/enter`); await post(wr.docA, `/consultations/${done.consultation.id}/finish`);
      const unpaid = await bookOk(wr, await customer(wr), today);
      for (const x of [open, done, unpaid]) await backdate(x.id);
      const r = await post(wr.mgr, '/bookings/close-past-days');
      expect(r.body).toMatchObject({ missed: 1, rolled_over: 0 });
      expect((await visitRow(open.id)).date).toBe(d(-1)); expect((await visitRow(done.id)).date).toBe(d(-1));
      expect((await visitRow(unpaid.id)).status).toBe('missed');
    });

    it('اليوم موقوف: يروح لأقرب يوم متاح. وإذا ما أكو يوم خلال 60 يوم يبقى ويطلع بقائمة «ما انخدموا»', async () => {
      const wr = await world('BFS');
      const b = await bookOk(wr, await customer(wr), today); await payCons(wr, b.consultation.id); await backdate(b.id);
      expect((await post(wr.mgr, `/bookings/days/${today}/stop`, {})).status).toBe(200);
      expect((await post(wr.mgr, '/bookings/close-past-days')).body.rolled_over).toBe(1);
      expect((await visitRow(b.id)).date).toBe(d(1));
      const wn = await world('BFU');
      const b2 = await bookOk(wn, await customer(wn), today); await payCons(wn, b2.consultation.id); await backdate(b2.id);
      for (let i = 0; i <= 60; i++) expect((await post(wn.mgr, `/bookings/days/${d(i)}/stop`, {})).status).toBe(200);
      expect((await post(wn.mgr, '/bookings/close-past-days')).body).toMatchObject({ rolled_over: 0 });
      expect((await visitRow(b2.id)).date).toBe(d(-1));
      const fu = (await get(wn.cash, '/bookings/follow-up')).body;
      expect(fu.unserved.map((x: any) => x.id)).toEqual([b2.id]);
      expect((await get(wr.cash, '/bookings/follow-up')).body.unserved).toEqual([]);
    }, 120000);

    it('الفروع ما تتداخل: ترحيل فرع ما يمس فرع ثاني', async () => {
      const x = await bookOk(w, await customer(w), today); await payCons(w, x.consultation.id);
      const y = await bookOk(wb, await customer(wb), today);
      await db.query(`update consultations set status = 'paid' where id = $1`, [y.consultation.id]); await db.query(`update visits set status = 'arrived' where id = $1`, [y.id]);
      await backdate(x.id); await backdate(y.id);
      await post(w.mgr, '/bookings/close-past-days');
      expect((await visitRow(x.id)).date).toBe(today); expect((await visitRow(y.id)).date).toBe(d(-1));
    });
  });

  // ================================================================================================
  describe('الدور عند الزبون', () => {
    it('«حاضرين قدامك»: يحسب اللي دفعوا وما انخدموا بس، ينقص لما ينخدمون، وما يطلع لحجز مو اليوم', async () => {
      const wt = await world('BFT'); const phone = '07871234597';
      await db.query(`delete from otp_requests where phone = $1`, ['+9647871234597']);
      await http().post('/customer/auth/request-otp').send({ phone });
      const code = [...sender.sent].reverse().find((x) => x.phone === '+9647871234597')!.code;
      const login = await http().post('/customer/auth/verify-otp').send({ phone, code, full_name: 'زبونة الدور', branch_id: wt.id });
      const tok = login.body.access_token as string; const cid = Number((await one(`select id from customers where phone = '+9647871234597'`)).id);
      const a = await bookOk(wt, await customer(wt), today); const bb = await bookOk(wt, await customer(wt), today); const nopay = await bookOk(wt, await customer(wt), today);
      const mine = await bookOk(wt, cid, today);
      const later = await bookOk(wt, cid, d(3));
      await payCons(wt, a.consultation.id); await payCons(wt, bb.consultation.id);
      const turn = async () => ((await get(tok, '/customer/bookings')).body.bookings as any[]).find((x) => x.id === mine.id).turn;
      const after = await bookOk(wt, await customer(wt), today); await payCons(wt, after.consultation.id);   // دفع بعده برقم أكبر
      expect(await turn()).toEqual({ seq_no: mine.seq_no, ahead: 2 });                      // الغير مدفوع واللي رقمه أكبر ما ينحسبون
      await post(wt.docA, `/consultations/${a.consultation.id}/enter`); expect((await turn()).ahead).toBe(2);   // عند الطبيب = لسه ينتظر دوره بالعيادة
      await post(wt.docA, `/consultations/${a.consultation.id}/finish`); expect((await turn()).ahead).toBe(1);
      expect(((await get(tok, '/customer/bookings')).body.bookings as any[]).find((x) => x.id === later.id).turn).toBeNull();
      void nopay;
    }, 60000);
  });
  // ================================================================================================
  describe('وصولات كل كاشير وخلص الزيارة', () => {
    it('الكاشير A استلم الكشفية وB استلم الجلسات: كل واحد يشوف وصولاته فقط، والمدير والمالك الكل، والورقة الجامعة كاملة', async () => {
      const ws = await world('BFX');
      const c = await customer(ws); const b = await bookOk(ws, c, today);
      const pa = await payCons(ws, b.consultation.id); expect(pa.status).toBe(201);                      // A (cash)
      expect((await post(ws.docA, `/consultations/${b.consultation.id}/enter`)).status).toBe(201);
      const pl = await post(ws.docA, `/consultations/${b.consultation.id}/plan`, { items: [{ service_id: ws.svc, values: { cc: 1 }, sessions_count: 2, interval_days: 7, first_session_date: today }] });
      expect((await post(ws.docA, `/consultations/${b.consultation.id}/finish`)).status).toBe(201);
      const pb = await paySess(ws, [pl.body.items[0].sessions[0].id], ws.cash2); expect(pb.status).toBe(201);   // B (cash2)
      const ids = (t: string, url: string) => get(t, url).then((r) => (r.body as any[]).map((x) => x.id).sort());
      expect(await ids(ws.cash, `/payments?date=${today}`)).toEqual([pa.body.id]);
      expect(await ids(ws.cash2, `/payments?date=${today}`)).toEqual([pb.body.id]);
      expect(await ids(ws.mgr, `/payments?date=${today}`)).toEqual([pa.body.id, pb.body.id].sort());
      expect(await ids(owner, `/payments?date=${today}&branch_id=${ws.id}`)).toEqual([pa.body.id, pb.body.id].sort());
      expect(await ids(ws.cash2, `/payments?customer_id=${c}`)).toEqual([pb.body.id]);
      expect((await get(ws.cash2, `/payments?receipt_no=${pa.body.receipt_no}`)).body).toEqual([]);          // بالرقم ما يلقاه
      expect((await get(ws.cash2, `/payments/${pa.body.id}`)).status).toBe(404);
      expect((await get(ws.cash, `/payments/${pa.body.id}`)).status).toBe(200);
      expect((await get(ws.cash, `/payments/${pb.body.id}`)).status).toBe(404);
      expect((await get(ws.mgr, `/payments/${pb.body.id}`)).status).toBe(200);
      // الورقة الجامعة للزبون: كاملة عند الاثنين، مع علامة «وصلي»
      for (const [t, mineIds] of [[ws.cash, [pa.body.id]], [ws.cash2, [pb.body.id]]] as const) {
        const r = await get(t, `/customers/${c}/day-receipt`); expect(r.status).toBe(200);
        expect(r.body.payment_ids).toEqual([pa.body.id, pb.body.id]); expect(r.body.net_amount).toBe(pa.body.net_amount + pb.body.net_amount);
        expect(r.body.payments.filter((x: any) => x.mine).map((x: any) => x.id)).toEqual(mineIds);
      }
      // الطباعة الجامعة تنسجل لكل الوصولات (حتى من كاشير ثاني)
      expect((await post(ws.cash2, '/payments/print', { payment_ids: [pa.body.id, pb.body.id] })).status).toBe(200);
      expect((await one(`select count(*)::int as n from receipt_prints where payment_id = any($1::bigint[])`, [[pa.body.id, pb.body.id]])).n).toBe(2);
      // الاسترجاع: بيانات الاسترجاع بس لصاحب الوصل
      const rf = await http().post(`/payments/${pb.body.id}/refund`).set(auth(ws.cash2)).set('Idempotency-Key', key()).send({ full_receipt: true, reason: 'تجربة الاسترجاع' });
      expect(rf.status).toBe(201);
      expect((await get(ws.cash2, `/refunds/${rf.body.id}`)).status).toBe(200);
      expect((await get(ws.cash, `/refunds/${rf.body.id}`)).status).toBe(404);
      expect((await get(ws.mgr, `/refunds/${rf.body.id}`)).status).toBe(200);
    }, 90000);

    it('تطبيق الزبون: الزيارة المنتهية finished (ما تطلع موعد قادم ولا دور)، والفعالة لا', async () => {
      const wc = await world('BFZ'); const phone = '07871234596';
      await db.query(`delete from otp_requests where phone = $1`, ['+9647871234596']);
      await http().post('/customer/auth/request-otp').send({ phone });
      const code = [...sender.sent].reverse().find((x) => x.phone === '+9647871234596')!.code;
      const login = await http().post('/customer/auth/verify-otp').send({ phone, code, full_name: 'زبونة منتهية', branch_id: wc.id });
      const tok = login.body.access_token as string; const cid = Number((await one(`select id from customers where phone = '+9647871234596'`)).id);
      const bk = await bookOk(wc, cid, today);
      const row = async () => ((await get(tok, '/customer/bookings')).body.bookings as any[]).find((x) => x.id === bk.id);
      expect(await row()).toMatchObject({ finished: false, turn: { seq_no: bk.seq_no } });
      await payCons(wc, bk.consultation.id); expect((await row()).finished).toBe(false);
      await post(wc.docA, `/consultations/${bk.consultation.id}/enter`); expect((await row()).finished).toBe(false);
      const pl = await post(wc.docA, `/consultations/${bk.consultation.id}/plan`, { items: [{ service_id: wc.svc, values: { cc: 1 }, sessions_count: 1, interval_days: 1, first_session_date: today }] });
      expect(pl.status).toBe(201); const sid = pl.body.items[0].sessions[0].id as number;
      await post(wc.docA, `/consultations/${bk.consultation.id}/finish`);
      expect((await row()).finished).toBe(false);                                          // جلسة اليوم لسه ما انفذت
      await db.query(`update consultations set status = 'cancelled' where id = $1`, [bk.consultation.id]);
      expect(await row()).toMatchObject({ finished: false });                              // بدون كشفية وبيها جلسة محجوزة: ما انتهت
      await db.query(`update treatment_sessions set status = 'completed', completed_at = now(), completed_by = $2 where id = $1`, [sid, wc.mgrId]);
      await db.query(`update consultations set status = 'finished' where id = $1`, [bk.consultation.id]);
      expect(await row()).toMatchObject({ finished: true, turn: null });
    }, 60000);

    it('خلصت (done): ملغية وفايتة وغيرها؛ كشفية جارية أو جلسة مجدولة/مدفوعة = ما خلصت؛ بعد تنفيذ كل الجلسات = خلصت', async () => {
      const wd = await world('BFY');
      const doneOf = async (c: number, date = today) => ((await get(wd.cash, `/bookings?date=${date}&customer_id=${c}`)).body.bookings as any[]).map((x) => x.done);
      // حجز غير مدفوع: ما خلص
      const c1 = await customer(wd); const b1 = await bookOk(wd, c1, today); expect(await doneOf(c1)).toEqual([false]);
      // ملغي: خلص
      expect((await post(wd.cash, `/bookings/${b1.id}/cancel`, { reason: 'تجربة الإلغاء' })).status).toBe(201); expect(await doneOf(c1)).toEqual([true]);
      // كشفية مدفوعة، عند الطبيب: ما خلصت. منتهية بدون جلسات: خلصت
      const c2 = await customer(wd); const b2 = await bookOk(wd, c2, today); await payCons(wd, b2.consultation.id); expect(await doneOf(c2)).toEqual([false]);
      await post(wd.docA, `/consultations/${b2.consultation.id}/enter`); expect(await doneOf(c2)).toEqual([false]);
      await post(wd.docA, `/consultations/${b2.consultation.id}/finish`); expect(await doneOf(c2)).toEqual([true]);
      // منتهية وجلسات اليوم مجدولة (ما اندفعت): ما خلصت؛ بعد دفعها خلصت عند الكاشير (الممرض ينفذها)؛ وبعد التنفيذ تبقى خلصت
      const p = await withPlan(wd, today); await post(wd.docA, `/consultations/${p.b.consultation.id}/finish`);
      expect(await doneOf(p.c)).toEqual([false]);
      expect((await paySess(wd, [p.sessions[0].id])).status).toBe(201); expect(await doneOf(p.c)).toEqual([true]);
      const nurse = Number((await one(`select id from users where username = $1`, [`mgr_BFY`])).id);
      await db.query(`update treatment_sessions set status = 'completed', completed_at = now(), completed_by = $2 where id = $1`, [p.sessions[0].id, nurse]);
      expect(await doneOf(p.c)).toEqual([true]);
      // فايتة: خلصت
      const c3 = await customer(wd); const b3 = await bookOk(wd, c3, today); await backdate(b3.id);
      await post(wd.mgr, '/bookings/close-past-days');
      expect(await doneOf(c3, d(-1))).toEqual([true]);
    }, 90000);
  });
});
