import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { LogOtpSender, OTP_SENDER } from '../src/customer-app/otp.service';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

interface World { id: number; code: string; mgr: string; mgrId: number; cash: string; docA: string; docAId: number; docB: string; docBId: number; cashMethod: number; svc: number; docCId: number }

describe('حجز كشفية لزبون عنده جلسات: تنضم لزيارته بنفس الرقم والمقعد', () => {
  let app: INestApplication; let db: Pool; let today: string; let owner: string; let sender: LogOtpSender;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  let phoneSeq = 0; let seq = 0;
  const key = () => `bj-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const day = (n: number) => addDays(today, n);
  const used = async (w: World, d: string) => Number((await one(`select coalesce((select used_slots from booking_days where branch_id = $1 and day = $2), 0) as u`, [w.id, d])).u);
  const pay = (w: World, cons: number, amount = 30000) => http().post('/payments/consultation').set(auth(w.cash)).set('Idempotency-Key', key()).send({ consultation_id: cons, tenders: [{ method_id: w.cashMethod, amount }] });

  async function world(code: string, limit = 1000): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name) values ($1,$1) returning id`, [code])).rows[0].id);
    await db.query(`insert into safes (branch_id) values ($1)`, [id]);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id); await seedUser(db, `cash_${code}`, 'cashier', id);
    const docAId = await seedUser(db, `docA_${code}`, 'doctor', id); const docBId = await seedUser(db, `docB_${code}`, 'doctor', id); await seedUser(db, `docC_${code}`, 'doctor', id);
    await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',100000000,'opening_balance','تجربة',$2)`, [id, mgrId]);
    const [mgr, cash, docA, docB] = await Promise.all([`mgr_${code}`, `cash_${code}`, `docA_${code}`, `docB_${code}`].map((u) => tokenFor(app, u)));
    expect((await put(mgr, `/schedule/doctors/${docAId}/weekly`, { days: [1, 2, 3, 4, 5, 6, 7].map((x) => ({ weekday: x, start_time: '09:00', end_time: '13:00' })), effective_from: today })).status).toBe(200);
    expect((await put(mgr, `/schedule/doctors/${docBId}/weekly`, { days: [1, 2, 3, 4, 5, 6, 7].map((x) => ({ weekday: x, start_time: '09:00', end_time: '13:00' })), effective_from: today })).status).toBe(200);
    const cur = (await get(mgr, '/settings')).body.settings.find((s: any) => s.key === 'booking.daily_limit');
    expect((await put(mgr, '/settings/booking.daily_limit', { value: limit, expected_version: cur.version })).status).toBe(200);
    const cs = Number((await db.query(`insert into services (branch_id, name_ar, kind, pricing_model, is_active) values ($1,'كشفية','consultation','fixed',true) returning id`, [id])).rows[0].id);
    await db.query(`insert into service_prices (service_id, price, set_by) values ($1,30000,$2)`, [cs, mgrId]);
    const cashMethod = Number((await db.query(`insert into payment_methods (branch_id, name_ar, kind, sort_order) values ($1,'كاش','cash',0) returning id`, [id])).rows[0].id);
    expect((await post(cash, '/shifts/open', { opening_float: 0 })).status).toBe(201);
    const bs = (await post(mgr, '/services', { name_ar: `ليزر ${code}`, pricing_model: 'per_unit', price: 50000 })).body;
    await post(mgr, `/services/${bs.id}/fields`, { field_key: 'cc', label_ar: 'كم', field_type: 'number', unit_label: 'cc', pricing_role: 'quantity', is_required: true });
    expect((await post(mgr, `/services/${bs.id}/activate`)).status).toBe(200);
    return { id, code, mgr, mgrId, cash, docA, docAId, docB, docBId, cashMethod, svc: bs.id, docCId: Number((await db.query(`select id from users where username = $1`, [`docC_${code}`])).rows[0].id) };
  }
  /** زبون بكشفية مدفوعة اليوم وخطة جلستين: الأولى بيوم +offset (زيارة جلسات بدون كشفية) والثانية بعدها بـ7 أيام */
  async function patient(w: World, offset: number) {
    phoneSeq++;
    const phone = `0788${String(phoneSeq).padStart(7, '0')}`;
    const c = (await post(w.cash, '/customers', { full_name: `زبون ضم ${phoneSeq}`, phone })).body.id as number;
    const b = await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docAId, date: today }); expect(b.status).toBe(201);
    const cons = b.body.consultation.id as number;
    expect((await pay(w, cons)).status).toBe(201);
    expect((await post(w.docA, `/consultations/${cons}/enter`)).status).toBe(201);
    const pl = await post(w.docA, `/consultations/${cons}/plan`, { items: [{ service_id: w.svc, values: { cc: 1 }, sessions_count: 2, interval_days: 7, first_session_date: day(offset) }] });
    expect(pl.status).toBe(201);
    const sessions = pl.body.items[0].sessions as { id: number; scheduled_date: string }[];
    const d = sessions[0].scheduled_date;
    const visit = await one(`select v.id::int as id, v.seq_no, v.status, v.doctor_id from treatment_sessions s join visits v on v.id = s.visit_id where s.id = $1`, [sessions[0].id]);
    return { c, phone, d, visit, sessions, cons, v0: b.body.id as number };
  }
  async function appLogin(phone: string, w: World) {
    await db.query(`delete from otp_requests where phone = $1`, [`+964${phone.replace(/^0/, '')}`]);
    expect((await http().post('/customer/auth/request-otp').send({ phone })).status).toBe(200);
    const norm = `+964${phone.replace(/^0/, '')}`; const code = [...sender.sent].reverse().find((s) => s.phone === norm)!.code;
    const r = await http().post('/customer/auth/verify-otp').send({ phone, code, full_name: 'زبون', branch_id: w.id });
    expect(r.status).toBe(200); return r.body.access_token as string;
  }

  let w: World;
  beforeAll(async () => {
    app = await makeApp(); db = pool(); sender = app.get(OTP_SENDER) as LogOtpSender;
    today = (await db.query(`select clinic_today()::text as d`)).rows[0].d; owner = await tokenFor(app, 'owner');
    w = await world('BJA');
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it('الكاشير يحجز كشفية ليوم فيه جلسات الزبون: تنضم لنفس الزيارة (نفس id ورقم التسلسل) بدون مقعد جديد', async () => {
    const p = await patient(w, 20); expect(p.visit.doctor_id).toBeNull();
    const before = await used(w, p.d);
    const r = await post(w.cash, '/bookings', { customer_id: p.c, doctor_id: w.docAId, date: p.d });
    expect(r.status).toBe(201);
    expect(r.body.id).toBe(p.visit.id); expect(r.body.seq_no).toBe(p.visit.seq_no);
    expect(r.body.consultation).toMatchObject({ kind: 'new', status: 'awaiting_payment' }); expect(r.body.doctor.id).toBe(w.docAId);
    expect(await used(w, p.d)).toBe(before);                                                                 // ما انحجز مقعد جديد
    expect(Number((await one(`select count(*)::int as n from visits where customer_id = $1 and visit_date = $2 and status in ('booked','arrived')`, [p.c, p.d])).n)).toBe(1);
    expect((await one(`select doctor_id::int as d from visits where id = $1`, [p.visit.id])).d).toBe(w.docAId);
    expect((await one(`select count(*)::int as n from treatment_sessions where visit_id = $1 and status = 'booked'`, [p.visit.id])).n).toBe(1);   // الجلسة باقية
    expect((await one(`select reason from booking_events where visit_id = $1 and event = 'booked' and consultation_id is not null`, [p.visit.id])).reason).toMatch(/انضمت/);
    expect((await one(`select (after_values->>'joined_existing_visit') as j from audit_log where action = 'booking.create' and entity_id = $1 order by id desc limit 1`, [p.visit.id])).j).toBe('true');
    const list = (await get(w.cash, `/bookings?date=${p.d}`)).body.bookings.filter((b: any) => b.customer.id === p.c);
    expect(list).toHaveLength(1);
  }, 60000);

  it('كشفية ثانية بنفس اليوم مرفوضة بوضوح مع أقرب يوم متاح (يتخطى أيام الزبون المشغولة)، وبعد إلغاء الأولى ينحجز', async () => {
    const p = await patient(w, 25);
    expect((await post(w.cash, '/bookings', { customer_id: p.c, doctor_id: w.docAId, date: p.d })).status).toBe(201);
    const dup = await post(w.cash, '/bookings', { customer_id: p.c, doctor_id: w.docAId, date: p.d });
    expect(dup.status).toBe(409); expect(dup.body.code).toBe('ALREADY_BOOKED_THAT_DAY'); expect(dup.body.message).toMatch(/كشفية فعالة بنفس هذا اليوم/);
    expect(dup.body.next_available_date).toBe(addDays(p.d, 1));
    const busyNext = await post(w.cash, '/bookings', { customer_id: p.c, doctor_id: w.docAId, date: addDays(p.d, 1) }); expect(busyNext.status).toBe(201);
    const dup2 = await post(w.cash, '/bookings', { customer_id: p.c, doctor_id: w.docAId, date: p.d });
    expect(dup2.body.next_available_date).toBe(addDays(p.d, 2));                                              // اليوم التالي صار مشغول بحجز الزبون
    const cancel = await post(w.cash, `/bookings/${busyNext.body.id}/cancel`, { reason: 'تجربة' }); expect(cancel.status).toBe(201);
    expect((await post(w.cash, '/bookings', { customer_id: p.c, doctor_id: w.docAId, date: addDays(p.d, 1) })).status).toBe(201);
  }, 60000);

  it('اليوم الممتلئ: الغريب مرفوض (DAY_FULL) لكن صاحب الزيارة يضيف كشفيته لزيارته (ما ياخذ مقعد)', async () => {
    const wl = await world('BJB', 5);
    const p = await patient(wl, 30);                                                                          // زيارة الجلسات تاخذ مقعد باليوم +30
    const cur = (await get(wl.mgr, '/settings')).body.settings.find((s: any) => s.key === 'booking.daily_limit');
    expect((await put(wl.mgr, '/settings/booking.daily_limit', { value: 1, expected_version: cur.version })).status).toBe(200);
    expect(await used(wl, p.d)).toBe(1);
    phoneSeq++; const stranger = (await post(wl.cash, '/customers', { full_name: 'غريب', phone: `0788${String(phoneSeq).padStart(7, '0')}` })).body.id;
    const full = await post(wl.cash, '/bookings', { customer_id: stranger, doctor_id: wl.docAId, date: p.d });
    expect(full.status).toBe(409); expect(full.body.code).toBe('DAY_FULL');
    const t = await appLogin(p.phone, wl);                                                                       // التوفر للزبون: يومه الممتلئ ينحجز له هو بس
    const dayInfo = (await http().get(`/customer/availability?from=${p.d}&to=${p.d}&doctor_id=${wl.docAId}`).set(auth(t))).body.days[0];
    expect(dayInfo).toMatchObject({ remaining: 0, customer_visit: { has_consultation: false }, bookable: true });
    const mine = await post(wl.cash, '/bookings', { customer_id: p.c, doctor_id: wl.docAId, date: p.d });
    expect(mine.status).toBe(201); expect(mine.body.id).toBe(p.visit.id); expect(await used(wl, p.d)).toBe(1);
  }, 60000);

  it('الطبيب ما يداوم بهذا اليوم أو العيادة مسكرة: ترفض حتى لو الزبون عنده زيارة (والزيارة ما تتغير)', async () => {
    const p = await patient(w, 35);
    const r = await post(w.cash, '/bookings', { customer_id: p.c, doctor_id: w.docCId, date: p.d });         // docC بدون جدول دوام
    expect(r.status).toBe(409); expect(r.body.code).toBe('DOCTOR_NOT_WORKING');
    expect((await one(`select doctor_id from visits where id = $1`, [p.visit.id])).doctor_id).toBeNull();
    expect((await one(`select count(*)::int as n from consultations where visit_id = $1`, [p.visit.id])).n).toBe(0);
    expect((await post(w.cash, '/bookings', { customer_id: p.c, doctor_id: w.docAId, date: p.d })).status).toBe(201);
  }, 60000);

  it('من تطبيق الزبون: نفس الشي، وتوفر الأيام يخبره: يوم فيه كشفية ما ينحجز، ويوم فيه جلسات بس ينحجز وفيه معلومات', async () => {
    const p = await patient(w, 40); const t = await appLogin(p.phone, w);
    const avail = async () => (await http().get(`/customer/availability?from=${addDays(p.d, -1)}&to=${addDays(p.d, 1)}&doctor_id=${w.docAId}`).set(auth(t))).body.days as any[];
    let days = await avail();
    expect(days.find((d) => d.date === addDays(p.d, -1))).toMatchObject({ customer_visit: null, bookable: true });
    expect(days.find((d) => d.date === p.d)).toMatchObject({ customer_visit: { has_consultation: false, sessions_count: 1 }, bookable: true });
    const r = await post(t, '/customer/bookings', { doctor_id: w.docAId, date: p.d });
    expect(r.status).toBe(201); expect(r.body.id).toBe(p.visit.id); expect(r.body.seq_no).toBe(p.visit.seq_no);
    days = await avail();
    expect(days.find((d) => d.date === p.d)).toMatchObject({ customer_visit: { has_consultation: true, sessions_count: 1 }, bookable: false });
    const dup = await post(t, '/customer/bookings', { doctor_id: w.docAId, date: p.d });
    expect(dup.status).toBe(409); expect(dup.body.code).toBe('ALREADY_BOOKED_THAT_DAY'); expect(dup.body.next_available_date).toBe(addDays(p.d, 1));
    const list = (await get(t, '/customer/bookings')).body.bookings.find((b: any) => b.id === p.visit.id);
    expect(list).toMatchObject({ kind: 'consultation', sessions_count: 1, cancellable: true, changeable: false, doctor_name: expect.any(String) });
  }, 60000);

  it('يوم مغلق أو يوم الطبيب فيه إجازة: ما ينحجز حتى لو للزبون جلسات بنفس اليوم', async () => {
    const p = await patient(w, 45); const t = await appLogin(p.phone, w);
    expect((await post(w.mgr, `/schedule/doctors/${w.docAId}/days-off`, { date: p.d, reason: 'تجربة' })).status).toBe(201);
    const days = (await http().get(`/customer/availability?from=${p.d}&to=${p.d}&doctor_id=${w.docAId}`).set(auth(t))).body.days as any[];
    expect(days[0]).toMatchObject({ customer_visit: { has_consultation: false, sessions_count: expect.any(Number) }, bookable: false });
    expect((await post(t, '/customer/bookings', { doctor_id: w.docAId, date: p.d })).status).toBe(409);
  }, 60000);

  it('إلغاء الكشفية المنضمة (كاشير أو زبون): تنلغي الكشفية بس، والزيارة والجلسة والرقم والمقعد يبقون، وبعدها ينحجز من جديد', async () => {
    const p = await patient(w, 50); const t = await appLogin(p.phone, w); const before = await used(w, p.d);
    const b = await post(t, '/customer/bookings', { doctor_id: w.docAId, date: p.d }); expect(b.status).toBe(201);
    const mv = await post(t, `/customer/bookings/${p.visit.id}/move`, { date: addDays(p.d, 3) });
    expect(mv.status).toBe(409); expect(mv.body.code).toBe('HAS_SESSIONS');
    const c1 = await post(t, `/customer/bookings/${p.visit.id}/cancel`); expect(c1.status).toBe(200);
    const av = (await http().get(`/customer/availability?from=${p.d}&to=${p.d}&doctor_id=${w.docAId}`).set(auth(t))).body.days[0];
    expect(av).toMatchObject({ customer_visit: { has_consultation: false, sessions_count: 1 }, bookable: true });          // رجع يقدر يحجز
    expect(await one(`select status, seq_no from visits where id = $1`, [p.visit.id])).toMatchObject({ status: 'booked', seq_no: p.visit.seq_no });
    expect((await one(`select status from treatment_sessions where id = $1`, [p.sessions[0].id])).status).toBe('booked');
    expect(await used(w, p.d)).toBe(before);
    expect((await one(`select doctor_id from visits where id = $1`, [p.visit.id])).doctor_id).toBeNull();               // رجعت زيارة جلسات بدون طبيب
    expect((await one(`select count(*)::int as n from consultations where visit_id = $1 and status <> 'cancelled'`, [p.visit.id])).n).toBe(0);
    expect((await one(`select action from audit_log where entity_id = $1 and action = 'booking.cancel_consultation_only'`, [p.visit.id])).action).toBeTruthy();
    const again = await post(w.cash, '/bookings', { customer_id: p.c, doctor_id: w.docAId, date: p.d });               // الكاشير يحجز من جديد
    expect(again.status).toBe(201); expect(again.body.id).toBe(p.visit.id);
    const c2 = await post(w.cash, `/bookings/${p.visit.id}/cancel`, { reason: 'تجربة' }); expect(c2.status).toBe(201);   // وإلغاء الكاشير نفس القاعدة
    expect((await one(`select status from visits where id = $1`, [p.visit.id])).status).toBe('booked');
    expect((await one(`select status from treatment_sessions where id = $1`, [p.sessions[0].id])).status).toBe('booked');
  }, 90000);

  /** ينقل زيارة ليوم ثاني بالقاعدة بشكل متسق (مقاعد الأيام وأرقام التسلسل وتواريخ الجلسات) لنختبر حالات «اليوم» بدون انتظار الزمن */
  async function shiftVisit(w2: World, visitId: number, to: string) {
    const v = await one(`select visit_date::text as d from visits where id = $1`, [visitId]);
    await db.query(`update booking_days set used_slots = used_slots - 1 where branch_id = $1 and day = $2`, [w2.id, v.d]);
    const r = await one(`insert into booking_days (branch_id, day, used_slots, last_seq) values ($1,$2,1,1) on conflict (branch_id, day) do update set used_slots = booking_days.used_slots + 1, last_seq = booking_days.last_seq + 1 returning last_seq`, [w2.id, to]);
    await db.query(`update visits set visit_date = $2, seq_no = $3 where id = $1`, [visitId, to, r.last_seq]);
    await db.query(`update treatment_sessions set scheduled_date = $2 where visit_id = $1 and status in ('booked','paid')`, [visitId, to]);
    return Number(r.last_seq);
  }
  /** زبون عنده اليوم زيارة جلسات بدون كشفية (وكشفيته الأصلية صارت أمس) */
  async function todaySessionsVisit(w2: World) {
    const p = await patient(w2, 20);
    await shiftVisit(w2, p.v0, day(-1)); const seqNo = await shiftVisit(w2, p.visit.id, today);
    return { ...p, seqNo };
  }
  const paySession = (w2: World, sid: number) => http().post('/payments/sessions').set(auth(w2.cash)).set('Idempotency-Key', key()).send({ session_ids: [sid], tenders: [{ method_id: w2.cashMethod, amount: 50000 }] });

  it('الدفع: كشفية منضمة لزيارة جلسات اليوم تنقبل الدفع وتظهر بقائمة الطبيب بنفس الرقم، والجلسة باقية', async () => {
    const p = await todaySessionsVisit(w); const before = await used(w, today);
    const b = await post(w.cash, '/bookings', { customer_id: p.c, doctor_id: w.docBId, date: today });
    expect(b.status).toBe(201); expect(b.body.id).toBe(p.visit.id); expect(b.body.seq_no).toBe(p.seqNo); expect(b.body.consultation.kind).toBe('new');
    expect(await used(w, today)).toBe(before);
    const r = await pay(w, b.body.consultation.id); expect(r.status).toBe(201);
    expect(await one(`select v.status as vs, c.status as cs from visits v join consultations c on c.visit_id = v.id where v.id = $1 and c.status <> 'cancelled'`, [p.visit.id])).toEqual({ vs: 'arrived', cs: 'paid' });
    expect((await one(`select status from treatment_sessions where id = $1`, [p.sessions[0].id])).status).toBe('booked');
    expect((await get(w.docB, '/doctor/queue')).body.queue.some((q: any) => q.consultation_id === b.body.consultation.id && q.seq_no === p.seqNo)).toBe(true);
  }, 90000);

  it('جلسة اليوم اندفعت أول (الزيارة «حضر») ثم انضمت كشفية: تنقبل الدفع بدون ما ينكسر شي', async () => {
    const p = await todaySessionsVisit(w);
    expect((await paySession(w, p.sessions[0].id)).status).toBe(201);
    expect((await one(`select status from visits where id = $1`, [p.visit.id])).status).toBe('arrived');
    const b = await post(w.cash, '/bookings', { customer_id: p.c, doctor_id: w.docBId, date: today }); expect(b.status).toBe(201); expect(b.body.id).toBe(p.visit.id);
    const r = await pay(w, b.body.consultation.id); expect(r.status).toBe(201);
    expect((await one(`select status from visits where id = $1`, [p.visit.id])).status).toBe('arrived');
    expect((await one(`select status from treatment_sessions where id = $1`, [p.sessions[0].id])).status).toBe('paid');
  }, 90000);

  it('زيارة «حضر» (جلسة مدفوعة) وعليها كشفية منضمة غير مدفوعة: الزبون يشوف «إلغاء الكشفية» ويلغيها والجلسة المدفوعة والزيارة تبقى', async () => {
    const p = await todaySessionsVisit(w); const t = await appLogin(p.phone, w);
    expect((await paySession(w, p.sessions[0].id)).status).toBe(201);
    const b = await post(t, '/customer/bookings', { doctor_id: w.docBId, date: today }); expect(b.status).toBe(201); expect(b.body.id).toBe(p.visit.id);
    const row = async () => (await get(t, '/customer/bookings')).body.bookings.find((x: any) => x.id === p.visit.id);
    expect(await row()).toMatchObject({ status: 'arrived', cancellable: true, changeable: false, sessions_count: 1 });
    expect((await post(t, `/customer/bookings/${p.visit.id}/cancel`)).status).toBe(200);
    expect(await one(`select v.status as vs, s.status as ss from visits v join treatment_sessions s on s.visit_id = v.id where v.id = $1`, [p.visit.id])).toEqual({ vs: 'arrived', ss: 'paid' });
    expect(await row()).toMatchObject({ kind: 'sessions', cancellable: false });
    expect((await one(`select reason from booking_events where visit_id = $1 and event = 'cancelled' and consultation_id is not null order by id desc limit 1`, [p.visit.id])).reason).toMatch(/الكشفية فقط/);
  }, 90000);

  it('استرجاع الكشفية المنضمة (قبل دخول الطبيب): تنلغي بس؛ الزيارة والجلسة والمقعد باقيين ورجوع «محجوز» إذا ما أكو جلسة مدفوعة', async () => {
    const p = await todaySessionsVisit(w); const before = await used(w, today);
    const b = await post(w.cash, '/bookings', { customer_id: p.c, doctor_id: w.docBId, date: today });
    const pr = await pay(w, b.body.consultation.id); expect(pr.status).toBe(201);
    const rf = await http().post(`/payments/${pr.body.id}/refund`).set(auth(w.cash)).set('Idempotency-Key', key()).send({ full_receipt: true, reason: 'تجربة الاسترجاع' });
    expect(rf.status).toBe(201);
    expect((await one(`select status from consultations where id = $1`, [b.body.consultation.id])).status).toBe('cancelled');
    expect(await one(`select status, seq_no from visits where id = $1`, [p.visit.id])).toEqual({ status: 'booked', seq_no: p.seqNo });
    expect((await one(`select status from treatment_sessions where id = $1`, [p.sessions[0].id])).status).toBe('booked');
    expect(await used(w, today)).toBe(before);
    expect((await one(`select doctor_id from visits where id = $1`, [p.visit.id])).doctor_id).toBeNull();
  }, 90000);

  it('استرجاع الكشفية المنضمة وبالزيارة جلسة مدفوعة: الزيارة تبقى «حضر»', async () => {
    const p = await todaySessionsVisit(w);
    expect((await paySession(w, p.sessions[0].id)).status).toBe(201);
    const b = await post(w.cash, '/bookings', { customer_id: p.c, doctor_id: w.docBId, date: today });
    const pr = await pay(w, b.body.consultation.id); expect(pr.status).toBe(201);
    const rf = await http().post(`/payments/${pr.body.id}/refund`).set(auth(w.cash)).set('Idempotency-Key', key()).send({ full_receipt: true, reason: 'تجربة' });
    expect(rf.status).toBe(201);
    expect((await one(`select status from visits where id = $1`, [p.visit.id])).status).toBe('arrived');
    expect((await one(`select status from treatment_sessions where id = $1`, [p.sessions[0].id])).status).toBe('paid');
    expect((await one(`select doctor_id from visits where id = $1`, [p.visit.id])).doctor_id).toBeNull();
  }, 90000);

  it('مراجعة مجانية منضمة لزيارة جلسات: الدخول بدون دفع ثم إلغاء الدخول يلغي المراجعة بس والزيارة تبقى «محجوز»', async () => {
    const p = await todaySessionsVisit(w); const before = await used(w, today);
    const f = await post(w.cash, '/bookings', { customer_id: p.c, doctor_id: w.docAId, date: today });                       // نفس طبيب الكشفية الأصلية خلال أسبوع
    expect(f.status).toBe(201); expect(f.body.id).toBe(p.visit.id); expect(f.body.consultation.kind).toBe('free_followup');
    expect((await post(w.cash, `/consultations/${f.body.consultation.id}/check-in`)).status).toBe(201);
    expect((await one(`select status from visits where id = $1`, [p.visit.id])).status).toBe('arrived');
    const c = await post(w.cash, `/consultations/${f.body.consultation.id}/cancel-check-in`, { reason: 'ما جا' });
    expect(c.status).toBe(201); expect(c.body).toMatchObject({ status: 'cancelled', visit_status: 'booked' });
    expect(await one(`select status, seq_no from visits where id = $1`, [p.visit.id])).toEqual({ status: 'booked', seq_no: p.seqNo });
    expect((await one(`select status from treatment_sessions where id = $1`, [p.sessions[0].id])).status).toBe('booked');
    expect(await used(w, today)).toBe(before);
    expect((await one(`select doctor_id from visits where id = $1`, [p.visit.id])).doctor_id).toBeNull();
  }, 90000);

  it('حجز كشفية عادية ثم إلغاؤها بالكامل (بدون جلسات): اليوم يرجع متاح للزبون ولا يُحسب حجزاً', async () => {
    const p = await patient(w, 30); const t = await appLogin(p.phone, w); const free = addDays(p.d, 2);
    const b = await post(t, '/customer/bookings', { doctor_id: w.docAId, date: free }); expect(b.status).toBe(201); expect(b.body.id).not.toBe(p.visit.id);
    const av = async () => (await http().get(`/customer/availability?from=${free}&to=${free}&doctor_id=${w.docAId}`).set(auth(t))).body.days[0];
    expect(await av()).toMatchObject({ customer_visit: { has_consultation: true, sessions_count: 0 }, bookable: false });
    expect((await post(t, `/customer/bookings/${b.body.id}/cancel`)).status).toBe(200);
    expect(await av()).toMatchObject({ customer_visit: null, bookable: true });
    expect((await one(`select status from visits where id = $1`, [b.body.id])).status).toBe('cancelled');
  }, 60000);

  it('حجز فات (ما حضر): ما يظهر له «إلغاء» ولا «تغيير» (القائمة تعرض الفايت بس)', async () => {
    const p = await patient(w, 30); const t = await appLogin(p.phone, w); const free = addDays(p.d, 2);
    const b = await post(t, '/customer/bookings', { doctor_id: w.docAId, date: free }); expect(b.status).toBe(201);
    await db.query(`update visits set status = 'missed' where id = $1`, [b.body.id]);                                    // الغياب يرجع المقعد (نفس ما تسوي المهمة المجدولة)
    await db.query(`update booking_days set used_slots = greatest(used_slots - 1, 0) where branch_id = $1 and day = $2`, [w.id, free]);
    const row = (await get(t, '/customer/bookings')).body.bookings.find((x: any) => x.id === b.body.id);
    expect(row).toMatchObject({ status: 'missed', cancellable: false, changeable: false });
  }, 60000);

  it('مراجعة مجانية: الدخول بدون دفع على زيارة «حضر» (جلسة اندفعت قبلها) ينقبل', async () => {
    const p = await todaySessionsVisit(w);
    expect((await paySession(w, p.sessions[0].id)).status).toBe(201);
    const f = await post(w.cash, '/bookings', { customer_id: p.c, doctor_id: w.docAId, date: today }); expect(f.status).toBe(201); expect(f.body.consultation.kind).toBe('free_followup');
    expect((await post(w.cash, `/consultations/${f.body.consultation.id}/check-in`)).status).toBe(201);
    expect((await one(`select c.status as cs, v.status as vs from consultations c join visits v on v.id = c.visit_id where c.id = $1`, [f.body.consultation.id]))).toEqual({ cs: 'paid', vs: 'arrived' });
    const c = await post(w.cash, `/consultations/${f.body.consultation.id}/cancel-check-in`, { reason: 'ما جا' });
    expect(c.body).toMatchObject({ status: 'cancelled', visit_status: 'arrived' });                              // جلسة مدفوعة بالزيارة: تبقى «حضر»
  }, 90000);

  it('كل شي بعد ذلك متسق: فحوصات سلامة النظام نظيفة (مقاعد الأيام = الزيارات الفعالة)', async () => {
    // فروع هذا الملف بس (ملفات ثانية تعدل القاعدة مباشرة وتترك فروعها بدون توازن، وهذا ما يخصنا)
    const bad = await db.query(`select c.* from v_integrity_checks c where c.entity_id in (select id from branches where code like 'BJ%') and (c.check_name like '%slot%' or c.check_name like '%visit%' or c.check_name like '%booking%')`);
    expect(bad.rows).toEqual([]);
  });
});
