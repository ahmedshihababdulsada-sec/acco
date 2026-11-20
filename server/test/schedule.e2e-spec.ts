import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { ScheduleService } from '../src/schedule/schedule.service';
import { auth, branchId, makeApp, pool, seedUser, tokenFor } from './helpers';

const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const isoDow = (d: string) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w === 0 ? 7 : w; };
/** أقرب تاريخ بعد `from` يكون يوم أسبوع معين (ISO) */
const nextDow = (from: string, dow: number) => { let d = addDays(from, 1); while (isoDow(d) !== dow) d = addDays(d, 1); return d; };

describe('الدوام والعطل والتوفر', () => {
  let app: INestApplication; let db: Pool; let b1: number; let b2: number; let today: string;
  let owner: string; let mgr1: string; let mgr2: string; let cash: string; let doc: string; let nurse: string;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  let custSeq = 0;
  const addVisit = async (b: number, date: string, doctorId: number | null = null, status = 'booked') => {
    custSeq++;
    const c = (await db.query(`insert into customers (branch_id, public_code, phone, full_name, source) values ($1,$2,$3,'زبون','cashier') returning id`,
      [b, `SC${custSeq}-${Date.now() % 100000}`, `+9647812${String(custSeq).padStart(6, '0')}`])).rows[0].id;
    const seq = Number((await db.query(`select coalesce(max(seq_no),0)+1 as n from visits where branch_id=$1 and visit_date=$2`, [b, date])).rows[0].n);
    await db.query(`insert into visits (branch_id, customer_id, visit_date, seq_no, status, source, doctor_id, cancelled_at) values ($1,$2,$3,$4,$5,'cashier',$6, case when $5 = 'cancelled' then now() end)`, [b, c, date, seq, status, doctorId]);
  };
  const newDoctor = async (name: string, b = b1) => seedUser(db, name, 'doctor', b);

  beforeAll(async () => {
    app = await makeApp(); db = pool(); b1 = await branchId(db, 'B1'); b2 = await branchId(db, 'B2');
    today = (await db.query(`select clinic_today()::text as d`)).rows[0].d;
    [owner, mgr1, mgr2, cash, doc, nurse] = await Promise.all(['owner', 'mgr1', 'mgr2', 'cash1', 'doc1', 'nurse1'].map((u) => tokenFor(app, u)));
  });
  afterAll(async () => { await app.close(); await db.end(); });

  describe('الصلاحيات', () => {
    it('الممرض ما يقرأ، والكاشير والطبيب يقرأون ولا يعدلون', async () => {
      expect((await get(nurse, '/schedule/clinic-days')).status).toBe(403);
      expect((await get(cash, '/schedule/clinic-days')).status).toBe(200);
      expect((await get(doc, '/schedule/clinic-days')).status).toBe(200);
      expect((await put(cash, '/schedule/clinic-days', { days: [{ weekday: 5, is_open: false }] })).status).toBe(403);
      expect((await post(doc, '/schedule/holidays', { date: addDays(today, 5), name: 'x' })).status).toBe(403);
      expect((await post(cash, '/schedule/holidays', { date: addDays(today, 5), name: 'x' })).status).toBe(403);
      expect((await put(doc, '/schedule/doctors/1/weekly', { days: [], effective_from: today })).status).toBe(403);
    });
    it('الطبيب يشوف دوامه هو بس، والكاشير يشوف دوام أي طبيب بفرعه', async () => {
      const docId = Number((await db.query(`select id from users where username='doc1'`)).rows[0].id);
      const other = await newDoctor('doc-priv');
      expect((await get(doc, `/schedule/doctors/${docId}`)).status).toBe(200);
      expect((await get(doc, `/schedule/doctors/${other}`)).status).toBe(404);
      expect((await get(cash, `/schedule/doctors/${other}`)).status).toBe(200);
      expect((await get(mgr2, `/schedule/doctors/${other}`)).status).toBe(404);              // فرع ثاني
      expect((await get(owner, `/schedule/doctors/${other}`)).status).toBe(200);
      expect((await get(mgr1, '/schedule/doctors/999999')).status).toBe(404);
      const nonDoctor = Number((await db.query(`select id from users where username='cash1'`)).rows[0].id);
      expect((await get(mgr1, `/schedule/doctors/${nonDoctor}`)).status).toBe(404);          // مو طبيب
    });
  });

  describe('أيام دوام العيادة', () => {
    it('الافتراضي كلها مفتوحة، والمدير يسكر يوم', async () => {
      const r = await get(mgr1, '/schedule/clinic-days');
      expect(r.body.branch_id).toBe(b1);
      expect(r.body.days).toHaveLength(7);
      expect(r.body.days.every((d: any) => d.is_open)).toBe(true);
      const set = await put(mgr1, '/schedule/clinic-days', { days: [{ weekday: 5, is_open: false }] });
      expect(set.status).toBe(200);
      expect(set.body.days.find((d: any) => d.weekday === 5).is_open).toBe(false);
      expect((await get(cash, '/schedule/clinic-days')).body.days.find((d: any) => d.weekday === 5).is_open).toBe(false);
    });
    it('لازم يوم مفتوح على الأقل، ولا تكرار ولا يوم غلط', async () => {
      const allClosed = await put(mgr1, '/schedule/clinic-days', { days: [1, 2, 3, 4, 6, 7].map((weekday) => ({ weekday, is_open: false })) });
      expect(allClosed.status).toBe(400);
      expect(allClosed.body.code).toBe('NO_OPEN_DAY');
      expect((await put(mgr1, '/schedule/clinic-days', { days: [{ weekday: 1, is_open: true }, { weekday: 1, is_open: false }] })).body.code).toBe('DUPLICATE_WEEKDAY');
      expect((await put(mgr1, '/schedule/clinic-days', { days: [{ weekday: 8, is_open: true }] })).status).toBe(400);
      expect((await put(mgr1, '/schedule/clinic-days', { days: [] })).status).toBe(400);
      expect((await get(mgr1, '/schedule/clinic-days')).body.days.find((d: any) => d.weekday === 5).is_open).toBe(false);   // ما تغير شي
    });
    it('تسكير يوم يرجع عدد الحجوزات المستقبلية المتأثرة (اللي بالماضي والملغاة لا)', async () => {
      const sat = nextDow(today, 6);
      await addVisit(b1, sat); await addVisit(b1, addDays(sat, 7)); await addVisit(b1, sat, null, 'cancelled');
      const r = await put(mgr1, '/schedule/clinic-days', { days: [{ weekday: 6, is_open: false }] });
      expect(r.body.affected_visits).toBe(2);
      await put(mgr1, '/schedule/clinic-days', { days: [{ weekday: 6, is_open: true }] });
    });
    it('كل فرع أيامه، والمدير ما يتعدى فرعه، والمالك لازم يحدد الفرع', async () => {
      expect((await get(mgr2, '/schedule/clinic-days')).body.days.find((d: any) => d.weekday === 5).is_open).toBe(true);
      expect((await put(mgr1, '/schedule/clinic-days', { days: [{ weekday: 2, is_open: false }], branch_id: b2 })).status).toBe(403);
      expect((await put(owner, '/schedule/clinic-days', { days: [{ weekday: 2, is_open: false }] })).body.code).toBe('BRANCH_REQUIRED');
      expect((await put(owner, '/schedule/clinic-days', { days: [{ weekday: 2, is_open: false }], branch_id: b2 })).status).toBe(200);
      await put(owner, '/schedule/clinic-days', { days: [{ weekday: 2, is_open: true }], branch_id: b2 });
    });
  });

  describe('العطل', () => {
    it('المدير يضيف عطلة قادمة ويرجع عدد الحجوزات اللي عليها، وتظهر بالقائمة', async () => {
      const d = addDays(today, 20);
      await addVisit(b1, d); await addVisit(b1, d);
      const r = await post(mgr1, '/schedule/holidays', { date: d, name: 'عيد' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ date: d, name: 'عيد', kind: 'official', affected_visits: 2 });
      const l = await get(cash, `/schedule/holidays?from=${addDays(today, 15)}&to=${addDays(today, 25)}`);
      expect(l.body.map((h: any) => h.date)).toContain(d);
    });
    it('عطلة اليوم نفسه (مفاجئة) مسموحة، والماضي مرفوض، والتاريخ لازم حقيقي', async () => {
      expect((await post(mgr1, '/schedule/holidays', { date: today, name: 'مفاجئة', kind: 'sudden' })).status).toBe(201);
      expect((await post(mgr1, '/schedule/holidays', { date: addDays(today, -1), name: 'أمس' })).body.code).toBe('DATE_IN_PAST');
      expect((await post(mgr1, '/schedule/holidays', { date: '2027-02-30', name: 'x' })).body.code).toBe('INVALID_DATE');
      expect((await post(mgr1, '/schedule/holidays', { date: '2027-2-3', name: 'x' })).status).toBe(400);
      expect((await post(mgr1, '/schedule/holidays', { date: addDays(today, 3), name: 'x', kind: 'weird' })).status).toBe(400);
      expect((await post(mgr1, '/schedule/holidays', { date: addDays(today, 3) })).status).toBe(400);
    });
    it('نفس اليوم مرتين مرفوض، وبعد الإلغاء ينضاف من جديد، والإلغاء مرتين بدون أثر', async () => {
      const d = addDays(today, 30);
      const a = await post(mgr1, '/schedule/holidays', { date: d, name: 'أولى' });
      expect((await post(mgr1, '/schedule/holidays', { date: d, name: 'ثانية' })).body.code).toBe('HOLIDAY_EXISTS');
      expect((await post(mgr1, `/schedule/holidays/${a.body.id}/cancel`)).status).toBe(204);
      expect((await post(mgr1, `/schedule/holidays/${a.body.id}/cancel`)).status).toBe(204);
      expect((await get(mgr1, `/schedule/holidays?from=${d}&to=${d}`)).body).toEqual([]);
      expect((await post(mgr1, '/schedule/holidays', { date: d, name: 'ثانية' })).status).toBe(201);
    });
    it('إلغاء عطلة ماضية مرفوض، وعطلة فرع ثاني 404، وعطلة غير موجودة 404', async () => {
      const past = Number((await db.query(`insert into holidays (branch_id, holiday_date, name, created_by) values ($1, clinic_today() - 5, 'قديمة', (select id from users where username='mgr1')) returning id`, [b1])).rows[0].id);
      expect((await post(mgr1, `/schedule/holidays/${past}/cancel`)).body.code).toBe('DATE_IN_PAST');
      const h = await post(mgr1, '/schedule/holidays', { date: addDays(today, 31), name: 'فرع 1' });
      expect((await post(mgr2, `/schedule/holidays/${h.body.id}/cancel`)).status).toBe(404);
      expect((await post(mgr1, '/schedule/holidays/999999/cancel')).status).toBe(404);
    });
    it('كل فرع عطله، والقائمة تبدي من اليوم افتراضياً', async () => {
      const d = addDays(today, 40);
      await post(mgr1, '/schedule/holidays', { date: d, name: 'فرع 1 فقط' });
      expect((await get(mgr2, `/schedule/holidays?from=${d}&to=${d}`)).body).toEqual([]);
      expect((await post(mgr1, '/schedule/holidays', { date: d, name: 'x', branch_id: b2 })).status).toBe(403);
      const all = (await get(mgr1, '/schedule/holidays')).body;
      expect(all.every((h: any) => h.date >= today)).toBe(true);
    });
  });

  describe('دوام الطبيب الأسبوعي', () => {
    const week = (days: number[], s = '09:00', e = '13:00') => days.map((weekday) => ({ weekday, start_time: s, end_time: e }));

    it('المدير يحدد الأسبوع من تاريخ مستقبلي، وتظهر الساعات', async () => {
      const id = await newDoctor('dw1');
      const from = addDays(today, 7);
      const r = await put(mgr1, `/schedule/doctors/${id}/weekly`, { days: week([1, 2, 3, 4]), effective_from: from });
      expect(r.status).toBe(200);
      expect(r.body.weekly.map((x: any) => [x.weekday, x.start_time, x.end_time])).toEqual([[1, '09:00', '13:00'], [2, '09:00', '13:00'], [3, '09:00', '13:00'], [4, '09:00', '13:00']]);
      expect(r.body.weekly[0].effective_from).toBe(from);
      expect(r.body.weekly[0].effective_to).toBeNull();
      expect((await get(mgr1, `/schedule/doctors/${id}`)).body.weekly).toEqual([]);                    // اليوم لسه ما بدى
      expect((await get(mgr1, `/schedule/doctors/${id}`)).body.upcoming_changes).toHaveLength(4);
    });
    it('التغيير الجديد يبدي من تاريخه وما يغير اللي قبله (الصف القديم ينقفل قبله)', async () => {
      const id = await newDoctor('dw2');
      await put(mgr1, `/schedule/doctors/${id}/weekly`, { days: week([1, 2, 3, 4]), effective_from: today });
      const from2 = addDays(today, 14);
      await put(mgr1, `/schedule/doctors/${id}/weekly`, { days: week([5, 6], '10:00', '14:00'), effective_from: from2 });
      const rows = (await db.query(`select weekday, effective_from::text as f, effective_to::text as t, to_char(start_time,'HH24:MI') as s from doctor_schedules where doctor_id=$1 order by effective_from, weekday`, [id])).rows;
      expect(rows.filter((r) => r.f === today).every((r) => r.t === addDays(from2, -1))).toBe(true);   // القديم ينتهي قبل الجديد
      expect(rows.filter((r) => r.f === from2).map((r) => [r.weekday, r.t, r.s])).toEqual([[5, null, '10:00'], [6, null, '10:00']]);
      const nowView = (await get(mgr1, `/schedule/doctors/${id}`)).body;
      expect(nowView.weekly.map((x: any) => x.weekday)).toEqual([1, 2, 3, 4]);
      const later = (await get(mgr1, `/schedule/doctors/${id}?date=${from2}`)).body;
      expect(later.weekly.map((x: any) => x.weekday)).toEqual([5, 6]);
    });
    it('الصفوف الماضية ما تنحذف، والتعديل بنفس التاريخ يستبدل المستقبلي', async () => {
      const id = await newDoctor('dw3');
      await db.query(`insert into doctor_schedules (doctor_id, weekday, start_time, end_time, effective_from, created_by) values ($1, 1, '08:00', '12:00', clinic_today() - 30, (select id from users where username='mgr1'))`, [id]);
      const from = addDays(today, 5);
      await put(mgr1, `/schedule/doctors/${id}/weekly`, { days: week([2]), effective_from: from });
      await put(mgr1, `/schedule/doctors/${id}/weekly`, { days: week([3]), effective_from: from });
      const rows = (await db.query(`select weekday, effective_from::text as f, effective_to::text as t from doctor_schedules where doctor_id=$1 order by effective_from, weekday`, [id])).rows;
      expect(rows).toEqual([{ weekday: 1, f: addDays(today, -30), t: addDays(from, -1) }, { weekday: 3, f: from, t: null }]);
    });
    it('أسبوع فاضي من تاريخ = الطبيب ما يداوم من هذاك اليوم', async () => {
      const id = await newDoctor('dw4');
      await put(mgr1, `/schedule/doctors/${id}/weekly`, { days: week([1, 2, 3, 4, 5, 6, 7]), effective_from: today });
      const stop = addDays(today, 10);
      await put(mgr1, `/schedule/doctors/${id}/weekly`, { days: [], effective_from: stop });
      const av = (await get(mgr1, `/schedule/availability?from=${addDays(stop, -1)}&to=${stop}&doctor_id=${id}`)).body.days;
      expect(av[0].doctor.start_time).toBe('09:00');
      expect(av[1].doctor).toMatchObject({ start_time: null, end_time: null });
    });
    it('تحققات: ماضي، ساعات غلط، يوم مكرر، تاريخ غلط', async () => {
      const id = await newDoctor('dw5');
      const set = (body: object) => put(mgr1, `/schedule/doctors/${id}/weekly`, body);
      expect((await set({ days: week([1]), effective_from: addDays(today, -1) })).body.code).toBe('DATE_IN_PAST');
      expect((await set({ days: [{ weekday: 1, start_time: '13:00', end_time: '09:00' }], effective_from: today })).body.code).toBe('INVALID_HOURS');
      expect((await set({ days: [{ weekday: 1, start_time: '09:00', end_time: '09:00' }], effective_from: today })).body.code).toBe('INVALID_HOURS');
      expect((await set({ days: [...week([1]), ...week([1], '14:00', '18:00')], effective_from: today })).body.code).toBe('DUPLICATE_WEEKDAY');
      expect((await set({ days: [{ weekday: 1, start_time: '9:00', end_time: '13:00' }], effective_from: today })).status).toBe(400);
      expect((await set({ days: [{ weekday: 1, start_time: '09:00', end_time: '25:00' }], effective_from: today })).status).toBe(400);
      expect((await set({ days: [{ weekday: 9, start_time: '09:00', end_time: '13:00' }], effective_from: today })).status).toBe(400);
      expect((await set({ days: week([1]), effective_from: '2027-13-01' })).status).toBe(400);
      expect((await set({ days: week([1]), effective_from: '2027-02-30' })).body.code).toBe('INVALID_DATE');
      expect((await db.query(`select count(*)::int as n from doctor_schedules where doctor_id=$1`, [id])).rows[0].n).toBe(0);    // كله تراجع
    });
    it('فرع ثاني 404، ومو طبيب 404', async () => {
      const id = await newDoctor('dw6');
      expect((await put(mgr2, `/schedule/doctors/${id}/weekly`, { days: week([1]), effective_from: today })).status).toBe(404);
      const cashId = Number((await db.query(`select id from users where username='cash1'`)).rows[0].id);
      expect((await put(mgr1, `/schedule/doctors/${cashId}/weekly`, { days: week([1]), effective_from: today })).status).toBe(404);
    });
    it('تعديلات متزامنة على نفس الطبيب: كلها تنجح (تتسلسل) بدون تداخل ولا أخطاء 500', async () => {
      const id = await newDoctor('dw7');
      const from = addDays(today, 3);
      const rs = await Promise.all([1, 2, 3, 4].map((i) => put(mgr1, `/schedule/doctors/${id}/weekly`, { days: week([i], `0${i}:00`, `1${i}:00`), effective_from: from })));
      expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      const rows = (await db.query(`select weekday, effective_from::text as f, effective_to from doctor_schedules where doctor_id=$1`, [id])).rows;
      expect(rows).toHaveLength(1);                           // الأخير بس يبقى
      expect(rows[0].f).toBe(from);
    });
  });

  describe('إجازات الطبيب', () => {
    it('تنضاف وترجع عدد كشفياته المتأثرة (الجلسات لا)، والتكرار 409، والماضي 400', async () => {
      const id = await newDoctor('do1');
      const d = addDays(today, 9);
      await addVisit(b1, d, id); await addVisit(b1, d, id); await addVisit(b1, d, null); await addVisit(b1, d, id, 'cancelled');
      const r = await post(mgr1, `/schedule/doctors/${id}/days-off`, { date: d, reason: 'سفر' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ date: d, reason: 'سفر', affected_visits: 2 });
      expect((await post(mgr1, `/schedule/doctors/${id}/days-off`, { date: d })).body.code).toBe('DAY_OFF_EXISTS');
      expect((await post(mgr1, `/schedule/doctors/${id}/days-off`, { date: addDays(today, -1) })).body.code).toBe('DATE_IN_PAST');
      expect((await post(mgr1, `/schedule/doctors/${id}/days-off`, { date: 'bad' })).status).toBe(400);
      expect((await get(mgr1, `/schedule/doctors/${id}`)).body.days_off.map((x: any) => x.date)).toContain(d);
    });
    it('الإلغاء ثم إعادة الإضافة، والإلغاء مرتين بدون أثر، وفرع ثاني 404', async () => {
      const id = await newDoctor('do2');
      const d = addDays(today, 12);
      const a = await post(mgr1, `/schedule/doctors/${id}/days-off`, { date: d });
      expect((await post(mgr2, `/schedule/days-off/${a.body.id}/cancel`)).status).toBe(404);
      expect((await post(mgr1, `/schedule/days-off/${a.body.id}/cancel`)).status).toBe(204);
      expect((await post(mgr1, `/schedule/days-off/${a.body.id}/cancel`)).status).toBe(204);
      expect((await get(mgr1, `/schedule/doctors/${id}`)).body.days_off).toEqual([]);
      expect((await post(mgr1, `/schedule/doctors/${id}/days-off`, { date: d })).status).toBe(201);
      expect((await post(mgr1, '/schedule/days-off/999999/cancel')).status).toBe(404);
      const other = await newDoctor('do3', b2);
      expect((await post(mgr1, `/schedule/doctors/${other}/days-off`, { date: d })).status).toBe(404);
    });
  });

  describe('التوفر', () => {
    it('كل يوم: العيادة مفتوحة (يوم دوام + ماكو عطلة)، والطبيب يداوم (جدول + مفتوحة + ماكو إجازة)', async () => {
      const id = await newDoctor('av1');
      const from = addDays(today, 1); const to = addDays(today, 21);
      // الجمعة مسكرة (مضبوطة بالأعلى)، الدوام اثنين إلى خميس، عطلة بالأسبوع الثاني، وإجازة طبيب
      await put(mgr1, '/schedule/clinic-days', { days: [{ weekday: 5, is_open: false }, { weekday: 6, is_open: true }, { weekday: 2, is_open: true }] });
      await put(mgr1, `/schedule/doctors/${id}/weekly`, { days: [1, 2, 3, 4].map((weekday) => ({ weekday, start_time: '09:00', end_time: '13:00' })), effective_from: from });
      const holiday = nextDow(addDays(today, 7), 3);               // أربعاء بالأسبوع الثاني
      const off = nextDow(addDays(today, 14), 1);                  // اثنين بالأسبوع الثالث
      await post(mgr1, '/schedule/holidays', { date: holiday, name: 'عطلة تجربة' });
      await post(mgr1, `/schedule/doctors/${id}/days-off`, { date: off, reason: 'مؤتمر' });
      const r = await get(cash, `/schedule/availability?from=${from}&to=${to}&doctor_id=${id}`);
      expect(r.status).toBe(200);
      expect(r.body.days).toHaveLength(21);
      for (const d of r.body.days) {
        const wd = isoDow(d.date);
        const isHoliday = d.date === holiday || (await db.query(`select 1 from holidays where branch_id=$1 and holiday_date=$2 and cancelled_at is null`, [b1, d.date])).rowCount === 1;
        const open = wd !== 5 && !isHoliday;
        expect(d.weekday).toBe(wd);
        expect(d.clinic_open).toBe(open);
        expect(d.closed_reason).toBe(open ? null : isHoliday ? 'holiday' : 'weekday');
        const works = open && [1, 2, 3, 4].includes(wd) && d.date !== off;
        expect(d.doctor.works).toBe(works);
        expect(d.doctor.start_time).toBe([1, 2, 3, 4].includes(wd) ? '09:00' : null);
        expect(!!d.doctor.day_off).toBe(d.date === off);
      }
      const hd = r.body.days.find((d: any) => d.date === holiday);
      expect(hd.holiday).toMatchObject({ name: 'عطلة تجربة', kind: 'official' });
      expect(r.body.days.find((d: any) => d.date === off).doctor.day_off.reason).toBe('مؤتمر');
    });
    it('بدون طبيب: بيانات العيادة بس، والجلسات ما تعتمد على دوام الطبيب', async () => {
      const r = await get(cash, `/schedule/availability?from=${addDays(today, 1)}&to=${addDays(today, 7)}`);
      expect(r.body.days.every((d: any) => d.doctor === undefined)).toBe(true);
      expect(r.body.days.filter((d: any) => isoDow(d.date) === 5).every((d: any) => d.clinic_open === false)).toBe(true);
    });
    it('حدود الاستعلام: مدى مقلوب، أطول من 62 يوم، تاريخ غلط، طبيب فرع ثاني، طبيب يسأل عن زميله', async () => {
      const q = (qs: string) => get(cash, `/schedule/availability?${qs}`);
      expect((await q(`from=${addDays(today, 5)}&to=${today}`)).body.code).toBe('INVALID_RANGE');
      expect((await q(`from=${today}&to=${addDays(today, 62)}`)).body.code).toBe('RANGE_TOO_LONG');
      expect((await q(`from=${today}&to=${addDays(today, 61)}`)).status).toBe(200);
      expect((await q(`from=2027-02-30&to=2027-03-01`)).body.code).toBe('INVALID_DATE');
      expect((await q('to=2027-03-01')).status).toBe(400);
      const otherBranchDoc = await newDoctor('av-b2', b2);
      expect((await q(`from=${today}&to=${today}&doctor_id=${otherBranchDoc}`)).status).toBe(404);
      const mine = Number((await db.query(`select id from users where username='doc1'`)).rows[0].id);
      const sameBranch = await newDoctor('av-colleague');
      expect((await get(doc, `/schedule/availability?from=${today}&to=${today}&doctor_id=${mine}`)).status).toBe(200);
      expect((await get(doc, `/schedule/availability?from=${today}&to=${today}&doctor_id=${sameBranch}`)).status).toBe(404);
      expect((await get(nurse, `/schedule/availability?from=${today}&to=${today}`)).status).toBe(403);
    });
    it('أقرب يوم متاح: يتخطى الجمعة المسكرة والعطل والإجازات (تستخدمه وحدة الحجز لنقل الحجوزات)', async () => {
      const svc = app.get(ScheduleService);
      const id = await newDoctor('nx1');
      const thursday = nextDow(addDays(today, 30), 4);
      await put(mgr1, `/schedule/doctors/${id}/weekly`, { days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_time: '09:00', end_time: '13:00' })), effective_from: today });
      // بعد الخميس: الجمعة مسكرة، والسبت عطلة، فأقرب يوم = الأحد (إلا إذا كان عطلة بالقاعدة من اختبار ثاني)
      const sat = addDays(thursday, 2);
      await post(mgr1, '/schedule/holidays', { date: sat, name: 'سبت عطلة' });
      const free = await svc.nextAvailableDate(db, b1, thursday);
      expect(free).toBe(addDays(thursday, 3));
      // إجازة الطبيب بالأحد تخلي أقرب يوم للطبيب هو الاثنين، لكن للجلسات (بدون طبيب) يبقى الأحد
      await post(mgr1, `/schedule/doctors/${id}/days-off`, { date: addDays(thursday, 3) });
      expect(await svc.nextAvailableDate(db, b1, thursday, id)).toBe(addDays(thursday, 4));
      expect(await svc.nextAvailableDate(db, b1, thursday)).toBe(addDays(thursday, 3));
      // ما أكو يوم بالمدى → null
      expect(await svc.nextAvailableDate(db, b1, thursday, id, 2)).toBeNull();
      // أكثر من 62 يوم ببحث واحد مرفوض
      await expect(svc.nextAvailableDate(db, b1, thursday, undefined, 100)).rejects.toThrow();
    });
  });

  it('كل التغييرات تنسجل بسجل الحركات', async () => {
    const actions = (await db.query(`select distinct action from audit_log where action like 'schedule.%'`)).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['schedule.clinic_days', 'schedule.holiday_add', 'schedule.holiday_cancel', 'schedule.doctor_weekly', 'schedule.day_off_add', 'schedule.day_off_cancel']));
  });
});
