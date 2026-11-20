import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { PayrollService } from '../src/payroll/payroll.service';
import { buildCsv, buildXlsx, crc32, zip } from '../src/reports/xlsx';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

interface World { id: number; code: string; mgr: string; mgrId: number; cash: string; cashId: number; nurse: string; nurseId: number; docA: string; docAId: number; cashMethod: number; botox: number; mat: number }
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('التعويضات والتقارير والتصدير', () => {
  let app: INestApplication; let db: Pool; let today: string; let owner: string; let payroll: PayrollService;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  let seq = 0; let phoneSeq = 0;
  const key = () => `rk-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const cashT = (w: World, amount: number) => ({ tenders: [{ method_id: w.cashMethod, amount }] });

  async function world(code: string): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name, created_at) values ($1,$1, now() - interval '400 days') returning id`, [code])).rows[0].id);
    await db.query(`insert into safes (branch_id) values ($1)`, [id]);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id); const cashId = await seedUser(db, `cash_${code}`, 'cashier', id); const nurseId = await seedUser(db, `nurse_${code}`, 'nurse', id);
    const docAId = await seedUser(db, `docA_${code}`, 'doctor', id);
    await db.query(`update users set created_at = now() - interval '400 days' where branch_id = $1`, [id]);
    await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',100000000,'opening_balance','تجربة',$2)`, [id, mgrId]);
    const [mgr, cash, nurse, docA] = await Promise.all([`mgr_${code}`, `cash_${code}`, `nurse_${code}`, `docA_${code}`].map((u) => tokenFor(app, u)));
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
    return { id, code, mgr, mgrId, cash, cashId, nurse, nurseId, docA, docAId, cashMethod, botox: bs.id, mat };
  }
  async function batch(w: World, qty: number, cost = 1000) {
    const b = Number((await db.query(`insert into material_batches (branch_id, material_id, source, received_on, expiry_date, unit_cost, qty_initial, qty_on_hand) values ($1,$2,'opening',clinic_today(),clinic_today() + 90,$3,$4,0) returning id`, [w.id, w.mat, cost, qty])).rows[0].id);
    await db.query(`insert into stock_movements (branch_id, material_id, batch_id, movement_type, qty_delta, unit_cost, cost_amount) values ($1,$2,$3,'opening',$4,$5,$6)`, [w.id, w.mat, b, String(qty), cost, qty * cost]);
    return b;
  }
  async function customer(w: World): Promise<number> {
    phoneSeq++; const r = await post(w.cash, '/customers', { full_name: `زبون تقارير ${phoneSeq}`, phone: `0786${String(phoneSeq).padStart(7, '0')}` });
    expect(r.status).toBe(201); return r.body.id;
  }
  /** كشفية مدفوعة (30,000) ومنتهية بخطة بوتكس cc × جلسات */
  async function flow(w: World, cc: number, sessions: number) {
    const c = await customer(w);
    const b = await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docAId, date: today });
    const cons = b.body.consultation.id as number;
    const pc = await http().post('/payments/consultation').set(auth(w.cash)).set('Idempotency-Key', key()).send({ consultation_id: cons, ...cashT(w, 30000) });
    expect(pc.status).toBe(201);
    expect((await post(w.docA, `/consultations/${cons}/enter`)).status).toBe(201);
    const pl = await post(w.docA, `/consultations/${cons}/plan`, { items: [{ service_id: w.botox, values: { cc }, sessions_count: sessions, interval_days: 7, first_session_date: today }] });
    expect(pl.status).toBe(201);
    expect((await post(w.docA, `/consultations/${cons}/finish`)).status).toBe(201);
    return { customer: c, cons, consPayment: pc.body.id as number, sessions: pl.body.items[0].sessions.map((s: any) => s.id as number) };
  }
  const paySession = (w: World, sid: number, amount: number) => http().post('/payments/sessions').set(auth(w.cash)).set('Idempotency-Key', key()).send({ session_ids: [sid], ...cashT(w, amount) });
  /** ربح طبيب بكشفية (مباشرة بالقاعدة) */
  async function earning(w: World, doctorId: number, amount: number, earnedOn: string) {
    seq++;
    const c = (await db.query(`insert into customers (branch_id, public_code, phone, full_name, source) values ($1,$2,$3,'زبون رواتب','cashier') returning id`, [w.id, `RE${seq}${Date.now() % 1e6}`, `+9647${String(320000000 + seq)}`])).rows[0].id;
    const v = (await db.query(`insert into visits (branch_id, customer_id, visit_date, seq_no, status, source, doctor_id) values ($1,$2,$3,$4,'arrived','cashier',$5) returning id`, [w.id, c, earnedOn, 7500 + seq, doctorId])).rows[0].id;
    const cons = (await db.query(`insert into consultations (branch_id, visit_id, customer_id, doctor_id, status, entered_at, finished_at) values ($1,$2,$3,$4,'finished',now(),now()) returning id`, [w.id, v, c, doctorId])).rows[0].id;
    await db.query(`insert into doctor_earnings (doctor_id, consultation_id, base_amount, percent, amount, earned_on) values ($1,$2,$3,10,$4,$5)`, [doctorId, cons, amount * 10, amount, earnedOn]);
  }
  const dash = (t: string, w: World, from = today, to = today) => get(t, `/reports/dashboard?from=${from}&to=${to}&branch_id=${w.id}`);
  const upload = async (w: World) => { const r = await http().post('/attachments').set(auth(w.mgr)).field('kind', 'expense_proof').attach('file', Buffer.concat([PNG, randomBytes(64)]), { filename: 'p.png' }); expect(r.status).toBe(201); return r.body.id as number; };
  const category = async (w: World, name: string, kind: string) => { const r = await post(w.mgr, '/expense-categories', { name, kind }); expect(r.status).toBe(201); return r.body.id as number; };

  beforeAll(async () => {
    app = await makeApp(); db = pool(); payroll = app.get(PayrollService);
    today = (await db.query(`select clinic_today()::text as d`)).rows[0].d;
    owner = await tokenFor(app, 'owner');
  });
  afterAll(async () => { await app.close(); await db.end(); });

  // ------------------------------------------------------------------------------------------------
  describe('كاتب xlsx و csv', () => {
    const t = { title: 'تقرير/تجربة?', columns: [{ key: 'a', label: 'الاسم' }, { key: 'n', label: 'المبلغ', type: 'money' as const }], rows: [{ a: 'سارة', n: 1250000 }, { a: '=cmd|calc', n: 5 }, { a: 'x<y&"z"', n: null }] };
    it('crc32 صحيح (قيمة معروفة) والملف zip سليم يفتح بـ unzip', () => {
      expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
      const z = zip([['a.txt', Buffer.from('hello')], ['dir/b.txt', Buffer.from('world'.repeat(100))]]);
      expect(z.readUInt32LE(0)).toBe(0x04034b50);
      const end = z.length - 22; expect(z.readUInt32LE(end)).toBe(0x06054b50); expect(z.readUInt16LE(end + 10)).toBe(2);
    });
    it('xlsx: أجزاء الحزمة موجودة، الاتجاه عربي، الأرقام أرقام، والنص يهرب XML ويمنع حقن الصيغ، واسم الورقة ينظف', () => {
      const x = buildXlsx(t);
      expect(x.subarray(0, 2).toString()).toBe('PK');
      const names = [...x.toString('latin1').matchAll(/(\[Content_Types\]\.xml|_rels\/\.rels|xl\/workbook\.xml|xl\/worksheets\/sheet1\.xml|xl\/styles\.xml)/g)].map((m) => m[1]);
      expect(new Set(names).size).toBe(5);
      const { inflateRawSync } = require('node:zlib');
      // نفك الورقة يدوياً: نبحث عن مدخلها بالـ central directory
      const files: Record<string, string> = {};
      let p = 0;
      while (x.readUInt32LE(p) === 0x04034b50) {
        const comp = x.readUInt32LE(p + 18); const nl = x.readUInt16LE(p + 26); const el = x.readUInt16LE(p + 28);
        const name = x.subarray(p + 30, p + 30 + nl).toString('utf8'); const data = x.subarray(p + 30 + nl + el, p + 30 + nl + el + comp);
        files[name] = inflateRawSync(data).toString('utf8'); p += 30 + nl + el + comp;
      }
      expect(Object.keys(files).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
      const sheet = files['xl/worksheets/sheet1.xml'];
      expect(sheet).toContain('rightToLeft="1"');
      expect(sheet).toContain('<c r="B2" s="2"><v>1250000</v></c>');
      expect(sheet).toContain('<t xml:space="preserve">سارة</t>');
      expect(sheet).toContain("&apos;=cmd|calc".replace('&apos;', "'"));
      expect(sheet).toContain('x&lt;y&amp;&quot;z&quot;');
      expect(sheet).not.toContain('<c r="B4"');                                                    // القيمة الفارغة ما تنكتب
      expect(files['xl/workbook.xml']).toContain('name="تقرير تجربة "');
      for (const f of Object.values(files)) expect(f.startsWith('<?xml')).toBe(true);
    });
    it('csv: BOM، فاصلة وسطر جديد وعلامة اقتباس بتهريب صحيح، وحقن الصيغ، والأرقام السالبة تبقى أرقام', () => {
      const c = buildCsv({ title: 't', columns: [{ key: 'a', label: 'اسم, "غريب"' }, { key: 'n', label: 'ن' }], rows: [{ a: 'سطر1\nسطر2', n: -500 }, { a: '=1+1', n: 0 }, { a: '+9647', n: '-12.5' }] });
      expect([...c.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = c.subarray(3).toString('utf8');
      expect(text.split('\r\n')[0]).toBe('"اسم, ""غريب""",ن');
      expect(text).toContain('"سطر1\nسطر2",-500');
      expect(text).toContain("'=1+1,0"); expect(text).toContain("'+9647,-12.5");
    });
  });

  describe('التعويضات', () => {
    const comp = (t: string, body: object) => post(t, '/compensations', body);
    it('المالك بس: على جلسة منفذة، من الخزنة أو إلكتروني، بسبب إلزامي، وتنخصم من الخزنة وتنسجل', async () => {
      const w = await world('RCA'); await batch(w, 50);
      const x = await flow(w, 1, 2); expect((await paySession(w, x.sessions[0], 50000)).status).toBe(201);
      expect((await post(w.nurse, `/sessions/${x.sessions[0]}/complete`)).status).toBe(201);
      const before = Number((await one(`select balance from safes where branch_id = $1`, [w.id])).balance);
      const r = await comp(owner, { session_id: x.sessions[0], amount: 5000, reason: 'حروق خفيفة بعد الجلسة', pay_source: 'safe' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ amount: 5000, reason: 'حروق خفيفة بعد الجلسة', pay_source: 'safe', bank_name: null, branch_id: w.id, customer: { id: x.customer }, session: { id: x.sessions[0], service_name: 'بوتكس' } });
      expect(Number((await one(`select balance from safes where branch_id = $1`, [w.id])).balance)).toBe(before - 5000);
      expect(await one(`select direction, amount::int as a, kind from safe_movements where compensation_id = $1`, [r.body.id])).toEqual({ direction: 'out', a: 5000, kind: 'compensation' });
      const e = await comp(owner, { session_id: x.sessions[0], amount: 7000, reason: 'تعويض ثاني', pay_source: 'electronic', bank_name: 'الرافدين' });
      expect(e.status).toBe(201); expect(Number((await one(`select balance from safes where branch_id = $1`, [w.id])).balance)).toBe(before - 5000);
      expect((await one(`select count(*)::int as n from audit_log where action = 'compensation.create' and entity_id = $1 and reason = 'حروق خفيفة بعد الجلسة'`, [r.body.id])).n).toBe(1);
      const list = await get(owner, `/compensations?branch_id=${w.id}`);
      expect(list.body.compensations.map((c: any) => c.amount)).toEqual([7000, 5000]); expect(list.body.total).toBe(12000);
      expect((await get(owner, `/compensations?branch_id=${w.id}&from=${day(1)}`)).body.compensations).toEqual([]);
      expect((await get(owner, `/compensations?branch_id=${w.id}&to=${day(-1)}`)).body.compensations).toEqual([]);
    });
    it('الرفض: غير المالك، جلسة غير منفذة، سبب أو مصرف ناقص، مبلغ غلط، خزنة ما تكفي، وغير موجودة', async () => {
      const w = await world('RCB'); await batch(w, 50);
      const x = await flow(w, 1, 2); expect((await paySession(w, x.sessions[0], 50000)).status).toBe(201);
      const body = { session_id: x.sessions[0], amount: 1000, reason: 'سبب', pay_source: 'safe' };
      for (const t of [w.mgr, w.cash, w.nurse, w.docA]) expect((await comp(t, body)).status).toBe(403);
      expect((await http().post('/compensations').send(body)).status).toBe(401);
      let r = await comp(owner, body);                                                                     // مدفوعة وما اكتملت
      expect(r.status).toBe(409); expect(r.body.code).toBe('NOT_COMPLETED');
      expect((await post(w.nurse, `/sessions/${x.sessions[0]}/complete`)).status).toBe(201);
      for (const bad of [{ reason: '' }, { reason: '  ' }, { reason: 'ab' }, { amount: 0 }, { amount: -5 }, { amount: 1.5 }, { amount: 1_000_000_001 }, { pay_source: 'cash' }, { session_id: 'x' }, { reason: undefined }])
        expect([bad, (await comp(owner, { ...body, ...bad })).status]).toEqual([bad, 400]);
      r = await comp(owner, { ...body, pay_source: 'electronic' }); expect(r.status).toBe(400); expect(r.body.code).toBe('BANK_REQUIRED');
      r = await comp(owner, { ...body, bank_name: 'مصرف' }); expect(r.status).toBe(400); expect(r.body.code).toBe('BANK_NOT_ALLOWED');
      expect((await comp(owner, { ...body, session_id: 99999999 })).status).toBe(404);
      const huge = await comp(owner, { ...body, amount: 999_999_999 });
      expect(huge.status).toBe(409); expect(huge.body.code).toBe('SAFE_INSUFFICIENT');
      expect(Number((await one(`select count(*)::int as n from compensations where branch_id = $1`, [w.id])).n)).toBe(0);
      expect((await comp(owner, body)).status).toBe(201);
    });
    it('قفل الجلسة (حتمي): تراجع جاري عن التأكيد → التعويض ينتظر ويرفض NOT_COMPLETED، والمالك هو المسجّل كمقرر', async () => {
      const w = await world('RCD'); await batch(w, 50);
      const x = await flow(w, 1, 2); expect((await paySession(w, x.sessions[0], 50000)).status).toBe(201);
      expect((await post(w.nurse, `/sessions/${x.sessions[0]}/complete`)).status).toBe(201);
      const ownerId = Number((await one(`select id from users where role = 'owner' limit 1`)).id);
      const ok = await comp(owner, { session_id: x.sessions[0], amount: 1000, reason: 'تعويض أول', pay_source: 'safe' });
      expect(ok.status).toBe(201); expect(ok.body.decided_by.id).toBe(ownerId);
      expect((await one(`select decided_by::int as d from compensations where id = $1`, [ok.body.id])).d).toBe(ownerId);
      const c = await db.connect(); let res: any; let held = true;
      try {
        await c.query('begin'); await c.query(`select 1 from treatment_sessions where id = $1 for update`, [x.sessions[0]]);
        await c.query(`update treatment_sessions set status = 'paid', completed_at = null, completed_by = null where id = $1`, [x.sessions[0]]);
        const p = comp(owner, { session_id: x.sessions[0], amount: 1000, reason: 'تعويض ثاني', pay_source: 'safe' }).then((r) => { res = r; });
        await new Promise((r) => setTimeout(r, 400));
        expect(res).toBeUndefined();
        await c.query('commit'); held = false; await p;
      } finally { if (held) await c.query('rollback'); c.release(); }
      expect(res.status).toBe(409); expect(res.body.code).toBe('NOT_COMPLETED');
    });
    it('التعويض لا يغير المخزون ولا يرجع الجلسة (ما يصير تراجع)', async () => {
      const w = await world('RCC'); const b = await batch(w, 50);
      const x = await flow(w, 2, 2); expect((await paySession(w, x.sessions[0], 100000)).status).toBe(201);
      expect((await post(w.nurse, `/sessions/${x.sessions[0]}/complete`)).status).toBe(201);
      const q = Number((await one(`select qty_on_hand from material_batches where id = $1`, [b])).qty_on_hand);
      expect((await comp(owner, { session_id: x.sessions[0], amount: 3000, reason: 'تعويض', pay_source: 'safe' })).status).toBe(201);
      expect(Number((await one(`select qty_on_hand from material_batches where id = $1`, [b])).qty_on_hand)).toBe(q);
      expect((await one(`select status from treatment_sessions where id = $1`, [x.sessions[0]])).status).toBe('completed');
    });
  });

  describe('اللوحة الرئيسية وربح الإدارة', () => {
    let w: World;
    beforeAll(async () => {
      w = await world('RPA');
      const b = await batch(w, 20, 1000);
      // زبون 1: كشفية منتهية 30,000 + جلسة بوتكس 2 cc (100,000) مكتملة (كلفة 2,000)
      const x = await flow(w, 2, 2);
      expect((await paySession(w, x.sessions[0], 100000)).status).toBe(201);
      expect((await post(w.nurse, `/sessions/${x.sessions[0]}/complete`)).status).toBe(201);
      // زبون 2: كشفية مدفوعة 30,000 ثم مسترجعة بنفس اليوم (قبل دخول الطبيب)
      const c2 = await customer(w);
      const b2 = await post(w.cash, '/bookings', { customer_id: c2, doctor_id: w.docAId, date: today });
      const p2 = await http().post('/payments/consultation').set(auth(w.cash)).set('Idempotency-Key', key()).send({ consultation_id: b2.body.consultation.id, ...cashT(w, 30000) });
      expect(p2.status).toBe(201);
      expect((await http().post(`/payments/${p2.body.id}/refund`).set(auth(w.cash)).set('Idempotency-Key', key()).send({ full_receipt: true, reason: 'ألغى' })).status).toBe(201);
      // تالف 1 cc (1,000)، مصروف تشغيلي 5,000، معدات 7,000 (خارج الربح)، تعويض 2,500
      expect((await post(w.mgr, '/stock/waste', { batch_id: b, qty: 1, reason: 'damaged' })).status).toBe(201);
      const op = await category(w, 'إيجار', 'operating'); const eq = await category(w, 'أجهزة', 'equipment');
      expect((await post(w.mgr, '/expenses', { category_id: op, amount: 5000, expense_date: today, pay_source: 'safe', proof_attachment_id: await upload(w) })).status).toBe(201);
      expect((await post(w.mgr, '/expenses', { category_id: eq, amount: 7000, expense_date: today, pay_source: 'safe', proof_attachment_id: await upload(w) })).status).toBe(201);
      expect((await post(owner, '/compensations', { session_id: x.sessions[0], amount: 2500, reason: 'تعويض', pay_source: 'safe' })).status).toBe(201);
      const ex = await post(w.mgr, '/expenses', { category_id: op, amount: 9999, expense_date: today, pay_source: 'safe', proof_attachment_id: await upload(w) });   // مصروف يلغيه المالك: ما ينحسب
      expect(ex.status).toBe(201); expect((await post(owner, `/expenses/${ex.body.id}/cancel`, { reason: 'مكرر' })).status).toBe(201);
    });
    it('الأرقام الثلاثة منفصلة وربح الإدارة بالمعادلة، وكل رقم يبين أساسه', async () => {
      const r = await dash(owner, w);
      expect(r.status).toBe(200);
      expect(r.body.basis).toMatchObject({ branch_id: w.id, from: today, to: today, timezone: 'Asia/Baghdad', generated_at: expect.any(String), collections: expect.any(String), executed_revenue: expect.any(String) });
      expect(r.body.collections).toMatchObject({ gross: 160000, refunds: 30000, net: 130000 });
      expect(r.body.collections.by_method).toEqual([{ method_name: 'كاش', kind: 'cash', collected: 160000, refunded: 30000 }]);
      expect(r.body.executed_revenue).toEqual({ total: 130000, sessions: 100000, consultations: 30000 });
      expect(r.body.costs).toEqual({ materials: 2000, salaries: 0, waste: 1000, expenses: 5000, compensations: 2500, total: 10500 });
      expect(r.body.outside_profit).toEqual({ equipment: 7000 });
      expect(r.body.management_profit).toBe(130000 - 10500);
      expect(r.body.counts).toMatchObject({ new_customers: 2, completed_sessions: 1, finished_consultations: 1, payments: 3, refunds: 1 });
      expect(r.body).not.toHaveProperty('table');
    });
    it('المبيعات بنفس بيانات الفرع: الصافي = المقبوض − المسترجع، والاسترجاع بيومه', async () => {
      const r = (await get(owner, `/reports/sales?from=${today}&to=${today}&branch_id=${w.id}`)).body;
      expect(r.days).toEqual([{ day: today, payments: 3, collected: 160000, refunds: 1, refunded: 30000, net: 130000 }]);
      expect(r.total).toEqual({ payments: 3, collected: 160000, refunds: 1, refunded: 30000, net: 130000 });
    });
    it('فترة ثانية فاضية: كلشي صفر، وفترة تضم اليوم والأمس نفس الأرقام', async () => {
      const empty = (await dash(owner, w, day(-30), day(-10))).body;
      expect(empty.collections).toMatchObject({ gross: 0, refunds: 0, net: 0, by_method: [] }); expect(empty.executed_revenue.total).toBe(0); expect(empty.management_profit).toBe(0);
      const wide = (await dash(owner, w, day(-3), day(2))).body;
      expect(wide.management_profit).toBe(119500); expect(wide.collections.net).toBe(130000);
    });
    it('الصلاحيات والتحقق: المالك بس، الفرع إلزامي للمالك (عدة فروع)، الفترة صحيحة وأقصاها سنة', async () => {
      for (const t of [w.mgr, w.cash, w.nurse, w.docA]) expect((await dash(t, w)).status).toBe(403);
      expect((await http().get(`/reports/dashboard?from=${today}&to=${today}`)).status).toBe(401);
      expect((await get(owner, `/reports/dashboard?from=${today}&to=${today}`)).status).toBe(400);                         // فروع كثيرة: لازم branch_id
      const bad = async (qs: string, code: string) => { const r = await get(owner, `/reports/dashboard?${qs}&branch_id=${w.id}`); expect([qs, r.status, r.body.code]).toEqual([qs, 400, code]); };
      await bad(`to=${today}`, 'RANGE_REQUIRED'); await bad(`from=${today}`, 'RANGE_REQUIRED'); await bad(`from=${day(1)}&to=${today}`, 'RANGE_INVALID');
      await bad(`from=2026-02-31&to=${today}`, 'INVALID_DATE'); await bad(`from=${day(-366)}&to=${today}`, 'RANGE_TOO_LONG');
      expect((await get(owner, `/reports/dashboard?from=${day(-365)}&to=${today}&branch_id=${w.id}`)).status).toBe(200);        // 366 يوم بالضبط مسموح
    });
    it('إيراد الكشفية يدخل بإنهائها فقط (المدفوعة غير المنتهية ما تنحسب إيراد منفذ)', async () => {
      const w5 = await world('RPH');
      const c = await customer(w5); const b = await post(w5.cash, '/bookings', { customer_id: c, doctor_id: w5.docAId, date: today });
      expect((await http().post('/payments/consultation').set(auth(w5.cash)).set('Idempotency-Key', key()).send({ consultation_id: b.body.consultation.id, ...cashT(w5, 30000) })).status).toBe(201);
      let r = (await dash(owner, w5)).body;
      expect(r.collections.gross).toBe(30000); expect(r.executed_revenue).toEqual({ total: 0, sessions: 0, consultations: 0 });
      expect((await post(w5.docA, `/consultations/${b.body.consultation.id}/enter`)).status).toBe(201);
      expect((await dash(owner, w5)).body.executed_revenue.total).toBe(0);                                  // دخل للطبيب وما انتهت
      expect((await post(w5.docA, `/consultations/${b.body.consultation.id}/finish`)).status).toBe(201);
      r = (await dash(owner, w5)).body;
      expect(r.executed_revenue).toEqual({ total: 30000, sessions: 0, consultations: 30000 });
    });
    it('التنبيهات: أطباء بدون راتب، سحوبات معلقة، مواد سالبة، رصيد الخزنة', async () => {
      const w2 = await world('RPB');
      await db.query(`insert into pay_rules (user_id, effective_from, monthly_salary, set_by) values ($1, clinic_today(), 1000000, $2)`, [w2.docAId, w2.mgrId]);
      const doc2 = await seedUser(db, `docB_${seq}`, 'doctor', w2.id);
      await db.query(`insert into owner_withdrawals (branch_id, amount, withdrawn_by_name, withdrawal_date, status, recorded_by) values ($1,1000,'المالك',clinic_today(),'pending',$2)`, [w2.id, w2.mgrId]);
      const a = (await dash(owner, w2)).body.alerts;
      expect(a.doctors_without_salary).toEqual([{ id: doc2, full_name: expect.any(String) }]);
      expect(a).toMatchObject({ pending_withdrawals: 1, negative_stock: 0, payroll_unset_items: 0, safe_balance: 100000000 });
      const appr = Number((await db.query(`insert into owner_withdrawals (branch_id, amount, withdrawn_by_name, withdrawal_date, status, recorded_by, decided_by, decided_at) values ($1,500,'المالك',clinic_today(),'approved',$2,$3,now()) returning id`, [w2.id, w2.mgrId, w2.mgrId])).rows[0].id);
      await db.query(`insert into safe_movements (branch_id, direction, amount, kind, owner_withdrawal_id, note, created_by) values ($1,'out',500,'owner_withdrawal',$2,'سحب',$3)`, [w2.id, appr, w2.mgrId]);     // المعتمد له حركة خزنة (الفحوص الشاملة بملفات ثانية تعتمد عليها)
      await db.query(`insert into owner_withdrawals (branch_id, amount, withdrawn_by_name, withdrawal_date, status, recorded_by, decided_by, decided_at) values ($1,600,'المالك',clinic_today(),'rejected',$2,$3,now())`, [w2.id, w2.mgrId, w2.mgrId]);
      expect((await dash(owner, w2)).body.alerts.pending_withdrawals).toBe(1);                                // المعتمد والمرفوض ما ينعدون
      const doc3 = await seedUser(db, `docC_${seq}`, 'doctor', w2.id);
      await db.query(`insert into pay_rules (user_id, effective_from, monthly_salary, set_by) values ($1, clinic_today(), 0, $2)`, [doc3, w2.mgrId]);
      expect((await dash(owner, w2)).body.alerts.doctors_without_salary.map((d: any) => d.id)).toEqual([doc2]);   // راتب صفر محدد مو «ما انحدد»
      const other = await world(`RPX${seq}`.slice(0, 8));
      await db.query(`insert into stock_movements (branch_id, material_id, movement_type, qty_delta, unit_cost, cost_amount) values ($1,$2,'count_adjust',-5,100,-500)`, [other.id, other.mat]);
      expect((await dash(owner, w2)).body.alerts.negative_stock).toBe(0);                                      // مادة سالبة بفرع ثاني ما تنعد
      await db.query(`insert into stock_movements (branch_id, material_id, movement_type, qty_delta, unit_cost, cost_amount) values ($1,$2,'count_adjust',-5,100,-500)`, [w2.id, w2.mat]);
      expect((await dash(owner, w2)).body.alerts.negative_stock).toBe(1);
    });
    it('الرواتب بشهر الاستحقاق، وتدخل بربح الفترة اللي تضم بداية الشهر، والمعدات خارج الربح دايماً', async () => {
      const w3 = await world('RPC');
      const prev = (await one(`select to_char(date_trunc('month', clinic_today()) - interval '1 month', 'YYYY-MM') as m`)).m as string;
      await db.query(`insert into pay_rules (user_id, effective_from, monthly_salary, set_by) values ($1,$2,500000,$3), ($4,$2,700000,$3)`, [w3.cashId, `${prev}-01`, w3.mgrId, w3.nurseId]);
      await earning(w3, w3.docAId, 10000, `${prev}-05`);                                                      // طبيب بدون راتب وعنده نسبة: «ما انحدد» ومستحقه ما يدخل الربح
      await payroll.generateForMonth(w3.id, `${prev}-01`, null);
      const inRange = (await dash(owner, w3, `${prev}-01`, `${prev}-28`)).body;
      expect(inRange.costs.salaries).toBe(1200000); expect(inRange.management_profit).toBe(-1200000);
      expect((await dash(owner, w3, `${prev}-02`, `${prev}-28`)).body.costs.salaries).toBe(0);               // الفترة ما تضم بداية الشهر
      expect(inRange.alerts.payroll_unset_items).toBe(2);                                                   // المدير والطبيب بدون راتب
    });
    it('عكس تأكيد جلسة: إيرادها يبقى بيومها الأصلي وينعكس بيوم التصحيح (ما يمحى من الماضي)', async () => {
      const w4 = await world('RPD'); await batch(w4, 20, 1000);
      const x = await flow(w4, 2, 2); expect((await paySession(w4, x.sessions[0], 100000)).status).toBe(201);
      expect((await post(w4.nurse, `/sessions/${x.sessions[0]}/complete`)).status).toBe(201);
      // نرجّع تاريخ التأكيد يومين للخلف (يحاكي تأكيد قديم) ثم نتراجع اليوم
      await db.query(`update treatment_sessions set completed_at = completed_at - interval '2 days' where id = $1`, [x.sessions[0]]);
      expect((await post(w4.mgr, `/sessions/${x.sessions[0]}/revert-confirmation`, { reason: 'ضغطة غلط' })).status).toBe(201);
      const old = (await dash(owner, w4, day(-2), day(-2))).body; const now = (await dash(owner, w4)).body; const all = (await dash(owner, w4, day(-3), day(1))).body;
      expect(old.executed_revenue.sessions).toBe(100000);                                                   // الإيراد القديم بيومه
      expect(now.executed_revenue.sessions).toBe(-100000);                                                  // العكس بيوم التصحيح
      expect(all.executed_revenue.sessions).toBe(0);
      expect(now.costs.materials).toBe(0);                                                                  // الخصم والإرجاع كلاهما اليوم → صافي صفر
    });
  });

  describe('بقية التقارير', () => {
    let w: World;
    beforeAll(async () => {
      w = await world('RPE'); await batch(w, 30, 1000);
      const x = await flow(w, 2, 2);
      expect((await paySession(w, x.sessions[0], 100000)).status).toBe(201);
      expect((await post(w.nurse, `/sessions/${x.sessions[0]}/complete`)).status).toBe(201);
      const x2 = await flow(w, 1, 1);
      expect((await paySession(w, x2.sessions[0], 50000)).status).toBe(201);
      expect((await http().post(`/payments/${x2.consPayment}/refund`).set(auth(w.cash)).set('Idempotency-Key', key()).send({ full_receipt: true, reason: 'بعد الإنهاء ممنوع' })).status).toBe(409);
    });
    const rep = (name: string, from = today, to = today) => get(owner, `/reports/${name}?from=${from}&to=${to}&branch_id=${w.id}`);
    it('المبيعات: صف لكل يوم بالفترة (حتى الفاضي)، والمجاميع، وحسب النوع مع الخصومات', async () => {
      const r = await rep('sales', day(-2), today);
      expect(r.body.days.map((d: any) => d.day)).toEqual([day(-2), day(-1), today]);
      expect(r.body.days[2]).toMatchObject({ payments: 4, collected: 30000 * 2 + 100000 + 50000, refunds: 0 });
      expect(r.body.days[0]).toEqual({ day: day(-2), payments: 0, collected: 0, refunds: 0, refunded: 0, net: 0 });
      expect(r.body.total).toMatchObject({ payments: 4, collected: 210000, net: 210000 });
      expect(r.body.by_kind).toEqual([{ kind: 'consultation', payments: 2, net: 60000, offer_discount: 0, manual_discount: 0, points_discount: 0 }, { kind: 'sessions', payments: 2, net: 150000, offer_discount: 0, manual_discount: 0, points_discount: 0 }]);
    });
    it('أرباح الخدمات: الإيراد وكلفة المواد والهامش لكل خدمة (الكشفية بسطر)', async () => {
      const r = await rep('services');
      const botox = r.body.services.find((s: any) => s.name === 'بوتكس'); const consult = r.body.services.find((s: any) => s.name === 'كشفية');
      expect(botox).toMatchObject({ executed: 1, revenue: 100000, materials_cost: 2000, margin: 98000 });
      expect(consult).toMatchObject({ executed: 2, revenue: 60000, materials_cost: 0, margin: 60000 });
      expect(r.body.total).toEqual({ revenue: 160000, materials_cost: 2000, margin: 158000 });
      expect(r.body.services[0].name).toBe('بوتكس');                                                        // مرتبة بالهامش
    });
    it('الكاشير: وصولاته وصافيها وخصوماته واسترجاعاته وشفتاته وفرق الشفتات', async () => {
      const shift = Number((await one(`select id from shifts where cashier_id = $1`, [w.cashId])).id);
      await db.query(`insert into shift_method_totals (shift_id, method_id, method_name, method_kind, collected, expected, counted, confirmed, note) values ($1,$2,'كاش','cash',210000,210000,209000,209000,'نقص 1000')`, [shift, w.cashMethod]);
      const r = await rep('cashiers');
      const c = r.body.cashiers.find((x: any) => x.cashier_id === w.cashId);
      expect(c).toMatchObject({ payments: 4, net: 210000, manual_discounts: 0, refunds: 0, refunded: 0, shifts: 1, cash_difference: -1000 });
    });
    it('المخزون: القيمة والموجود والمنتهي والمحجوز، والتالف حسب السبب، وفروقات الجرد منفصلة', async () => {
      expect((await post(w.mgr, '/stock/waste', { batch_id: Number((await one(`select id from material_batches where branch_id = $1`, [w.id])).id), qty: 2, reason: 'prep_error' })).status).toBe(201);
      const r = await rep('stock');
      const m = r.body.materials.find((x: any) => x.name === 'بوتكس');
      expect(m).toMatchObject({ on_hand: 26, unit: 'cc' });                                                  // 30 − 2 (جلسة مكتملة) − 2 (تالف)
      expect(m.value).toBe(26000); expect(r.body.valuation.total).toBe(26000);                              // 26 cc × 1,000 لكل cc
      expect(r.body.waste).toEqual({ total_cost: 2000, by_reason: [{ reason: 'prep_error', count: 1, cost: 2000 }] });
      expect(r.body.count_adjustments).toEqual({ movements: 0, gains: 0, losses: 0 });
    });
    it('الأطباء والرواتب: كشفيات منتهية ونسبتها، وبنود الرواتب بأشهرها', async () => {
      const d = await rep('doctors');
      expect(d.body.doctors.find((x: any) => x.doctor_id === w.docAId)).toMatchObject({ consultations: 2, percent_amount: 0 });
      const prev = (await one(`select to_char(date_trunc('month', clinic_today()) - interval '1 month', 'YYYY-MM') as m`)).m as string;
      await db.query(`insert into pay_rules (user_id, effective_from, monthly_salary, set_by) values ($1,$2,400000,$3)`, [w.cashId, `${prev}-01`, w.mgrId]);
      await payroll.generateForMonth(w.id, `${prev}-01`, null);
      const p = await rep('payroll', `${prev}-01`, `${prev}-28`);
      expect(p.body.items.find((i: any) => i.name.includes('cash_'))).toMatchObject({ month: prev, base_salary: 400000, total_due: 400000, status: 'pending' });
      expect(p.body.totals).toMatchObject({ accrued: 400000, paid: 0 });
      expect(p.body.totals.unset).toBeGreaterThanOrEqual(1);
    });
    it('ترتيب أرباح الخدمات بالهامش (مو بالاسم)، والأطباء: الكشفيات المنتهية بس وأساس النسبة', async () => {
      const w5 = await world('RPJ'); await batch(w5, 30, 1000);
      const fx = (await post(w5.mgr, '/services', { name_ar: 'ليزر', pricing_model: 'fixed', price: 200000 })).body;
      expect((await post(w5.mgr, `/services/${fx.id}/activate`)).status).toBe(200);
      const x = await flow(w5, 2, 1); expect((await paySession(w5, x.sessions[0], 100000)).status).toBe(201);
      expect((await post(w5.nurse, `/sessions/${x.sessions[0]}/complete`)).status).toBe(201);
      // جلسة ليزر (خدمة ثابتة 200,000) هامشها أكبر من البوتكس واسمها يجي بعده أبجدياً: الترتيب بالهامش مو بالاسم
      const lc = await customer(w5); const lb = await post(w5.cash, '/bookings', { customer_id: lc, doctor_id: w5.docAId, date: today });
      expect((await http().post('/payments/consultation').set(auth(w5.cash)).set('Idempotency-Key', key()).send({ consultation_id: lb.body.consultation.id, ...cashT(w5, 30000) })).status).toBe(201);
      expect((await post(w5.docA, `/consultations/${lb.body.consultation.id}/enter`)).status).toBe(201);
      const lp = await post(w5.docA, `/consultations/${lb.body.consultation.id}/plan`, { items: [{ service_id: fx.id, sessions_count: 1, interval_days: 0, first_session_date: today }] });
      expect(lp.status).toBe(201);
      expect((await paySession(w5, lp.body.items[0].sessions[0].id, 200000)).status).toBe(201);
      expect((await post(w5.nurse, `/sessions/${lp.body.items[0].sessions[0].id}/complete`)).status).toBe(201);
      const c = await customer(w5); const b = await post(w5.cash, '/bookings', { customer_id: c, doctor_id: w5.docAId, date: today });
      expect((await http().post('/payments/consultation').set(auth(w5.cash)).set('Idempotency-Key', key()).send({ consultation_id: b.body.consultation.id, ...cashT(w5, 30000) })).status).toBe(201);   // مدفوعة وما انتهت
      const cons = (await get(owner, `/reports/doctors?from=${today}&to=${today}&branch_id=${w5.id}`)).body.doctors.find((d: any) => d.doctor_id === w5.docAId);
      expect(cons).toMatchObject({ consultations: 1, percent_amount: 0, consultation_net: 0 });
      await db.query(`insert into doctor_earnings (doctor_id, consultation_id, base_amount, percent, amount, earned_on) values ($1,$2,30000,10,3000,clinic_today())`, [w5.docAId, x.cons]);
      expect((await get(owner, `/reports/doctors?from=${today}&to=${today}&branch_id=${w5.id}`)).body.doctors.find((d: any) => d.doctor_id === w5.docAId)).toMatchObject({ consultations: 1, percent_amount: 3000, consultation_net: 30000 });
      const sv = (await get(owner, `/reports/services?from=${today}&to=${today}&branch_id=${w5.id}`)).body.services;
      expect(sv.map((s: any) => s.margin)).toEqual([...sv.map((s: any) => s.margin)].sort((a: number, b: number) => b - a));
      expect(sv.map((s: any) => s.name).slice(0, 2)).toEqual(['ليزر', 'بوتكس']);
    });
    it('الفروع محصورة: تقرير فرع ثاني ما يتداخل', async () => {
      const other = await world('RPF');
      const r = (await get(owner, `/reports/sales?from=${today}&to=${today}&branch_id=${other.id}`)).body;
      expect(r.total).toEqual({ payments: 0, collected: 0, refunds: 0, refunded: 0, net: 0 });
    });
  });

  describe('التصدير', () => {
    let w: World;
    beforeAll(async () => { w = await world('RPG'); await batch(w, 30, 1000); const x = await flow(w, 2, 1); expect((await paySession(w, x.sessions[0], 100000)).status).toBe(201); });
    const exp = (t: string, name: string, qs = '') => get(t, `/reports/${name}/export?from=${today}&to=${today}&branch_id=${w.id}${qs}`).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    it('xlsx (افتراضي) و csv: بالأنواع الصحيحة وأسماء الملفات، ومحتوى مطابق لتقرير JSON', async () => {
      const x = await exp(owner, 'sales');
      expect(x.status).toBe(200); expect(x.headers['content-type']).toContain('spreadsheetml.sheet');
      expect(x.headers['content-disposition']).toBe(`attachment; filename="sales-${today}_${today}.xlsx"`); expect(x.headers['cache-control']).toBe('no-store');
      expect((x.body as Buffer).subarray(0, 2).toString()).toBe('PK');
      const c = await exp(owner, 'sales', '&format=csv');
      expect(c.status).toBe(200); expect(c.headers['content-type']).toContain('text/csv');
      const text = (c.body as Buffer).subarray(3).toString('utf8').split('\r\n');
      expect(text[0]).toBe('اليوم,عدد الوصولات,المقبوض,عدد الاسترجاعات,المسترجع,الصافي'); expect(text[1]).toBe(`${today},2,130000,0,0,130000`);
      for (const name of ['dashboard', 'services', 'cashiers', 'stock', 'doctors']) expect([name, (await exp(owner, name, '&format=csv')).status]).toEqual([name, 200]);
      expect((await exp(owner, 'payroll', '&format=csv')).status).toBe(200);
    });
    it('المالك بس وكل تصدير ينسجل (من، شنو، أي فترة، كم صف)، والصيغة والاسم غلط مرفوضين', async () => {
      for (const t of [w.mgr, w.cash, w.nurse, w.docA]) expect((await exp(t, 'sales')).status).toBe(403);
      expect((await http().get(`/reports/sales/export?from=${today}&to=${today}`)).status).toBe(401);
      expect((await exp(owner, 'sales', '&format=pdf')).status).toBe(400);
      expect((await exp(owner, 'secrets')).status).toBe(404);
      expect((await get(owner, `/reports/sales/export?branch_id=${w.id}`)).status).toBe(400);
      const before = Number((await one(`select count(*)::int as n from audit_log where action = 'report.export' and branch_id = $1`, [w.id])).n);
      await exp(owner, 'services', '&format=csv');
      const log = await one(`select actor_role, reason, after_values from audit_log where action = 'report.export' and branch_id = $1 order by id desc limit 1`, [w.id]);
      expect(Number((await one(`select count(*)::int as n from audit_log where action = 'report.export' and branch_id = $1`, [w.id])).n)).toBe(before + 1);
      expect(log).toMatchObject({ actor_role: 'owner', reason: 'services', after_values: { report: 'services', format: 'csv', from: today, to: today, rows: expect.any(Number) } });
      await exp(w.mgr, 'sales');                                                                            // الممنوع ما ينسجل كتصدير
      expect(Number((await one(`select count(*)::int as n from audit_log where action = 'report.export' and branch_id = $1`, [w.id])).n)).toBe(before + 1);
    });
  });
});
