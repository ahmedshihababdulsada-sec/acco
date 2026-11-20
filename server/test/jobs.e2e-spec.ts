import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { JobsService } from '../src/jobs/jobs.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { LogPushSender, PUSH_SENDER } from '../src/notifications/push-sender';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

interface World { id: number; code: string; mgrId: number; mgr: string; cash: string; svcA: number; svcB: number }

describe('المهام المجدولة والإشعارات', () => {
  let app: INestApplication; let db: Pool; let owner: string; let notif: NotificationsService; let jobs: JobsService; let sender: LogPushSender;
  const http = () => request(app.getHttpServer());
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  let seq = 0;
  const uniq = () => `${++seq}${Date.now() % 1e6}`;

  async function world(code: string): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name, created_at) values ($1,$1, now() - interval '400 days') returning id`, [code])).rows[0].id);
    await db.query(`insert into safes (branch_id) values ($1)`, [id]);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id); await seedUser(db, `cash_${code}`, 'cashier', id);
    const mgr = await tokenFor(app, `mgr_${code}`); const cash = await tokenFor(app, `cash_${code}`);
    const svc = async (name: string) => Number((await db.query(`insert into services (branch_id, name_ar, kind, pricing_model, is_active) values ($1,$2,'treatment','fixed',true) returning id`, [id, name])).rows[0].id);
    return { id, code, mgrId, mgr, cash, svcA: await svc('ليزر'), svcB: await svc('تنظيف') };
  }
  /** زبون بالتطبيق (افتراضياً بجهاز فعال) */
  async function cust(w: World, o: { app?: boolean; device?: boolean | 'inactive'; deleted?: boolean; notifyOffers?: boolean; merged?: boolean } = {}) {
    const n = uniq();
    const merged = o.merged === true;
    const id = Number((await db.query(
      `insert into customers (branch_id, public_code, phone, full_name, source, app_registered_at, app_deleted_at, notify_offers, status, merged_into_id)
       values ($1,$2,$3,'زبون إشعار','cashier',$4,$5,$6,$7,$8) returning id`,
      [w.id, `NT${n}`, `+9647${String(300000000 + seq)}`, o.app === false ? null : new Date(), o.deleted ? new Date() : null, o.notifyOffers ?? true, merged ? 'merged' : 'active',
        merged ? (await one(`select id from customers where branch_id = $1 and status = 'active' limit 1`, [w.id]))?.id ?? null : null])).rows[0].id);
    let token: string | null = null;
    if (o.device !== false) { token = `tok-${n}-${'x'.repeat(10)}`; await db.query(`insert into customer_devices (customer_id, platform, push_token, is_active) values ($1,'android',$2,$3)`, [id, token, o.device !== 'inactive']); }
    return { id, token };
  }
  async function offerRow(w: World, o: { service?: number; notifyAt?: number; audience?: string; notifyService?: number | null; title?: string | null; body?: string | null; start?: number; end?: number; status?: string; sent?: boolean } = {}) {
    return Number((await db.query(
      `insert into offers (branch_id, service_id, title, percent, start_date, end_date, status, notify_audience, notify_service_id, notify_title, notify_body, notify_at, notification_sent_at, created_by)
       values ($1,$2,'عرض',10,clinic_today() + $3::int,clinic_today() + $4::int,$5,$6,$7,$8,$9,clinic_today() + $10::int,$11,$12) returning id`,
      [w.id, o.service ?? w.svcA, o.start ?? 0, o.end ?? 10, o.status ?? 'scheduled', o.audience ?? 'all', o.notifyService ?? null, o.title ?? null, o.body ?? null, o.notifyAt ?? 0, o.sent ? new Date() : null, w.mgrId])).rows[0].id);
  }
  /** جلسة مكتملة لزبون بخدمة (لفئة «سوّوا الخدمة») */
  async function completed(w: World, customerId: number, service: number) {
    const u = await seedUser(db, `dr_${uniq()}`, 'doctor', w.id);
    const v = (await db.query(`insert into visits (branch_id, customer_id, visit_date, seq_no, status, source, doctor_id) values ($1,$2,clinic_today(),$3,'arrived','cashier',$4) returning id`, [w.id, customerId, 5000 + seq, u])).rows[0].id;
    const cons = (await db.query(`insert into consultations (branch_id, visit_id, customer_id, doctor_id, status, entered_at, finished_at) values ($1,$2,$3,$4,'finished',now(),now()) returning id`, [w.id, v, customerId, u])).rows[0].id;
    const plan = (await db.query(`insert into treatment_plans (branch_id, customer_id, consultation_id, doctor_id, status) values ($1,$2,$3,$4,'active') returning id`, [w.id, customerId, cons, u])).rows[0].id;
    const item = (await db.query(`insert into plan_items (plan_id, service_id, sessions_count, first_session_date) values ($1,$2,1,clinic_today()) returning id`, [plan, service])).rows[0].id;
    const nurse = await seedUser(db, `nr_${uniq()}`, 'nurse', w.id);
    return Number((await db.query(`insert into treatment_sessions (branch_id, customer_id, plan_item_id, seq_no, status, scheduled_date, doctor_planned_date, visit_id, completed_at, completed_by) values ($1,$2,$3,1,'completed',clinic_today(),clinic_today(),$4,now(),$5) returning id`, [w.id, customerId, item, v, nurse])).rows[0].id);
  }
  async function visit(w: World, customerId: number, offset: number, status = 'booked') {
    return Number((await db.query(`insert into visits (branch_id, customer_id, visit_date, seq_no, status, source, cancelled_at) values ($1,$2,clinic_today() + $3::int,$4,$5,'cashier',$6) returning id`, [w.id, customerId, offset, 6000 + ++seq, status, status === 'cancelled' ? new Date() : null])).rows[0].id);
  }
  const queued = async (offerId: number) => (await db.query(`select customer_id::int as c, title, body, data, status from notifications where offer_id = $1 order by customer_id`, [offerId])).rows;
  const notifOf = async (customerId: number, kind?: string) => (await db.query(`select id::int as id, kind, title, body, data, status, sent_at, read_at from notifications where customer_id = $1 and ($2::text is null or kind = $2) order by id`, [customerId, kind ?? null])).rows;

  beforeAll(async () => {
    app = await makeApp(); db = pool();
    notif = app.get(NotificationsService); jobs = app.get(JobsService); sender = app.get(PUSH_SENDER) as LogPushSender;
    owner = await tokenFor(app, 'owner');
  });
  afterAll(async () => { await app.close(); await db.end(); });

  // ------------------------------------------------------------------------------------------------
  describe('إشعار العرض يوم بدايته', () => {
    it('للزبائن المسجلين بالتطبيق وبجهاز فعال وما طفوا العروض بس، بنص افتراضي بدون اسم علاج، ومرة وحدة', async () => {
      const w = await world('JNA'); const other = await world('JNB');
      const a = await cust(w); const noDevice = await cust(w, { device: false }); const deleted = await cust(w, { deleted: true }); const off = await cust(w, { notifyOffers: false });
      const noApp = await cust(w, { app: false }); const inactive = await cust(w, { device: 'inactive' }); const merged = await cust(w, { merged: true }); const foreign = await cust(other);
      const o = await offerRow(w);
      const r = await notif.dispatchOffers(w.id);
      expect(r.offers).toBeGreaterThanOrEqual(1);
      const q = await queued(o);
      expect(q.map((x) => x.c)).toEqual([a.id]);
      expect(q[0]).toMatchObject({ title: 'عرض جديد', status: 'pending', data: { offer_id: o } });
      expect(q[0].body).not.toContain('ليزر');
      expect((await one(`select notification_sent_at from offers where id = $1`, [o])).notification_sent_at).not.toBeNull();
      for (const x of [noDevice, deleted, off, noApp, inactive, merged, foreign]) expect(await notifOf(x.id, 'offer')).toEqual([]);
      const again = await notif.dispatchOffers(w.id);
      expect(again.offers).toBe(0);
      expect(await queued(o)).toHaveLength(1);
    });
    it('النص المخصص يُستخدم كما كتبه المدير', async () => {
      const w = await world('JNC'); const a = await cust(w);
      const o = await offerRow(w, { title: 'خصم الصيف', body: 'تخفيض حتى 30%' });
      await notif.dispatchOffers(w.id);
      expect((await queued(o))[0]).toMatchObject({ c: a.id, title: 'خصم الصيف', body: 'تخفيض حتى 30%' });
    });
    it('الفئة «سوّوا الخدمة»: اللي عنده جلسة مكتملة بهالخدمة بس (مو غيرها ولا غير مكتملة)', async () => {
      const w = await world('JND');
      const did = await cust(w); const didOther = await cust(w); const never = await cust(w);
      await completed(w, did.id, w.svcA); await completed(w, didOther.id, w.svcB);
      const paidOnly = await cust(w); const sPaid = await completed(w, paidOnly.id, w.svcA);
      await db.query(`update treatment_sessions set status = 'paid', completed_at = null, completed_by = null where id = $1`, [sPaid]);       // مدفوعة وما اكتملت
      const o = await offerRow(w, { audience: 'did_service', notifyService: w.svcA });
      await notif.dispatchOffers(w.id);
      expect((await queued(o)).map((x) => x.c)).toEqual([did.id]);
      expect(never.id).toBeDefined(); expect(paidOnly.id).toBeDefined();
    });
    it('ما ينرسل: يوم الإشعار بعدين، العرض ملغى أو منتهي، أو «بدون»', async () => {
      const w = await world('JNE'); await cust(w);
      const later = await offerRow(w, { notifyAt: 3 }); const cancelled = await offerRow(w, { status: 'cancelled', service: w.svcB });
      const ended = await offerRow(w, { start: -8, end: -2, notifyAt: -8 }); const none = await offerRow(w, { audience: 'none', start: 20, end: 30, notifyAt: 0 });
      await notif.dispatchOffers(w.id);
      for (const o of [later, cancelled, ended, none]) expect(await queued(o)).toEqual([]);
      for (const o of [later, cancelled, none]) expect((await one(`select notification_sent_at from offers where id = $1`, [o])).notification_sent_at).toBeNull();
    });
    it('تشغيلين متزامنين: كل زبون يوصله إشعار واحد بس', async () => {
      const w = await world('JNF'); const cs: { id: number; token: string | null }[] = []; for (let i = 0; i < 5; i++) cs.push(await cust(w));
      const o = await offerRow(w);
      await Promise.all([notif.dispatchOffers(w.id), notif.dispatchOffers(w.id), notif.dispatchOffers(w.id)]);
      expect((await queued(o)).map((x) => x.c).sort()).toEqual(cs.map((c) => c.id).sort());
    });
  });

  describe('تذكير الموعد ونقل الموعد', () => {
    it('تذكير لزيارة بكرة المحجوزة لمسجلي التطبيق بس، مرة وحدة لكل زيارة، بنص بدون علاج', async () => {
      const w = await world('JRA');
      const a = await cust(w); const noApp = await cust(w, { app: false }); const noDev = await cust(w, { device: false });
      const vTomorrow = await visit(w, a.id, 1); await visit(w, noApp.id, 1); await visit(w, noDev.id, 1);
      const c2 = await cust(w); const c3 = await cust(w); const c4 = await cust(w); const c5 = await cust(w);
      await visit(w, c2.id, 0); await visit(w, c3.id, 2); await visit(w, c4.id, 1, 'cancelled'); await visit(w, c5.id, 1, 'arrived');
      await notif.queueReminders(w.id); await notif.queueReminders(w.id);
      const n = await notifOf(a.id, 'reminder');
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({ title: 'تذكير بموعدك', status: 'pending', data: { visit_id: vTomorrow } });
      for (const x of [noApp, noDev, c2, c3, c4, c5]) expect(await notifOf(x.id, 'reminder')).toEqual([]);
    });
    it('الموعد انتقل أو انلغى قبل الإرسال: التذكير ينلغي ولا يوصل', async () => {
      const w = await world('JRB'); const a = await cust(w); const b = await cust(w);
      const va = await visit(w, a.id, 1); const vb = await visit(w, b.id, 1);
      await notif.queueReminders(w.id);
      await db.query(`update visits set visit_date = clinic_today() + 5 where id = $1`, [va]);
      await db.query(`update visits set status = 'cancelled', cancelled_at = now() where id = $1`, [vb]);
      await notif.sendPending(200, w.id);
      expect((await notifOf(a.id, 'reminder'))[0].status).toBe('cancelled'); expect((await notifOf(b.id, 'reminder'))[0].status).toBe('cancelled');
      expect(sender.sent.some((s) => s.targets.some((t) => t.token === a.token || t.token === b.token))).toBe(false);
    });
    it('إشعار نقل الموعد بسبب عطلة: لكل حدث مرة، لآخر 3 أيام، وللحجز الفعال بس', async () => {
      const w = await world('JRC'); const a = await cust(w); const b = await cust(w); const c = await cust(w);
      const va = await visit(w, a.id, 3); const vb = await visit(w, b.id, 4); const vc = await visit(w, c.id, 5, 'cancelled');
      const ev = async (v: number, ago = '1 hour') => Number((await db.query(`insert into booking_events (visit_id, event, from_date, to_date, created_at) values ($1,'moved_by_closure',clinic_today() + 2,clinic_today() + 3, now() - $2::interval) returning id`, [v, ago])).rows[0].id);
      const ea = await ev(va); await ev(vb, '5 days'); await ev(vc);
      await notif.queueBookingMoved(w.id); await notif.queueBookingMoved(w.id);
      const n = await notifOf(a.id, 'booking_moved');
      expect(n).toHaveLength(1); expect(n[0]).toMatchObject({ status: 'pending', data: { visit_id: va, event_id: ea } });
      expect(n[0].body).not.toContain('ليزر');
      expect(await notifOf(b.id, 'booking_moved')).toEqual([]); expect(await notifOf(c.id, 'booking_moved')).toEqual([]);
    });
  });

  describe('إرسال الطابور', () => {
    it('يرسل لأجهزة الزبون الفعالة، ويصير «أُرسل» بوقت، والبيانات تحمل نوع الإشعار', async () => {
      const w = await world('JSA'); const a = await cust(w);
      const dev2 = `tok2-${uniq()}-yyyyyyyy`; await db.query(`insert into customer_devices (customer_id, platform, push_token) values ($1,'ios',$2)`, [a.id, dev2]);
      await db.query(`insert into customer_devices (customer_id, platform, push_token, is_active) values ($1,'ios',$2,false)`, [a.id, `off-${uniq()}-zzzzzzzz`]);
      const o = await offerRow(w); await notif.dispatchOffers(w.id);
      const r = await notif.sendPending(200, w.id);
      expect(r.sent).toBeGreaterThanOrEqual(1);
      const n = (await notifOf(a.id, 'offer'))[0];
      expect(n.status).toBe('sent'); expect(n.sent_at).not.toBeNull();
      const call = sender.sent.find((s) => s.targets.some((t) => t.token === a.token))!;
      expect(call.targets.map((t) => [t.token, t.platform]).sort()).toEqual([[a.token, 'android'], [dev2, 'ios']].sort());
      expect(call.msg).toMatchObject({ title: 'عرض جديد', data: { kind: 'offer', offer_id: o, notification_id: n.id } });
    });
    it('ينلغي وقت الإرسال إذا: العرض انلغى، الزبون طفى العروض، ما بقى عنده جهاز، أو حذف حسابه (كل سبب لحاله)', async () => {
      const w = await world('JSB');
      const [c1, c2, c3, c4, ok] = [await cust(w), await cust(w), await cust(w), await cust(w), await cust(w)];
      const oCancel = await offerRow(w, { service: w.svcA });
      await db.query(`delete from customer_devices where customer_id = any($1::bigint[])`, [[c2.id, c3.id, c4.id, ok.id]]);       // نستثني الأول: هذا عرضه فقط
      await notif.dispatchOffers(w.id);
      await db.query(`update offers set status = 'cancelled' where id = $1`, [oCancel]);
      // سبب ثاني: عرض صالح لباقي الحالات (نعيد الأجهزة قبل التوليد)
      for (const c of [c2, c3, c4, ok]) await db.query(`insert into customer_devices (customer_id, platform, push_token) values ($1,'android',$2)`, [c.id, `re-${c.id}-${uniq()}-xxxxxxxx`]);
      const oValid = await offerRow(w, { service: w.svcB });
      await notif.dispatchOffers(w.id);
      await db.query(`update customers set notify_offers = false where id = $1`, [c2.id]);
      await db.query(`update customer_devices set is_active = false where customer_id = $1`, [c3.id]);
      await db.query(`update customers set app_deleted_at = now() where id = $1`, [c4.id]);
      const before = sender.sent.length;
      await notif.sendPending(200, w.id);
      expect((await notifOf(c1.id, 'offer')).filter((x) => x.data.offer_id === oCancel).map((x) => x.status)).toEqual(['cancelled']);   // العرض الملغى
      for (const [name, c] of [['opt-out', c2], ['no device', c3], ['deleted', c4]] as const) expect([name, (await notifOf(c.id, 'offer')).filter((x) => x.data.offer_id === oValid).map((x) => x.status)]).toEqual([name, ['cancelled']]);
      expect((await notifOf(ok.id, 'offer')).filter((x) => x.data.offer_id === oValid).map((x) => x.status)).toEqual(['sent']);      // الشاهد: عرض صالح وزبون سليم يوصل
      const tokens = sender.sent.slice(before).flatMap((s) => s.targets.map((t) => t.token));
      for (const c of [c2, c3, c4]) expect(tokens).not.toContain(c.token);
    });
    it('طلب التقييم: يوصل لجلسة مكتملة بدون تقييم، وينلغي إذا قيّمها أو رجعت غير مكتملة', async () => {
      const w = await world('JSC'); const a = await cust(w); const b = await cust(w); const c = await cust(w);
      const sa = await completed(w, a.id, w.svcA); const sb = await completed(w, b.id, w.svcA); const sc = await completed(w, c.id, w.svcA);
      for (const [cu, s] of [[a, sa], [b, sb], [c, sc]] as const) await db.query(`insert into notifications (customer_id, kind, title, body, treatment_session_id) values ($1,'rating_request','قيّم جلستك','شاركنا رأيك',$2)`, [cu.id, s]);
      await db.query(`insert into session_ratings (session_id, customer_id, service_id, nurse_id, stars) select s.id, s.customer_id, $2, s.completed_by, 5 from treatment_sessions s where s.id = $1`, [sb, w.svcA]);
      await db.query(`update treatment_sessions set status = 'paid', completed_at = null, completed_by = null where id = $1`, [sc]);
      await notif.sendPending(200, w.id);
      expect((await notifOf(a.id, 'rating_request'))[0].status).toBe('sent');
      expect((await notifOf(b.id, 'rating_request'))[0].status).toBe('cancelled'); expect((await notifOf(c.id, 'rating_request'))[0].status).toBe('cancelled');
    });
    it('فشل الإرسال يصير «فشل» وما ينعاد تلقائياً، والباقين يكملون', async () => {
      const w = await world('JSD'); const a = await cust(w); const b = await cust(w);
      const o = await offerRow(w); await notif.dispatchOffers(w.id);
      const spy = jest.spyOn(sender, 'send').mockImplementationOnce(async () => { throw new Error('FCM down'); });
      const r = await notif.sendPending(200, w.id);
      spy.mockRestore();
      expect(r.failed).toBeGreaterThanOrEqual(1);
      const statuses = [...(await notifOf(a.id, 'offer')), ...(await notifOf(b.id, 'offer'))].map((x) => x.status).sort();
      expect(statuses.filter((s) => s === 'failed')).toHaveLength(1); expect(statuses.filter((s) => s === 'sent')).toHaveLength(1);
      expect(o).toBeDefined();
      const again = await notif.sendPending(200, w.id); expect(again.failed).toBe(0);
      expect((await db.query(`select 1 from notifications where status = 'failed' and customer_id = any($1::bigint[])`, [[a.id, b.id]])).rowCount).toBe(1);
    });
    it('تشغيلين متزامنين: كل إشعار يتسلم مرة وحدة بس', async () => {
      const w = await world('JSE'); const cs: { id: number; token: string | null }[] = []; for (let i = 0; i < 6; i++) cs.push(await cust(w));
      await offerRow(w); await notif.dispatchOffers(w.id);
      const before = sender.sent.length;
      await Promise.all([notif.sendPending(200, w.id), notif.sendPending(200, w.id), notif.sendPending(200, w.id)]);
      const mine = sender.sent.slice(before).filter((s) => s.targets.some((t) => cs.some((c) => c.token === t.token)));
      expect(mine).toHaveLength(6);
      expect(new Set(mine.map((m) => (m.msg.data as any).notification_id)).size).toBe(6);
    });
    it('الحد الأعلى للدفعة يُحترم والباقي ينتظر', async () => {
      const w = await world('JSF'); for (let i = 0; i < 4; i++) await cust(w);
      const o = await offerRow(w); await notif.dispatchOffers(w.id);
      await db.query(`update notifications set status = 'cancelled' where status = 'pending' and offer_id <> $1`, [o]);
      const r = await notif.sendPending(3, w.id);
      expect(r.sent + r.failed + r.cancelled).toBe(3);
      expect(Number((await one(`select count(*)::int as n from notifications where offer_id = $1 and status = 'pending'`, [o])).n)).toBe(1);
    });
    it('الإشعار المجدول للمستقبل ما ينرسل', async () => {
      const w = await world('JSG'); const a = await cust(w);
      await db.query(`insert into notifications (customer_id, kind, title, body, scheduled_at) values ($1,'reminder','t','b', now() + interval '1 day')`, [a.id]);
      await notif.sendPending(200, w.id);
      expect((await notifOf(a.id))[0].status).toBe('pending');
    });
  });

  describe('صندوق الزبون والأجهزة', () => {
    it('القائمة: المُرسَل بس، الأحدث أول، غير المقروء، وتعليم مقروء (واحد أو الكل) مع فحص الملكية', async () => {
      const w = await world('JIA'); const a = await cust(w); const b = await cust(w);
      const mk = async (cu: number, status: string) => Number((await db.query(`insert into notifications (customer_id, kind, title, body, status) values ($1,'reminder','t','b',$2) returning id`, [cu, status])).rows[0].id);
      const n1 = await mk(a.id, 'sent'); const n2 = await mk(a.id, 'sent'); await mk(a.id, 'pending'); await mk(a.id, 'cancelled'); await mk(a.id, 'failed'); const other = await mk(b.id, 'sent');
      const list = await notif.listForCustomer(a.id);
      expect(list.notifications.map((n) => n.id)).toEqual([n2, n1]); expect(list.notifications.every((n) => n.read === false)).toBe(true);
      expect((await notif.markRead(a.id, n1)).marked).toBe(1);
      expect((await notif.listForCustomer(a.id, { unreadOnly: true })).notifications.map((n) => n.id)).toEqual([n2]);
      expect((await notif.markRead(a.id, n1)).marked).toBe(0);                                                // مقروء مسبقاً: ما يخطي ولا يرفض
      await expect(notif.markRead(a.id, other)).rejects.toMatchObject({ status: 404 });
      await expect(notif.markRead(a.id, 99999999)).rejects.toMatchObject({ status: 404 });
      expect((await notif.markRead(a.id)).marked).toBe(1);
      expect((await notif.listForCustomer(a.id, { unreadOnly: true })).notifications).toEqual([]);
      expect((await notif.listForCustomer(b.id)).notifications.map((n) => n.id)).toEqual([other]);
      expect((await notif.listForCustomer(a.id, { limit: 1 })).notifications).toHaveLength(1);
    });
    it('تسجيل الجهاز: يضيف، يحدث، وينتقل لزبون ثاني بدون تكرار، والتوكن غير الصحيح مرفوض، والإلغاء يطفي', async () => {
      const w = await world('JIB'); const a = await cust(w, { device: false }); const b = await cust(w, { device: false });
      const tok = `reg-${uniq()}-abcdefgh`;
      await notif.registerDevice(a.id, 'ios', tok);
      expect((await db.query(`select customer_id::int as c, platform, is_active from customer_devices where push_token = $1`, [tok])).rows).toEqual([{ c: a.id, platform: 'ios', is_active: true }]);
      await notif.registerDevice(b.id, 'android', tok);
      expect((await db.query(`select customer_id::int as c, platform from customer_devices where push_token = $1`, [tok])).rows).toEqual([{ c: b.id, platform: 'android' }]);
      await expect(notif.registerDevice(a.id, 'ios', 'short')).rejects.toMatchObject({ response: { code: 'INVALID_TOKEN' } });
      expect((await notif.unregisterDevice(a.id, tok)).removed).toBe(0);                                      // مو جهازه هسه
      expect((await notif.unregisterDevice(b.id, tok)).removed).toBe(1);
      expect((await one(`select is_active from customer_devices where push_token = $1`, [tok])).is_active).toBe(false);
      await notif.registerDevice(b.id, 'android', tok);
      expect((await one(`select is_active from customer_devices where push_token = $1`, [tok])).is_active).toBe(true);        // إعادة التفعيل
    });
  });

  describe('دورة المهام', () => {
    it('تقفل الحجوزات الفايتة للنظام (بدون موظف)، وتنهي طلبات الخصم القديمة، وتولد الرواتب، وتعيد الإشعارات', async () => {
      const w = await world('JJA'); const a = await cust(w);
      const missed = await visit(w, a.id, -2);
      const c2 = await cust(w);
      const dr = Number((await db.query(`insert into discount_requests (branch_id, customer_id, basket, status, requested_by, requested_at) values ($1,$2,'{}','pending',$3, now() - interval '3 days') returning id`, [w.id, c2.id, w.mgrId])).rows[0].id);
      const r = await jobs.runAll(w.id);
      expect(r.closed_days.find((x) => x.branch_id === w.id)).toEqual({ branch_id: w.id, missed: 1, rolled_over: 0 });
      expect((await one(`select status from visits where id = $1`, [missed])).status).toBe('missed');
      expect((await one(`select actor_user_id, event from booking_events where visit_id = $1 and event = 'missed'`, [missed])).actor_user_id).toBeNull();
      expect((await one(`select actor_role, actor_user_id from audit_log where action = 'booking.close_past_days' and branch_id = $1 order by id desc limit 1`, [w.id]))).toEqual({ actor_role: 'system', actor_user_id: null });
      expect((await one(`select status from discount_requests where id = $1`, [dr])).status).toBe('expired');
      expect(r.discounts_expired).toBeGreaterThanOrEqual(1);
      expect(Number((await one(`select count(*)::int as n from payroll_runs where branch_id = $1`, [w.id])).n)).toBe(1);
      expect(Object.keys(r).sort()).toEqual(['closed_days', 'discounts_expired', 'moved_notices', 'offers', 'orphans_removed', 'payroll_runs', 'push', 'reminders']);
      const r2 = await jobs.runAll(w.id);                                                                           // إعادة بدون أثر
      expect(r2.closed_days.find((x) => x.branch_id === w.id)).toEqual({ branch_id: w.id, missed: 0, rolled_over: 0 });
      expect(r2.payroll_runs).toBe(0);
    });
    it('بقفل استشاري: نسخة شغالة تخلي الثانية تتخطى، والمالك بس يشغلها يدوياً', async () => {
      const lock = await db.connect();
      try {
        await lock.query(`select pg_advisory_lock(7340001)`);
        expect(await jobs.tick()).toBeNull();
        const busy = await post(owner, '/jobs/run', { branch_id: 1 });
        expect(busy.status).toBe(409); expect(busy.body.code).toBe('JOBS_BUSY');
      } finally { await lock.query(`select pg_advisory_unlock(7340001)`); lock.release(); }
      const w = await world('JJB');
      const ok = await post(owner, '/jobs/run', { branch_id: w.id });
      expect(ok.status).toBe(200); expect(ok.body.closed_days).toEqual([{ branch_id: w.id, missed: 0, rolled_over: 0 }]);
      expect((await post(owner, '/jobs/run', { branch_id: 'x' })).status).toBe(400);
      for (const t of [w.mgr, w.cash]) expect((await post(t, '/jobs/run')).status).toBe(403);
      expect((await http().post('/jobs/run')).status).toBe(401);
    });
  });
});
