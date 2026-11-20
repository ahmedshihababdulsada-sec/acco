import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const isoDow = (d: string) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w === 0 ? 7 : w; };
const nextDow = (from: string, dow: number) => { let d = addDays(from, 1); while (isoDow(d) !== dow) d = addDays(d, 1); return d; };

interface World { id: number; code: string; mgr: string; cash: string; doctorA: number; doctorB: number; docAToken: string }

describe('الحجز', () => {
  let app: INestApplication; let db: Pool; let today: string; let owner: string; let nurse: string; let cash1: string; let mgr1: string;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const d = (n: number) => addDays(today, n);
  let phoneSeq = 0;
  const week = (days: number[]) => days.map((w) => ({ weekday: w, start_time: '09:00', end_time: '13:00' }));

  /** فرع جديد معزول: مدير وكاشير وطبيبين يداومون كل الأيام من اليوم. */
  async function world(code: string): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name) values ($1,$1) returning id`, [code])).rows[0].id);
    await seedUser(db, `mgr_${code}`, 'manager', id); await seedUser(db, `cash_${code}`, 'cashier', id);
    const doctorA = await seedUser(db, `docA_${code}`, 'doctor', id); const doctorB = await seedUser(db, `docB_${code}`, 'doctor', id);
    const [mgr, cash, docAToken] = await Promise.all([`mgr_${code}`, `cash_${code}`, `docA_${code}`].map((u) => tokenFor(app, u)));
    for (const doc of [doctorA, doctorB]) expect((await put(mgr, `/schedule/doctors/${doc}/weekly`, { days: week([1, 2, 3, 4, 5, 6, 7]), effective_from: today })).status).toBe(200);
    return { id, code, mgr, cash, doctorA, doctorB, docAToken };
  }
  async function cust(t: string, name = 'زبون حجز'): Promise<number> {
    phoneSeq++;
    const r = await post(t, '/customers', { full_name: `${name} ${phoneSeq}`, phone: `0790${String(phoneSeq).padStart(7, '0')}` });
    expect(r.status).toBe(201);
    return r.body.id;
  }
  const book = (t: string, customer_id: number, doctor_id: number, date: string, extra: object = {}) => post(t, '/bookings', { customer_id, doctor_id, date, ...extra });
  async function bookOk(t: string, doctor: number, date: string, customer?: number) {
    const c = customer ?? (await cust(t));
    const r = await book(t, c, doctor, date);
    expect(r.status).toBe(201);
    return { ...r.body, customer_id: c };
  }
  async function setSetting(t: string, key: string, value: number, branch?: number) {
    const q = branch ? `?branch_id=${branch}` : '';
    const cur = (await get(t, `/settings${q}`)).body.settings.find((s: any) => s.key === key);
    const r = await put(t, `/settings/${key}`, { value, expected_version: cur.version, ...(branch ? { branch_id: branch } : {}) });
    expect(r.status).toBe(200);
  }
  const markPaid = async (visitId: number) => {
    await db.query(`update consultations set status = 'paid' where visit_id = $1`, [visitId]);
    await db.query(`update visits set status = 'arrived' where id = $1`, [visitId]);
  };
  const enterDoctor = async (visitId: number) => {
    await db.query(`update consultations set status = 'with_doctor', entered_at = now() where visit_id = $1`, [visitId]);
    await db.query(`update visits set status = 'arrived' where id = $1`, [visitId]);
  };
  const dayRow = async (b: number, day: string) => (await db.query(`select used_slots, last_seq from booking_days where branch_id = $1 and day = $2`, [b, day])).rows[0] ?? { used_slots: 0, last_seq: 0 };
  const visitRow = async (id: number) => (await db.query(`select visit_date::text as date, seq_no, status from visits where id = $1`, [id])).rows[0];
  /** تطابق الحد اليومي: المستخدم بكل يوم مستقبلي = عدد الزيارات الفعالة */
  const assertConsistent = async (b: number) => {
    const bad = await db.query(
      `select bd.day::text, bd.used_slots, (select count(*)::int from visits v where v.branch_id = bd.branch_id and v.visit_date = bd.day and v.status in ('booked','arrived')) as active
         from booking_days bd where bd.branch_id = $1 and bd.day >= clinic_today() and bd.used_slots <> (select count(*)::int from visits v where v.branch_id = bd.branch_id and v.visit_date = bd.day and v.status in ('booked','arrived'))`, [b]);
    expect(bad.rows).toEqual([]);
    const seqs = await db.query(`select v.visit_date::text, count(*)::int as n, count(distinct seq_no)::int as dn from visits v where v.branch_id = $1 group by v.visit_date having count(*) <> count(distinct seq_no)`, [b]);
    expect(seqs.rows).toEqual([]);
  };

  beforeAll(async () => {
    app = await makeApp(); db = pool();
    today = (await db.query(`select clinic_today()::text as d`)).rows[0].d;
    [owner, nurse, cash1, mgr1] = await Promise.all(['owner', 'nurse1', 'cash1', 'mgr1'].map((u) => tokenFor(app, u)));
  });
  afterAll(async () => { await app.close(); await db.end(); });

  // ------------------------------------------------------------------------------------------------
  describe('الصلاحيات وفصل الفروع', () => {
    let w: World; let other: World;
    beforeAll(async () => { w = await world('BKP1'); other = await world('BKP2'); });
    it('الممرض والطبيب ما يحجزون، والطبيب يقرأ، وبدون توكن 401', async () => {
      const c = await cust(w.cash);
      expect((await book(nurse, c, w.doctorA, d(2))).status).toBe(403);
      expect((await book(w.docAToken, c, w.doctorA, d(2))).status).toBe(403);
      expect((await get(nurse, '/bookings')).status).toBe(403);
      expect((await get(w.docAToken, '/bookings')).status).toBe(200);
      expect((await http().post('/bookings').send({})).status).toBe(401);
    });
    it('مدير/كاشير فرع ثاني ما يشوف ولا يعدل حجوزات هذا الفرع، وما يحجز على طبيب فرعه', async () => {
      const b = await bookOk(w.cash, w.doctorA, d(3));
      expect((await post(other.cash, `/bookings/${b.id}/cancel`, { reason: 'تجربة' })).status).toBe(404);
      expect((await post(other.mgr, `/bookings/${b.id}/move`, { date: d(4) })).status).toBe(404);
      expect((await book(other.cash, await cust(other.cash), w.doctorA, d(3))).status).toBe(404);        // طبيب فرع ثاني
      expect((await get(other.cash, `/bookings?date=${d(3)}`)).body.bookings).toEqual([]);
      expect((await get(owner, `/bookings?date=${d(3)}&branch_id=${w.id}`)).body.bookings.map((x: any) => x.id)).toEqual([b.id]);
      expect((await get(owner, `/bookings?date=${d(3)}`)).status).toBe(400);                              // المالك لازم يحدد الفرع
    });
    it('الكاشير ما ينقل الحجز لفرع ثاني (ما أكو مسار لهذا)، وإغلاق الأيام للمدير والمالك بس', async () => {
      expect((await post(w.cash, '/bookings/close-past-days')).status).toBe(403);
      expect((await post(nurse, '/bookings/close-past-days')).status).toBe(403);
      expect((await post(w.mgr, '/bookings/close-past-days')).status).toBe(201);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('إنشاء الحجز', () => {
    let w: World;
    beforeAll(async () => { w = await world('BKC'); });
    it('كشفية جديدة: رقم 1 ثم 2، مكان مستخدم، كشفية بانتظار الدفع، وحدث وسجل حركات', async () => {
      const a = await bookOk(w.cash, w.doctorA, d(2));
      expect(a).toMatchObject({ date: d(2), seq_no: 1, status: 'booked', source: 'cashier', branch_id: w.id,
        doctor: { id: w.doctorA }, consultation: { kind: 'new', status: 'awaiting_payment' } });
      const b = await bookOk(w.cash, w.doctorB, d(2));
      expect(b.seq_no).toBe(2);
      expect(await dayRow(w.id, d(2))).toMatchObject({ used_slots: 2, last_seq: 2 });
      const ev = (await db.query(`select event, to_date::text as to_date, to_seq, actor_user_id from booking_events where visit_id = $1`, [a.id])).rows;
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ event: 'booked', to_date: d(2), to_seq: 1 });
      expect((await db.query(`select 1 from audit_log where action = 'booking.create' and entity_id = $1`, [a.id])).rowCount).toBe(1);
      const created = (await db.query(`select created_by from visits where id = $1`, [a.id])).rows[0];
      expect(created.created_by).not.toBeNull();
    });
    it('اليوم نفسه مسموح، والأيام الماضية والبعيدة والتاريخ الغلط مرفوضة', async () => {
      const c = await cust(w.cash);
      expect((await book(w.cash, c, w.doctorA, today)).status).toBe(201);
      const c2 = await cust(w.cash);
      expect((await book(w.cash, c2, w.doctorA, d(-1))).body.code).toBe('DATE_IN_PAST');
      expect((await book(w.cash, c2, w.doctorA, d(61))).body.code).toBe('DATE_TOO_FAR');
      expect((await book(w.cash, c2, w.doctorA, d(60))).status).toBe(201);
      expect((await book(w.cash, c2, w.doctorA, '2026-02-30')).body.code).toBe('INVALID_DATE');
      expect((await book(w.cash, c2, w.doctorA, 'غدا')).status).toBe(400);
    });
    it('زبون/طبيب غير موجود، طبيب معطل، زبون مدموج، حقول ناقصة أو زايدة', async () => {
      const c = await cust(w.cash);
      expect((await book(w.cash, 99999999, w.doctorA, d(3))).status).toBe(404);
      expect((await book(w.cash, c, 99999999, d(3))).status).toBe(404);
      const nonDoc = Number((await db.query(`select id from users where username = $1`, [`cash_${w.code}`])).rows[0].id);
      expect((await book(w.cash, c, nonDoc, d(3))).status).toBe(404);                                       // مو طبيب
      const off = await seedUser(db, 'docOff_BKC', 'doctor', w.id, { active: false });
      expect((await book(w.cash, c, off, d(3))).body.code).toBe('DOCTOR_INACTIVE');
      const m = await cust(w.cash);
      const target = await cust(w.cash);
      await db.query(`update customers set status = 'merged', merged_into_id = $2 where id = $1`, [m, target]);
      expect((await book(w.cash, m, w.doctorA, d(3))).body.code).toBe('CUSTOMER_MERGED');
      expect((await post(w.cash, '/bookings', { customer_id: c, date: d(3) })).status).toBe(400);
      expect((await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.doctorA, date: d(3), seq_no: 5 })).status).toBe(400);
    });
    it('زبون عنده حجز فعال بنفس اليوم → 409 والرقم ما ينحرق، وبعد الإلغاء ينحجز برقم جديد (الملغى ما ينعاد)', async () => {
      const day = d(5);
      const c = await cust(w.cash);
      const a = await book(w.cash, c, w.doctorA, day);
      expect(a.body.seq_no).toBe(1);
      const dup = await book(w.cash, c, w.doctorB, day);
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('ALREADY_BOOKED_THAT_DAY');
      expect(await dayRow(w.id, day)).toMatchObject({ used_slots: 1, last_seq: 1 });
      expect((await bookOk(w.cash, w.doctorA, day)).seq_no).toBe(2);
      expect((await post(w.cash, `/bookings/${a.body.id}/cancel`, { reason: 'تجربة' })).status).toBe(201);
      const again = await book(w.cash, c, w.doctorA, day);
      expect(again.status).toBe(201);
      expect(again.body.seq_no).toBe(3);                                                                  // مو 1
      expect(await dayRow(w.id, day)).toMatchObject({ used_slots: 2, last_seq: 3 });
      await assertConsistent(w.id);
    });
    it('الزبون يحجز بأيام مختلفة عادي', async () => {
      const c = await cust(w.cash);
      expect((await book(w.cash, c, w.doctorA, d(6))).status).toBe(201);
      expect((await book(w.cash, c, w.doctorA, d(7))).status).toBe(201);
      const p = (await get(w.cash, `/customers/${c}`)).body;
      expect(p.upcoming_visits.map((v: any) => v.date)).toEqual([d(6), d(7)]);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('الحد اليومي والتزامن', () => {
    let w: World;
    beforeAll(async () => { w = await world('BKL'); });
    it('الحد 3: الرابع يرفض ويعرض أقرب يوم بيه مكان، والإلغاء يرجع المكان بدون إعادة الرقم', async () => {
      await setSetting(w.mgr, 'booking.daily_limit', 3);
      const day = d(4);
      const made = [await bookOk(w.cash, w.doctorA, day), await bookOk(w.cash, w.doctorA, day), await bookOk(w.cash, w.doctorB, day)];
      const c4 = await cust(w.cash);
      const full = await book(w.cash, c4, w.doctorA, day);
      expect(full.status).toBe(409);
      expect(full.body).toMatchObject({ code: 'DAY_FULL', next_available_date: addDays(day, 1) });
      expect(await dayRow(w.id, day)).toMatchObject({ used_slots: 3, last_seq: 3 });
      await post(w.cash, `/bookings/${made[1].id}/cancel`, { reason: 'تجربة' });
      const ok = await book(w.cash, c4, w.doctorA, day);
      expect(ok.status).toBe(201);
      expect(ok.body.seq_no).toBe(4);
      expect((await get(w.cash, `/bookings?date=${day}`)).body.day).toMatchObject({ daily_limit: 3, used_slots: 3, remaining: 0, last_seq: 4 });
      await assertConsistent(w.id);
    });
    it('اليوم الممتلئ يتخطى الأيام الممتلئة بالاقتراح ويتخطى يوم الزبون المحجوز', async () => {
      const day = d(10);
      const c = await cust(w.cash);
      for (let i = 0; i < 3; i++) await bookOk(w.cash, w.doctorA, day);
      for (let i = 0; i < 3; i++) await bookOk(w.cash, w.doctorA, addDays(day, 1));
      await bookOk(w.cash, w.doctorA, addDays(day, 2), c);                                                 // الزبون محجوز باليوم الثالث
      const full = await book(w.cash, c, w.doctorA, day);
      expect(full.body).toMatchObject({ code: 'DAY_FULL', next_available_date: addDays(day, 3) });
    });
    it('12 حجز متزامن على 5 أماكن: بالضبط 5 ينجحون بأرقام 1..5 والباقي DAY_FULL', async () => {
      await setSetting(w.mgr, 'booking.daily_limit', 5);
      const day = d(20);
      const cs = await Promise.all(Array.from({ length: 12 }, () => cust(w.cash)));
      const rs = await Promise.all(cs.map((c, i) => book(i % 2 ? w.cash : w.mgr, c, i % 3 ? w.doctorA : w.doctorB, day)));
      const ok = rs.filter((r) => r.status === 201);
      expect(ok).toHaveLength(5);
      expect(ok.map((r) => r.body.seq_no).sort()).toEqual([1, 2, 3, 4, 5]);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'DAY_FULL')).toHaveLength(7);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(await dayRow(w.id, day)).toMatchObject({ used_slots: 5, last_seq: 5 });
      await assertConsistent(w.id);
    });
    it('نفس الزبون 6 مرات متزامنة بنفس اليوم: وحدة تنجح والباقي ALREADY_BOOKED', async () => {
      await setSetting(w.mgr, 'booking.daily_limit', 50);
      const day = d(21); const c = await cust(w.cash);
      const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => book(w.cash, c, i % 2 ? w.doctorA : w.doctorB, day)));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'ALREADY_BOOKED_THAT_DAY')).toHaveLength(5);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(await dayRow(w.id, day)).toMatchObject({ used_slots: 1, last_seq: 1 });
    });
    it('حجز وإلغاء متزامنين: العد يبقى مطابق للزيارات الفعالة', async () => {
      const day = d(22);
      const first = await Promise.all(Array.from({ length: 6 }, async () => bookOk(w.cash, w.doctorA, day)));
      const cs = await Promise.all(Array.from({ length: 6 }, () => cust(w.cash)));
      await Promise.all([
        ...first.slice(0, 4).map((b) => post(w.cash, `/bookings/${b.id}/cancel`, { reason: 'سباق' })),
        ...cs.map((c) => book(w.cash, c, w.doctorB, day)),
      ]);
      await assertConsistent(w.id);
      expect((await dayRow(w.id, day)).used_slots).toBe(8);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('أيام الإغلاق عند الحجز', () => {
    let w: World;
    beforeAll(async () => { w = await world('BKX'); });
    it('يوم دوام مسكر، عطلة، طبيب ما يداوم، إجازة طبيب: كل واحد يرفض ويقترح أقرب يوم صالح', async () => {
      const mon = nextDow(d(1), 1); const tue = addDays(mon, 1);
      const c = await cust(w.cash);
      expect((await put(w.mgr, '/schedule/clinic-days', { days: [{ weekday: 1, is_open: false }] })).status).toBe(200);
      const r1 = await book(w.cash, c, w.doctorA, mon);
      expect(r1.status).toBe(409);
      expect(r1.body).toMatchObject({ code: 'CLINIC_CLOSED', reason: 'weekday', next_available_date: tue });
      await put(w.mgr, '/schedule/clinic-days', { days: [{ weekday: 1, is_open: true }] });

      const hol = nextDow(d(3), 3);
      await post(w.mgr, '/schedule/holidays', { date: hol, name: 'عيد تجربة' });
      const r2 = await book(w.cash, c, w.doctorA, hol);
      expect(r2.body).toMatchObject({ code: 'CLINIC_CLOSED', reason: 'holiday', next_available_date: addDays(hol, 1) });
      expect(r2.body.message).toContain('عيد تجربة');

      const only = await seedUser(db, 'docMon_BKX', 'doctor', w.id);
      await put(w.mgr, `/schedule/doctors/${only}/weekly`, { days: week([2]), effective_from: today });
      const thu = nextDow(d(1), 4);
      const r3 = await book(w.cash, c, only, thu);
      expect(r3.body).toMatchObject({ code: 'DOCTOR_NOT_WORKING', next_available_date: nextDow(thu, 2) });

      const off = nextDow(d(1), 5);
      await post(w.mgr, `/schedule/doctors/${w.doctorB}/days-off`, { date: off, reason: 'سفر' });
      const r4 = await book(w.cash, c, w.doctorB, off);
      expect(r4.body).toMatchObject({ code: 'DOCTOR_NOT_WORKING', next_available_date: addDays(off, 1) });
      expect(r4.body.message).toContain('إجازة');
      expect((await book(w.cash, c, w.doctorA, off)).status).toBe(201);                                    // الطبيب الثاني يداوم
    });
    it('/bookings/days: مدى الأيام مع الحد والتوفر', async () => {
      await setSetting(w.mgr, 'booking.daily_limit', 2);
      const day = d(8);
      await bookOk(w.cash, w.doctorA, day); await bookOk(w.cash, w.doctorA, day);
      const r = await get(w.cash, `/bookings/days?from=${day}&to=${addDays(day, 1)}&doctor_id=${w.doctorA}`);
      expect(r.status).toBe(200);
      expect(r.body.daily_limit).toBe(2);
      expect(r.body.days[0]).toMatchObject({ date: day, used_slots: 2, remaining: 0, bookable: false });
      expect(r.body.days[1]).toMatchObject({ date: addDays(day, 1), used_slots: 0, remaining: 2, bookable: true });
      expect((await get(w.cash, `/bookings/days?from=${day}&to=${addDays(day, 70)}`)).status).toBe(400);
      expect((await get(nurse, `/bookings/days?from=${day}&to=${day}`)).status).toBe(403);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('المراجعة المجانية', () => {
    let w: World;
    beforeAll(async () => { w = await world('BKF'); });
    it('نفس الطبيب خلال المدة بعد كشفية مدفوعة → مجانية مرة وحدة لكل كشفية', async () => {
      const c = await cust(w.cash);
      const parent = await bookOk(w.cash, w.doctorA, d(2), c);
      expect(parent.consultation.kind).toBe('new');
      const early = await book(w.cash, c, w.doctorA, d(3));                                                // الكشفية لسه ما مدفوعة
      expect(early.body.consultation.kind).toBe('new');
      await post(w.cash, `/bookings/${early.body.id}/cancel`, { reason: 'تجربة' });
      await markPaid(parent.id);
      const f = await book(w.cash, c, w.doctorA, d(5));
      expect(f.status).toBe(201);
      expect(f.body.consultation.kind).toBe('free_followup');
      const row = (await db.query(`select parent_consultation_id from consultations where id = $1`, [f.body.consultation.id])).rows[0];
      expect(Number(row.parent_consultation_id)).toBe(parent.consultation.id);
      const second = await book(w.cash, c, w.doctorA, d(6));                                               // وحدة بس
      expect(second.body.consultation.kind).toBe('new');
      await post(w.cash, `/bookings/${second.body.id}/cancel`, { reason: 'تجربة' });
      await post(w.cash, `/bookings/${f.body.id}/cancel`, { reason: 'تجربة' });                           // إلغاء المراجعة يرجّع الحق
      const again = await book(w.cash, c, w.doctorA, d(6));
      expect(again.body.consultation.kind).toBe('free_followup');
    });
    it('طبيب مختلف أو بعد المدة (الحد 7 أيام شامل) → كشفية جديدة، والمدة إعداد المالك', async () => {
      const c = await cust(w.cash);
      const parent = await bookOk(w.cash, w.doctorA, d(2), c);
      await markPaid(parent.id);
      expect((await book(w.cash, c, w.doctorB, d(3))).body.consultation.kind).toBe('new');
      const edge = await book(w.cash, c, w.doctorA, d(9));                                                 // 7 أيام بالضبط
      expect(edge.body.consultation.kind).toBe('free_followup');
      await post(w.cash, `/bookings/${edge.body.id}/cancel`, { reason: 'تجربة' });
      expect((await book(w.cash, c, w.doctorA, d(10))).body.consultation.kind).toBe('new');                // 8 أيام
      await setSetting(owner, 'booking.free_followup_days', 2, w.id);
      const c2 = await cust(w.cash);
      const p2 = await bookOk(w.cash, w.doctorA, d(12), c2);
      await markPaid(p2.id);
      expect((await book(w.cash, c2, w.doctorA, d(15))).body.consultation.kind).toBe('new');               // 3 أيام > 2
      expect((await book(w.cash, c2, w.doctorA, d(14))).body.consultation.kind).toBe('free_followup');
      await setSetting(owner, 'booking.free_followup_days', 7, w.id);
    });
    it('المراجعة المجانية بالنقل: تنتقل ضمن المدة، وخارجها 409', async () => {
      const c = await cust(w.cash);
      const p = await bookOk(w.cash, w.doctorA, d(30), c);
      await markPaid(p.id);
      const f = await book(w.cash, c, w.doctorA, d(31));
      expect(f.body.consultation.kind).toBe('free_followup');
      expect((await post(w.cash, `/bookings/${f.body.id}/move`, { date: d(37) })).status).toBe(201);
      const bad = await post(w.cash, `/bookings/${f.body.id}/move`, { date: d(38) });
      expect(bad.status).toBe(409);
      expect(bad.body.code).toBe('FOLLOWUP_WINDOW_EXPIRED');
      expect((await visitRow(f.body.id)).date).toBe(d(37));
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('الإلغاء', () => {
    let w: World;
    beforeAll(async () => { w = await world('BKA'); });
    it('قبل الدفع: يلغي الحجز والكشفية ويرجع المكان، وبسجل الحركات، وما ينلغي مرتين', async () => {
      const b = await bookOk(w.cash, w.doctorA, d(2));
      const r = await post(w.cash, `/bookings/${b.id}/cancel`, { reason: 'الزبون اعتذر' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ status: 'cancelled', cancel_reason: 'الزبون اعتذر', consultation: { status: 'cancelled' } });
      expect(await dayRow(w.id, d(2))).toMatchObject({ used_slots: 0, last_seq: 1 });
      expect((await db.query(`select 1 from booking_events where visit_id = $1 and event = 'cancelled' and reason = 'الزبون اعتذر'`, [b.id])).rowCount).toBe(1);
      expect((await db.query(`select 1 from audit_log where action = 'booking.cancel' and entity_id = $1`, [b.id])).rowCount).toBe(1);
      const again = await post(w.cash, `/bookings/${b.id}/cancel`, { reason: 'مرة ثانية' });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('NOT_CANCELLABLE');
      expect(await dayRow(w.id, d(2))).toMatchObject({ used_slots: 0 });                                   // ما نزل تحت صفر ولا مرتين
    });
    it('بعد الدفع أو دخول الطبيب: ما ينلغي (الاسترجاع من الدفع)', async () => {
      const paid = await bookOk(w.cash, w.doctorA, d(3));
      await markPaid(paid.id);
      expect((await post(w.cash, `/bookings/${paid.id}/cancel`, { reason: 'تجربة' })).body.code).toBe('NOT_CANCELLABLE');
      const inside = await bookOk(w.cash, w.doctorA, d(3));
      await enterDoctor(inside.id);
      expect((await post(w.cash, `/bookings/${inside.id}/cancel`, { reason: 'تجربة' })).status).toBe(409);
      expect((await visitRow(paid.id)).status).toBe('arrived');
    });
    it('كشفية مدفوعة حتى لو الزيارة لسه «محجوزة» (حالة غير متسقة) ما تنلغي', async () => {
      const b = await bookOk(w.cash, w.doctorA, d(3));
      await db.query(`update consultations set status = 'paid' where visit_id = $1`, [b.id]);
      const r = await post(w.cash, `/bookings/${b.id}/cancel`, { reason: 'تجربة' });
      expect(r.status).toBe(409);
      expect((await visitRow(b.id)).status).toBe('booked');
    });
    it('السبب إلزامي، والحجز غير الموجود 404، والرقم غلط 400', async () => {
      const b = await bookOk(w.cash, w.doctorA, d(4));
      expect((await post(w.cash, `/bookings/${b.id}/cancel`, {})).status).toBe(400);
      expect((await post(w.cash, `/bookings/${b.id}/cancel`, { reason: '  ' })).status).toBe(400);
      expect((await post(w.cash, `/bookings/${b.id}/cancel`, { reason: 'ab' })).status).toBe(400);
      expect((await post(w.cash, '/bookings/99999999/cancel', { reason: 'تجربة' })).status).toBe(404);
      expect((await post(w.cash, '/bookings/abc/cancel', { reason: 'تجربة' })).status).toBe(400);
      expect((await visitRow(b.id)).status).toBe('booked');
    });
    it('إلغاء متزامن لنفس الحجز: واحد ينجح والمكان ينزل مرة وحدة', async () => {
      const b = await bookOk(w.cash, w.doctorA, d(5));
      await bookOk(w.cash, w.doctorA, d(5));
      const rs = await Promise.all(Array.from({ length: 5 }, () => post(w.cash, `/bookings/${b.id}/cancel`, { reason: 'سباق' })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409)).toHaveLength(4);
      expect(await dayRow(w.id, d(5))).toMatchObject({ used_slots: 1 });
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('نقل الحجز', () => {
    let w: World;
    beforeAll(async () => { w = await world('BKM'); });
    it('ينتقل برقم جديد بنهاية اليوم الجديد، المكان القديم يرجع والرقم القديم ما ينعاد', async () => {
      const x = await bookOk(w.cash, w.doctorA, d(2));                                                      // الرقم 1 باليوم d2
      const y = await bookOk(w.cash, w.doctorA, d(2));                                                      // الرقم 2
      await bookOk(w.cash, w.doctorA, d(4)); await bookOk(w.cash, w.doctorA, d(4));                        // d4 فيه 2
      const r = await post(w.cash, `/bookings/${x.id}/move`, { date: d(4), reason: 'طلب الزبون' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ date: d(4), seq_no: 3, status: 'booked' });
      expect(await dayRow(w.id, d(2))).toMatchObject({ used_slots: 1, last_seq: 2 });
      expect(await dayRow(w.id, d(4))).toMatchObject({ used_slots: 3, last_seq: 3 });
      const z = await bookOk(w.cash, w.doctorA, d(2));
      expect(z.seq_no).toBe(3);                                                                              // الرقم 1 ما رجع
      const ev = (await db.query(`select event, from_date::text as f, to_date::text as t, from_seq, to_seq, reason from booking_events where visit_id = $1 and event = 'moved_by_cashier'`, [x.id])).rows;
      expect(ev).toEqual([{ event: 'moved_by_cashier', f: d(2), t: d(4), from_seq: 1, to_seq: 3, reason: 'طلب الزبون' }]);
      expect((await db.query(`select 1 from audit_log where action = 'booking.move' and entity_id = $1`, [x.id])).rowCount).toBe(1);
      expect(y.seq_no).toBe(2);
      await assertConsistent(w.id);
    });
    it('يوم ممتلئ → 409 مع اقتراح وما يتغير شي، ونفس اليوم والماضي والبعيد وزبون محجوز بالهدف مرفوضة', async () => {
      await setSetting(w.mgr, 'booking.daily_limit', 2);
      const full = d(10);
      await bookOk(w.cash, w.doctorA, full); await bookOk(w.cash, w.doctorA, full);
      const c = await cust(w.cash);
      const b = await bookOk(w.cash, w.doctorA, d(9), c);
      const r = await post(w.cash, `/bookings/${b.id}/move`, { date: full });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: 'DAY_FULL', next_available_date: d(11) });
      expect(await visitRow(b.id)).toMatchObject({ date: d(9), seq_no: 1, status: 'booked' });
      expect(await dayRow(w.id, d(9))).toMatchObject({ used_slots: 1, last_seq: 1 });
      expect((await post(w.cash, `/bookings/${b.id}/move`, { date: d(9) })).body.code).toBe('SAME_DATE');
      expect((await post(w.cash, `/bookings/${b.id}/move`, { date: d(-1) })).body.code).toBe('DATE_IN_PAST');
      expect((await post(w.cash, `/bookings/${b.id}/move`, { date: d(61) })).body.code).toBe('DATE_TOO_FAR');
      expect((await post(w.cash, `/bookings/${b.id}/move`, { date: 'x' })).status).toBe(400);
      await bookOk(w.cash, w.doctorB, d(12), c);                                                             // الزبون عنده حجز بـ d12
      expect((await post(w.cash, `/bookings/${b.id}/move`, { date: d(12) })).body.code).toBe('ALREADY_BOOKED_THAT_DAY');
      expect(await visitRow(b.id)).toMatchObject({ date: d(9) });
    });
    it('الهدف يوم مغلق أو الطبيب ما يداوم → 409', async () => {
      const b = await bookOk(w.cash, w.doctorA, d(14));
      const hol = d(15);
      await post(w.mgr, '/schedule/holidays', { date: hol, name: 'عطلة نقل' });
      expect((await post(w.cash, `/bookings/${b.id}/move`, { date: hol })).body.code).toBe('CLINIC_CLOSED');
      const off = d(16);
      await post(w.mgr, `/schedule/doctors/${w.doctorA}/days-off`, { date: off });
      expect((await post(w.cash, `/bookings/${b.id}/move`, { date: off })).body.code).toBe('DOCTOR_NOT_WORKING');
      expect(await visitRow(b.id)).toMatchObject({ date: d(14) });
    });
    it('بعد الدفع ينتقل بنفس الكشفية، وبعد دخول الطبيب أو الإلغاء ما ينتقل', async () => {
      const paid = await bookOk(w.cash, w.doctorA, d(20));
      await markPaid(paid.id);
      const r = await post(w.cash, `/bookings/${paid.id}/move`, { date: d(21) });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ date: d(21), status: 'arrived', consultation: { id: paid.consultation.id, status: 'paid' } });
      const inside = await bookOk(w.cash, w.doctorA, d(22));
      await enterDoctor(inside.id);
      expect((await post(w.cash, `/bookings/${inside.id}/move`, { date: d(23) })).body.code).toBe('NOT_MOVABLE');
      const gone = await bookOk(w.cash, w.doctorA, d(24));
      await post(w.cash, `/bookings/${gone.id}/cancel`, { reason: 'تجربة' });
      expect((await post(w.cash, `/bookings/${gone.id}/move`, { date: d(25) })).body.code).toBe('NOT_MOVABLE');
    });
    it('6 نقلات متزامنة على مكانين فاضيين: بالضبط 2 ينجحون والعد مطابق', async () => {
      await setSetting(w.mgr, 'booking.daily_limit', 4);
      const target = d(30);
      await bookOk(w.cash, w.doctorA, target); await bookOk(w.cash, w.doctorA, target);
      const movers = await Promise.all(Array.from({ length: 6 }, (_, i) => bookOk(w.cash, w.doctorA, d(31 + i))));
      const rs = await Promise.all(movers.map((m) => post(w.cash, `/bookings/${m.id}/move`, { date: target })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(2);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'DAY_FULL')).toHaveLength(4);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect((await dayRow(w.id, target)).used_slots).toBe(4);
      await assertConsistent(w.id);
    });
    it('نقلتين متعاكستين A→B و B→A بنفس اللحظة: الاثنين ينجحون بدون تشابك', async () => {
      await setSetting(w.mgr, 'booking.daily_limit', 10);
      const A = d(40); const B = d(41);
      const pairs = await Promise.all(Array.from({ length: 4 }, async () => [await bookOk(w.cash, w.doctorA, A), await bookOk(w.cash, w.doctorA, B)]));
      const rs = await Promise.all(pairs.flatMap(([a, b]) => [post(w.cash, `/bookings/${a.id}/move`, { date: B }), post(w.cash, `/bookings/${b.id}/move`, { date: A })]));
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(rs.every((r) => r.status === 201)).toBe(true);
      expect((await dayRow(w.id, A)).used_slots).toBe(4);
      expect((await dayRow(w.id, B)).used_slots).toBe(4);
      await assertConsistent(w.id);
    });
    it('نقل وإلغاء متزامنين لنفس الحجز: النتيجة سليمة والعد مطابق', async () => {
      const b = await bookOk(w.cash, w.doctorA, d(45));
      const [m, c] = await Promise.all([post(w.cash, `/bookings/${b.id}/move`, { date: d(46) }), post(w.cash, `/bookings/${b.id}/cancel`, { reason: 'سباق' })]);
      expect([m.status, c.status].filter((s) => s >= 500)).toHaveLength(0);
      await assertConsistent(w.id);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('نقل الحجوزات عند العطلة والإجازة والإغلاق', () => {
    let w: World;
    beforeAll(async () => { w = await world('BKH'); });
    it('عطلة جديدة: الحجوزات تنتقل بترتيب أسبقيتها لأقرب يوم مفتوح بيه مكان، وتحترم الامتلاء وحجز الزبون', async () => {
      await setSetting(w.mgr, 'booking.daily_limit', 4);
      const day = d(10);
      const cs = await Promise.all(Array.from({ length: 4 }, () => cust(w.cash)));
      const v: any[] = []; for (const c of cs) v.push(await bookOk(w.cash, w.doctorA, day, c));
      const next = addDays(day, 1);
      await bookOk(w.cash, w.doctorA, next); await bookOk(w.cash, w.doctorA, next); await bookOk(w.cash, w.doctorA, next);   // d11: 3 من 4
      await bookOk(w.cash, w.doctorA, addDays(day, 2), cs[1]);                                                                   // الزبون 2 محجوز بـ d12
      const r = await post(w.mgr, '/schedule/holidays', { date: day, name: 'عطلة طارئة', kind: 'sudden' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ affected_visits: 4, moved_visits: 4, unmoved_visits: 0 });
      const now = await Promise.all(v.map((x) => visitRow(x.id)));
      expect(now[0]).toMatchObject({ date: next, seq_no: 4 });                                                                   // آخر مكان بـ d11
      expect(now[1]).toMatchObject({ date: addDays(day, 3), seq_no: 1 });                                                        // d11 امتلأ، d12 عنده حجز
      expect(now[2]).toMatchObject({ date: addDays(day, 2) });
      expect(now[3]).toMatchObject({ date: addDays(day, 2) });
      expect(now[2].seq_no).toBeLessThan(now[3].seq_no);                                                                         // ترتيب الأسبقية محفوظ
      expect(await dayRow(w.id, day)).toMatchObject({ used_slots: 0 });
      const ev = (await db.query(`select count(*)::int as n from booking_events where event = 'moved_by_closure' and visit_id = any($1::bigint[]) and reason = 'عطلة: عطلة طارئة'`, [v.map((x) => x.id)])).rows[0].n;
      expect(ev).toBe(4);
      const fu = await get(w.cash, '/bookings/follow-up');
      expect(fu.status).toBe(200);
      expect(fu.body.moved.map((m: any) => m.visit_id).sort()).toEqual(v.map((x) => x.id).sort());
      expect(fu.body.moved.find((m: any) => m.visit_id === v[0].id)).toMatchObject({ from_date: day, to_date: next, customer: { id: cs[0] } });
      expect(fu.body.stuck).toEqual([]);
      await assertConsistent(w.id);
    });
    it('إجازة طبيب: كشفياته بس تنتقل (لأقرب يوم يداوم)، وكشفيات الطبيب الثاني تبقى، والكشفية بعد دخول الطبيب تبقى', async () => {
      await setSetting(w.mgr, 'booking.daily_limit', 30);
      const day = d(20);
      const a1 = await bookOk(w.cash, w.doctorA, day); const a2 = await bookOk(w.cash, w.doctorA, day); const b1 = await bookOk(w.cash, w.doctorB, day);
      await enterDoctor(a2.id);
      await put(w.mgr, `/schedule/doctors/${w.doctorA}/weekly`, { days: week([1, 2, 3, 4, 5, 6, 7].filter((x) => x !== isoDow(addDays(day, 1)))), effective_from: today });
      const r = await post(w.mgr, `/schedule/doctors/${w.doctorA}/days-off`, { date: day, reason: 'مرض' });
      expect(r.body).toMatchObject({ affected_visits: 2, moved_visits: 1, unmoved_visits: 0 });                // a1 بس تنتقل (a2 دخل للطبيب) وb1 للطبيب الثاني
      expect(await visitRow(a1.id)).toMatchObject({ date: addDays(day, 2) });                                   // d21 الطبيب ما يداوم بيه
      expect(await visitRow(a2.id)).toMatchObject({ date: day });
      expect(await visitRow(b1.id)).toMatchObject({ date: day, seq_no: 3 });
      await assertConsistent(w.id);
      await put(w.mgr, `/schedule/doctors/${w.doctorA}/weekly`, { days: week([1, 2, 3, 4, 5, 6, 7]), effective_from: today });
    });
    it('يوم دوام انسكر: كل حجوزاته المستقبلية تنتقل، والكشفية المدفوعة تنتقل بنفس كشفيتها', async () => {
      const mon1 = nextDow(d(25), 1); const mon2 = addDays(mon1, 7);
      const p = await bookOk(w.cash, w.doctorA, mon1); await markPaid(p.id);
      const q = await bookOk(w.cash, w.doctorB, mon2);
      // حجوزات الاثنين من اختبارات قبله (تعتمد على يوم الأسبوع الحالي): نلغيها حتى يبقى العد خاص بهذا الاختبار
      for (const x of (await db.query(`select id from visits where branch_id = $1 and extract(isodow from visit_date) = 1 and visit_date >= clinic_today() and status = 'booked' and id <> all($2::bigint[])`, [w.id, [p.id, q.id]])).rows) expect((await post(w.cash, `/bookings/${x.id}/cancel`, { reason: 'تنظيف الاختبار' })).status).toBe(201);
      const r = await put(w.mgr, '/schedule/clinic-days', { days: [{ weekday: 1, is_open: false }] });
      expect(r.body).toMatchObject({ affected_visits: 2, moved_visits: 2, unmoved_visits: 0 });
      expect(await visitRow(p.id)).toMatchObject({ date: addDays(mon1, 1), status: 'arrived' });
      expect(await visitRow(q.id)).toMatchObject({ date: addDays(mon2, 1) });
      expect((await db.query(`select status from consultations where id = $1`, [p.consultation.id])).rows[0].status).toBe('paid');
      await put(w.mgr, '/schedule/clinic-days', { days: [{ weekday: 1, is_open: true }] });
      await assertConsistent(w.id);
    });
    it('المراجعة المجانية تبقى مجانية لو العطلة أخرتها بعد مدتها', async () => {
      const c = await cust(w.cash);
      const parent = await bookOk(w.cash, w.doctorA, d(40), c); await markPaid(parent.id);
      const f = await book(w.cash, c, w.doctorA, d(47));                                                    // آخر يوم بالمدة
      expect(f.body.consultation.kind).toBe('free_followup');
      await post(w.mgr, '/schedule/holidays', { date: d(47), name: 'عطلة بعد المدة' });
      expect(await visitRow(f.body.id)).toMatchObject({ date: d(48) });                                     // بعد المدة بس بدون ما تضيع المجانية
      expect((await db.query(`select kind from consultations where id = $1`, [f.body.consultation.id])).rows[0].kind).toBe('free_followup');
    });
    it('ما لگينا يوم بديل خلال 60 يوم: الحجز يبقى ويطلع بقائمة المتابعة (stuck)', async () => {
      const only = await seedUser(db, 'docMonOnly_BKH', 'doctor', w.id);
      await put(w.mgr, `/schedule/doctors/${only}/weekly`, { days: week([1]), effective_from: today });
      const m0 = nextDow(d(1), 1);
      const b = await bookOk(w.cash, only, m0);
      for (let i = 1; i <= 8; i++) expect((await post(w.mgr, `/schedule/doctors/${only}/days-off`, { date: addDays(m0, 7 * i) })).status).toBe(201);
      const r = await post(w.mgr, `/schedule/doctors/${only}/days-off`, { date: m0, reason: 'سفر طويل' });
      expect(r.body).toMatchObject({ affected_visits: 1, moved_visits: 0, unmoved_visits: 1 });
      expect(await visitRow(b.id)).toMatchObject({ date: m0, status: 'booked' });
      const fu = await get(w.cash, '/bookings/follow-up');
      expect(fu.body.stuck.map((x: any) => x.id)).toContain(b.id);
      expect(fu.body.stuck.find((x: any) => x.id === b.id)).toMatchObject({ customer: { id: b.customer_id } });
    });
    it('إلغاء العطلة بعدين ما يرجع الحجوزات اللي انتقلت', async () => {
      const day = d(50); const b = await bookOk(w.cash, w.doctorA, day);
      const h = await post(w.mgr, '/schedule/holidays', { date: day, name: 'عطلة بتلغي' });
      expect(await visitRow(b.id)).toMatchObject({ date: d(51) });
      await post(w.mgr, `/schedule/holidays/${h.body.id}/cancel`);
      expect(await visitRow(b.id)).toMatchObject({ date: d(51) });
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('إقفال الأيام الماضية', () => {
    let w: World; let other: World;
    beforeAll(async () => { w = await world('BKD'); other = await world('BKD2'); });
    let pvSeq = 0;
    const pastVisit = async (b: number, doctor: number, seq: number, status: 'booked' | 'arrived', daysAgo = 2) => {
      const c = await db.query(`insert into customers (branch_id, public_code, phone, full_name, source) values ($1,$2,$3,'زبون ماضي','cashier') returning id`,
        [b, `PV${++pvSeq}X${Date.now() % 1e6}`, `+9647${String(800000000 + pvSeq)}`]);
      const date = addDays(today, -daysAgo);
      await db.query(`insert into booking_days (branch_id, day, used_slots, last_seq) values ($1,$2,1,$3) on conflict (branch_id, day) do update set used_slots = booking_days.used_slots + 1, last_seq = greatest(booking_days.last_seq, $3)`, [b, date, seq]);
      const v = await db.query(`insert into visits (branch_id, customer_id, visit_date, seq_no, status, source, doctor_id) values ($1,$2,$3,$4,$5,'cashier',$6) returning id`, [b, c.rows[0].id, date, seq, status, doctor]);
      const cs = await db.query(`insert into consultations (branch_id, visit_id, customer_id, doctor_id, status) values ($1,$2,$3,$4,$5) returning id`,
        [b, v.rows[0].id, c.rows[0].id, doctor, status === 'booked' ? 'awaiting_payment' : 'paid']);
      return { visit: Number(v.rows[0].id), consultation: Number(cs.rows[0].id) };
    };
    it('الحجز الغير مدفوع بيوم مضى يصير «فات» وكشفيته تنلغي، والمدفوع ينتقل (ما وصله الدور)، والمستقبلي يبقى', async () => {
      const missed = await pastVisit(w.id, w.doctorA, 1, 'booked'); const missed2 = await pastVisit(w.id, w.doctorA, 2, 'booked', 5);
      const paid = await pastVisit(w.id, w.doctorA, 3, 'arrived');
      const future = await bookOk(w.cash, w.doctorA, d(3));
      const foreign = await pastVisit(other.id, other.doctorA, 1, 'booked');
      const r = await post(w.mgr, '/bookings/close-past-days');
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ branch_id: w.id, missed: 2, rolled_over: 1 });
      expect((await visitRow(missed.visit)).status).toBe('missed');
      expect((await db.query(`select coalesce(sum(used_slots),0)::int as n from booking_days where branch_id = $1 and day < clinic_today()`, [w.id])).rows[0].n).toBe(0);   // المكان رجع للمفوتين، والمدفوع انتقل بمكانه فقط، حتى يطابق v_integrity_checks
      expect((await visitRow(missed2.visit)).status).toBe('missed');
      expect((await db.query(`select status from consultations where id = $1`, [missed.consultation])).rows[0].status).toBe('cancelled');
      expect(await visitRow(paid.visit)).toMatchObject({ status: 'arrived', date: today });                 // مدفوع وما وصله الدور: انتقل لأقرب يوم فيه مكان (اليوم) برقم جديد
      expect((await db.query(`select status from consultations where id = $1`, [paid.consultation])).rows[0].status).toBe('paid');
      expect((await visitRow(future.id)).status).toBe('booked');
      expect((await visitRow(foreign.visit)).status).toBe('booked');                                          // فرع ثاني ما تأثر
      expect((await db.query(`select count(*)::int as n from booking_events where event = 'missed' and visit_id = any($1::bigint[])`, [[missed.visit, missed2.visit]])).rows[0].n).toBe(2);
      expect((await post(w.mgr, '/bookings/close-past-days')).body.missed).toBe(0);                          // مرة ثانية ما يسوي شي
      expect((await post(owner, `/bookings/close-past-days?branch_id=${other.id}`)).body.missed).toBe(1);
    });
    it('الحجز «الفات» ما ينلغي ولا ينتقل', async () => {
      const m = await pastVisit(w.id, w.doctorA, 9, 'booked', 3);
      await post(w.mgr, '/bookings/close-past-days');
      expect((await post(w.cash, `/bookings/${m.visit}/cancel`, { reason: 'تجربة' })).body.code).toBe('NOT_CANCELLABLE');
      expect((await post(w.cash, `/bookings/${m.visit}/move`, { date: d(5) })).body.code).toBe('NOT_MOVABLE');
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('قائمة الحجوزات', () => {
    let w: World;
    beforeAll(async () => { w = await world('BKR'); });
    it('تنرتب بالرقم، تفلتر بالطبيب والزبون والحالة، وتبين ملخص اليوم، والطبيب يشوف حجوزاته بس', async () => {
      const day = d(3);
      const c = await cust(w.cash);
      const a = await bookOk(w.cash, w.doctorA, day, c); const b = await bookOk(w.cash, w.doctorB, day); const e = await bookOk(w.cash, w.doctorA, day);
      await post(w.cash, `/bookings/${b.id}/cancel`, { reason: 'تجربة' });
      const all = (await get(w.cash, `/bookings?date=${day}`)).body;
      expect(all.bookings.map((x: any) => x.id)).toEqual([a.id, b.id, e.id]);
      expect(all.day).toMatchObject({ date: day, daily_limit: 30, used_slots: 2, remaining: 28, last_seq: 3 });
      expect(all.bookings[0]).toMatchObject({ customer: { id: c }, doctor: { id: w.doctorA }, consultation: { kind: 'new' } });
      expect((await get(w.cash, `/bookings?date=${day}&status=cancelled`)).body.bookings.map((x: any) => x.id)).toEqual([b.id]);
      expect((await get(w.cash, `/bookings?date=${day}&doctor_id=${w.doctorB}`)).body.bookings.map((x: any) => x.id)).toEqual([b.id]);
      expect((await get(w.cash, `/bookings?from=${day}&to=${addDays(day, 5)}&customer_id=${c}`)).body.bookings.map((x: any) => x.id)).toEqual([a.id]);
      expect((await get(w.docAToken, `/bookings?date=${day}&doctor_id=${w.doctorB}`)).body.bookings.map((x: any) => x.id)).toEqual([a.id, e.id]);   // يتجاهل doctor_id ويرجع حجوزاته
      expect((await get(w.cash, '/bookings')).body.from).toBe(today);                                         // الافتراضي اليوم
    });
    it('مدى غلط أو طويل أو حالة غير معروفة → 400', async () => {
      expect((await get(w.cash, `/bookings?from=${d(1)}`)).status).toBe(400);
      expect((await get(w.cash, `/bookings?from=${d(5)}&to=${d(1)}`)).status).toBe(400);
      expect((await get(w.cash, `/bookings?from=${d(0)}&to=${d(70)}`)).status).toBe(400);
      expect((await get(w.cash, `/bookings?date=${d(1)}&status=nope`)).status).toBe(400);
      expect((await get(w.cash, '/bookings?date=2026-13-40')).status).toBe(400);
    });
  });

  it('تأكد نهائي: ما صار أي خرق للأرصدة بأي فرع اختبار', async () => {
    const { rows } = await db.query(`select id from branches where code like 'BK%'`);
    for (const r of rows) await assertConsistent(Number(r.id));
    expect(cash1 && mgr1).toBeTruthy();
  });
});
