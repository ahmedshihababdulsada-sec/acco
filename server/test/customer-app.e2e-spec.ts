import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { sha256 } from '../src/auth/token.service';
import { LogOtpSender, OTP_SENDER, OtpService } from '../src/customer-app/otp.service';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

interface World { id: number; code: string; mgr: string; mgrId: number; cash: string; nurse: string; docA: string; docAId: number; cashMethod: number; botox: number; mat: number }

describe('تطبيق الزبون: الدخول والحساب والبيانات', () => {
  let app: INestApplication; let db: Pool; let today: string; let owner: string; let sender: LogOtpSender; let otp: OtpService;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const del = (t: string, url: string, body: object = {}) => http().delete(url).set(auth(t)).send(body);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  let seq = 0; let phoneSeq = 0;
  const key = () => `ck-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const cashT = (w: World, amount: number) => ({ tenders: [{ method_id: w.cashMethod, amount }] });
  /** رقم جديد غير مستخدم (07730000000 + n) */
  const newPhone = () => `0773${String(++phoneSeq).padStart(7, '0')}${Math.floor(Math.random() * 10)}`.slice(0, 11);

  async function world(code: string): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name) values ($1,$1) returning id`, [code])).rows[0].id);
    await db.query(`insert into safes (branch_id) values ($1)`, [id]);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id); await seedUser(db, `cash_${code}`, 'cashier', id); await seedUser(db, `nurse_${code}`, 'nurse', id);
    const docAId = await seedUser(db, `docA_${code}`, 'doctor', id);
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
    return { id, code, mgr, mgrId, cash, nurse, docA, docAId, cashMethod, botox: bs.id, mat };
  }
  /** زبون عند الكاشير بدون تطبيق */
  async function cashierCustomer(w: World, phone = newPhone()) {
    const r = await post(w.cash, '/customers', { full_name: `زبون كاشير ${++seq}`, phone });
    expect(r.status).toBe(201); return { id: r.body.id as number, phone };
  }
  /** تسجيل دخول زبون بالتطبيق (طلب رمز + تحقق) */
  async function appLogin(phone: string, w: World, name = 'زبون التطبيق') {
    await db.query(`delete from otp_requests where phone = $1`, [`+964${phone.replace(/^0/, '')}`]);        // يتخطى فاصل الستين ثانية بين الطلبات (اختباره منفصل)
    const rq = await http().post('/customer/auth/request-otp').send({ phone });
    expect(rq.status).toBe(200);
    const norm = `+964${phone.replace(/^0/, '')}`;
    const code = [...sender.sent].reverse().find((s) => s.phone === norm)!.code;
    const r = await http().post('/customer/auth/verify-otp').send({ phone, code, full_name: name, branch_id: w.id });
    expect(r.status).toBe(200);
    return { token: r.body.access_token as string, refresh: r.body.refresh_token as string, id: r.body.customer.id as number, body: r.body };
  }
  /** زبون بخطة: كشفية مدفوعة، وجلستين بوتكس اليوم (الأولى مدفوعة) */
  async function withSessions(w: World, appCustomer: { id: number; phone: string }, cc = 2, count = 2) {
    const b = await post(w.cash, '/bookings', { customer_id: appCustomer.id, doctor_id: w.docAId, date: today });
    expect(b.status).toBe(201);
    expect((await http().post('/payments/consultation').set(auth(w.cash)).set('Idempotency-Key', key()).send({ consultation_id: b.body.consultation.id, ...cashT(w, 30000) })).status).toBe(201);
    expect((await post(w.docA, `/consultations/${b.body.consultation.id}/enter`)).status).toBe(201);
    const pl = await post(w.docA, `/consultations/${b.body.consultation.id}/plan`, { items: [{ service_id: w.botox, values: { cc }, sessions_count: count, interval_days: 7, first_session_date: today }] });
    expect(pl.status).toBe(201);
    return { all: pl.body.items[0].sessions.map((x: any) => x.id as number), first: pl.body.items[0].sessions[0].id as number, second: pl.body.items[0].sessions[1].id as number, consId: b.body.consultation.id as number, paymentCons: b.body.id as number };
  }
  async function batch(w: World, qty: number) {
    const b = Number((await db.query(`insert into material_batches (branch_id, material_id, source, received_on, expiry_date, unit_cost, qty_initial, qty_on_hand) values ($1,$2,'opening',clinic_today(),clinic_today() + 90,1000,$3,0) returning id`, [w.id, w.mat, qty])).rows[0].id);
    await db.query(`insert into stock_movements (branch_id, material_id, batch_id, movement_type, qty_delta, unit_cost, cost_amount) values ($1,$2,$3,'opening',$4,1000,$5)`, [w.id, w.mat, b, String(qty), qty * 1000]);
  }

  let w: World; let wb: World;
  beforeAll(async () => {
    app = await makeApp(); db = pool(); sender = app.get(OTP_SENDER) as LogOtpSender; otp = app.get(OtpService);
    today = (await db.query(`select clinic_today()::text as d`)).rows[0].d;
    owner = await tokenFor(app, 'owner');
    w = await world('CAA'); wb = await world('CAB');
  });
  afterAll(async () => { await app.close(); await db.end(); });

  // ------------------------------------------------------------------------------------------------
  describe('رمز التأكيد', () => {
    it('الطلب: الرقم يتوحد (أرقام عربية، 07، +964)، الرمز 6 أرقام يوصل للمرسل، وينحفظ مجزّأ، والرد ما يكشف التسجيل', async () => {
      const p = newPhone(); const before = sender.sent.length;
      const r = await http().post('/customer/auth/request-otp').send({ phone: p });
      expect(r.status).toBe(200); expect(r.body).toEqual({ sent: true, expires_in: 300, resend_after: 60 });
      const msg = sender.sent[before];
      expect(msg.phone).toBe(`+964${p.slice(1)}`); expect(msg.code).toMatch(/^\d{6}$/);
      const row = await one(`select code_hash, purpose, attempts, expires_at > now() as live from otp_requests where phone = $1 order by id desc limit 1`, [msg.phone]);
      expect(row.code_hash).not.toContain(msg.code); expect(row).toMatchObject({ purpose: 'register', attempts: 0, live: true });
      const arabic = newPhone().replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);
      expect((await http().post('/customer/auth/request-otp').send({ phone: arabic })).status).toBe(200);
      const existing = await cashierCustomer(w);
      expect((await http().post('/customer/auth/request-otp').send({ phone: existing.phone })).body).toEqual(r.body);               // نفس الرد لرقم مسجل
    });
    it('رقم غلط أو ناقص → 400، وبدون جسم 400', async () => {
      for (const phone of ['', '123', '0770123', '06701234567', 'abc', '07701234567890']) expect((await http().post('/customer/auth/request-otp').send({ phone })).status).toBe(400);
      expect((await http().post('/customer/auth/request-otp').send({})).status).toBe(400);
    });
    it('فاصل 60 ثانية بين الطلبات، و5 بالساعة بالأكثر، والطلب الجديد يبطل القديم', async () => {
      const p = newPhone(); const norm = `+964${p.slice(1)}`;
      expect((await http().post('/customer/auth/request-otp').send({ phone: p })).status).toBe(200);
      const first = sender.sent[sender.sent.length - 1].code;
      const soon = await http().post('/customer/auth/request-otp').send({ phone: p });
      expect(soon.status).toBe(409); expect(soon.body.code).toBe('OTP_TOO_SOON'); expect(soon.body.retry_after).toBeGreaterThan(0);
      const age = () => db.query(`update otp_requests set created_at = created_at - interval '2 minutes' where phone = $1`, [norm]);
      await age();
      expect((await http().post('/customer/auth/request-otp').send({ phone: p })).status).toBe(200);
      const bad = await http().post('/customer/auth/verify-otp').send({ phone: p, code: first, full_name: 'اسم', branch_id: w.id });
      expect(bad.status).toBe(400);                                                                                                      // القديم بطل (إلا إذا صدف نفس الرقم)
      for (let i = 0; i < 3; i++) { await age(); expect((await http().post('/customer/auth/request-otp').send({ phone: p })).status).toBe(200); }
      await age();
      const limit = await http().post('/customer/auth/request-otp').send({ phone: p });
      expect(limit.status).toBe(409); expect(limit.body.code).toBe('OTP_LIMIT');
    });
  });

  describe('رمز التأكيد: حالات دقيقة', () => {
    it('طلبات متزامنة لنفس الرقم: واحد ينجح والباقي «بدري» (قفل الرقم)، وصف واحد بالقاعدة', async () => {
      const p = newPhone(); const norm = `+964${p.slice(1)}`;
      const rs = await Promise.all([1, 2, 3, 4].map(() => http().post('/customer/auth/request-otp').send({ phone: p })));
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
      expect(rs.filter((r) => r.status === 409).every((r) => r.body.code === 'OTP_TOO_SOON')).toBe(true);
      expect(Number((await one(`select count(*)::int as n from otp_requests where phone = $1`, [norm])).n)).toBe(1);
    });
    it('الطلب الأحدث هو المعتمد: بعد استنفاد محاولاته ما ينفع رمز أقدم (كل الأقدم يبطل)', async () => {
      const p = newPhone(); const norm = `+964${p.slice(1)}`;
      await http().post('/customer/auth/request-otp').send({ phone: p });
      const first = sender.sent[sender.sent.length - 1].code;
      await db.query(`update otp_requests set created_at = created_at - interval '2 minutes' where phone = $1`, [norm]);
      await http().post('/customer/auth/request-otp').send({ phone: p });
      const second = sender.sent[sender.sent.length - 1].code;
      expect(first === second).toBe(false);
      const wrong = [first, second].includes('000000') ? '999999' : '000000';
      for (let i = 0; i < 5; i++) await http().post('/customer/auth/verify-otp').send({ phone: p, code: wrong, full_name: 'اسم', branch_id: w.id });
      const r = await http().post('/customer/auth/verify-otp').send({ phone: p, code: first, full_name: 'اسم', branch_id: w.id });
      expect(r.status).toBe(400); expect(r.body.code).toBe('INVALID_CODE');
      expect(Number((await one(`select count(*)::int as n from otp_requests where phone = $1 and consumed_at is null`, [norm])).n)).toBe(0);
    });
    it('الغرض: «دخول» لحساب فعال، و«تسجيل» لغيره', async () => {
      const p = newPhone(); const norm = `+964${p.slice(1)}`;
      await http().post('/customer/auth/request-otp').send({ phone: p });
      expect((await one(`select purpose from otp_requests where phone = $1 order by id desc limit 1`, [norm])).purpose).toBe('register');
      await appLogin(p, w);
      await db.query(`delete from otp_requests where phone = $1`, [norm]);
      await http().post('/customer/auth/request-otp').send({ phone: p });
      expect((await one(`select purpose from otp_requests where phone = $1 order by id desc limit 1`, [norm])).purpose).toBe('login');
    });
    it('الاستهلاك ذري: نفس الطلب ما ينستهلك مرتين، والمنتهي ما ينستهلك، والتحقق من المنتهي يرفض', async () => {
      const p = newPhone(); const norm = `+964${p.slice(1)}`;
      await http().post('/customer/auth/request-otp').send({ phone: p });
      const code = sender.sent[sender.sent.length - 1].code;
      const a = await otp.check(p, code); const b = await otp.check(p, code);                                  // نجحوا الاثنين (ما استهلكنا بعد)
      expect(a.requestId).toBe(b.requestId);
      await otp.consume(db, a.requestId);
      await expect(otp.consume(db, b.requestId)).rejects.toMatchObject({ response: { code: 'INVALID_CODE' } });
      await db.query(`update otp_requests set created_at = created_at - interval '2 minutes' where phone = $1`, [norm]);
      await http().post('/customer/auth/request-otp').send({ phone: p });
      const code2 = sender.sent[sender.sent.length - 1].code;
      const live = await otp.check(p, code2);
      await db.query(`update otp_requests set expires_at = now() - interval '1 second' where id = $1`, [live.requestId]);
      await expect(otp.consume(db, live.requestId)).rejects.toMatchObject({ response: { code: 'INVALID_CODE' } });
      await expect(otp.check(p, code2)).rejects.toMatchObject({ response: { code: 'INVALID_CODE' } });
    });
    it('الرمز ما يخص رقم ثاني: رمز رقم A على رقم B مرفوض', async () => {
      const pa = newPhone(); const pb = newPhone();
      await http().post('/customer/auth/request-otp').send({ phone: pa });
      const ca = sender.sent[sender.sent.length - 1].code;
      await http().post('/customer/auth/request-otp').send({ phone: pb });
      const cb = sender.sent[sender.sent.length - 1].code;
      const wrong = ca === cb ? (ca === '000000' ? '111111' : '000000') : ca;
      const r = await http().post('/customer/auth/verify-otp').send({ phone: pb, code: wrong, full_name: 'اسم', branch_id: w.id });
      expect(r.status).toBe(400);
    });
  });

  describe('التسجيل وتسجيل الدخول', () => {
    it('رقم جديد: الاسم والفرع إلزاميين، وفشلهم ما يحرق الرمز، والنجاح ينشئ ملف source=app برمز مميز وتوكنات', async () => {
      const p = newPhone(); const norm = `+964${p.slice(1)}`;
      await http().post('/customer/auth/request-otp').send({ phone: p });
      const code = sender.sent[sender.sent.length - 1].code;
      const v = (body: object) => http().post('/customer/auth/verify-otp').send({ phone: p, code, ...body });
      let r = await v({ branch_id: w.id }); expect(r.status).toBe(400); expect(r.body.code).toBe('NAME_REQUIRED');
      r = await v({ full_name: 'ا', branch_id: w.id }); expect(r.body.code).toBe('NAME_REQUIRED');
      r = await v({ full_name: 'سارة أحمد' }); expect(r.status).toBe(400); expect(r.body.code).toBe('BRANCH_REQUIRED');                  // أكثر من فرع
      r = await v({ full_name: 'سارة أحمد', branch_id: 99999999 }); expect(r.status).toBe(400); expect(r.body.code).toBe('BRANCH_NOT_FOUND');
      r = await v({ full_name: '  سارة   أحمد ', branch_id: w.id });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ token_type: 'Bearer', is_new: true, expires_in: expect.any(Number), customer: { phone: norm, full_name: 'سارة أحمد', points_balance: 0, notify_offers: true, branch: { id: w.id } } });
      expect(r.body.customer.public_code).toMatch(/^[A-Z0-9]+$/);
      const c = await one(`select source, app_registered_at, app_deleted_at, status from customers where phone = $1`, [norm]);
      expect(c).toMatchObject({ source: 'app', app_deleted_at: null, status: 'active' }); expect(c.app_registered_at).not.toBeNull();
      expect((await one(`select count(*)::int as n from refresh_tokens where customer_id = $1 and user_id is null`, [r.body.customer.id])).n).toBe(1);
      expect((await one(`select count(*)::int as n from audit_log where action = 'customer.app_register' and entity_id = $1`, [r.body.customer.id])).n).toBe(1);
      const again = await v({ full_name: 'سارة أحمد', branch_id: w.id });                                                              // الرمز انستهلك
      expect(again.status).toBe(400); expect(again.body.code).toBe('INVALID_CODE');
    });
    it('رقم عنده ملف من الكاشير: يرتبط بنفس الملف (النقاط والاسم يبقون) بدون إنشاء ملف جديد', async () => {
      const cc = await cashierCustomer(w);
      const old = (await db.query(`insert into customers (branch_id, public_code, phone, full_name, source, status, merged_into_id) values ($1,$2,$3,'ملف قديم','cashier','merged',$4) returning id`, [w.id, `OLC${Date.now() % 1e6}`, `+9647${String(310000000 + (++seq))}`, cc.id])).rows[0].id;
      const mg = (await db.query(`insert into customer_merges (from_customer_id, into_customer_id, reason, merged_by) values ($1,$2,'تجربة',$3) returning id`, [old, cc.id, w.mgrId])).rows[0].id;
      await db.query(`insert into points_ledger (customer_id, entry_type, points, merge_id) values ($1,'merge_in',777,$2)`, [cc.id, mg]);     // عبر الدفتر (الرصيد المخزّن يتحدث بالـ trigger)
      const before = Number((await one(`select count(*)::int as n from customers where phone = $1`, [`+964${cc.phone.slice(1)}`])).n);
      const l = await appLogin(cc.phone, w, 'اسم ثاني يتجاهل');
      expect(l.id).toBe(cc.id); expect(l.body.is_new).toBe(false);
      expect(l.body.customer).toMatchObject({ points_balance: 777 }); expect(l.body.customer.full_name).toMatch(/زبون كاشير/);
      expect(Number((await one(`select count(*)::int as n from customers where phone = $1`, [`+964${cc.phone.slice(1)}`])).n)).toBe(before);
      expect((await one(`select source, app_registered_at from customers where id = $1`, [cc.id]))).toMatchObject({ source: 'cashier' });
      expect((await one(`select app_registered_at from customers where id = $1`, [cc.id])).app_registered_at).not.toBeNull();
      expect((await one(`select count(*)::int as n from audit_log where action = 'customer.app_claim' and entity_id = $1`, [cc.id])).n).toBe(1);
    });
    it('تسجيل دخول لاحق (حساب فعال): بدون اسم، is_new=false، وتوكنات جديدة بكل مرة', async () => {
      const cc = await cashierCustomer(w);
      const a = await appLogin(cc.phone, w); const b = await appLogin(cc.phone.replace(/^0/, '0'), w);
      expect(a.id).toBe(b.id); expect(b.body.is_new).toBe(false); expect(a.refresh).not.toBe(b.refresh);
      await db.query(`update otp_requests set created_at = created_at - interval '2 minutes' where phone = $1`, [`+964${cc.phone.slice(1)}`]);
      await http().post('/customer/auth/request-otp').send({ phone: cc.phone });
      const code = sender.sent[sender.sent.length - 1].code;
      const nameless = await http().post('/customer/auth/verify-otp').send({ phone: cc.phone, code });
      expect(nameless.status).toBe(200); expect(nameless.body.is_new).toBe(false);
      expect((await one(`select count(*)::int as n from audit_log where action = 'customer.app_login' and entity_id = $1`, [a.id])).n).toBe(2);
      expect((await one(`select count(*)::int as n from audit_log where action = 'customer.app_claim' and entity_id = $1`, [a.id])).n).toBe(1);
    });
    it('رمز غلط: المحاولات تنعد (attempts_left)، وبعد 5 يبطل الرمز حتى الصحيح، والمنتهي والمستهلك مرفوضين', async () => {
      const p = newPhone(); const norm = `+964${p.slice(1)}`;
      await http().post('/customer/auth/request-otp').send({ phone: p });
      const code = sender.sent[sender.sent.length - 1].code; const wrong = code === '000000' ? '111111' : '000000';
      const v = (c: string) => http().post('/customer/auth/verify-otp').send({ phone: p, code: c, full_name: 'اسم', branch_id: w.id });
      for (let i = 1; i <= 4; i++) { const r = await v(wrong); expect(r.status).toBe(400); expect(r.body).toMatchObject({ code: 'INVALID_CODE', attempts_left: 5 - i }); }
      const last = await v(wrong); expect(last.body).toMatchObject({ code: 'INVALID_CODE', attempts_left: 0 });
      expect((await v(code)).body.code).toBe('INVALID_CODE');                                                                            // الصحيح بعد الاستنفاد ما يشتغل
      // منتهي
      await db.query(`update otp_requests set created_at = created_at - interval '2 minutes' where phone = $1`, [norm]);
      await http().post('/customer/auth/request-otp').send({ phone: p });
      const c2 = sender.sent[sender.sent.length - 1].code;
      await db.query(`update otp_requests set expires_at = now() - interval '1 second' where phone = $1 and consumed_at is null`, [norm]);
      expect((await v(c2)).body.code).toBe('INVALID_CODE');
      // رمز لرقم ما طلب رمز
      expect((await http().post('/customer/auth/verify-otp').send({ phone: newPhone(), code: '123456', full_name: 'اسم', branch_id: w.id })).status).toBe(400);
      // صيغة الرمز
      for (const bad of ['12345', '1234567', 'abcdef', '']) expect((await v(bad)).status).toBe(400);
    });
    it('تحقق متزامن بنفس الرمز: واحد ينجح بس وملف واحد', async () => {
      const p = newPhone(); const norm = `+964${p.slice(1)}`;
      await http().post('/customer/auth/request-otp').send({ phone: p });
      const code = sender.sent[sender.sent.length - 1].code;
      const rs = await Promise.all([1, 2, 3].map(() => http().post('/customer/auth/verify-otp').send({ phone: p, code, full_name: 'متزامن', branch_id: w.id })));
      expect(rs.map((r) => r.status).sort()).toEqual([200, 400, 400]);
      expect(Number((await one(`select count(*)::int as n from customers where phone = $1`, [norm])).n)).toBe(1);
    });
  });

  describe('حالات حساب وتوكن دقيقة', () => {
    it('فرع معطل ما ينقبل للتسجيل', async () => {
      const wz = await world('CAZ'); await db.query(`update branches set is_active = false where id = $1`, [wz.id]);
      const p = newPhone(); await http().post('/customer/auth/request-otp').send({ phone: p });
      const code = sender.sent[sender.sent.length - 1].code;
      const r = await http().post('/customer/auth/verify-otp').send({ phone: p, code, full_name: 'اسم', branch_id: wz.id });
      expect(r.status).toBe(400); expect(r.body.code).toBe('BRANCH_NOT_FOUND');
    });
    it('حساب انحذف (بدون إلغاء التوكنات) ما ينجدد توكنه، والخروج ما يلغي توكن غيره', async () => {
      const a = await appLogin(newPhone(), w); const b = await appLogin(newPhone(), w);
      expect((await post(a.token, '/customer/auth/logout', { refresh_token: b.refresh })).status).toBe(200);                 // توكن زبون ثاني: ما يتأثر
      expect((await one(`select revoked_at is not null as r from refresh_tokens where customer_id = $1 and token_hash = $2`, [b.id, sha256(b.refresh)])).r).toBe(false);
      await db.query(`update customers set app_deleted_at = now() where id = $1`, [b.id]);
      expect((await http().post('/customer/auth/refresh').send({ refresh_token: b.refresh })).status).toBe(401);
      expect((await get(b.token, '/customer/me')).status).toBe(401);
    });
  });

  describe('التوكنات والحذف', () => {
    it('توكن الزبون لا يفتح مسارات الموظفين، وتوكن الموظف لا يفتح مسارات الزبون، وبدون توكن 401', async () => {
      const c = await appLogin(newPhone(), w);
      for (const url of ['/customers?q=abc', '/payments', '/shifts/current', '/offers', '/nurse/queue', '/auth/me']) expect([url, (await get(c.token, url)).status]).toEqual([url, 403]);
      expect((await post(c.token, '/payments/consultation', {})).status).toBe(403);
      for (const t of [w.cash, w.mgr, owner, w.nurse]) expect((await get(t, '/customer/me')).status).toBe(403);
      expect((await http().get('/customer/me')).status).toBe(401);
      expect((await get('garbage', '/customer/me')).status).toBe(401);
      expect((await get(c.token + 'x', '/customer/me')).status).toBe(401);
      expect((await get(c.token, '/customer/me')).status).toBe(200);
    });
    it('التجديد: يدور التوكن، القديم يرفض، وإعادة استخدامه تلغي كل الأجهزة، والمنتهي والعشوائي 401', async () => {
      const c = await appLogin(newPhone(), w);
      const r = await http().post('/customer/auth/refresh').send({ refresh_token: c.refresh });
      expect(r.status).toBe(200); expect(r.body.refresh_token).not.toBe(c.refresh);
      expect((await get(r.body.access_token, '/customer/me')).status).toBe(200);
      const reuse = await http().post('/customer/auth/refresh').send({ refresh_token: c.refresh });
      expect(reuse.status).toBe(401);
      expect((await http().post('/customer/auth/refresh').send({ refresh_token: r.body.refresh_token })).status).toBe(401);                // الجديد انلغى بسبب إعادة الاستخدام
      expect((await one(`select count(*)::int as n from audit_log where action = 'customer.refresh_reuse_detected' and entity_id = $1`, [c.id])).n).toBeGreaterThanOrEqual(1);
      expect((await http().post('/customer/auth/refresh').send({ refresh_token: 'x'.repeat(40) })).status).toBe(401);
      expect((await http().post('/customer/auth/refresh').send({ refresh_token: 'short' })).status).toBe(400);
      const d = await appLogin(newPhone(), w);
      await db.query(`update refresh_tokens set expires_at = now() - interval '1 second' where customer_id = $1`, [d.id]);
      expect((await http().post('/customer/auth/refresh').send({ refresh_token: d.refresh })).status).toBe(401);
    });
    it('الخروج: توكن واحد أو كل الأجهزة', async () => {
      const cc = await cashierCustomer(w);
      const a = await appLogin(cc.phone, w); const b = await appLogin(cc.phone, w);
      expect((await post(a.token, '/customer/auth/logout', { refresh_token: a.refresh })).status).toBe(200);
      expect((await one(`select revoked_at is not null as r from refresh_tokens where customer_id = $1 and token_hash = $2`, [cc.id, sha256(a.refresh)])).r).toBe(true);
      expect((await one(`select revoked_at is not null as r from refresh_tokens where customer_id = $1 and token_hash = $2`, [cc.id, sha256(b.refresh)])).r).toBe(false);          // الباقي ما يتأثر
      expect((await http().post('/customer/auth/refresh').send({ refresh_token: b.refresh })).status).toBe(200);
      const c = await appLogin(cc.phone, w);
      expect((await post(c.token, '/customer/auth/logout', {})).status).toBe(200);
      expect((await http().post('/customer/auth/refresh').send({ refresh_token: c.refresh })).status).toBe(401);
      expect((await http().post('/customer/auth/logout').send({})).status).toBe(401);
    });
    it('حذف الحساب: لازم تأكيد، يوقف التوكنات والأجهزة والإشعارات المعلّقة، الملف والسجل يبقون، وتسجيل الدخول يرجّعه (نفس الملف)', async () => {
      const cc = await cashierCustomer(w);
      const c = await appLogin(cc.phone, w);
      await post(c.token, '/customer/devices', { platform: 'ios', token: `del-${seq}-${Date.now()}-abcdefgh` });
      await db.query(`insert into notifications (customer_id, kind, title, body) values ($1,'reminder','t','b')`, [c.id]);
      expect((await del(c.token, '/customer/me', {})).status).toBe(400);
      expect((await del(c.token, '/customer/me', { confirm: false })).status).toBe(400);
      expect((await del(c.token, '/customer/me', { confirm: true })).status).toBe(200);
      expect((await get(c.token, '/customer/me')).status).toBe(401);                                                                     // الدخول وقف فوراً
      expect((await http().post('/customer/auth/refresh').send({ refresh_token: c.refresh })).status).toBe(401);
      expect((await one(`select app_deleted_at from customers where id = $1`, [c.id])).app_deleted_at).not.toBeNull();
      expect((await one(`select count(*)::int as n from refresh_tokens where customer_id = $1 and revoked_at is null`, [c.id])).n).toBe(0);
      expect((await one(`select count(*)::int as n from customer_devices where customer_id = $1 and is_active`, [c.id])).n).toBe(0);
      expect((await one(`select status from notifications where customer_id = $1`, [c.id])).status).toBe('cancelled');
      expect(Number((await one(`select count(*)::int as n from customers where id = $1`, [c.id])).n)).toBe(1);
      const back = await appLogin(cc.phone, w);
      expect(back.id).toBe(c.id); expect((await one(`select app_deleted_at from customers where id = $1`, [c.id])).app_deleted_at).toBeNull();
      expect((await get(back.token, '/customer/me')).status).toBe(200);
    });
  });

  describe('حسابي وبياناتي', () => {
    it('الملف الشخصي: القراءة والتعديل (الاسم، الجنس، الميلاد، إشعارات العروض) والتحقق', async () => {
      const c = await appLogin(newPhone(), w);
      const me = await get(c.token, '/customer/me');
      expect(me.body).toMatchObject({ id: c.id, branch: { id: w.id }, full_name: 'زبون التطبيق', notify_offers: true, points_balance: 0 });
      expect(me.body).not.toHaveProperty('status');
      const u = await put(c.token, '/customer/me', { full_name: '  ليلى   حسن ', gender: 'female', birth_date: '1995-04-12', notify_offers: false });
      expect(u.status).toBe(200); expect(u.body).toMatchObject({ full_name: 'ليلى حسن', gender: 'female', birth_date: '1995-04-12', notify_offers: false });
      expect((await put(c.token, '/customer/me', { notify_offers: true })).body).toMatchObject({ notify_offers: true, full_name: 'ليلى حسن' });
      for (const bad of [{}, { full_name: 'ا' }, { gender: 'x' }, { birth_date: '2999-01-01' }, { birth_date: '1800-01-01' }, { birth_date: '2020-02-31' }, { birth_date: 'غلط' }, { notify_offers: 'yes' }])
        expect([bad, (await put(c.token, '/customer/me', bad)).status]).toEqual([bad, 400]);
      expect((await put(c.token, '/customer/me', { phone: '07700000000', full_name: 'اسم جديد' })).status).toBe(400);               // حقول زايدة ممنوعة (تغيير الرقم مو من التطبيق)
    });
    it('الفروع تنعرض بدون توكن للتسجيل', async () => {
      const r = await http().get('/customer/branches');
      expect(r.status).toBe(200); expect(r.body.branches.map((b: any) => b.id)).toEqual(expect.arrayContaining([w.id, wb.id]));
    });
    it('الجلسات والوصولات والنقاط والحجوزات: بياناتي بس، وبالأسعار بعد العرض', async () => {
      const w = await world('CAD');
      await batch(w, 50);
      const cc = await cashierCustomer(w); const other = await cashierCustomer(w);
      const c = await appLogin(cc.phone, w); const o = await appLogin(other.phone, w);
      const x = await withSessions(w, cc, 2);
      await db.query(`insert into offers (branch_id, service_id, title, percent, start_date, end_date, status, created_by, notify_audience) values ($1,$2,'عرض اليوم',20,clinic_today(),clinic_today() + 5,'scheduled',$3,'none')`, [w.id, w.botox, w.mgrId]);
      const pay = await http().post('/payments/sessions').set(auth(w.cash)).set('Idempotency-Key', key()).send({ session_ids: [x.first], ...cashT(w, 80000) });
      expect(pay.status).toBe(201);
      const s = (await get(c.token, '/customer/sessions')).body;
      expect(s.today).toBe(today);
      const s1 = s.sessions.find((i: any) => i.id === x.first); const s2 = s.sessions.find((i: any) => i.id === x.second);
      expect(s1).toMatchObject({ status: 'paid', paid_amount: 80000, movable: false, seq_no: 1, of: 2, service_name: 'بوتكس' });
      expect(s2).toMatchObject({ status: 'booked', paid_amount: null, movable: true, estimate_price: 100000, estimate_after_offer: 80000, offer_percent: 20 });
      expect((await get(o.token, '/customer/sessions')).body.sessions).toEqual([]);
      const pays = (await get(c.token, '/customer/payments')).body.payments;
      expect(pays.map((p: any) => [p.kind, p.net_amount])).toEqual([['sessions', 80000], ['consultation', 30000]]);
      const detail = await get(c.token, `/customer/payments/${pay.body.id}`);
      expect(detail.body).toMatchObject({ receipt_no: pay.body.receipt_no, net_amount: 80000, offer_discount: 20000 });
      expect(detail.body.items[0]).toMatchObject({ service_name: 'بوتكس', list_price: 100000, offer_percent: 20, offer_discount: 20000, net_amount: 80000 });
      expect((await get(o.token, `/customer/payments/${pay.body.id}`)).status).toBe(404);                                                 // وصل غيري
      expect((await get(c.token, '/customer/payments/99999999')).status).toBe(404);
      expect((await get(o.token, '/customer/payments')).body.payments).toEqual([]);
      const pts = (await get(c.token, '/customer/points')).body;
      expect(pts.balance).toBe(750 + 2000);                                                                                              // كشفية 30,000 + جلسة 80,000 على 10,000 = 250
      expect(pts.entries.map((e: any) => e.type)).toEqual(['earn', 'earn']); expect(pts.entries[0].receipt_no).toBe(pay.body.receipt_no);
      expect((await get(o.token, '/customer/points')).body).toEqual({ balance: 0, entries: [] });
      const bk = (await get(c.token, '/customer/bookings')).body.bookings;
      expect(bk[0]).toMatchObject({ date: today, status: 'arrived', kind: 'consultation', changeable: false, doctor_name: expect.any(String) });
      expect((await get(o.token, '/customer/bookings')).body.bookings).toEqual([]);
    });
    it('العروض: الفعالة اليوم بفرع الزبون بس', async () => {
      const wc = await world('CAC'); const c = await appLogin(newPhone(), wc);
      const svc = async (b: World, name: string) => Number((await db.query(`insert into services (branch_id, name_ar, kind, pricing_model, is_active) values ($1,$2,'treatment','fixed',true) returning id`, [b.id, name])).rows[0].id);
      const mk = (b: World, service: number, start: number, end: number, title: string, status = 'scheduled') => db.query(`insert into offers (branch_id, service_id, title, percent, start_date, end_date, status, created_by, notify_audience) values ($1,$2,$3,10,clinic_today() + $4::int,clinic_today() + $5::int,$6,$7,'none')`, [b.id, service, title, start, end, status, b.mgrId]);
      await mk(wc, await svc(wc, 'خدمة أ'), -1, 4, 'فعال'); await mk(wc, await svc(wc, 'خدمة ب'), 2, 6, 'قادم'); await mk(wc, await svc(wc, 'خدمة ج'), -9, -3, 'منتهي');
      await mk(wc, await svc(wc, 'خدمة د'), -1, 4, 'ملغى', 'cancelled'); await mk(wb, await svc(wb, 'خدمة هـ'), -1, 4, 'فرع ثاني');
      const offers = (await get(c.token, '/customer/offers')).body.offers;
      expect(offers).toHaveLength(1); expect(offers[0]).toMatchObject({ title: 'فعال', percent: 10, service_name: 'خدمة أ', ends_on: day(4) });
    });
    it('الإشعارات والأجهزة والتقييم عبر الـ API: معزولة بالزبون، والتقييم بعد الاكتمال مرة وحدة وبجلسته هو بس', async () => {
      await batch(w, 50);
      const cc = await cashierCustomer(w); const other = await cashierCustomer(w);
      const c = await appLogin(cc.phone, w); const o = await appLogin(other.phone, w);
      const x = await withSessions(w, cc, 1);
      expect((await http().post('/payments/sessions').set(auth(w.cash)).set('Idempotency-Key', key()).send({ session_ids: [x.first], ...cashT(w, 50000) })).status).toBe(201);
      const early = await post(c.token, `/customer/sessions/${x.first}/rating`, { stars: 5 });
      expect(early.status).toBe(409); expect(early.body.code).toBe('NOT_COMPLETED');
      expect((await post(w.nurse, `/sessions/${x.first}/complete`)).status).toBe(201);
      for (const bad of [{ stars: 0 }, { stars: 6 }, { stars: 2.5 }, {}, { stars: 'x' }]) expect([bad, (await post(c.token, `/customer/sessions/${x.first}/rating`, bad)).status]).toEqual([bad, 400]);
      expect((await post(o.token, `/customer/sessions/${x.first}/rating`, { stars: 5 })).status).toBe(404);                              // جلسة غيري
      const ok = await post(c.token, `/customer/sessions/${x.first}/rating`, { stars: 4, comment: 'ممتازة' });
      expect(ok.status).toBe(201); expect(ok.body).toMatchObject({ stars: 4, comment: 'ممتازة' });
      expect((await post(c.token, `/customer/sessions/${x.first}/rating`, { stars: 5 })).body.code).toBe('ALREADY_RATED');
      expect((await http().post(`/customer/sessions/${x.first}/rating`).send({ stars: 5 })).status).toBe(401);
      expect((await post(w.cash, `/customer/sessions/${x.first}/rating`, { stars: 5 })).status).toBe(403);
      // أجهزة وإشعارات
      const tok = `dev-${Date.now()}-abcdefgh`;
      expect((await post(c.token, '/customer/devices', { platform: 'android', token: tok })).status).toBe(200);
      expect((await post(c.token, '/customer/devices', { platform: 'windows', token: tok })).status).toBe(400);
      expect((await post(c.token, '/customer/devices', { platform: 'ios', token: 'short' })).status).toBe(400);
      expect((await del(o.token, '/customer/devices', { token: tok })).body.removed).toBe(0);                                          // جهاز زبون ثاني
      const mk = async (cu: number, status = 'sent') => Number((await db.query(`insert into notifications (customer_id, kind, title, body, status, sent_at) values ($1,'reminder','t','b',$2,now()) returning id`, [cu, status])).rows[0].id);
      const n1 = await mk(c.id); const n2 = await mk(c.id); const theirs = await mk(o.id); await mk(c.id, 'pending');
      expect((await get(c.token, '/customer/notifications')).body.notifications.map((n: any) => n.id)).toEqual([n2, n1]);
      expect((await post(c.token, '/customer/notifications/read', { id: n1 })).body.marked).toBe(1);
      expect((await get(c.token, '/customer/notifications?unread=1')).body.notifications.map((n: any) => n.id)).toEqual([n2]);
      expect((await post(c.token, '/customer/notifications/read', { id: theirs })).status).toBe(404);
      expect((await post(c.token, '/customer/notifications/read', {})).body.marked).toBe(1);
      expect((await get(o.token, '/customer/notifications')).body.notifications.map((n: any) => n.id)).toEqual([theirs]);
      expect((await del(c.token, '/customer/devices', { token: tok })).body.removed).toBe(1);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('الحجز ونقل الجلسات من التطبيق', () => {
    let wk: World;
    beforeAll(async () => { wk = await world('CAK'); });
    const sessDate = async (id: number) => (await one(`select scheduled_date::text as d, status from treatment_sessions where id = $1`, [id]));
    const usedTotal = async (b: number) => Number((await one(`select coalesce(sum(used_slots),0)::int as n from booking_days where branch_id = $1`, [b])).n);

    it('الأطباء والتوفر: أطباء فرعه الفعالين بس، وأيام الحجز بالحد والتوفر', async () => {
      const c = await appLogin(newPhone(), wk);
      const inactive = await seedUser(db, `docOff_${seq}`, 'doctor', wk.id); await db.query(`update users set is_active = false, deactivated_at = now() where id = $1`, [inactive]);
      await seedUser(db, `docOther_${seq}`, 'doctor', wb.id);
      const docs = (await get(c.token, '/customer/doctors')).body.doctors;
      expect(docs.map((d: any) => d.id)).toEqual([wk.docAId]);
      const av = await get(c.token, `/customer/availability?doctor_id=${wk.docAId}&from=${today}&to=${day(3)}`);
      expect(av.status).toBe(200); expect(av.body.days).toHaveLength(4);
      expect(av.body.days[0]).toMatchObject({ date: today, bookable: true, remaining: expect.any(Number) });
      expect((await get(c.token, '/customer/availability?from=2026-01-01')).status).toBe(400);
      expect((await get(c.token, `/customer/availability?from=${today}&to=${day(200)}`)).status).toBeGreaterThanOrEqual(400);
      expect((await http().get(`/customer/availability?from=${today}&to=${day(2)}`)).status).toBe(401);
      expect((await get(wk.cash, `/customer/availability?from=${today}&to=${day(2)}`)).status).toBe(403);
    });
    it('حجز كشفية: مصدره «تطبيق» بدون موظف، برقم تسلسل، وحدث وسجل باسم الزبون، وبقواعد الحجز (يوم واحد، مغلق، طبيب)', async () => {
      const c = await appLogin(newPhone(), wk);
      const r = await post(c.token, '/customer/bookings', { doctor_id: wk.docAId, date: day(2) });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ date: day(2), status: 'booked', source: 'app' });
      const v = await one(`select source, created_by, customer_id::int as c, seq_no from visits where id = $1`, [r.body.id]);
      expect(v).toMatchObject({ source: 'app', created_by: null, c: c.id }); expect(v.seq_no).toBeGreaterThan(0);
      const ev = await one(`select actor_user_id, actor_customer_id::int as c from booking_events where visit_id = $1 and event = 'booked'`, [r.body.id]);
      expect(ev).toEqual({ actor_user_id: null, c: c.id });
      const au = await one(`select actor_role, actor_user_id from audit_log where action = 'booking.create' and entity_id = $1`, [r.body.id]);
      expect(au).toEqual({ actor_role: 'customer', actor_user_id: null });
      const dup = await post(c.token, '/customer/bookings', { doctor_id: wk.docAId, date: day(2) });
      expect(dup.status).toBe(409); expect(dup.body.code).toBe('ALREADY_BOOKED_THAT_DAY');
      expect((await post(c.token, '/customer/bookings', { doctor_id: 99999999, date: day(3) })).status).toBe(404);
      expect((await post(c.token, '/customer/bookings', { doctor_id: wb.docAId, date: day(3) })).status).toBe(404);              // طبيب فرع ثاني
      expect((await post(c.token, '/customer/bookings', { doctor_id: wk.docAId, date: day(-1) })).status).toBe(400);
      expect((await post(c.token, '/customer/bookings', { doctor_id: wk.docAId, date: day(200) })).status).toBe(400);
      expect((await post(c.token, '/customer/bookings', { doctor_id: wk.docAId, date: 'x' })).status).toBe(400);
      expect((await post(c.token, '/customer/bookings', { doctor_id: wk.docAId })).status).toBe(400);
      expect((await post(c.token, '/customer/bookings', { doctor_id: wk.docAId, date: day(4), customer_id: 1 })).status).toBe(400);   // ما يحجز باسم غيره
      const bk = (await get(c.token, '/customer/bookings')).body.bookings;
      expect(bk[0]).toMatchObject({ id: r.body.id, date: day(2), kind: 'consultation', changeable: true });
    });
    it('الحجز بيوم مسكر أو ممتلئ يرفض', async () => {
      const w2 = await world('CAL'); const c = await appLogin(newPhone(), w2);
      expect((await post(w2.mgr, '/schedule/holidays', { date: day(2), name: 'عطلة' })).status).toBe(201);
      const closed = await post(c.token, '/customer/bookings', { doctor_id: w2.docAId, date: day(2) });
      expect(closed.status).toBe(409); expect(closed.body.code).toBe('CLINIC_CLOSED');
      const cur = (await get(w2.mgr, '/settings')).body.settings.find((x: any) => x.key === 'booking.daily_limit');
      expect((await put(w2.mgr, '/settings/booking.daily_limit', { value: 1, expected_version: cur.version })).status).toBe(200);
      const other = await appLogin(newPhone(), w2);
      expect((await post(other.token, '/customer/bookings', { doctor_id: w2.docAId, date: day(3) })).status).toBe(201);
      const full = await post(c.token, '/customer/bookings', { doctor_id: w2.docAId, date: day(3) });
      expect(full.status).toBe(409); expect(full.body.code).toBe('DAY_FULL'); expect(full.body.next_available_date).toBeTruthy();
    });
    it('إلغاء الكشفية قبل الدفع: ينلغي والمقعد يرجع بحدث باسمه، ومدفوعة أو بيها جلسات أو لغيره ممنوع', async () => {
      const cc = await cashierCustomer(wk); const c = await appLogin(cc.phone, wk); const other = await appLogin(newPhone(), wk);
      const before = await usedTotal(wk.id);
      const b = await post(c.token, '/customer/bookings', { doctor_id: wk.docAId, date: day(5) });
      expect(await usedTotal(wk.id)).toBe(before + 1);
      expect((await post(other.token, `/customer/bookings/${b.body.id}/cancel`)).status).toBe(404);                              // حجز غيره
      expect((await post(wk.cash, `/customer/bookings/${b.body.id}/cancel`)).status).toBe(403);
      expect((await http().post(`/customer/bookings/${b.body.id}/cancel`)).status).toBe(401);
      const r = await post(c.token, `/customer/bookings/${b.body.id}/cancel`);
      expect(r.status).toBe(200); expect(r.body.status).toBe('cancelled');
      expect(await usedTotal(wk.id)).toBe(before);
      expect((await one(`select cancel_reason from visits where id = $1`, [b.body.id])).cancel_reason).toBe('ألغاه الزبون من التطبيق');
      expect(await one(`select actor_user_id, actor_customer_id::int as c from booking_events where visit_id = $1 and event = 'cancelled'`, [b.body.id])).toEqual({ actor_user_id: null, c: c.id });
      expect((await post(c.token, `/customer/bookings/${b.body.id}/cancel`)).status).toBe(409);                                  // مرتين
      // مدفوعة
      const paid = await post(c.token, '/customer/bookings', { doctor_id: wk.docAId, date: today });
      expect((await http().post('/payments/consultation').set(auth(wk.cash)).set('Idempotency-Key', key()).send({ consultation_id: paid.body.consultation.id, ...cashT(wk, 30000) })).status).toBe(201);
      const np = await post(c.token, `/customer/bookings/${paid.body.id}/cancel`);
      expect(np.status).toBe(409); expect(np.body.code).toBe('NOT_CHANGEABLE');
      // زيارة بيها جلسات
      const cc2 = await cashierCustomer(wk); const c2 = await appLogin(cc2.phone, wk);
      const x = await withSessions(wk, cc2, 1);
      const bks = (await get(c2.token, '/customer/bookings')).body.bookings;
      expect(bks[0].changeable).toBe(false);
      expect(x.first).toBeGreaterThan(0);
    });
    it('كشفية غير مدفوعة بزيارة فيها جلسة محجوزة: النقل ممنوع (يحرك الجلسات)، والإلغاء يلغي الكشفية بس وتبقى الجلسة والزيارة والرقم', async () => {
      const cc = await cashierCustomer(wk); const c = await appLogin(cc.phone, wk);
      const x = await withSessions(wk, cc, 1, 2);
      const b = await post(c.token, '/customer/bookings', { doctor_id: wk.docAId, date: day(3) });
      await db.query(`update treatment_sessions set visit_id = $2, scheduled_date = $3 where id = $1`, [x.second, b.body.id, day(3)]);
      const bk = (await get(c.token, '/customer/bookings')).body.bookings.find((i: any) => i.id === b.body.id);
      expect(bk).toMatchObject({ changeable: false, cancellable: true, sessions_count: 1 });
      const mv = await post(c.token, `/customer/bookings/${b.body.id}/move`, { date: day(4) });
      expect(mv.status).toBe(409); expect(mv.body.code).toBe('HAS_SESSIONS'); expect(mv.body.message).toMatch(/الغِها واحجز يوم ثاني/);
      const before = await db.query(`select seq_no, status from visits where id = $1`, [b.body.id]);
      const cancel = await post(c.token, `/customer/bookings/${b.body.id}/cancel`);
      expect(cancel.status).toBe(200);
      expect((await db.query(`select status from consultations where visit_id = $1`, [b.body.id])).rows.map((r) => r.status)).toEqual(['cancelled']);
      expect((await db.query(`select seq_no, status from visits where id = $1`, [b.body.id])).rows[0]).toEqual(before.rows[0]);
      expect((await db.query(`select status, scheduled_date::text as d from treatment_sessions where id = $1`, [x.second])).rows[0]).toEqual({ status: 'booked', d: day(3) });
      const after = (await get(c.token, '/customer/bookings')).body.bookings.find((i: any) => i.id === b.body.id);
      expect(after).toMatchObject({ kind: 'sessions', sessions_count: 1, cancellable: false, changeable: false });
    });
    it('تغيير يوم الكشفية قبل الدفع: رقم جديد بنهاية اليوم الجديد، بحدث «أجّله الزبون»، ومدفوعة أو يوم ممتلئ أو نفس اليوم مرفوض', async () => {
      const c = await appLogin(newPhone(), wk); const o = await appLogin(newPhone(), wk);
      const b = await post(c.token, '/customer/bookings', { doctor_id: wk.docAId, date: day(6) });
      const r = await post(c.token, `/customer/bookings/${b.body.id}/move`, { date: day(8) });
      expect(r.status).toBe(200); expect(r.body).toMatchObject({ date: day(8), status: 'booked' });
      expect(await one(`select event, actor_user_id, actor_customer_id::int as c from booking_events where visit_id = $1 and event = 'postponed_by_customer'`, [b.body.id])).toEqual({ event: 'postponed_by_customer', actor_user_id: null, c: c.id });
      expect((await post(c.token, `/customer/bookings/${b.body.id}/move`, { date: day(8) })).body.code).toBe('SAME_DATE');
      expect((await post(c.token, `/customer/bookings/${b.body.id}/move`, { date: day(-2) })).status).toBe(400);
      expect((await post(o.token, `/customer/bookings/${b.body.id}/move`, { date: day(9) })).status).toBe(404);
      expect((await post(c.token, `/customer/bookings/${b.body.id}/move`, {})).status).toBe(400);
      expect((await post(c.token, '/customer/bookings', { doctor_id: wk.docAId, date: day(9) })).status).toBe(201);
      const busy = await post(c.token, `/customer/bookings/${b.body.id}/move`, { date: day(9) });                              // عنده حجز ثاني بهذا اليوم
      expect(busy.status).toBe(409); expect(busy.body.code).toBe('ALREADY_BOOKED_THAT_DAY');
      const paid = await post(o.token, '/customer/bookings', { doctor_id: wk.docAId, date: today });
      expect((await http().post('/payments/consultation').set(auth(wk.cash)).set('Idempotency-Key', key()).send({ consultation_id: paid.body.consultation.id, ...cashT(wk, 30000) })).status).toBe(201);
      const np = await post(o.token, `/customer/bookings/${paid.body.id}/move`, { date: day(1) });
      expect(np.status).toBe(409); expect(np.body.code).toBe('NOT_CHANGEABLE');
    });
    it('نقل جلسة غير مدفوعة: بأي يوم صالح، الجلسات اللي بعدها تنزاح، وقاعدة أقل فرق، والمدفوعة والمنتظرة حجز ممنوعة', async () => {
      const cc = await cashierCustomer(wk); const c = await appLogin(cc.phone, wk); const o = await appLogin(newPhone(), wk);
      await batch(wk, 30);
      const x = await withSessions(wk, cc, 1, 3);                                           // اليوم، +7، +14
      const [s1, s2, s3] = x.all;
      expect((await sessDate(s2)).d).toBe(day(7)); expect((await sessDate(s3)).d).toBe(day(14));
      const early = await post(c.token, `/customer/sessions/${s2}/move`, { date: day(3) });
      expect(early.status).toBe(409); expect(early.body.code).toBe('TOO_EARLY'); expect(early.body.earliest_date).toBe(day(7));
      const prev = await post(c.token, `/customer/sessions/${s2}/move-preview`, { date: day(20) });
      expect(prev.status).toBe(200);
      expect(prev.body.changes).toEqual([{ session_id: s2, seq_no: 2, from: day(7), to: day(20) }, { session_id: s3, seq_no: 3, from: day(14), to: day(27) }]);
      expect((await sessDate(s2)).d).toBe(day(7)); expect((await sessDate(s3)).d).toBe(day(14));                                 // المعاينة ما حفظت شي
      const r = await post(c.token, `/customer/sessions/${s2}/move`, { date: day(20) });
      expect(r.status).toBe(200); expect(r.body.changes).toEqual(prev.body.changes);
      expect((await sessDate(s2)).d).toBe(day(20)); expect((await sessDate(s3)).d).toBe(day(27));
      expect(await one(`select count(*)::int as n from booking_events where treatment_session_id = $1 and event = 'postponed_by_customer' and actor_customer_id = $2`, [s2, c.id])).toEqual({ n: 1 });
      expect((await one(`select source from visits where id = (select visit_id from treatment_sessions where id = $1)`, [s2])).source).toBe('app');
      expect((await one(`select actor_role, actor_user_id from audit_log where action = 'session.move' and entity_id = $1 order by id desc limit 1`, [s2]))).toEqual({ actor_role: 'customer', actor_user_id: null });
      // الأولى: ينقلها لبعد اليوم (بنفس اليوم أو غيره)
      expect((await post(o.token, `/customer/sessions/${s2}/move`, { date: day(30) })).status).toBe(404);                      // جلسة غيره
      expect((await post(o.token, `/customer/sessions/${s2}/move-preview`, { date: day(30) })).status).toBe(404);
      // مدفوعة
      expect((await http().post('/payments/sessions').set(auth(wk.cash)).set('Idempotency-Key', key()).send({ session_ids: [s1], ...cashT(wk, 50000) })).status).toBe(201);
      const paid = await post(c.token, `/customer/sessions/${s1}/move`, { date: day(1) });
      expect(paid.status).toBe(409); expect(paid.body.code).toBe('NOT_MOVABLE');
      expect((await post(c.token, `/customer/sessions/${s1}/move-preview`, { date: day(1) })).body.code).toBe('NOT_MOVABLE');
      // تنتظر حجز
      await db.query(`update treatment_sessions set status = 'awaiting_booking', visit_id = null, scheduled_date = null where id = $1`, [s3]);
      expect((await post(c.token, `/customer/sessions/${s3}/move`, { date: day(40) })).body.code).toBe('NOT_MOVABLE');
      // أخطاء الطلب
      for (const bad of [{}, { date: 'x' }]) expect((await post(c.token, `/customer/sessions/${s2}/move`, bad)).status).toBe(400);
      expect((await post(c.token, `/customer/sessions/${s2}/move`, { date: day(-1) })).status).toBe(400);
      expect((await post(wk.cash, `/customer/sessions/${s2}/move`, { date: day(30) })).status).toBe(403);
    });
    it('معاينة النقل بدون أثر: لا زيارات ولا مقاعد ولا أحداث ولا سجل، حتى لو الجلسات تنزاح', async () => {
      const cc = await cashierCustomer(wk); const c = await appLogin(cc.phone, wk);
      const x = await withSessions(wk, cc, 1, 3); const s2 = x.all[1];
      const snap = async () => ({ visits: (await one(`select count(*)::int as n from visits where customer_id = $1`, [cc.id])).n, used: await usedTotal(wk.id), events: (await one(`select count(*)::int as n from booking_events`)).n, audits: (await one(`select count(*)::int as n from audit_log`)).n });
      const before = await snap();
      const p = await post(c.token, `/customer/sessions/${s2}/move-preview`, { date: day(25) });
      expect(p.status).toBe(200); expect(p.body.changes).toHaveLength(2);
      expect(await snap()).toEqual(before);
    });
    it('النقل ليوم مسكر أو ممتلئ يرفض باقتراح يوم بديل', async () => {
      const w2 = await world('CAM'); const cc = await cashierCustomer(w2); const c = await appLogin(cc.phone, w2);
      const x = await withSessions(w2, cc, 1, 2);
      expect((await post(w2.mgr, '/schedule/holidays', { date: day(12), name: 'عطلة' })).status).toBe(201);
      const closed = await post(c.token, `/customer/sessions/${x.second}/move`, { date: day(12) });
      expect(closed.status).toBe(409); expect(closed.body).toMatchObject({ code: 'CLINIC_CLOSED', next_available_date: day(13) });
    });
  });
});
