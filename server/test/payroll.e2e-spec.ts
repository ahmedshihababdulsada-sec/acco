import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { PayrollService } from '../src/payroll/payroll.service';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

interface World { id: number; code: string; mgr: string; mgrId: number; mgr2: string; mgr2Id: number; cash: string; cashId: number; nurse: string; nurseId: number; doc: string; docId: number; doc2Id: number }

describe('الرواتب: قواعد الأجر والتوليد والتسديد', () => {
  let app: INestApplication; let db: Pool; let today: string; let owner: string; let prevMonth: string; let svc: PayrollService;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  let seq = 0;

  async function world(code: string, fund = 100_000_000): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name, created_at) values ($1,$1, now() - interval '400 days') returning id`, [code])).rows[0].id);
    await db.query(`insert into safes (branch_id) values ($1)`, [id]);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id); const mgr2Id = await seedUser(db, `mgrB_${code}`, 'manager', id);
    const cashId = await seedUser(db, `cash_${code}`, 'cashier', id); const nurseId = await seedUser(db, `nurse_${code}`, 'nurse', id);
    const docId = await seedUser(db, `doc_${code}`, 'doctor', id); const doc2Id = await seedUser(db, `docB_${code}`, 'doctor', id);
    await db.query(`update users set created_at = now() - interval '400 days' where branch_id = $1`, [id]);
    if (fund > 0) await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',$2,'opening_balance','تجربة',$3)`, [id, fund, mgrId]);
    const [mgr, mgr2, cash, nurse, doc] = await Promise.all([`mgr_${code}`, `mgrB_${code}`, `cash_${code}`, `nurse_${code}`, `doc_${code}`].map((u) => tokenFor(app, u)));
    return { id, code, mgr, mgrId, mgr2, mgr2Id, cash, cashId, nurse, nurseId, doc, docId, doc2Id };
  }
  /** قاعدة أجر بتاريخ ماضي مباشرة (الـ API يمنع الماضي) لتجربة الشهر الماضي */
  const oldRule = (userId: number, from: string, salary: number | null, percent: number | null = null) =>
    db.query(`insert into pay_rules (user_id, effective_from, monthly_salary, consult_percent, set_by) values ($1,$2,$3,$4,(select id from users where role = 'owner' limit 1))`, [userId, from, salary, percent]);
  /** أرباح طبيب بكشفية (حجز + ربح مباشر بالقاعدة) */
  async function earning(w: World, doctorId: number, amount: number, earnedOn: string) {
    seq++;
    const c = (await db.query(`insert into customers (branch_id, public_code, phone, full_name, source) values ($1,$2,$3,'زبون رواتب','cashier') returning id`, [w.id, `PR${seq}${Date.now() % 1e6}`, `+9647${String(310000000 + seq)}`])).rows[0].id;
    const v = (await db.query(`insert into visits (branch_id, customer_id, visit_date, seq_no, status, source, doctor_id) values ($1,$2,$3,$4,'arrived','cashier',$5) returning id`, [w.id, c, earnedOn, 7000 + seq, doctorId])).rows[0].id;
    const cons = (await db.query(`insert into consultations (branch_id, visit_id, customer_id, doctor_id, status, entered_at, finished_at) values ($1,$2,$3,$4,'finished',now(),now()) returning id`, [w.id, v, c, doctorId])).rows[0].id;
    return Number((await db.query(`insert into doctor_earnings (doctor_id, consultation_id, base_amount, percent, amount, earned_on) values ($1,$2,$3,10,$4,$5) returning id`, [doctorId, cons, amount * 10, amount, earnedOn])).rows[0].id);
  }
  const genMonth = (w: World, month = prevMonth) => svc.generateForMonth(w.id, `${month}-01`, null);
  const items = async (w: World, month = prevMonth, tok = 'owner') => (await get(tok === 'owner' ? owner : tok, `/payroll?month=${month}&branch_id=${w.id}`)).body;
  const itemOf = (list: any, userId: number) => list.items.find((i: any) => i.user.id === userId);
  const safeBal = async (w: World) => Number((await one(`select balance from safes where branch_id = $1`, [w.id])).balance);

  beforeAll(async () => {
    app = await makeApp(); db = pool(); svc = app.get(PayrollService);
    today = (await db.query(`select clinic_today()::text as d`)).rows[0].d;
    prevMonth = (await db.query(`select to_char(date_trunc('month', clinic_today()) - interval '1 month', 'YYYY-MM') as m`)).rows[0].m;
    owner = await tokenFor(app, 'owner');
  });
  afterAll(async () => { await app.close(); await db.end(); });

  // ------------------------------------------------------------------------------------------------
  describe('قواعد الأجر', () => {
    let w: World; let wb: World;
    beforeAll(async () => { w = await world('PRA'); wb = await world('PRB'); });
    it('المدير يحدد راتب الكاشير والممرض، والمالك يحدد للجميع (طبيب ومدير) والنسبة للطبيب، وكلها تنسجل', async () => {
      let r = await put(w.mgr, `/staff/${w.cashId}/pay-rule`, { effective_from: today, monthly_salary: 600000 });
      expect(r.status).toBe(200); expect(r.body.current).toEqual({ effective_from: today, monthly_salary: 600000, consult_percent: null });
      expect((await put(w.mgr, `/staff/${w.nurseId}/pay-rule`, { effective_from: today, monthly_salary: 650000 })).status).toBe(200);
      r = await put(owner, `/staff/${w.docId}/pay-rule`, { effective_from: today, monthly_salary: 2000000, consult_percent: 10 });
      expect(r.status).toBe(200); expect(r.body.current).toEqual({ effective_from: today, monthly_salary: 2000000, consult_percent: 10 });
      expect((await put(owner, `/staff/${w.mgrId}/pay-rule`, { effective_from: today, monthly_salary: 1500000 })).status).toBe(200);
      expect((await put(owner, `/staff/${w.cashId}/pay-rule`, { effective_from: day(30), monthly_salary: 700000 })).body.current.monthly_salary).toBe(600000);   // اللاحق ما يصير ساري
      expect((await one(`select count(*)::int as n from audit_log where action = 'pay_rule.set' and entity_id = $1`, [w.cashId])).n).toBe(2);
    });
    it('الصلاحيات حسب دور الموظف: المدير ما يحدد راتب الطبيب ولا المدير ولا النسبة، وغير المدير/المالك ممنوع، والمالك حساب ما ينُدار', async () => {
      for (const target of [w.docId, w.mgr2Id]) expect((await put(w.mgr, `/staff/${target}/pay-rule`, { effective_from: today, monthly_salary: 1 })).status).toBe(403);
      expect((await put(w.mgr, `/staff/${w.docId}/pay-rule`, { effective_from: today, consult_percent: 50 })).status).toBe(403);
      for (const t of [w.cash, w.nurse, w.doc]) expect((await put(t, `/staff/${w.cashId}/pay-rule`, { effective_from: today, monthly_salary: 1 })).status).toBe(403);
      const ownerId = Number((await one(`select id from users where role = 'owner' limit 1`)).id);
      expect((await put(owner, `/staff/${ownerId}/pay-rule`, { effective_from: today, monthly_salary: 1 })).status).toBe(404);
      expect((await put(wb.mgr, `/staff/${w.cashId}/pay-rule`, { effective_from: today, monthly_salary: 1 })).status).toBe(404);
      expect((await put(owner, `/staff/99999999/pay-rule`, { effective_from: today, monthly_salary: 1 })).status).toBe(404);
      expect((await http().put(`/staff/${w.cashId}/pay-rule`).send({ effective_from: today, monthly_salary: 1 })).status).toBe(401);
    });
    it('التحقق: التاريخ (مو ماضي ولا بعيد)، الراتب، النسبة (للأطباء وبالمنزلتين)، وحقل واحد على الأقل', async () => {
      const bad = async (target: number, body: object, code?: string, tok = owner) => { const r = await put(tok, `/staff/${target}/pay-rule`, body); expect([body, r.status]).toEqual([body, 400]); if (code) expect(r.body.code).toBe(code); };
      await bad(w.cashId, { effective_from: day(-1), monthly_salary: 1 }, 'EFFECTIVE_IN_PAST');
      await bad(w.cashId, { effective_from: day(367), monthly_salary: 1 }, 'EFFECTIVE_TOO_FAR');
      await bad(w.cashId, { effective_from: 'غلط', monthly_salary: 1 });
      await bad(w.cashId, { effective_from: '2026-02-31', monthly_salary: 1 }, 'INVALID_DATE');
      await bad(w.cashId, { effective_from: today }, 'NOTHING_TO_SET');
      await bad(w.cashId, { effective_from: today, monthly_salary: -1 }); await bad(w.cashId, { effective_from: today, monthly_salary: 10.5 }); await bad(w.cashId, { effective_from: today, monthly_salary: 'x' });
      await bad(w.docId, { effective_from: today, consult_percent: 101 }); await bad(w.docId, { effective_from: today, consult_percent: -1 }); await bad(w.docId, { effective_from: today, consult_percent: 10.123 });
      await bad(w.cashId, { effective_from: today, consult_percent: 5 }, 'PERCENT_DOCTORS_ONLY'); await bad(w.mgrId, { effective_from: today, consult_percent: 5 }, 'PERCENT_DOCTORS_ONLY');
      expect((await put(owner, `/staff/${w.docId}/pay-rule`, { effective_from: day(366), monthly_salary: 5 })).status).toBe(200);          // آخر يوم مسموح
    });
    it('السجل: كل تغيير بتاريخه، الساري هو الأحدث لحد اليوم، والمحذوف حقل يرث الساري، والنقطة null تمسح، ونفس التاريخ يستبدل', async () => {
      const u = w.nurseId;
      await put(owner, `/staff/${u}/pay-rule`, { effective_from: day(10), monthly_salary: 900000 });
      await put(owner, `/staff/${w.docId}/pay-rule`, { effective_from: day(10), monthly_salary: 2500000 });                      // النسبة 10 تنورث
      let r = await get(owner, `/staff/${w.docId}/pay-rules`);
      expect(r.body.rules.find((x: any) => x.effective_from === day(10))).toMatchObject({ monthly_salary: 2500000, consult_percent: 10 });
      await put(owner, `/staff/${w.docId}/pay-rule`, { effective_from: day(10), consult_percent: null });                          // مسح النسبة صراحة والراتب يبقى
      r = await get(owner, `/staff/${w.docId}/pay-rules`);
      expect(r.body.rules.filter((x: any) => x.effective_from === day(10))).toHaveLength(1);
      expect(r.body.rules.find((x: any) => x.effective_from === day(10))).toMatchObject({ monthly_salary: 2500000, consult_percent: null });          // الراتب ينورث من نفس السجل
      expect(r.body.current).toMatchObject({ effective_from: today, monthly_salary: 2000000, consult_percent: 10 });
      expect(r.body.rules[0].set_by.name).toEqual(expect.any(String));
      const dates = r.body.rules.map((x: any) => x.effective_from); expect(dates).toEqual([...dates].sort().reverse());
      await put(w.mgr, `/staff/${w.cashId}/pay-rule`, { effective_from: today, monthly_salary: 610000 });                          // نفس تاريخ اليوم يستبدل
      r = await get(w.mgr, `/staff/${w.cashId}/pay-rules`);
      expect(r.body.rules.filter((x: any) => x.effective_from === today)).toHaveLength(1); expect(r.body.current.monthly_salary).toBe(610000);
    });
    it('قراءة السجل: المدير يقرأ الكاشير والممرض بس، والمالك الكل، وفرع ثاني 404', async () => {
      expect((await get(w.mgr, `/staff/${w.cashId}/pay-rules`)).status).toBe(200);
      expect((await get(w.mgr, `/staff/${w.docId}/pay-rules`)).status).toBe(403);
      expect((await get(w.mgr, `/staff/${w.mgr2Id}/pay-rules`)).status).toBe(403);
      expect((await get(owner, `/staff/${w.mgr2Id}/pay-rules`)).status).toBe(200);
      expect((await get(wb.mgr, `/staff/${w.cashId}/pay-rules`)).status).toBe(404);
      expect((await get(w.cash, `/staff/${w.cashId}/pay-rules`)).status).toBe(403);
    });
    it('نظرة الموظفين: المالك يشوف الكل بالمبالغ، والمدير مبالغ الكاشير والممرض بس (والباقي «محدد/غير محدد»)، والمعطل ما يظهر', async () => {
      const w2 = await world('PRO');
      await put(owner, `/staff/${w2.cashId}/pay-rule`, { effective_from: today, monthly_salary: 500000 });
      await put(owner, `/staff/${w2.docId}/pay-rule`, { effective_from: today, monthly_salary: 1800000, consult_percent: 5 });
      await db.query(`update users set is_active = false, deactivated_at = now() where id = $1`, [w2.doc2Id]);
      const o = (await get(owner, `/payroll/staff?branch_id=${w2.id}`)).body.staff;
      expect(o.find((s: any) => s.user_id === w2.docId)).toMatchObject({ role: 'doctor', salary_set: true, monthly_salary: 1800000, consult_percent: 5 });
      expect(o.find((s: any) => s.user_id === w2.nurseId)).toMatchObject({ salary_set: false, monthly_salary: null });
      expect(o.map((s: any) => s.user_id)).not.toContain(w2.doc2Id);
      const m = (await get(w2.mgr, '/payroll/staff')).body.staff;
      expect(m.find((s: any) => s.user_id === w2.cashId)).toMatchObject({ salary_set: true, monthly_salary: 500000 });
      expect(m.find((s: any) => s.user_id === w2.docId)).toMatchObject({ salary_set: true, monthly_salary: null, consult_percent: null });
      expect((await get(w2.cash, '/payroll/staff')).status).toBe(403);
      expect((await get(w2.mgr, `/payroll/staff?branch_id=${w.id}`)).status).toBe(403);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('توليد رواتب الشهر', () => {
    it('كل موظف بالفرع (مدير، كاشير، ممرض، طبيب) بالراتب الساري بآخر يوم بالشهر، وبدون راتب «ما انحدد»، والمالك والفرع الثاني ما يدخلون', async () => {
      const w = await world('PGA'); const other = await world('PGB');
      const m10 = `${prevMonth}-10`;
      await oldRule(w.cashId, `${prevMonth}-01`, 500000);                      // راتب أول الشهر
      await oldRule(w.cashId, m10, 560000);                                    // تعديل بنص الشهر: ينطبق على الشهر كله (بدون تناسب)
      await oldRule(w.cashId, day(0), 999000);                                 // لاحق (هذا الشهر): ما ينطبق
      await oldRule(w.mgrId, `${prevMonth}-01`, 1500000); await oldRule(w.nurseId, `${prevMonth}-01`, 650000);
      await oldRule(w.docId, `${prevMonth}-01`, 2000000, 10);
      await oldRule(other.cashId, `${prevMonth}-01`, 1);
      const r = await genMonth(w);
      expect(r).toMatchObject({ items: 6 });                                    // مديرين 2 + كاشير + ممرض + طبيبين
      const list = await items(w);
      expect(list).toMatchObject({ generated: true, branch_id: w.id, month: prevMonth, not_payable: 2 });
      expect(itemOf(list, w.cashId)).toMatchObject({ status: 'pending', base_salary: 560000, consult_amount: 0, adjustment_amount: 0, total_due: 560000, user: { role: 'cashier' } });
      expect(itemOf(list, w.mgrId)).toMatchObject({ status: 'pending', base_salary: 1500000, user: { role: 'manager' } });
      expect(itemOf(list, w.mgr2Id)).toMatchObject({ status: 'not_payable', base_salary: null, salary_set: false, total_due: 0 });       // مدير بدون راتب
      expect(itemOf(list, w.doc2Id)).toMatchObject({ status: 'not_payable', salary_set: false });
      expect(list.items.map((i: any) => i.user.id)).not.toContain(other.cashId);
      expect(Number((await one(`select count(*)::int as n from payroll_items i join users u on u.id = i.user_id where u.role = 'owner'`)).n)).toBe(0);
      expect(list.totals).toEqual({ due: 560000 + 1500000 + 650000 + 2000000, paid: 0, pending: 560000 + 1500000 + 650000 + 2000000 });
      expect((await one(`select count(*)::int as n from audit_log where action = 'payroll.generate' and entity_id = $1`, [r!.run_id])).n).toBe(1);
    });
    it('نسبة الطبيب: أرباح الشهر بس تنربط وتنجمع مع الراتب، وأرباح غيره ما تنلمس، والطبيب بدون راتب مستحقه معلّق لحد ما المالك يحدد', async () => {
      const w = await world('PGC');
      await oldRule(w.docId, `${prevMonth}-01`, 2000000, 10);
      const e1 = await earning(w, w.docId, 3000, `${prevMonth}-05`); const e2 = await earning(w, w.docId, 4500, `${prevMonth}-28`);
      const outBefore = await earning(w, w.docId, 9999, new Date(Date.parse(`${prevMonth}-01T00:00:00Z`) - 3 * 86400000).toISOString().slice(0, 10)); const thisMonth = await earning(w, w.docId, 7777, today);
      const noSalaryEarn = await earning(w, w.doc2Id, 6000, `${prevMonth}-15`);
      await genMonth(w);
      const list = await items(w);
      expect(itemOf(list, w.docId)).toMatchObject({ status: 'pending', base_salary: 2000000, consult_amount: 7500, total_due: 2007500 });
      const linked = (await db.query(`select id from doctor_earnings where payroll_item_id = $1 order by id`, [itemOf(list, w.docId).id])).rows.map((r) => Number(r.id));
      expect(linked).toEqual([e1, e2]);
      expect((await db.query(`select payroll_item_id from doctor_earnings where id = any($1::bigint[])`, [[outBefore, thisMonth]])).rows.every((r) => r.payroll_item_id === null || Number(r.payroll_item_id) !== itemOf(list, w.docId).id)).toBe(true);
      expect((await one(`select payroll_item_id from doctor_earnings where id = $1`, [thisMonth])).payroll_item_id).toBeNull();
      expect(itemOf(list, w.doc2Id)).toMatchObject({ status: 'not_payable', base_salary: null, consult_amount: 6000, total_due: 6000 });
      expect(list.totals).toEqual({ due: 2007500, paid: 0, pending: 2007500 });                          // «ما انحدد» ما يدخل بالمستحق
      expect((await one(`select payroll_item_id from doctor_earnings where id = $1`, [noSalaryEarn])).payroll_item_id).not.toBeNull();
      // المالك يحدد الراتب بعدين: يتحول معلّق ويتحسب المستحق
      const sb = await post(owner, `/payroll/items/${itemOf(list, w.doc2Id).id}/set-base`, { base_salary: 1800000, reason: 'تحديد راتب جديد' });
      expect(sb.status).toBe(201); expect(sb.body).toMatchObject({ status: 'pending', base_salary: 1800000, consult_amount: 6000, total_due: 1806000 });
    });
    it('الموظف المعطل: قبل الشهر ما يدخل، وخلال الشهر أو بعده يدخل، وزائد عن الشهر (انضاف بعده) ما يدخل', async () => {
      const w = await world('PGD');
      await db.query(`update users set is_active = false, deactivated_at = $2::date - 5 where id = $1`, [w.nurseId, `${prevMonth}-01`]);       // عُطّل قبل الشهر
      await db.query(`update users set is_active = false, deactivated_at = $2::date + 10 where id = $1`, [w.cashId, `${prevMonth}-01`]);      // عُطّل خلال الشهر
      await db.query(`update users set created_at = now() where id = $1`, [w.doc2Id]);                                                          // انضاف هذا الشهر
      await genMonth(w);
      const ids = (await items(w)).items.map((i: any) => i.user.id);
      expect(ids).toContain(w.cashId); expect(ids).not.toContain(w.nurseId); expect(ids).not.toContain(w.doc2Id);
    });
    it('ما يتكرر: التوليد مرة ثانية ما يسوي شي، وتوليدين متزامنين يسوون تشغيل وحيد بدون تكرار بنود', async () => {
      const w = await world('PGE');
      const rs = await Promise.all([genMonth(w), genMonth(w), genMonth(w)]);
      expect(rs.filter((r) => r !== null)).toHaveLength(1);
      expect(Number((await one(`select count(*)::int as n from payroll_runs where branch_id = $1`, [w.id])).n)).toBe(1);
      expect(Number((await one(`select count(*)::int as n from payroll_items i join payroll_runs r on r.id = i.run_id where r.branch_id = $1`, [w.id])).n)).toBe(6);
      expect(await genMonth(w)).toBeNull();
      const api = await post(w.mgr, '/payroll/generate', { month: prevMonth });
      expect(api.status).toBe(409); expect(api.body.code).toBe('ALREADY_GENERATED');
    });
    it('الزر اليدوي: المدير والمالك، شهر مضى بس، صيغة صحيحة، وبعدها القائمة تظهر', async () => {
      const w = await world('PGF');
      expect((await post(w.cash, '/payroll/generate', { month: prevMonth })).status).toBe(403);
      for (const m of ['2026-13', '2026-1', 'x', '']) expect((await post(w.mgr, '/payroll/generate', { month: m })).status).toBe(400);
      const cur = today.slice(0, 7);
      const r = await post(w.mgr, '/payroll/generate', { month: cur });
      expect(r.status).toBe(400); expect(r.body.code).toBe('MONTH_NOT_FINISHED');
      expect((await post(w.mgr, '/payroll/generate', { month: day(40).slice(0, 7) })).body.code).toBe('MONTH_NOT_FINISHED');
      const ok = await post(w.mgr, '/payroll/generate', { month: prevMonth });
      expect(ok.status).toBe(201); expect(ok.body).toMatchObject({ generated: true, month: prevMonth });
      expect(ok.body.items.map((i: any) => i.user.role)).not.toContain('manager');                       // المدير ما يشوف بنود المدراء
    });
    it('المهمة اليومية (generateDue): كل فرع فعال انولد له الشهر الماضي، والفرع اللي انفتح هذا الشهر ما يدخل، وما يتكرر', async () => {
      const w = await world('PGG');
      const young = await world('PGH');
      await db.query(`update branches set created_at = now() where id = $1`, [young.id]);
      const n1 = await svc.generateDue(w.id);
      expect(n1).toBe(1);
      expect(await svc.generateDue(young.id)).toBe(0);
      expect(Number((await one(`select count(*)::int as n from payroll_runs where branch_id = $1 and period_month = $2`, [w.id, `${prevMonth}-01`])).n)).toBe(1);
      expect(Number((await one(`select count(*)::int as n from payroll_runs where branch_id = $1`, [young.id])).n)).toBe(0);
      expect(await svc.generateDue(w.id)).toBe(0);
    });
    it('القائمة: صيغة الشهر إلزامية، شهر ما انولد يرجع generated:false، المدير ما يشوف بنود المدراء والمالك يشوفها، والفرع محصور', async () => {
      const w = await world('PGI'); const other = await world('PGJ');
      expect((await get(w.mgr, '/payroll')).status).toBe(400);
      expect((await get(w.mgr, '/payroll?month=2026-99')).status).toBe(400);
      expect((await get(w.mgr, `/payroll?month=${prevMonth}`)).body).toMatchObject({ generated: false, items: [], totals: { due: 0, paid: 0, pending: 0 } });
      await genMonth(w);
      const m = (await get(w.mgr, `/payroll?month=${prevMonth}`)).body;
      expect(m.items.map((i: any) => i.user.role)).not.toContain('manager'); expect(m.items).toHaveLength(4);
      expect((await get(owner, `/payroll?month=${prevMonth}&branch_id=${w.id}`)).body.items).toHaveLength(6);
      expect((await get(other.mgr, `/payroll?month=${prevMonth}&branch_id=${w.id}`)).status).toBe(403);
      expect((await get(other.mgr, `/payroll?month=${prevMonth}`)).body.generated).toBe(false);
      expect((await get(w.cash, `/payroll?month=${prevMonth}`)).status).toBe(403);
      expect((await http().get(`/payroll?month=${prevMonth}`)).status).toBe(401);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('التعديل والتحديد', () => {
    let w: World; let wb: World; let list: any;
    beforeAll(async () => {
      w = await world('PAA'); wb = await world('PAB');
      for (const u of [w.cashId, w.nurseId, w.docId, w.mgrId]) await oldRule(u, `${prevMonth}-01`, 1000000);
      await genMonth(w); list = await items(w);
    });
    const adj = (t: string, id: number, body: object) => post(t, `/payroll/items/${id}/adjust`, body);
    it('التعديل بسبب إلزامي (خصم أو إضافة)، يستبدل السابق، وصفر يلغيه، والمستحق ما ينزل تحت صفر، وبسجل الحركات', async () => {
      const id = itemOf(list, w.cashId).id;
      let r = await adj(w.mgr, id, { amount: -150000, reason: 'غياب 3 أيام' });
      expect(r.status).toBe(201); expect(r.body).toMatchObject({ adjustment_amount: -150000, adjustment_reason: 'غياب 3 أيام', total_due: 850000 });
      r = await adj(w.mgr, id, { amount: 200000, reason: 'مكافأة' });
      expect(r.body).toMatchObject({ adjustment_amount: 200000, total_due: 1200000 });
      r = await adj(w.mgr, id, { amount: -1000001, reason: 'كبير' });
      expect(r.status).toBe(409); expect(r.body).toMatchObject({ code: 'NEGATIVE_TOTAL', max_deduction: 1000000 });
      expect((await adj(w.mgr, id, { amount: -1000000, reason: 'كامل' })).body.total_due).toBe(0);
      for (const body of [{ amount: -5 }, { amount: -5, reason: '  ' }, { amount: -5, reason: 'ab' }, { amount: 1.5, reason: 'سبب' }, { reason: 'سبب' }, { amount: 'x', reason: 'سبب' }]) expect((await adj(w.mgr, id, body)).status).toBe(400);
      r = await adj(w.mgr, id, { amount: 0, reason: 'إلغاء التعديل' });
      expect(r.body).toMatchObject({ adjustment_amount: 0, adjustment_reason: null, total_due: 1000000 });
      expect((await one(`select adjusted_by from payroll_items where id = $1`, [id])).adjusted_by).toBeNull();
      expect((await one(`select count(*)::int as n from audit_log where action = 'payroll.adjust' and entity_id = $1`, [id])).n).toBeGreaterThanOrEqual(4);
    });
    it('الرفض: غير مدير/مالك، فرع ثاني، بند المدير للمالك بس، غير موجود، ما انحدد راتبه، ومسدد', async () => {
      const id = itemOf(list, w.nurseId).id;
      for (const t of [w.cash, w.nurse, w.doc]) expect((await adj(t, id, { amount: -1, reason: 'سبب' })).status).toBe(403);
      expect((await adj(wb.mgr, id, { amount: -1, reason: 'سبب' })).status).toBe(404);
      expect((await adj(w.mgr, 99999999, { amount: -1, reason: 'سبب' })).status).toBe(404);
      const mid = itemOf(list, w.mgrId).id;
      expect((await adj(w.mgr, mid, { amount: -1, reason: 'سبب' })).status).toBe(404);
      expect((await adj(w.mgr2, mid, { amount: -1, reason: 'سبب' })).status).toBe(404);
      expect((await adj(owner, mid, { amount: -100, reason: 'المالك يعدل راتب المدير' })).body.total_due).toBe(999900);
      const np = itemOf(list, w.mgr2Id).id;
      expect((await adj(owner, np, { amount: 5, reason: 'سبب' })).body.code).toBe('NOT_PENDING');
      expect((await post(w.mgr, `/payroll/items/${id}/pay`, { pay_source: 'safe' })).status).toBe(201);
      const paid = await adj(w.mgr, id, { amount: -1, reason: 'متأخر' });
      expect(paid.status).toBe(409); expect(paid.body.code).toBe('NOT_PENDING');
    });
    it('تحديد الراتب: المالك بس، فقط لـ«ما انحدد»، بسبب، والمستحق يشمل الأرباح والتعديل', async () => {
      const np = itemOf(list, w.mgr2Id).id; const docNp = itemOf(list, w.doc2Id).id;
      const body = { base_salary: 1700000, reason: 'تحديد' };
      for (const t of [w.mgr, w.cash, w.nurse, w.doc]) expect((await post(t, `/payroll/items/${np}/set-base`, body)).status).toBe(403);
      expect((await post(owner, `/payroll/items/${np}/set-base`, { base_salary: 5, reason: '  ' })).status).toBe(400);
      expect((await post(owner, `/payroll/items/${np}/set-base`, { base_salary: -5, reason: 'سبب' })).status).toBe(400);
      expect((await post(owner, `/payroll/items/${np}/set-base`, { base_salary: 5.5, reason: 'سبب' })).status).toBe(400);
      expect((await post(owner, `/payroll/items/${itemOf(list, w.cashId).id}/set-base`, body)).body.code).toBe('ALREADY_SET');
      expect((await post(owner, `/payroll/items/99999999/set-base`, body)).status).toBe(404);
      const r = await post(owner, `/payroll/items/${docNp}/set-base`, body);
      expect(r.status).toBe(201); expect(r.body).toMatchObject({ status: 'pending', base_salary: 1700000, total_due: 1700000 });
      expect((await post(owner, `/payroll/items/${docNp}/set-base`, body)).body.code).toBe('ALREADY_SET');
      expect((await one(`select count(*)::int as n from audit_log where action = 'payroll.set_base' and entity_id = $1`, [docNp])).n).toBe(1);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('تسديد الراتب', () => {
    const pay = (t: string, id: number, body: object) => post(t, `/payroll/items/${id}/pay`, body);
    async function paid(code: string, fund?: number) {
      const w = await world(code, fund); const wb = await world(`${code}X`);
      for (const u of [w.cashId, w.nurseId, w.docId, w.mgrId]) await oldRule(u, `${prevMonth}-01`, 400000);
      await genMonth(w); const list = await items(w);
      return { w, wb, list };
    }
    it('من الخزنة: تنخصم من رصيدها بحركة «راتب» مربوطة بالبند، يتسجل المسدد والتاريخ، وما ينكتب مصروف', async () => {
      const { w, list } = await paid('TPA');
      const id = itemOf(list, w.cashId).id; const before = await safeBal(w);
      const expensesBefore = Number((await one(`select count(*)::int as n from expenses where branch_id = $1`, [w.id])).n);
      const r = await pay(w.mgr, id, { pay_source: 'safe', note: 'تسديد شهر' });
      expect(r.status).toBe(201); expect(r.body).toMatchObject({ status: 'paid', pay_source: 'safe', paid_on: today, total_due: 400000, note: 'تسديد شهر' });
      expect(await safeBal(w)).toBe(before - 400000);
      const m = await one(`select direction, amount::int as a, kind, created_by::int as by from safe_movements where payroll_item_id = $1`, [id]);
      expect(m).toEqual({ direction: 'out', a: 400000, kind: 'salary', by: w.mgrId });
      expect((await one(`select paid_by::int as p from payroll_items where id = $1`, [id])).p).toBe(w.mgrId);
      expect(Number((await one(`select count(*)::int as n from expenses where branch_id = $1`, [w.id])).n)).toBe(expensesBefore);
      expect((await items(w)).totals).toMatchObject({ paid: 400000 });
      expect((await one(`select count(*)::int as n from audit_log where action = 'payroll.pay' and entity_id = $1`, [id])).n).toBe(1);
    });
    it('إلكتروني: مصرف إلزامي والخزنة ما تتأثر، والكاش ما ياخذ مصرف، وتاريخ تسديد بالماضي مسموح والمستقبل لا', async () => {
      const { w, list } = await paid('TPB');
      const id = itemOf(list, w.nurseId).id; const before = await safeBal(w);
      let r = await pay(w.mgr, id, { pay_source: 'electronic' });
      expect(r.status).toBe(400); expect(r.body.code).toBe('BANK_REQUIRED');
      r = await pay(w.mgr, id, { pay_source: 'safe', bank_name: 'الرافدين' });
      expect(r.status).toBe(400); expect(r.body.code).toBe('BANK_NOT_ALLOWED');
      expect((await pay(w.mgr, id, { pay_source: 'safe', paid_on: day(1) })).body.code).toBe('FUTURE_DATE');
      expect((await pay(w.mgr, id, { pay_source: 'safe', paid_on: 'غلط' })).status).toBe(400);
      for (const body of [{}, { pay_source: 'cash' }, { pay_source: 'safe', note: 'x'.repeat(301) }]) expect((await pay(w.mgr, id, body)).status).toBe(400);
      r = await pay(w.mgr, id, { pay_source: 'electronic', bank_name: 'الرافدين', paid_on: day(-3) });
      expect(r.status).toBe(201); expect(r.body).toMatchObject({ pay_source: 'electronic', bank_name: 'الرافدين', paid_on: day(-3) });
      expect(await safeBal(w)).toBe(before);
      expect(Number((await one(`select count(*)::int as n from safe_movements where payroll_item_id = $1`, [id])).n)).toBe(0);
    });
    it('مرتين: ALREADY_PAID، وتسديدين متزامنين: واحد ينجح وحركة وحدة بالخزنة', async () => {
      const { w, list } = await paid('TPC');
      const id = itemOf(list, w.cashId).id; const before = await safeBal(w);
      const rs = await Promise.all([pay(w.mgr, id, { pay_source: 'safe' }), pay(w.mgr, id, { pay_source: 'safe' }), pay(owner, id, { pay_source: 'safe' })]);
      expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(rs.filter((r) => r.status === 409).every((r) => r.body.code === 'ALREADY_PAID')).toBe(true);
      expect(await safeBal(w)).toBe(before - 400000);
      expect(Number((await one(`select count(*)::int as n from safe_movements where payroll_item_id = $1`, [id])).n)).toBe(1);
    });
    it('رصيد الخزنة ما يكفي: SAFE_INSUFFICIENT والبند يبقى معلّق، وبعد التمويل ينجح', async () => {
      const { w, list } = await paid('TPD', 100000);
      const id = itemOf(list, w.cashId).id;
      const r = await pay(w.mgr, id, { pay_source: 'safe' });
      expect(r.status).toBe(409); expect(r.body).toMatchObject({ code: 'SAFE_INSUFFICIENT', safe_balance: 100000, requested: 400000 });
      expect((await one(`select status from payroll_items where id = $1`, [id])).status).toBe('pending');
      await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',1000000,'opening_balance','تمويل',$2)`, [w.id, w.mgrId]);
      expect((await pay(w.mgr, id, { pay_source: 'safe' })).status).toBe(201);
    });
    it('«ما انحدد» و«صفر» ما يتسددون، وراتب المدير للمالك بس، والفروع والصلاحيات', async () => {
      const { w, wb, list } = await paid('TPE');
      expect((await pay(w.mgr, itemOf(list, w.doc2Id).id, { pay_source: 'safe' })).body.code).toBe('SALARY_NOT_SET');
      const zero = itemOf(list, w.nurseId).id;
      await db.query(`update payroll_items set base_salary = 0, total_due = 0 where id = $1`, [zero]);
      expect((await pay(w.mgr, zero, { pay_source: 'safe' })).body.code).toBe('NOTHING_TO_PAY');
      const mid = itemOf(list, w.mgrId).id;
      expect((await pay(w.mgr, mid, { pay_source: 'safe' })).status).toBe(404);
      expect((await pay(w.mgr2, mid, { pay_source: 'safe' })).status).toBe(404);
      const ok = await pay(owner, mid, { pay_source: 'safe' });
      expect(ok.status).toBe(201); expect(ok.body.status).toBe('paid');
      const id = itemOf(list, w.docId).id;
      for (const t of [w.cash, w.nurse, w.doc]) expect((await pay(t, id, { pay_source: 'safe' })).status).toBe(403);
      expect((await pay(wb.mgr, id, { pay_source: 'safe' })).status).toBe(404);
      expect((await pay(w.mgr, 99999999, { pay_source: 'safe' })).status).toBe(404);
      expect((await http().post(`/payroll/items/${id}/pay`).send({ pay_source: 'safe' })).status).toBe(401);
      expect((await pay(w.mgr, id, { pay_source: 'safe' })).status).toBe(201);                       // المدير يسدد راتب الطبيب
    });
    it('التسديد والتعديل بنفس اللحظة: المبلغ المسدد = المستحق وقت التسديد (واحد منهم يفوز بالترتيب)', async () => {
      const { w, list } = await paid('TPF');
      const id = itemOf(list, w.cashId).id;
      const [a, p] = await Promise.all([post(w.mgr, `/payroll/items/${id}/adjust`, { amount: -100000, reason: 'سباق' }), pay(w.mgr, id, { pay_source: 'safe' })]);
      expect(p.status).toBe(201);
      const mv = Number((await one(`select amount::int as a from safe_movements where payroll_item_id = $1`, [id])).a);
      const row = await one(`select total_due::int as t, status, adjustment_amount::int as adj from payroll_items where id = $1`, [id]);
      expect(row.status).toBe('paid'); expect(mv).toBe(row.t);
      expect([a.status, row.adj]).toEqual(a.status === 201 ? [201, -100000] : [409, 0]);
    });
  });
});
