import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

interface World { id: number; code: string; mgr: string; mgrId: number; cash: string; nurse: string; docA: string; docAId: number; cashMethod: number; botox: number; fixed: number; consId: number }

describe('العروض', () => {
  let app: INestApplication; let db: Pool; let today: string; let owner: string;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  let phoneSeq = 0; let seq = 0;
  const key = () => `ok-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const cashT = (w: World, amount: number) => ({ tenders: [{ method_id: w.cashMethod, amount }] });

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
    const fx = (await post(mgr, '/services', { name_ar: 'تنظيف بشرة', pricing_model: 'fixed', price: 40000 })).body;
    expect((await post(mgr, `/services/${fx.id}/activate`)).status).toBe(200);
    expect((await post(cash, '/shifts/open', { opening_float: 0 })).status).toBe(201);
    return { id, code, mgr, mgrId, cash, nurse, docA, docAId, cashMethod, botox: bs.id, fixed: fx.id, consId: cs };
  }
  async function customer(w: World): Promise<number> {
    phoneSeq++;
    const r = await post(w.cash, '/customers', { full_name: `زبون عروض ${phoneSeq}`, phone: `0798${String(phoneSeq).padStart(7, '0')}` });
    expect(r.status).toBe(201); return r.body.id;
  }
  /** زبون بخطة: بوتكس (cc) وتنظيف، كل جلسات اليوم، والكشفية مدفوعة */
  async function planned(w: World, cc = 2) {
    const c = await customer(w);
    const b = await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docAId, date: today });
    expect(b.status).toBe(201);
    expect((await http().post('/payments/consultation').set(auth(w.cash)).set('Idempotency-Key', key()).send({ consultation_id: b.body.consultation.id, ...cashT(w, 30000) })).status).toBe(201);
    expect((await post(w.docA, `/consultations/${b.body.consultation.id}/enter`)).status).toBe(201);
    const pl = await post(w.docA, `/consultations/${b.body.consultation.id}/plan`, { items: [
      { service_id: w.botox, values: { cc }, sessions_count: 1, interval_days: 0, first_session_date: today },
      { service_id: w.fixed, sessions_count: 1, interval_days: 0, first_session_date: today }] });
    expect(pl.status).toBe(201);
    return { customer: c, botoxSid: pl.body.items[0].sessions[0].id as number, fixedSid: pl.body.items[1].sessions[0].id as number };
  }
  const paySess = (t: string, body: object) => http().post('/payments/sessions').set(auth(t)).set('Idempotency-Key', key()).send(body);
  const offer = (t: string, svc: number, over: Record<string, unknown> = {}) => post(t, '/offers', { service_id: svc, title: 'عرض الشتاء', percent: 20, start_date: day(5), end_date: day(15), ...over });
  /** عرض فعال اليوم لخدمة (مباشرة بالقاعدة حتى ما نعتمد على التواريخ المستقبلية) */
  async function activeOffer(w: World, svc: number, percent: string, over: { start?: number; end?: number; status?: string } = {}) {
    return Number((await db.query(`insert into offers (branch_id, service_id, title, percent, start_date, end_date, status, created_by, notify_audience) values ($1,$2,'عرض تجربة',$3,clinic_today() + $4::int,clinic_today() + $5::int,$6,$7,'none') returning id`,
      [w.id, svc, percent, over.start ?? 0, over.end ?? 3, over.status ?? 'scheduled', w.mgrId])).rows[0].id);
  }

  let w: World; let wb: World;
  beforeAll(async () => {
    app = await makeApp(); db = pool();
    today = (await db.query(`select clinic_today()::text as d`)).rows[0].d;
    owner = await tokenFor(app, 'owner');
    w = await world('OFA'); wb = await world('OFB');
  });
  afterAll(async () => { await app.close(); await db.end(); });

  // ------------------------------------------------------------------------------------------------
  describe('إنشاء عرض', () => {
    it('المدير والمالك: عرض مجدول بنص إشعار افتراضي بدون اسم علاج، وسجل الحركات', async () => {
      const r = await offer(w.mgr, w.botox);
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ title: 'عرض الشتاء', percent: 20, start_date: day(5), end_date: day(15), state: 'scheduled', version: 1, service: { id: w.botox, name: 'بوتكس' }, warnings: [],
        notify: { audience: 'all', service: null, title: 'عرض جديد', at: day(5), sent_at: null } });
      expect(r.body.notify.body).not.toContain('بوتكس');
      expect((await one(`select count(*)::int as n from audit_log where action = 'offer.create' and entity_id = $1`, [r.body.id])).n).toBe(1);
      const o = await offer(owner, w.fixed, { branch_id: w.id, percent: 12.5, start_date: today, end_date: today });
      expect(o.status).toBe(201); expect(o.body).toMatchObject({ percent: 12.5, state: 'active' });
    });
    it('التحقق: النسبة، التواريخ، العنوان، الخدمة، الصلاحيات', async () => {
      const svc = w.botox; const base = { service_id: svc, title: 'عرض', percent: 10, start_date: day(30), end_date: day(35) };
      const bad = async (over: object, status = 400, code?: string) => { const r = await post(w.mgr, '/offers', { ...base, ...over }); expect([over, r.status]).toEqual([over, status]); if (code) expect(r.body.code).toBe(code); };
      await bad({ percent: 0 }); await bad({ percent: 100 }); await bad({ percent: 100.5 }); await bad({ percent: 10.123 }); await bad({ percent: -5 }); await bad({ percent: 'abc' });
      await bad({ title: '' }); await bad({ title: 'x' }); await bad({ title: '   ' }, 400, 'TITLE_REQUIRED');
      await bad({ start_date: '2026-13-40' }, 400, 'INVALID_DATE'); await bad({ start_date: 'غلط' }); await bad({ start_date: day(-1) }, 400, 'START_IN_PAST');
      await bad({ end_date: day(29) }, 400, 'END_BEFORE_START'); await bad({ end_date: day(30 + 366) }, 400, 'OFFER_TOO_LONG');
      await bad({ service_id: 99999999 }, 400, 'SERVICE_NOT_FOUND'); await bad({ service_id: wb.botox }, 400, 'SERVICE_NOT_FOUND'); await bad({ service_id: w.consId }, 400, 'CONSULTATION_NO_OFFER');
      await bad({ service_id: 'x' });
      for (const t of [w.cash, w.nurse, w.docA]) expect((await post(t, '/offers', base)).status).toBe(403);
      expect((await post(owner, '/offers', base)).status).toBe(400);                                  // المالك لازم يحدد الفرع (فيه أكثر من فرع)
      expect((await http().post('/offers').send(base)).status).toBe(401);
      expect((await post(w.mgr, '/offers', { ...base, end_date: day(30) })).status).toBe(201);        // يوم واحد مسموح
    });
    it('تواريخ المدة: 366 يوم مسموحة (حد أقصى)، ونهاية العرض نفس البداية', async () => {
      const r = await post(w.mgr, '/offers', { service_id: w.fixed, title: 'سنة كاملة', percent: 5, start_date: day(100), end_date: day(100 + 365) });
      expect(r.status).toBe(201);
    });
    it('عرض واحد لكل خدمة بتواريخ متقاطعة: OFFER_OVERLAP، المتجاور مسموح، والملغى يفتح المدة، وخدمة ثانية مستقلة، وفرع ثاني مستقل', async () => {
      const w2 = await world('OFO'); const s = w2.botox;
      const a = await offer(w2.mgr, s, { start_date: day(10), end_date: day(20) });
      expect(a.status).toBe(201);
      for (const [st, en] of [[10, 20], [15, 25], [5, 10], [20, 30], [12, 14], [1, 40]]) {
        const r = await offer(w2.mgr, s, { start_date: day(st), end_date: day(en) });
        expect([st, en, r.status, r.body.code]).toEqual([st, en, 409, 'OFFER_OVERLAP']);
      }
      expect((await offer(w2.mgr, s, { start_date: day(21), end_date: day(30) })).status).toBe(201);   // متجاور بعد النهاية
      expect((await offer(w2.mgr, s, { start_date: day(1), end_date: day(9) })).status).toBe(201);     // متجاور قبل البداية
      expect((await offer(w2.mgr, w2.fixed, { start_date: day(10), end_date: day(20) })).status).toBe(201);
      expect((await post(w2.mgr, `/offers/${a.body.id}/cancel`, { reason: 'تعديل المدة' })).status).toBe(201);
      expect((await offer(w2.mgr, s, { start_date: day(10), end_date: day(20) })).status).toBe(201);
    });
    it('إنشاءين متزامنين بنفس الخدمة والمدة: واحد ينجح والثاني OFFER_OVERLAP (بدون 500)', async () => {
      const w2 = await world('OFC');
      const rs = await Promise.all([0, 1, 2].map(() => offer(w2.mgr, w2.botox, { start_date: day(10), end_date: day(20) })));
      expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(rs.filter((r) => r.status === 409).every((r) => r.body.code === 'OFFER_OVERLAP')).toBe(true);
    });
  });

  describe('إشعار العرض', () => {
    it('الفئة: «سوّوا الخدمة» تحتاج الخدمة، والخدمة مع غيرها ممنوعة، و«بدون» يلغي التاريخ، وتاريخ الإشعار ضمن المدة', async () => {
      const w2 = await world('OFN'); const mk = (over: object, i: number) => offer(w2.mgr, w2.botox, { start_date: day(10 + i * 30), end_date: day(20 + i * 30), ...over });
      let r = await mk({ notify_audience: 'did_service' }, 0); expect(r.status).toBe(400); expect(r.body.code).toBe('NOTIFY_SERVICE_REQUIRED');
      r = await mk({ notify_audience: 'all', notify_service_id: w2.fixed }, 0); expect(r.status).toBe(400); expect(r.body.code).toBe('NOTIFY_SERVICE_NOT_ALLOWED');
      r = await mk({ notify_audience: 'did_service', notify_service_id: wb.fixed }, 0); expect(r.status).toBe(400); expect(r.body.code).toBe('SERVICE_NOT_FOUND');
      r = await mk({ notify_audience: 'did_service', notify_service_id: w2.fixed }, 0);
      expect(r.status).toBe(201); expect(r.body.notify).toMatchObject({ audience: 'did_service', service: { id: w2.fixed, name: 'تنظيف بشرة' } });
      r = await mk({ notify_audience: 'none', notify_at: day(12 + 30) }, 1);
      expect(r.status).toBe(201); expect(r.body.notify.at).toBeNull();
      r = await mk({ notify_at: day(9 + 60) }, 2); expect(r.status).toBe(201); expect(r.body.notify.at).toBe(day(9 + 60));      // قبل البداية مسموح (من اليوم)
      r = await mk({ notify_at: day(21 + 90) }, 3); expect(r.status).toBe(400); expect(r.body.code).toBe('NOTIFY_AFTER_END');
      r = await mk({ notify_at: day(-1) }, 3); expect(r.status).toBe(400); expect(r.body.code).toBe('NOTIFY_IN_PAST');
      r = await mk({ notify_at: 'x' }, 3); expect(r.status).toBe(400);
    });
    it('النص المخصص اللي يذكر اسم الخدمة: تحذير بس بدون منع', async () => {
      const w2 = await world('OFW');
      const r = await offer(w2.mgr, w2.botox, { notify_title: 'خصم البوتكس', notify_body: 'تخفيض 20%' });
      expect(r.status).toBe(201); expect(r.body.warnings).toEqual(['NOTIFICATION_MENTIONS_SERVICE']);
      expect(r.body.notify).toMatchObject({ title: 'خصم البوتكس' });
      const ok = await offer(w2.mgr, w2.fixed, { notify_title: 'عرض خاص', notify_body: 'لفترة محدودة' });
      expect(ok.body.warnings).toEqual([]);
    });
  });

  describe('التعديل والإلغاء', () => {
    it('المجدول بس ينعدل: النسبة والتواريخ والنص، بنسخة (version)، ويعيد فحص التقاطع، ويسجل', async () => {
      const w2 = await world('OFE');
      const a = (await offer(w2.mgr, w2.botox, { start_date: day(10), end_date: day(20) })).body;
      const b = (await offer(w2.mgr, w2.botox, { start_date: day(30), end_date: day(40) })).body;
      const u = await put(w2.mgr, `/offers/${a.id}`, { expected_version: 1, percent: 25, title: 'عرض معدل', end_date: day(22) });
      expect(u.status).toBe(200); expect(u.body).toMatchObject({ percent: 25, title: 'عرض معدل', end_date: day(22), version: 2, start_date: day(10) });
      expect((await put(w2.mgr, `/offers/${a.id}`, { expected_version: 1, percent: 30 })).body.code).toBe('VERSION_CONFLICT');
      const ov = await put(w2.mgr, `/offers/${a.id}`, { expected_version: 2, end_date: day(31) });
      expect(ov.status).toBe(409); expect(ov.body.code).toBe('OFFER_OVERLAP');
      expect((await put(w2.mgr, `/offers/${a.id}`, { expected_version: 2, end_date: day(5) })).body.code).toBe('END_BEFORE_START');
      expect((await put(w2.mgr, `/offers/${a.id}`, { expected_version: 2, start_date: day(-3) })).body.code).toBe('START_IN_PAST');
      expect((await put(w2.mgr, `/offers/${a.id}`, { expected_version: 2, percent: 100 })).status).toBe(400);
      expect((await put(w2.mgr, `/offers/${a.id}`, { percent: 30 })).status).toBe(400);                                // النسخة إلزامية
      expect((await put(w2.cash, `/offers/${a.id}`, { expected_version: 2, percent: 30 })).status).toBe(403);
      expect((await put(wb.mgr, `/offers/${a.id}`, { expected_version: 2, percent: 30 })).status).toBe(404);
      expect((await put(w2.mgr, `/offers/99999999`, { expected_version: 1, percent: 30 })).status).toBe(404);
      expect((await one(`select count(*)::int as n from audit_log where action = 'offer.update' and entity_id = $1`, [a.id])).n).toBe(1);
      // نقل البداية يحرك تاريخ الإشعار الافتراضي معاها
      const m = await put(w2.mgr, `/offers/${b.id}`, { expected_version: 1, start_date: day(32) });
      expect(m.body.notify.at).toBe(day(32));
      // الإشعار الصريح يبقى
      const c = (await offer(w2.mgr, w2.fixed, { start_date: day(10), end_date: day(20), notify_at: day(12) })).body;
      expect((await put(w2.mgr, `/offers/${c.id}`, { expected_version: 1, title: 'تعديل العنوان' })).body.notify.at).toBe(day(12));
    });
    it('الفعال والمنتهي والملغى ما ينعدلون', async () => {
      const w2 = await world('OFF');
      const act = await activeOffer(w2, w2.botox, '10', { start: 0, end: 5 });
      let r = await put(w2.mgr, `/offers/${act}`, { expected_version: 1, percent: 30 });
      expect(r.status).toBe(409); expect(r.body.code).toBe('OFFER_STARTED');
      const done = await activeOffer(w2, w2.fixed, '10', { start: -9, end: -3 });
      expect((await put(w2.mgr, `/offers/${done}`, { expected_version: 1, percent: 30 })).body.code).toBe('OFFER_STARTED');
      const sch = (await offer(w2.mgr, w2.fixed, { start_date: day(10), end_date: day(20) })).body;
      expect((await post(w2.mgr, `/offers/${sch.id}/cancel`, { reason: 'ألغيناه' })).status).toBe(201);
      r = await put(w2.mgr, `/offers/${sch.id}`, { expected_version: 2, percent: 30 });
      expect(r.status).toBe(409); expect(r.body.code).toBe('OFFER_CANCELLED');
    });
    it('الإلغاء: السبب إلزامي، الفعال يتوقف من هسه، المنتهي والملغى مرفوضين، والإشعار المعلّق ينلغي', async () => {
      const w2 = await world('OFG');
      const act = await activeOffer(w2, w2.botox, '10', { start: 0, end: 5 });
      const mk = async (n: number) => Number((await db.query(`insert into customers (branch_id, public_code, phone, full_name, source) values ($1,$2,$3,'زبون إشعار','cashier') returning id`, [w2.id, `OFG${n}${Date.now() % 1e6}`, `+96477000000${n}0`])).rows[0].id);
      const c1 = await mk(1); const c2 = await mk(2);
      await db.query(`insert into notifications (customer_id, kind, title, body, offer_id) values ($1,'offer','t','b',$2)`, [c1, act]);
      await db.query(`insert into notifications (customer_id, kind, title, body, offer_id, status, sent_at) values ($1,'offer','t','b',$2,'sent',now())`, [c2, act]);
      for (const reason of ['', '  ', 'ab']) expect((await post(w2.mgr, `/offers/${act}/cancel`, { reason })).status).toBe(400);
      expect((await post(w2.cash, `/offers/${act}/cancel`, { reason: 'سبب' })).status).toBe(403);
      expect((await post(wb.mgr, `/offers/${act}/cancel`, { reason: 'سبب' })).status).toBe(404);
      const r = await post(w2.mgr, `/offers/${act}/cancel`, { reason: 'خطأ بالنسبة' });
      expect(r.status).toBe(201); expect(r.body.state).toBe('cancelled');
      expect((await db.query(`select status from notifications where offer_id = $1 order by id`, [act])).rows.map((x) => x.status)).toEqual(['cancelled', 'sent']);   // المعلّق بس ينلغي
      expect((await post(w2.mgr, `/offers/${act}/cancel`, { reason: 'مرة ثانية' })).body.code).toBe('OFFER_CANCELLED');
      const done = await activeOffer(w2, w2.fixed, '10', { start: -9, end: -3 });
      expect((await post(w2.mgr, `/offers/${done}/cancel`, { reason: 'سبب' })).body.code).toBe('OFFER_ENDED');
      expect((await one(`select count(*)::int as n from audit_log where action = 'offer.cancel' and entity_id = $1 and reason = 'خطأ بالنسبة'`, [act])).n).toBe(1);
    });
    it('القوائم: الحالة مشتقة من التواريخ، التصفية، الفرع، والعروض الفعالة للكاشير', async () => {
      const w2 = await world('OFL');
      const s = await activeOffer(w2, w2.botox, '10', { start: 5, end: 9 }); const a = await activeOffer(w2, w2.fixed, '15', { start: -1, end: 2 });
      const e = await activeOffer(w2, w2.fixed, '5', { start: -30, end: -20 }); const c = await activeOffer(w2, w2.fixed, '8', { start: 20, end: 25, status: 'cancelled' });
      const states = (await get(w2.mgr, '/offers')).body.offers.map((o: any) => [o.id, o.state]);
      expect(states).toEqual(expect.arrayContaining([[s, 'scheduled'], [a, 'active'], [e, 'ended'], [c, 'cancelled']]));
      for (const st of ['scheduled', 'active', 'ended', 'cancelled']) expect((await get(w2.mgr, `/offers?state=${st}`)).body.offers.every((o: any) => o.state === st)).toBe(true);
      expect((await get(w2.mgr, '/offers?state=active')).body.offers.map((o: any) => o.id)).toEqual([a]);
      expect((await get(w2.mgr, '/offers?state=zzz')).status).toBe(400);
      expect((await get(owner, `/offers?branch_id=${w2.id}`)).body.offers).toHaveLength(4);
      expect((await get(wb.mgr, '/offers')).body.offers.map((o: any) => o.id)).not.toContain(a);
      expect((await get(w2.mgr, `/offers/${a}`)).body).toMatchObject({ id: a, state: 'active', percent: 15 });
      expect((await get(wb.mgr, `/offers/${a}`)).status).toBe(404);
      expect((await get(w2.cash, '/offers')).status).toBe(403);
      const act = await get(w2.cash, '/offers/active');
      expect(act.status).toBe(200); expect(act.body.offers).toEqual([{ id: a, title: 'عرض تجربة', percent: 15, service: { id: w2.fixed, name: 'تنظيف بشرة' }, end_date: day(2) }]);
      expect((await get(w2.nurse, '/offers/active')).status).toBe(403);
    });
    it('عرض يبدا بكرة «مجدول» مو فعال، والعرض الملغى (بمدته الحالية) ما يظهر بالفعالة', async () => {
      const w2 = await world('OFH');
      const tomorrow = await activeOffer(w2, w2.botox, '7', { start: 1, end: 3 });
      const cancelledInRange = await activeOffer(w2, w2.fixed, '9', { start: -1, end: 3, status: 'cancelled' });
      const list = (await get(w2.mgr, '/offers')).body.offers;
      expect(list.find((o: any) => o.id === tomorrow).state).toBe('scheduled');
      expect(list.find((o: any) => o.id === cancelledInRange).state).toBe('cancelled');
      expect((await get(w2.cash, '/offers/active')).body.offers).toEqual([]);
    });
    it('قفل العرض (حتمي): تعديل جاري من جهة ثانية → التعديل المتأخر ينتظر ويرفض VERSION_CONFLICT', async () => {
      const w2 = await world('OFK');
      const o = (await offer(w2.mgr, w2.botox, { start_date: day(10), end_date: day(20) })).body;
      const c = await db.connect(); let res: any; let held = true;
      try {
        await c.query('begin'); await c.query(`select 1 from offers where id = $1 for update`, [o.id]);
        await c.query(`update offers set percent = 33, version = version + 1 where id = $1`, [o.id]);
        const p = put(w2.mgr, `/offers/${o.id}`, { expected_version: 1, percent: 44 }).then((r) => { res = r; });
        await new Promise((r) => setTimeout(r, 400));
        expect(res).toBeUndefined();
        await c.query('commit'); held = false; await p;
      } finally { if (held) await c.query('rollback'); c.release(); }
      expect(res.status).toBe(409); expect(res.body.code).toBe('VERSION_CONFLICT');
      expect(Number((await one(`select percent from offers where id = $1`, [o.id])).percent)).toBe(33);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('تطبيق العرض بالدفع', () => {
    it('العرض الفعال ينطبق تلقائياً: خصم النسبة على السعر، الوصل يعرضه، والنقاط على المدفوع بعده', async () => {
      const w2 = await world('OFP'); const o = await activeOffer(w2, w2.botox, '20');
      const x = await planned(w2, 2);                                                                  // بوتكس 100,000
      const r = await paySess(w2.cash, { session_ids: [x.botoxSid], ...cashT(w2, 80000) });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ gross_amount: 100000, offer_discount: 20000, manual_discount: 0, net_amount: 80000, points_earned: 2000 });
      expect(r.body.items[0]).toMatchObject({ list_price: 100000, offer_id: o, offer_percent: 20, offer_discount: 20000, net_amount: 80000 });
      const row = await one(`select offer_discount::int as od, net_amount::int as n from payments where id = $1`, [r.body.id]);
      expect(row).toEqual({ od: 20000, n: 80000 });
      expect((await db.query(`select * from v_integrity_checks where entity_id = $1`, [r.body.id])).rows).toEqual([]);
    });
    it('الدفع بسعر غير مطابق للمخفض يرفض TENDER_MISMATCH (الكاشير ما يدفع السعر الكامل)', async () => {
      const w2 = await world('OFQ'); await activeOffer(w2, w2.botox, '20');
      const x = await planned(w2, 2);
      const r = await paySess(w2.cash, { session_ids: [x.botoxSid], ...cashT(w2, 100000) });
      expect(r.status).toBe(409); expect(r.body).toMatchObject({ code: 'TENDER_MISMATCH', net_amount: 80000 });
    });
    it('عرض على خدمة وحدة من بندين: الثانية بسعرها الكامل، والإجمالي صحيح، والخصم اليدوي والنقاط على المخفض', async () => {
      const w2 = await world('OFR'); await activeOffer(w2, w2.botox, '50');
      const x = await planned(w2, 2);                                                                  // بوتكس 100,000 → 50,000 ، تنظيف 40,000
      // خصم يدوي: السلة بعد العرض = 90,000، والخصم المعتمد 9,000 يتوزع بنسبة 50,000/40,000
      const dr = await post(w2.cash, '/discount-requests', { session_ids: [x.botoxSid, x.fixedSid] });
      expect(dr.status).toBe(201); expect(dr.body.basket.gross).toBe(90000);
      expect(dr.body.basket.items.map((i: any) => [i.name, i.price, i.list_price, i.offer_percent, i.offer_discount])).toEqual([['بوتكس', 50000, 100000, 50, 50000], ['تنظيف بشرة', 40000, 40000, null, 0]]);
      expect((await post(w2.mgr, `/discount-requests/${dr.body.id}/approve`, { amount: 90001 })).body).toMatchObject({ code: 'DISCOUNT_TOO_LARGE', gross: 90000 });
      expect((await post(w2.mgr, `/discount-requests/${dr.body.id}/approve`, { amount: 9000 })).status).toBe(201);
      const r = await paySess(w2.cash, { session_ids: [x.botoxSid, x.fixedSid], discount_request_id: dr.body.id, ...cashT(w2, 81000) });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ gross_amount: 140000, offer_discount: 50000, manual_discount: 9000, net_amount: 81000 });
      expect(r.body.items.map((i: any) => [i.service_name, i.list_price, i.offer_discount, i.manual_discount_share, i.net_amount])).toEqual([['بوتكس', 100000, 50000, 5000, 45000], ['تنظيف بشرة', 40000, 0, 4000, 36000]]);
      expect((await db.query(`select * from v_integrity_checks where entity_id = $1`, [r.body.id])).rows).toEqual([]);
    });
    it('خصم يدوي معتمد قبل نزول العرض وأكبر من المدفوع بعده: يرفض DISCOUNT_TOO_LARGE وما يستهلك الطلب', async () => {
      const w2 = await world('OFD');
      const x = await planned(w2, 2);                                                                  // بدون عرض: السلة 140,000
      const dr = await post(w2.cash, '/discount-requests', { session_ids: [x.botoxSid, x.fixedSid] });
      expect(dr.body.basket.gross).toBe(140000);
      expect((await post(w2.mgr, `/discount-requests/${dr.body.id}/approve`, { amount: 95000 })).status).toBe(201);
      await activeOffer(w2, w2.botox, '50');                                                           // بعدها نزل العرض: الجلسات 90,000
      const r = await paySess(w2.cash, { session_ids: [x.botoxSid, x.fixedSid], discount_request_id: dr.body.id, ...cashT(w2, 1000) });
      expect(r.status).toBe(409); expect(r.body.code).toBe('DISCOUNT_TOO_LARGE');
      expect((await one(`select status from discount_requests where id = $1`, [dr.body.id])).status).toBe('approved');
    });
    it('نقاط الاستخدام تنحسب على السعر بعد العرض والخصم اليدوي (السقف 50%)', async () => {
      const w2 = await world('OFS'); await activeOffer(w2, w2.fixed, '25');
      const x = await planned(w2, 1);                                                                  // تنظيف 40,000 → 30,000
      const old = (await db.query(`insert into customers (branch_id, public_code, phone, full_name, source, status, merged_into_id) values ($1,$2,'+9647711111111','قديم','cashier','merged',$3) returning id`, [w2.id, `OLD${Date.now() % 1e6}`, x.customer])).rows[0].id;
      const m = (await db.query(`insert into customer_merges (from_customer_id, into_customer_id, reason, merged_by) values ($1,$2,'تجربة',$3) returning id`, [old, x.customer, w2.mgrId])).rows[0].id;
      await db.query(`insert into points_ledger (customer_id, entry_type, points, merge_id) values ($1,'merge_in',100000,$2)`, [x.customer, m]);
      const r = await paySess(w2.cash, { session_ids: [x.fixedSid], redeem_points: true, ...cashT(w2, 15000) });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ gross_amount: 40000, offer_discount: 10000, points_discount: 15000, net_amount: 15000, points_used: 15000 });   // سقف 50% من 30,000
    });
    it('عرض بكسور: 12.5% من 100,000 = 12,500، و33.33% من 40,000 = 13,332 (للأسفل)', async () => {
      const w2 = await world('OFT'); await activeOffer(w2, w2.botox, '12.5'); await activeOffer(w2, w2.fixed, '33.33');
      const x = await planned(w2, 2);
      const r = await paySess(w2.cash, { session_ids: [x.botoxSid, x.fixedSid], ...cashT(w2, 114000) });          // 87,500 + 26,668 = 114,168 → التقريب للأسفل لأقرب 250
      expect(r.status).toBe(201);
      expect(r.body.items.map((i: any) => [i.offer_discount, i.offer_percent])).toEqual([[12500, 12.5], [13332, 33.33]]);
      expect(r.body).toMatchObject({ gross_amount: 140000, offer_discount: 25832, rounding_amount: 168, net_amount: 114000 });
    });
    it('عرض غير فعال ما ينطبق: مجدول، منتهي، ملغى، خدمة ثانية، فرع ثاني', async () => {
      const w2 = await world('OFU');
      await activeOffer(w2, w2.botox, '40', { start: 3, end: 6 }); await activeOffer(w2, w2.fixed, '40', { start: -9, end: -1 });
      await activeOffer(wb, wb.botox, '40');                                                           // عرض فرع ثاني بنفس اسم الخدمة
      const x = await planned(w2, 2);
      let r = await paySess(w2.cash, { session_ids: [x.botoxSid, x.fixedSid], ...cashT(w2, 140000) });
      expect(r.status).toBe(201); expect(r.body).toMatchObject({ offer_discount: 0, net_amount: 140000 });
      expect(r.body.items.every((i: any) => i.offer_id === null && i.offer_percent === null && i.offer_discount === 0)).toBe(true);
      const w3 = await world('OFV'); await activeOffer(w3, w3.botox, '40', { status: 'cancelled' });
      const y = await planned(w3, 2);
      r = await paySess(w3.cash, { session_ids: [y.botoxSid], ...cashT(w3, 100000) });
      expect(r.status).toBe(201); expect(r.body.offer_discount).toBe(0);
    });
    it('الكشفية ما عليها عروض، وبدون عرض الحساب نفسه (ما تأثر الدفع القديم)', async () => {
      const w2 = await world('OFX'); await activeOffer(w2, w2.botox, '90');
      const c = await customer(w2);
      const b = await post(w2.cash, '/bookings', { customer_id: c, doctor_id: w2.docAId, date: today });
      const r = await http().post('/payments/consultation').set(auth(w2.cash)).set('Idempotency-Key', key()).send({ consultation_id: b.body.consultation.id, ...cashT(w2, 30000) });
      expect(r.status).toBe(201); expect(r.body).toMatchObject({ gross_amount: 30000, offer_discount: 0, net_amount: 30000 });
    });
    it('استرجاع جلسة مخفضة يرجع صافيها بالضبط (بعد العرض)، والنقاط المكتسبة تنسحب', async () => {
      const w2 = await world('OFY'); await activeOffer(w2, w2.botox, '20');
      const x = await planned(w2, 2);
      const r = await paySess(w2.cash, { session_ids: [x.botoxSid, x.fixedSid], ...cashT(w2, 80000 + 40000) });
      expect(r.status).toBe(201);
      const itemBotox = r.body.items.find((i: any) => i.service_name === 'بوتكس');
      const rf = await http().post(`/payments/${r.body.id}/refund`).set(auth(w2.cash)).set('Idempotency-Key', key()).send({ items: [itemBotox.id], reason: 'الزبونة غيرت رأيها' });
      expect(rf.status).toBe(201); expect(rf.body.total_amount).toBe(80000);
      const bal = Number((await one(`select points_balance from customers where id = $1`, [x.customer])).points_balance);
      expect(bal).toBe(750 + 1000);                                // كشفية 30,000 (750) + المتبقي من الجلسات 40,000 (1,000)
    });
    it('تقدير سعر الجلسة بحساب الزبون يعرض السعر بعد العرض الفعال', async () => {
      const w2 = await world('OFZ'); await activeOffer(w2, w2.botox, '20');
      const x = await planned(w2, 2);
      const s = (await get(w2.cash, `/customers/${x.customer}/sessions`)).body.sessions;
      const bs = s.find((i: any) => i.id === x.botoxSid); const fs = s.find((i: any) => i.id === x.fixedSid);
      expect(bs).toMatchObject({ estimate_price: 100000, estimate_after_offer: 80000, offer_percent: 20 });
      expect(fs).toMatchObject({ estimate_price: 40000, estimate_after_offer: 40000, offer_percent: null });
    });
  });
});
