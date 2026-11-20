import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

interface World {
  id: number; code: string; mgr: string; mgrId: number; cash: string; docA: string; docAId: number; docB: string; docBId: number;
  botox: { id: number; fieldId: number }; laser: { id: number; zones: { id: number; label_ar: string }[] }; fixed: number; botoxMat: number;
}

describe('جولة الطبيب: الملف والمعلومات الصحية والخطة وحجز الجلسات', () => {
  let app: INestApplication; let db: Pool; let today: string; let owner: string; let nurse: string;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  let phoneSeq = 0; let seq = 0;
  const key = () => `pk-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const d = (n: number) => addDays(today, n);

  async function world(code: string): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name) values ($1,$1) returning id`, [code])).rows[0].id);
    await db.query(`insert into safes (branch_id) values ($1)`, [id]);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id); await seedUser(db, `cash_${code}`, 'cashier', id);
    const docAId = await seedUser(db, `docA_${code}`, 'doctor', id); const docBId = await seedUser(db, `docB_${code}`, 'doctor', id);
    await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',100000000,'opening_balance','تجربة',$2)`, [id, mgrId]);
    const [mgr, cash, docA, docB] = await Promise.all([`mgr_${code}`, `cash_${code}`, `docA_${code}`, `docB_${code}`].map((u) => tokenFor(app, u)));
    for (const doc of [docAId, docBId]) expect((await put(mgr, `/schedule/doctors/${doc}/weekly`, { days: [1, 2, 3, 4, 5, 6, 7].map((w) => ({ weekday: w, start_time: '09:00', end_time: '13:00' })), effective_from: today })).status).toBe(200);
    const cur = (await get(mgr, '/settings')).body.settings.find((s: any) => s.key === 'booking.daily_limit');
    expect((await put(mgr, '/settings/booking.daily_limit', { value: 1000, expected_version: cur.version })).status).toBe(200);
    const cs = Number((await db.query(`insert into services (branch_id, name_ar, kind, pricing_model, is_active) values ($1,'كشفية','consultation','fixed',true) returning id`, [id])).rows[0].id);
    await db.query(`insert into service_prices (service_id, price, set_by) values ($1,30000,$2)`, [cs, mgrId]);
    await db.query(`insert into payment_methods (branch_id, name_ar, kind, sort_order) values ($1,'كاش','cash',0)`, [id]);
    const botoxMat = Number((await db.query(`insert into materials (branch_id, name, base_unit, pack_unit) values ($1,'بوتكس','cc','كرتون') returning id`, [id])).rows[0].id);
    const bs = (await post(mgr, '/services', { name_ar: 'بوتكس', pricing_model: 'per_unit', price: 50000 })).body;
    const bf = (await post(mgr, `/services/${bs.id}/fields`, { field_key: 'cc', label_ar: 'كم cc', field_type: 'number', unit_label: 'cc', pricing_role: 'quantity', is_required: true })).body.fields[0];
    expect((await put(mgr, `/services/${bs.id}/materials`, { items: [{ material_id: botoxMat, formula: 'per_field_value', field_id: bf.id, factor: '1' }] })).status).toBe(200);
    expect((await post(mgr, `/services/${bs.id}/activate`)).status).toBe(200);
    const ls = (await post(mgr, '/services', { name_ar: 'ليزر', pricing_model: 'per_option' })).body;
    const lf = (await post(mgr, `/services/${ls.id}/fields`, { field_key: 'zones', label_ar: 'المناطق', field_type: 'multi_select', pricing_role: 'option', is_required: true,
      options: [{ label_ar: 'ابط', price: 30000 }, { label_ar: 'وجه', price: 50000 }, { label_ar: 'فول بدي', price: 200000, is_exclusive: true }] })).body.fields[0];
    expect((await post(mgr, `/services/${ls.id}/activate`)).status).toBe(200);
    const fx = (await post(mgr, '/services', { name_ar: 'تنظيف بشرة', pricing_model: 'fixed', price: 40000 })).body;
    expect((await post(mgr, `/services/${fx.id}/activate`)).status).toBe(200);
    const w: World = { id, code, mgr, mgrId, cash, docA, docAId, docB, docBId, botox: { id: bs.id, fieldId: bf.id }, laser: { id: ls.id, zones: lf.options }, fixed: fx.id, botoxMat };
    const sh = await post(cash, '/shifts/open', { opening_float: 0 }); expect(sh.status).toBe(201);
    return w;
  }
  async function customer(w: World): Promise<number> {
    phoneSeq++;
    const r = await post(w.cash, '/customers', { full_name: `زبون خطة ${phoneSeq}`, phone: `0794${String(phoneSeq).padStart(7, '0')}` });
    expect(r.status).toBe(201); return r.body.id;
  }
  /** زبون حجز عند الطبيب ودفع الكشفية (اليوم). يرجع الكشفية والزيارة. */
  async function paidConsult(w: World, doc: 'A' | 'B' = 'A', cust?: number) {
    const c = cust ?? (await customer(w)); const doctorId = doc === 'A' ? w.docAId : w.docBId;
    const b = await post(w.cash, '/bookings', { customer_id: c, doctor_id: doctorId, date: today });
    expect(b.status).toBe(201);
    const m = (await one(`select id from payment_methods where branch_id = $1 and kind = 'cash'`, [w.id])).id;
    const p = await http().post('/payments/consultation').set(auth(w.cash)).set('Idempotency-Key', key()).send({ consultation_id: b.body.consultation.id, tenders: [{ method_id: Number(m), amount: 30000 }] });
    expect(p.status).toBe(201);
    return { customer: c, consId: b.body.consultation.id as number, visitId: b.body.id as number, seqNo: b.body.seq_no as number, token: doc === 'A' ? w.docA : w.docB, paymentId: p.body.id as number };
  }
  async function opened(w: World, doc: 'A' | 'B' = 'A', cust?: number) {
    const x = await paidConsult(w, doc, cust);
    expect((await post(x.token, `/consultations/${x.consId}/enter`)).status).toBe(201);
    return x;
  }
  /** ينقل زيارة لأمس بالقاعدة (يحاكي كشفية قديمة) ويصلّح عدّاد الأيام حتى يبقى متسق */
  let hackSeq = 0;
  async function moveVisitToYesterday(visitId: number) {
    const v = (await db.query(`select branch_id, visit_date::text as d from visits where id = $1`, [visitId])).rows[0];
    await db.query(`update visits set visit_date = clinic_today() - 1, seq_no = $2 where id = $1`, [visitId, 9000 + (++hackSeq)]);
    await db.query(`insert into booking_days (branch_id, day, used_slots, last_seq) values ($1, clinic_today() - 1, 0, 0) on conflict do nothing`, [v.branch_id]);
    await db.query(`update booking_days bd set used_slots = (select count(*)::int from visits x where x.branch_id = bd.branch_id and x.visit_date = bd.day and x.status in ('booked','arrived')) where bd.branch_id = $1 and bd.day in (clinic_today(), clinic_today() - 1)`, [v.branch_id]);
  }
  const botoxItem = (w: World, over: Record<string, unknown> = {}) => ({ service_id: w.botox.id, values: { cc: 2.5 }, sessions_count: 3, interval_days: 28, first_session_date: d(7), ...over });
  const laserItem = (w: World, zones: number[], over: Record<string, unknown> = {}) => ({ service_id: w.laser.id, values: { zones }, sessions_count: 2, interval_days: 14, first_session_date: d(7), ...over });
  const plan = (t: string, consId: number, items: object[], extra: object = {}) => post(t, `/consultations/${consId}/plan`, { items, ...extra });
  const activeVisits = async (w: World, from = today) => Number((await one(`select count(*)::int as n from visits where branch_id = $1 and visit_date >= $2 and status in ('booked','arrived')`, [w.id, from])).n);
  const assertConsistent = async (w: World) => {
    const bad = await db.query(
      `select bd.day::text, bd.used_slots, (select count(*)::int from visits v where v.branch_id = bd.branch_id and v.visit_date = bd.day and v.status in ('booked','arrived')) as active
         from booking_days bd where bd.branch_id = $1 and bd.used_slots <> (select count(*)::int from visits v where v.branch_id = bd.branch_id and v.visit_date = bd.day and v.status in ('booked','arrived'))`, [w.id]);
    expect(bad.rows).toEqual([]);
    expect((await db.query(`select visit_date from visits where branch_id = $1 group by visit_date, seq_no having count(*) > 1`, [w.id])).rows).toEqual([]);
    expect((await db.query(`select s.id from treatment_sessions s join visits v on v.id = s.visit_id where s.branch_id = $1 and s.status in ('booked','paid') and (v.status not in ('booked','arrived') or v.visit_date <> s.scheduled_date)`, [w.id])).rows).toEqual([]);
  };

  beforeAll(async () => {
    app = await makeApp(); db = pool();
    today = (await db.query(`select clinic_today()::text as d`)).rows[0].d;
    [owner, nurse] = await Promise.all(['owner', 'nurse1'].map((u) => tokenFor(app, u)));
  });
  afterAll(async () => { await app.close(); await db.end(); });

  // ------------------------------------------------------------------------------------------------
  describe('قائمة الطبيب ودخول الملف', () => {
    let w: World;
    beforeAll(async () => { w = await world('PLA'); });
    it('القائمة: زبائنه اللي دفعوا بالتسلسل، وما يشوف زبائن طبيب ثاني، وغير المدفوع ما يظهر', async () => {
      const a1 = await paidConsult(w, 'A'); const b1 = await paidConsult(w, 'B'); const a2 = await paidConsult(w, 'A');
      const unpaid = await post(w.cash, '/bookings', { customer_id: await customer(w), doctor_id: w.docAId, date: today });
      const q = (await get(w.docA, '/doctor/queue')).body;
      expect(q.date).toBe(today);
      const mine = q.queue.filter((x: any) => [a1.consId, a2.consId].includes(x.consultation_id));
      expect(mine.map((x: any) => x.consultation_id)).toEqual([a1.consId, a2.consId]);
      expect(mine[0]).toMatchObject({ status: 'paid', kind: 'new', seq_no: a1.seqNo, customer: { id: a1.customer }, has_health_alert: false });
      expect(q.queue.map((x: any) => x.consultation_id)).not.toContain(b1.consId);
      expect(q.queue.map((x: any) => x.consultation_id)).not.toContain(unpaid.body.consultation.id);
      expect(q.waiting).toBe(q.queue.filter((x: any) => x.status === 'paid').length);
      expect((await get(w.docB, '/doctor/queue')).body.queue.map((x: any) => x.consultation_id)).toContain(b1.consId);
    });
    it('الصلاحيات: الطبيب بس (الكاشير والممرض والمدير والمالك 403)، والتاريخ الغلط 400، والتاريخ الماضي فاضي', async () => {
      for (const t of [w.cash, nurse, w.mgr, owner]) expect((await get(t, '/doctor/queue')).status).toBe(403);
      expect((await get(w.docA, '/doctor/queue?date=x')).status).toBe(400);
      expect((await get(w.docA, `/doctor/queue?date=${d(-30)}`)).body.queue).toEqual([]);
    });
    it('فتح الملف: paid → with_doctor، إعادة الفتح مسموحة، وغير المدفوع 409، وكشفية طبيب ثاني 404، والمنتهية 409', async () => {
      const x = await paidConsult(w, 'A');
      const r = await post(x.token, `/consultations/${x.consId}/enter`);
      expect(r.status).toBe(201); expect(r.body).toMatchObject({ id: x.consId, status: 'with_doctor', customer_id: x.customer, visit_id: x.visitId });
      expect(r.body.entered_at).not.toBeNull();
      expect((await post(x.token, `/consultations/${x.consId}/enter`)).body.status).toBe('with_doctor');
      expect((await one(`select count(*)::int as n from audit_log where action = 'consultation.enter' and entity_id = $1`, [x.consId])).n).toBe(1);
      const unpaid = await post(w.cash, '/bookings', { customer_id: await customer(w), doctor_id: w.docAId, date: today });
      expect((await post(w.docA, `/consultations/${unpaid.body.consultation.id}/enter`)).body.code).toBe('NOT_PAID');
      const y = await paidConsult(w, 'B');
      expect((await post(w.docA, `/consultations/${y.consId}/enter`)).status).toBe(404);
      expect((await post(w.docA, '/consultations/99999999/enter')).status).toBe(404);
      for (const t of [w.cash, nurse, w.mgr]) expect((await post(t, `/consultations/${y.consId}/enter`)).status).toBe(403);
      expect((await post(y.token, `/consultations/${y.consId}/enter`)).status).toBe(201);
      expect((await post(y.token, `/consultations/${y.consId}/finish`)).status).toBe(201);
      expect((await post(y.token, `/consultations/${y.consId}/enter`)).body.code).toBe('ALREADY_FINISHED');
    });
    it('بعد دخول الطبيب الاسترجاع ممنوع (تكامل مع الدفع)، وباللحظة نفسها: واحد يفوز', async () => {
      const x = await paidConsult(w, 'A');
      await post(x.token, `/consultations/${x.consId}/enter`);
      const r = await http().post(`/payments/${x.paymentId}/refund`).set(auth(w.cash)).set('Idempotency-Key', key()).send({ full_receipt: true, reason: 'تجربة' });
      expect(r.status).toBe(409); expect(r.body.code).toBe('CONSULTATION_ENTERED');
      for (let i = 0; i < 4; i++) {
        const y = await paidConsult(w, 'A');
        const [e, f] = await Promise.all([post(y.token, `/consultations/${y.consId}/enter`), http().post(`/payments/${y.paymentId}/refund`).set(auth(w.cash)).set('Idempotency-Key', key()).send({ full_receipt: true, reason: 'سباق' })]);
        expect([e.status, f.status].filter((s) => s >= 500)).toHaveLength(0);
        expect([e.status === 201, f.status === 201].filter(Boolean)).toHaveLength(1);
        expect((await one(`select status from consultations where id = $1`, [y.consId])).status).toBe(e.status === 201 ? 'with_doctor' : 'cancelled');
      }
    });
    it('الدخول المتزامن 5 مرات: كلها تنجح بنفس النتيجة وسجل حركة واحد', async () => {
      const x = await paidConsult(w, 'A');
      const rs = await Promise.all(Array.from({ length: 5 }, () => post(x.token, `/consultations/${x.consId}/enter`)));
      expect(rs.map((r) => r.status)).toEqual(new Array(5).fill(201));
      expect((await one(`select count(*)::int as n from audit_log where action = 'consultation.enter' and entity_id = $1`, [x.consId])).n).toBe(1);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('المعلومات الصحية وإنهاء الكشفية وملف الزبون', () => {
    let w: World;
    beforeAll(async () => { w = await world('PLB'); });
    it('تسجيل معلومات صحية: إضافة فقط، آخر سجل هو الحالي، وتنبيه بقائمة الطبيب', async () => {
      const x = await opened(w);
      const r = await post(x.token, `/consultations/${x.consId}/health`, { allergies: '  بنسلين ', pregnancy: 'yes', medications: 'حديد' });
      expect(r.status).toBe(201); expect(r.body).toMatchObject({ allergies: 'بنسلين', pregnancy: 'yes', medications: 'حديد', chronic_conditions: null, consultation_id: x.consId });
      const r2 = await post(x.token, `/consultations/${x.consId}/health`, { allergies: 'بنسلين، لاتكس', pregnancy: 'no' });
      expect(r2.status).toBe(201);
      const file = (await get(x.token, `/customers/${x.customer}/file`)).body;
      expect(file.health.current).toMatchObject({ allergies: 'بنسلين، لاتكس', pregnancy: 'no' }); expect(file.health.history).toHaveLength(2);
      expect((await get(x.token, '/doctor/queue')).body.queue.find((q: any) => q.consultation_id === x.consId).has_health_alert).toBe(true);
      expect((await db.query(`select 1 from audit_log where action = 'health.record' and entity_id = $1`, [x.customer])).rowCount).toBe(2);
      await expect(db.query(`update customer_health set notes = 'x' where customer_id = $1`, [x.customer])).rejects.toThrow();     // إضافة فقط
    });
    it('لازم معلومة وحدة، والكشفية لازم مفتوحة، وبصلاحية الطبيب ولكشفيته بس', async () => {
      const x = await opened(w); const y = await paidConsult(w, 'A');
      expect((await post(x.token, `/consultations/${x.consId}/health`, {})).body.code).toBe('EMPTY_RECORD');
      expect((await post(x.token, `/consultations/${x.consId}/health`, { allergies: '   ', pregnancy: 'unknown' })).body.code).toBe('EMPTY_RECORD');
      expect((await post(x.token, `/consultations/${y.consId}/health`, { allergies: 'x1' })).body.code).toBe('NOT_WITH_DOCTOR');
      expect((await post(w.docB, `/consultations/${x.consId}/health`, { allergies: 'x1' })).status).toBe(404);
      for (const t of [w.cash, nurse, w.mgr, owner]) expect((await post(t, `/consultations/${x.consId}/health`, { allergies: 'x1' })).status).toBe(403);
      for (const bad of [{ pregnancy: 'maybe' }, { allergies: 'x'.repeat(501) }, { extra: 1 }]) expect((await post(x.token, `/consultations/${x.consId}/health`, { allergies: 'x1', ...bad })).status).toBe(400);
    });
    it('إنهاء الكشفية: بدون نسبة ما يثبت مستحق، ومع نسبة 20% يثبت من صافي الكشفية، ومرتين 409، وقبل الدخول 409', async () => {
      const x = await opened(w);
      const f = await post(x.token, `/consultations/${x.consId}/finish`);
      expect(f.status).toBe(201); expect(f.body).toMatchObject({ status: 'finished', doctor_earning: null }); expect(f.body.finished_at).not.toBeNull();
      expect((await post(x.token, `/consultations/${x.consId}/finish`)).body.code).toBe('ALREADY_FINISHED');
      const notEntered = await paidConsult(w, 'A');
      expect((await post(notEntered.token, `/consultations/${notEntered.consId}/finish`)).body.code).toBe('NOT_WITH_DOCTOR');
      await db.query(`insert into pay_rules (user_id, effective_from, consult_percent, set_by) values ($1, clinic_today() - 5, 20, $2)`, [w.docAId, w.mgrId]);
      const y = await opened(w);
      const g = await post(y.token, `/consultations/${y.consId}/finish`);
      expect(g.body.doctor_earning).toEqual({ base_amount: 30000, percent: 20, amount: 6000 });
      expect(await one(`select base_amount::int as b, percent::float as p, amount::int as a, earned_on::text as d from doctor_earnings where consultation_id = $1`, [y.consId])).toEqual({ b: 30000, p: 20, a: 6000, d: today });
      const bOnly = await opened(w, 'B');
      expect((await post(bOnly.token, `/consultations/${bOnly.consId}/finish`)).body.doctor_earning).toBeNull();            // طبيب ثاني بدون نسبة
    });
    it('النسبة تتحدد بالتاريخ الساري، وعلى الصافي بعد الخصم، والمراجعة المجانية بدون مستحق', async () => {
      await db.query(`update pay_rules set consult_percent = 15 where user_id = $1`, [w.docAId]);                              // الأقدم
      await db.query(`insert into pay_rules (user_id, effective_from, consult_percent, set_by) values ($1, clinic_today() + 30, 50, $2)`, [w.docAId, w.mgrId]);   // مستقبلية: ما تنطبق
      const x = await paidConsult(w, 'A');
      await post(x.token, `/consultations/${x.consId}/enter`);
      expect((await post(x.token, `/consultations/${x.consId}/finish`)).body.doctor_earning).toEqual({ base_amount: 30000, percent: 15, amount: 4500 });
      const parent = await opened(w, 'A');
      await moveVisitToYesterday(parent.visitId);
      const fu = await post(w.cash, '/bookings', { customer_id: parent.customer, doctor_id: w.docAId, date: today });
      expect(fu.body.consultation.kind).toBe('free_followup');
      expect((await post(w.cash, `/consultations/${fu.body.consultation.id}/check-in`)).status).toBe(201);
      await post(w.docA, `/consultations/${fu.body.consultation.id}/enter`);
      expect((await post(w.docA, `/consultations/${fu.body.consultation.id}/finish`)).body.doctor_earning).toBeNull();
    });
    it('مستحق الطبيب على الصافي بعد الخصم المعتمد (25,000 مو 30,000): 20% = 5,000', async () => {
      await db.query(`delete from pay_rules where user_id = $1`, [w.docBId]);
      await db.query(`insert into pay_rules (user_id, effective_from, consult_percent, set_by) values ($1, clinic_today() - 1, 20, $2)`, [w.docBId, w.mgrId]);
      const c = await customer(w);
      const b = await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docBId, date: today });
      const dr = Number((await one(`insert into discount_requests (branch_id, customer_id, visit_id, basket, status, requested_by, amount, decided_by) values ($1,$2,$3,'[]','approved',$4,5000,$5) returning id`, [w.id, c, b.body.id, w.mgrId, w.mgrId])).id);
      const m = Number((await one(`select id from payment_methods where branch_id = $1 and kind = 'cash'`, [w.id])).id);
      const pay = await http().post('/payments/consultation').set(auth(w.cash)).set('Idempotency-Key', key()).send({ consultation_id: b.body.consultation.id, discount_request_id: dr, tenders: [{ method_id: m, amount: 25000 }] });
      expect(pay.status).toBe(201);
      await post(w.docB, `/consultations/${b.body.consultation.id}/enter`);
      expect((await post(w.docB, `/consultations/${b.body.consultation.id}/finish`)).body.doctor_earning).toEqual({ base_amount: 25000, percent: 20, amount: 5000 });
    });
    it('ملف الزبون: لزبائنه بس (طبيب ثاني 404)، والمالك للكل، وتاريخ الأطباء الثانيين للقراءة، والكاشير والممرض 403', async () => {
      const x = await opened(w, 'A');
      await post(x.token, `/consultations/${x.consId}/finish`);
      await moveVisitToYesterday(x.visitId);                                                                    // زيارة الطبيب الأول صارت أمس
      await opened(w, 'B', x.customer);                                                                         // نفس الزبون اليوم عند طبيب ثاني
      const f = await get(w.docA, `/customers/${x.customer}/file`);
      expect(f.status).toBe(200);
      expect(f.body.customer).toMatchObject({ id: x.customer, status: 'active' });
      expect(f.body.consultations.map((c: any) => [c.doctor.id === w.docAId, c.mine])).toEqual(expect.arrayContaining([[true, true], [false, false]]));
      const stranger = await opened(w, 'B');
      expect((await get(w.docA, `/customers/${stranger.customer}/file`)).status).toBe(404);
      expect((await get(owner, `/customers/${stranger.customer}/file`)).status).toBe(200);
      for (const t of [w.cash, nurse, w.mgr]) expect((await get(t, `/customers/${x.customer}/file`)).status).toBe(403);
      expect((await get(w.docA, '/customers/99999999/file')).status).toBe(404);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('كتابة الخطة وحجز الجلسات', () => {
    let w: World;
    beforeAll(async () => { w = await world('PLC'); });
    it('خطة بوتكس 3 جلسات: بتواريخها بالفرق، كل جلسة بزيارة ورقم، وحالة booked، وتقدير السعر', async () => {
      const x = await opened(w);
      const r = await plan(x.token, x.consId, [botoxItem(w)], { treatments_text: ' بوتكس للجبهة ' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ status: 'active', treatments_text: 'بوتكس للجبهة', consultation_id: x.consId, customer_id: x.customer, draft_failure_reason: null, estimated_total: 125000 * 3 });
      const it = r.body.items[0];
      expect(it).toMatchObject({ sessions_count: 3, interval_days: 28, first_session_date: d(7), estimate: { per_session: 125000, total: 375000 }, service: { name: 'بوتكس' } });
      expect(it.values).toEqual([{ field_key: 'cc', label: 'كم cc', number: 2.5, text: null, bool: null, option_ids: [] }]);
      expect(it.sessions.map((s: any) => [s.seq_no, s.status, s.scheduled_date, s.planned_date, s.moved])).toEqual([[1, 'booked', d(7), d(7), false], [2, 'booked', d(35), d(35), false], [3, 'booked', d(63), d(63), false]]);
      const visits = new Set(it.sessions.map((s: any) => s.visit_id)); expect(visits.size).toBe(3);
      for (const s of it.sessions) {
        const v = await one(`select status, visit_date::text as d, seq_no, doctor_id from visits where id = $1`, [s.visit_id]);
        expect(v).toMatchObject({ status: 'booked', d: s.scheduled_date, doctor_id: null }); expect(v.seq_no).toBe(s.visit_seq_no);
      }
      expect((await db.query(`select 1 from booking_events where treatment_session_id = $1 and event = 'booked'`, [it.sessions[0].id])).rowCount).toBe(1);
      expect((await db.query(`select 1 from audit_log where action = 'plan.create' and entity_id = $1`, [r.body.id])).rowCount).toBe(1);
      const v = (await db.query(`select pv.value_number::float as n, pv.field_version_id from plan_item_values pv where plan_item_id = $1`, [it.id])).rows[0];
      expect(v.n).toBe(2.5); expect(v.field_version_id).not.toBeNull();
      await assertConsistent(w);
    });
    it('جلسة أولى اليوم تنضم لزيارة الكشفية (بدون مقعد ورقم جديد)، وخدمتين بنفس اليوم تشاركان زيارة وحدة', async () => {
      const x = await opened(w);
      const used0 = Number((await one(`select used_slots from booking_days where branch_id = $1 and day = $2`, [w.id, today])).used_slots);
      const r = await plan(x.token, x.consId, [botoxItem(w, { first_session_date: today, sessions_count: 1 }), laserItem(w, [w.laser.zones[0].id], { first_session_date: today, sessions_count: 1 })]);
      expect(r.status).toBe(201);
      expect(r.body.items.map((i: any) => i.sessions[0].visit_id)).toEqual([x.visitId, x.visitId]);
      expect(Number((await one(`select used_slots from booking_days where branch_id = $1 and day = $2`, [w.id, today])).used_slots)).toBe(used0);
      const y = await opened(w);
      const r2 = await plan(y.token, y.consId, [botoxItem(w, { first_session_date: d(20), sessions_count: 1 }), laserItem(w, [w.laser.zones[1].id], { first_session_date: d(20), sessions_count: 1 })]);
      expect(r2.status).toBe(201);
      const [a, b] = r2.body.items.map((i: any) => i.sessions[0]);
      expect(a.visit_id).toBe(b.visit_id); expect(a.visit_seq_no).toBe(b.visit_seq_no);
      expect(Number((await one(`select used_slots from booking_days where branch_id = $1 and day = $2`, [w.id, d(20)])).used_slots)).toBe(1);
      await assertConsistent(w);
    });
    it('يوم ممتلئ: الجلسة تنتقل لأقرب يوم فيه مكان والتالية بعدها بالفرق على الأقل، واليوم المسكر والعطلة يتخطاهم', async () => {
      const x = await world('PLD');
      const lim = (await get(x.mgr, '/settings')).body.settings.find((s: any) => s.key === 'booking.daily_limit');
      expect((await put(x.mgr, '/settings/booking.daily_limit', { value: 2, expected_version: lim.version })).status).toBe(200);
      const day1 = d(10);
      for (let i = 0; i < 2; i++) { const c = await customer(x); expect((await post(x.cash, '/bookings', { customer_id: c, doctor_id: x.docAId, date: day1 })).status).toBe(201); }     // اليوم 10 ممتلئ
      expect((await post(x.mgr, '/schedule/holidays', { date: d(11), name: 'عطلة' })).status).toBe(201);
      const c = await opened(x);
      const r = await plan(c.token, c.consId, [botoxItem(x, { first_session_date: day1, sessions_count: 3, interval_days: 7 })]);
      expect(r.status).toBe(201);
      const s = r.body.items[0].sessions;
      expect(s[0]).toMatchObject({ planned_date: day1, scheduled_date: d(12), moved: true });                         // 10 ممتلئ، 11 عطلة، 12 فاضي
      expect(s[1]).toMatchObject({ planned_date: d(17), scheduled_date: d(19), moved: true });                        // أقل من 12+7 = 19
      expect(s[2]).toMatchObject({ planned_date: d(24), scheduled_date: d(26), moved: true });                        // 19+7 = 26
      await assertConsistent(x);
    });
    it('تواريخ بالإيد: تنحجز بتواريخها، والتحقق (التزايد، العدد، واحد من الاثنين، الماضي)', async () => {
      const x = await opened(w);
      const r = await plan(x.token, x.consId, [{ service_id: w.fixed, sessions_count: 3, interval_days: 0, dates: [d(3), d(4), d(30)] }]);
      expect(r.status).toBe(201);
      expect(r.body.items[0].sessions.map((s: any) => s.scheduled_date)).toEqual([d(3), d(4), d(30)]);
      const y = await opened(w);
      const base = { service_id: w.fixed, sessions_count: 2, interval_days: 7 };
      expect((await plan(y.token, y.consId, [{ ...base, dates: [d(5), d(5)] }])).body.code).toBe('DATES_NOT_INCREASING');
      expect((await plan(y.token, y.consId, [{ ...base, dates: [d(6), d(5)] }])).body.code).toBe('DATES_NOT_INCREASING');
      expect((await plan(y.token, y.consId, [{ ...base, dates: [d(5)] }])).body.code).toBe('DATES_COUNT_MISMATCH');
      expect((await plan(y.token, y.consId, [{ ...base }])).body.code).toBe('DATES_OR_FIRST');
      expect((await plan(y.token, y.consId, [{ ...base, dates: [d(5), d(6)], first_session_date: d(5) }])).body.code).toBe('DATES_OR_FIRST');
      expect((await plan(y.token, y.consId, [{ ...base, first_session_date: d(-1) }])).body.code).toBe('DATE_IN_PAST');
      expect((await plan(y.token, y.consId, [{ ...base, dates: [d(-2), d(5)] }])).body.code).toBe('DATE_IN_PAST');
      expect((await plan(y.token, y.consId, [{ ...base, first_session_date: '2026-02-30' }])).body.code).toBe('INVALID_DATE');
      expect((await one(`select count(*)::int as n from treatment_plans where consultation_id = $1`, [y.consId])).n).toBe(0);
    });
    it('قيم الحقول تنتحقق بمحرك التسعير: حقل ناقص/مجهول/غلط، فول بدي مع غيره، خدمة معطلة أو كشفية أو من فرع ثاني', async () => {
      const x = await opened(w); const full = w.laser.zones.find((z) => z.label_ar === 'فول بدي')!.id; const arm = w.laser.zones[0].id;
      expect((await plan(x.token, x.consId, [botoxItem(w, { values: {} })])).body.code).toBe('FIELD_REQUIRED');
      expect((await plan(x.token, x.consId, [botoxItem(w, { values: { cc: 2, nope: 1 } })])).body.code).toBe('UNKNOWN_FIELD');
      expect((await plan(x.token, x.consId, [botoxItem(w, { values: { cc: 0 } })])).body.code).toBe('INVALID_FIELD_VALUE');
      expect((await plan(x.token, x.consId, [botoxItem(w, { values: { cc: -1 } })])).body.code).toBe('INVALID_FIELD_VALUE');
      expect((await plan(x.token, x.consId, [laserItem(w, [full, arm])])).body.code).toBe('EXCLUSIVE_OPTION_CONFLICT');
      expect((await plan(x.token, x.consId, [laserItem(w, [])])).body.code).toBe('FIELD_REQUIRED');
      expect((await plan(x.token, x.consId, [laserItem(w, [99999999])])).body.code).toBe('INVALID_OPTION');
      const off = (await post(w.mgr, '/services', { name_ar: 'معطلة', pricing_model: 'fixed', price: 1000 })).body.id;
      expect((await plan(x.token, x.consId, [{ service_id: off, sessions_count: 1, interval_days: 0, first_session_date: d(3) }])).body.code).toBe('SERVICE_INACTIVE');
      const consSvc = (await one(`select id from services where branch_id = $1 and kind = 'consultation'`, [w.id])).id;
      expect((await plan(x.token, x.consId, [{ service_id: Number(consSvc), sessions_count: 1, interval_days: 0, first_session_date: d(3) }])).body.code).toBe('SERVICE_INVALID');
      expect((await plan(x.token, x.consId, [{ service_id: 99999999, sessions_count: 1, interval_days: 0, first_session_date: d(3) }])).status).toBe(404);
      const other = await world('PLC2');
      expect((await plan(x.token, x.consId, [{ service_id: other.fixed, sessions_count: 1, interval_days: 0, first_session_date: d(3) }])).body.code).toBe('SERVICE_INVALID');
      for (const bad of [{ sessions_count: 0 }, { sessions_count: 61 }, { interval_days: -1 }, { interval_days: 366 }, { extra: 1 }]) expect((await plan(x.token, x.consId, [botoxItem(w, bad)])).status).toBe(400);
      expect((await plan(x.token, x.consId, [])).status).toBe(400);
      expect((await one(`select count(*)::int as n from treatment_plans where consultation_id = $1`, [x.consId])).n).toBe(0);
      expect(await activeVisits(w, d(1))).toBeGreaterThanOrEqual(0);
    });
    it('الكشفية: لازم مفتوحة، وللطبيب نفسه بس (طبيب ثاني 404)، والمالك والكاشير والممرض والمدير 403، وخطة ثانية للكشفية 409', async () => {
      const closed = await paidConsult(w, 'A');
      expect((await plan(closed.token, closed.consId, [botoxItem(w)])).body.code).toBe('NOT_WITH_DOCTOR');
      const x = await opened(w);
      expect((await plan(w.docB, x.consId, [botoxItem(w)])).status).toBe(404);
      for (const t of [owner, w.cash, nurse, w.mgr]) expect((await plan(t, x.consId, [botoxItem(w)])).status).toBe(403);
      expect((await plan(x.token, x.consId, [botoxItem(w)])).status).toBe(201);
      expect((await plan(x.token, x.consId, [botoxItem(w)])).body.code).toBe('PLAN_EXISTS');
      expect((await plan(x.token, 99999999, [botoxItem(w)])).status).toBe(404);
    });
    it('تنبيه المخزون: يطلع إذا المادة ما تكفي (ما يمنع)، وبعد الشراء ما يطلع', async () => {
      const x = await opened(w);
      const r = await plan(x.token, x.consId, [botoxItem(w, { values: { cc: 4 }, sessions_count: 2 })]);
      expect(r.status).toBe(201);
      expect(r.body.stock_warnings).toEqual([{ material_id: w.botoxMat, name: 'بوتكس', unit: 'cc', needed: 8, available: 0 }]);
      const b = (await one(`insert into material_batches (branch_id, material_id, source, received_on, expiry_date, unit_cost, qty_initial, qty_on_hand) values ($1,$2,'opening',clinic_today(),clinic_today() + 300,1000,100,0) returning id`, [w.id, w.botoxMat])).id;
      await db.query(`insert into stock_movements (branch_id, material_id, batch_id, movement_type, qty_delta, unit_cost, cost_amount) values ($1,$2,$3,'opening',100,1000,100000)`, [w.id, w.botoxMat, b]);      // رصيد افتتاحي بدفعة (متسق مع فحوصات المخزون)
      const y = await opened(w);
      expect((await plan(y.token, y.consId, [botoxItem(w, { values: { cc: 4 }, sessions_count: 2 })])).body.stock_warnings).toEqual([]);
    });
    it('قراءة الخطة: الطبيب لكشفيته والمالك، والباقي 403/404', async () => {
      const x = await opened(w);
      const p = await plan(x.token, x.consId, [botoxItem(w)]);
      const g = await get(x.token, `/consultations/${x.consId}/plan`);
      expect(g.status).toBe(200); expect(g.body.id).toBe(p.body.id); expect(g.body.items[0].sessions).toHaveLength(3);
      expect((await get(owner, `/consultations/${x.consId}/plan`)).status).toBe(200);
      expect((await get(w.docB, `/consultations/${x.consId}/plan`)).status).toBe(404);
      for (const t of [w.cash, nurse, w.mgr]) expect((await get(t, `/consultations/${x.consId}/plan`)).status).toBe(403);
      const y = await opened(w);
      expect((await get(y.token, `/consultations/${y.consId}/plan`)).status).toBe(404);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('فشل الحجز: المسودة والذرّية', () => {
    let w: World;
    beforeAll(async () => { w = await world('PLE'); });
    /** يملي كل الأيام بالحد من `from` لمدة 400 يوم (حتى ما يلكى يوم) */
    const fillFrom = async (from: string) => db.query(
      `insert into booking_days (branch_id, day, used_slots, last_seq) select $1, g::date, 1000, 1000 from generate_series($2::date, $2::date + 400, interval '1 day') g on conflict (branch_id, day) do update set used_slots = 1000`, [w.id, from]);
    /** يرجع عدّاد الأيام المحشوة لقيمته الحقيقية (عدد الزيارات الفعالة) ويحذف الأيام اللي ما فيها زيارات */
    const unfill = async (from: string) => {
      await db.query(`delete from booking_days bd where bd.branch_id = $1 and bd.day >= $2 and not exists (select 1 from visits v where v.branch_id = bd.branch_id and v.visit_date = bd.day)`, [w.id, from]);
      await db.query(`update booking_days bd set used_slots = (select count(*)::int from visits v where v.branch_id = bd.branch_id and v.visit_date = bd.day and v.status in ('booked','arrived')) where bd.branch_id = $1 and bd.day >= $2`, [w.id, from]);
    };
    it('ما لگينا يوم → 409 والخطة مسودة بسبب الفشل، وبدون أي جلسة أو زيارة أو مقعد، وإعادة المحاولة بعد التفريغ تستبدل المسودة', async () => {
      const x = await opened(w);
      const from = d(40);
      await fillFrom(from);
      const visitsBefore = Number((await one(`select count(*)::int as n from visits where branch_id = $1`, [w.id])).n);
      const r = await plan(x.token, x.consId, [botoxItem(w, { first_session_date: from, sessions_count: 2 })], { treatments_text: 'مسودة' });
      expect(r.status).toBe(409); expect(r.body.code).toBe('PLAN_BOOKING_FAILED'); expect(r.body.reason).toContain('للجلسة 1');
      const p = await one(`select id, status, draft_failure_reason, treatments_text from treatment_plans where consultation_id = $1`, [x.consId]);
      expect(p).toMatchObject({ status: 'draft', treatments_text: 'مسودة' }); expect(p.draft_failure_reason).toContain('ما لگينا يوم'); expect(Number(p.id)).toBe(r.body.plan_id);
      expect(Number((await one(`select count(*)::int as n from plan_items where plan_id = $1`, [p.id])).n)).toBe(1);
      expect(Number((await one(`select count(*)::int as n from treatment_sessions where branch_id = $1 and plan_item_id in (select id from plan_items where plan_id = $2)`, [w.id, p.id])).n)).toBe(0);
      expect(Number((await one(`select count(*)::int as n from visits where branch_id = $1`, [w.id])).n)).toBe(visitsBefore);
      expect((await get(x.token, `/consultations/${x.consId}/plan`)).body).toMatchObject({ status: 'draft', draft_failure_reason: expect.stringContaining('ما لگينا يوم') });
      await unfill(from);
      const ok = await plan(x.token, x.consId, [botoxItem(w, { first_session_date: from, sessions_count: 2 })]);
      expect(ok.status).toBe(201); expect(ok.body.status).toBe('active'); expect(ok.body.draft_failure_reason).toBeNull();
      expect((await one(`select count(*)::int as n from treatment_plans where consultation_id = $1`, [x.consId])).n).toBe(1);        // المسودة انحذفت
    });
    it('فشل بالبند الثاني يلغي حجز البند الأول (ذرّي): لا جلسات ولا زيارات ولا مقاعد', async () => {
      const x = await opened(w);
      const late = d(120);
      await fillFrom(late);
      const visitsBefore2 = Number((await one(`select count(*)::int as n from visits where branch_id = $1`, [w.id])).n);
      const sessionsBefore = Number((await one(`select count(*)::int as n from treatment_sessions where branch_id = $1`, [w.id])).n);
      const r = await plan(x.token, x.consId, [botoxItem(w, { first_session_date: d(50), sessions_count: 2, interval_days: 7 }), laserItem(w, [w.laser.zones[0].id], { first_session_date: late, sessions_count: 1 })]);
      expect(r.status).toBe(409); expect(r.body.code).toBe('PLAN_BOOKING_FAILED');
      expect(Number((await one(`select count(*)::int as n from treatment_sessions where branch_id = $1`, [w.id])).n)).toBe(sessionsBefore);
      expect(Number((await one(`select count(*)::int as n from visits where branch_id = $1`, [w.id])).n)).toBe(visitsBefore2);
      expect((await one(`select status from treatment_plans where consultation_id = $1`, [x.consId])).status).toBe('draft');
      await unfill(late);
      await assertConsistent(w);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('إيقاف الخطة', () => {
    let w: World;
    beforeAll(async () => { w = await world('PLF'); });
    it('الجلسات غير المدفوعة تنلغي، وزياراتها (اللي فيها جلسات بس) تنلغي ويرجع المقعد، وزيارة الكشفية تبقى', async () => {
      const x = await opened(w);
      const r = await plan(x.token, x.consId, [botoxItem(w, { first_session_date: today, sessions_count: 3, interval_days: 7 })]);
      expect(r.status).toBe(201);
      const sessions = r.body.items[0].sessions;
      const d1 = await one(`select used_slots::int as u from booking_days where branch_id = $1 and day = $2`, [w.id, d(7)]);
      const s = await post(x.token, `/plans/${r.body.id}/stop`, { reason: 'الزبون سافر' });
      expect(s.status).toBe(201);
      expect(s.body).toMatchObject({ status: 'stopped', stop_reason: 'الزبون سافر', cancelled_sessions: 3, released_visits: 2, paid_sessions_to_follow_up: [] });
      expect((await db.query(`select status from treatment_sessions where plan_item_id = $1 order by seq_no`, [r.body.items[0].id])).rows.map((x) => x.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
      expect((await one(`select status from visits where id = $1`, [x.visitId])).status).toBe('arrived');                       // زيارة الكشفية
      expect((await one(`select status from visits where id = $1`, [sessions[1].visit_id])).status).toBe('cancelled');
      expect(Number((await one(`select used_slots::int as u from booking_days where branch_id = $1 and day = $2`, [w.id, d(7)])).u)).toBe(d1.u - 1);
      expect((await db.query(`select 1 from booking_events where treatment_session_id = $1 and event = 'cancelled'`, [sessions[0].id])).rowCount).toBe(1);
      expect((await db.query(`select 1 from audit_log where action = 'plan.stop' and entity_id = $1 and reason = 'الزبون سافر'`, [r.body.id])).rowCount).toBe(1);
      await assertConsistent(w);
    });
    it('المدفوعة والمكتملة ما تتأثر وتنذكر للمتابعة، والزيارة اللي فيها جلسة مدفوعة تبقى', async () => {
      const x = await opened(w);
      const r = await plan(x.token, x.consId, [botoxItem(w, { first_session_date: d(3), sessions_count: 3, interval_days: 7 })]);
      const ss = r.body.items[0].sessions;
      await db.query(`update treatment_sessions set status = 'paid' where id = $1`, [ss[0].id]);
      await db.query(`update treatment_sessions set status = 'completed', completed_at = now(), completed_by = (select id from users where username = 'nurse1') where id = $1`, [ss[1].id]);
      const s = await post(x.token, `/plans/${r.body.id}/stop`, { reason: 'إيقاف' });
      expect(s.body).toMatchObject({ cancelled_sessions: 1, paid_sessions_to_follow_up: [ss[0].id], released_visits: 1 });
      expect((await db.query(`select status from treatment_sessions where plan_item_id = $1 order by seq_no`, [r.body.items[0].id])).rows.map((q) => q.status)).toEqual(['paid', 'completed', 'cancelled']);
      expect((await one(`select status from visits where id = $1`, [ss[0].visit_id])).status).toBe('booked');
    });
    it('السبب إلزامي، ومرتين 409، وطبيب ثاني 404، والخطة المسودة ما توقف، والصلاحيات', async () => {
      const x = await opened(w); const r = await plan(x.token, x.consId, [botoxItem(w)]);
      expect((await post(x.token, `/plans/${r.body.id}/stop`, {})).status).toBe(400);
      expect((await post(x.token, `/plans/${r.body.id}/stop`, { reason: '     ' })).status).toBe(400);
      expect((await post(w.docB, `/plans/${r.body.id}/stop`, { reason: 'سبب' })).status).toBe(404);
      for (const t of [w.cash, nurse, w.mgr, owner]) expect((await post(t, `/plans/${r.body.id}/stop`, { reason: 'سبب' })).status).toBe(403);
      expect((await post(x.token, `/plans/${r.body.id}/stop`, { reason: 'سبب' })).status).toBe(201);
      expect((await post(x.token, `/plans/${r.body.id}/stop`, { reason: 'سبب' })).body.code).toBe('NOT_ACTIVE');
      expect((await post(x.token, '/plans/99999999/stop', { reason: 'سبب' })).status).toBe(404);
    });
    it('4 إيقافات متزامنة: واحد ينجح والمقاعد ترجع مرة وحدة', async () => {
      const x = await opened(w); const r = await plan(x.token, x.consId, [botoxItem(w, { first_session_date: d(60), sessions_count: 2, interval_days: 14 })]);
      const before = Number((await one(`select used_slots::int as u from booking_days where branch_id = $1 and day = $2`, [w.id, d(60)])).u);
      const rs = await Promise.all(Array.from({ length: 4 }, () => post(x.token, `/plans/${r.body.id}/stop`, { reason: 'سباق' })));
      expect(rs.filter((q) => q.status === 201)).toHaveLength(1);
      expect(rs.filter((q) => q.status >= 500)).toHaveLength(0);
      expect(Number((await one(`select used_slots::int as u from booking_days where branch_id = $1 and day = $2`, [w.id, d(60)])).u)).toBe(before - 1);
      await assertConsistent(w);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('التزامن', () => {
    it('8 أطباء/زبائن يكتبون خطط بنفس اليوم والحد 5: المقاعد ما تتجاوز الحد، والباقي يتزاحون لأيام بعده بدون تكرار أرقام أو 500', async () => {
      const w = await world('PLG');
      const xs = []; for (let i = 0; i < 4; i++) { xs.push(await opened(w, 'A')); xs.push(await opened(w, 'B')); }
      const lim = (await get(w.mgr, '/settings')).body.settings.find((s: any) => s.key === 'booking.daily_limit');
      expect((await put(w.mgr, '/settings/booking.daily_limit', { value: 5, expected_version: lim.version })).status).toBe(200);          // بعد الكشفيات (اليوم صار 8)
      // اليوم ممتلئ جزئياً بالكشفيات: نخلي الجلسات على يوم مستقبلي
      const day = d(15);
      const rs = await Promise.all(xs.map((x) => plan(x.token, x.consId, [botoxItem(w, { first_session_date: day, sessions_count: 2, interval_days: 3 })])));
      expect(rs.map((r) => r.status)).toEqual(new Array(8).fill(201));
      expect(Number((await one(`select used_slots::int as u from booking_days where branch_id = $1 and day = $2`, [w.id, day])).u)).toBe(5);
      const perDay = (await db.query(`select visit_date::text as d, count(*)::int as n from visits where branch_id = $1 and visit_date >= $2 and status = 'booked' group by 1 order by 1`, [w.id, day])).rows;
      expect(perDay.every((x) => x.n <= 5)).toBe(true);
      for (const r of rs) { const s = r.body.items[0].sessions; expect(s[1].scheduled_date >= addDays(s[0].scheduled_date, 3)).toBe(true); }
      await assertConsistent(w);
    });
    it('جلسة تنضم لزيارة جارية الإلغاء (حتمي): الإلغاء يفوز فتنفتح زيارة جديدة وما تنربط الجلسة بزيارة ملغاة', async () => {
      const w = await world('PLJ'); const x = await opened(w, 'A');
      const day = d(10);
      const fut = await post(w.cash, '/bookings', { customer_id: x.customer, doctor_id: w.docBId, date: day });      // زيارة مستقبلية غير مدفوعة (طبيب ثاني)
      expect(fut.status).toBe(201);
      const hold = await db.connect();
      let res: any; let held = true;
      try {
        await hold.query('begin');
        await hold.query(`select 1 from visits where id = $1 for update`, [fut.body.id]);                        // مثل إلغاء جاري على الزيارة
        const p = plan(x.token, x.consId, [botoxItem(w, { first_session_date: day, sessions_count: 1 })]).then((r) => { res = r; return r; });
        await new Promise((r) => setTimeout(r, 400));
        await hold.query(`update visits set status = 'cancelled', cancelled_at = now(), cancel_reason = 'سباق' where id = $1`, [fut.body.id]);
        await hold.query(`update booking_days set used_slots = greatest(used_slots - 1, 0) where branch_id = $1 and day = $2`, [w.id, day]);
        await hold.query(`update consultations set status = 'cancelled' where visit_id = $1`, [fut.body.id]);
        await hold.query('commit'); held = false;
        await p;
      } finally { if (held) await hold.query('rollback'); hold.release(); }
      expect(res.status).toBe(201);
      const s = res.body.items[0].sessions[0];
      expect(s.scheduled_date).toBe(day); expect(s.visit_id).not.toBe(fut.body.id);
      expect((await one(`select status from visits where id = $1`, [s.visit_id])).status).toBe('booked');
      await assertConsistent(w);
    });
    it('4 طلبات خطة متزامنة لنفس الكشفية: واحد ينجح والباقي PLAN_EXISTS وبدون جلسات مكررة', async () => {
      const w = await world('PLH'); const x = await opened(w);
      const rs = await Promise.all(Array.from({ length: 4 }, () => plan(x.token, x.consId, [botoxItem(w, { sessions_count: 2 })])));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'PLAN_EXISTS')).toHaveLength(3);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(Number((await one(`select count(*)::int as n from treatment_sessions where branch_id = $1`, [w.id])).n)).toBe(2);
      await assertConsistent(w);
    });
    it('خطة ونقل/إلغاء حجز الجلسة الشريكة بنفس اللحظة (زيارة مشتركة بيوم الكشفية): ما يصير 500 والمقاعد متسقة', async () => {
      const w = await world('PLI');
      for (let i = 0; i < 3; i++) {
        const x = await opened(w);
        const [p, c] = await Promise.all([
          plan(x.token, x.consId, [botoxItem(w, { first_session_date: today, sessions_count: 1 })]),
          post(w.cash, `/bookings/${x.visitId}/cancel`, { reason: 'سباق' }),
        ]);
        expect([p.status, c.status].filter((s) => s >= 500)).toHaveLength(0);
        await assertConsistent(w);
      }
    });
  });

  it('فحص نهائي: كل جلسة محجوزة لها زيارة فعالة بنفس التاريخ، ومقاعد كل يوم = زياراته، وما أكو رقم مكرر', async () => {
    const bad = await db.query(`select * from v_integrity_checks where check_name = 'booking_day_slots_mismatch' and entity_id in (select id from branches where code like 'PL%')`);
    // الأيام المحشوة عمداً بالاختبار (نحذفها) ما تبقى؛ أي شي ثاني خلل
    expect(bad.rows).toEqual([]);
    const orphan = await db.query(`select s.id from treatment_sessions s left join visits v on v.id = s.visit_id where s.status in ('booked','paid') and (v.id is null or v.status not in ('booked','arrived'))`);
    expect(orphan.rows).toEqual([]);
  });
});
