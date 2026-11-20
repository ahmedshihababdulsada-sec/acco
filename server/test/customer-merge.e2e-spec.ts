import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

interface World { id: number; code: string; mgr: string; mgrId: number; cash: string; docA: string; docAId: number; cashMethod: number }

describe('دمج الملفات المكررة (المالك)', () => {
  let app: INestApplication; let db: Pool; let today: string; let owner: string;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  let seq = 0; let phoneSeq = 0;
  const key = () => `mk-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const merge = (t: string, from: number, into: number, reason = 'نفس الشخص انسجل مرتين') => post(t, `/customers/${from}/merge`, { into_id: into, reason });

  async function world(code: string): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name) values ($1,$1) returning id`, [code])).rows[0].id);
    await db.query(`insert into safes (branch_id) values ($1)`, [id]);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id); await seedUser(db, `cash_${code}`, 'cashier', id);
    const docAId = await seedUser(db, `docA_${code}`, 'doctor', id);
    await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',100000000,'opening_balance','تجربة',$2)`, [id, mgrId]);
    const [mgr, cash, docA] = await Promise.all([`mgr_${code}`, `cash_${code}`, `docA_${code}`].map((u) => tokenFor(app, u)));
    expect((await put(mgr, `/schedule/doctors/${docAId}/weekly`, { days: [1, 2, 3, 4, 5, 6, 7].map((x) => ({ weekday: x, start_time: '09:00', end_time: '13:00' })), effective_from: today })).status).toBe(200);
    const cur = (await get(mgr, '/settings')).body.settings.find((s: any) => s.key === 'booking.daily_limit');
    expect((await put(mgr, '/settings/booking.daily_limit', { value: 1000, expected_version: cur.version })).status).toBe(200);
    const cs = Number((await db.query(`insert into services (branch_id, name_ar, kind, pricing_model, is_active) values ($1,'كشفية','consultation','fixed',true) returning id`, [id])).rows[0].id);
    await db.query(`insert into service_prices (service_id, price, set_by) values ($1,30000,$2)`, [cs, mgrId]);
    const cashMethod = Number((await db.query(`insert into payment_methods (branch_id, name_ar, kind, sort_order) values ($1,'كاش','cash',0) returning id`, [id])).rows[0].id);
    expect((await post(cash, '/shifts/open', { opening_float: 0 })).status).toBe(201);
    return { id, code, mgr, mgrId, cash, docA, docAId, cashMethod };
  }
  async function customer(w: World, name = 'زبون دمج') {
    phoneSeq++; const r = await post(w.cash, '/customers', { full_name: `${name} ${phoneSeq}`, phone: `0785${String(phoneSeq).padStart(7, '0')}` });
    expect(r.status).toBe(201); return r.body.id as number;
  }
  const givePoints = async (w: World, c: number, points: number) => {
    const old = (await db.query(`insert into customers (branch_id, public_code, phone, full_name, source, status, merged_into_id) values ($1,$2,$3,'ملف قديم','cashier','merged',$4) returning id`, [w.id, `OLM${++seq}${Date.now() % 1e6}`, `+9647${String(330000000 + seq)}`, c])).rows[0].id;
    const m = (await db.query(`insert into customer_merges (from_customer_id, into_customer_id, reason, merged_by) values ($1,$2,'تجربة',$3) returning id`, [old, c, w.mgrId])).rows[0].id;
    await db.query(`insert into points_ledger (customer_id, entry_type, points, merge_id) values ($1,'merge_in',$2,$3)`, [c, points, m]);
  };

  let w: World;
  beforeAll(async () => {
    app = await makeApp(); db = pool();
    today = (await db.query(`select clinic_today()::text as d`)).rows[0].d;
    owner = await tokenFor(app, 'owner'); w = await world('MGA');
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it('الملف المكرر يصير «مدموج» ويشير للباقي، وحجوزاته (غير المدفوعة) وأجهزته وإشعاراته تنتقل، والنقاط بحركتين، والصحة تنتسخ، وبسجل الحركات', async () => {
    const dup = await customer(w, 'مكرر'); const keep = await customer(w, 'الأصلي');
    const b = await post(w.cash, '/bookings', { customer_id: dup, doctor_id: w.docAId, date: day(3) }); expect(b.status).toBe(201);
    await db.query(`insert into customer_devices (customer_id, platform, push_token) values ($1,'ios',$2)`, [dup, `mg-${Date.now()}-abcdefgh`]);
    await db.query(`insert into notifications (customer_id, kind, title, body) values ($1,'reminder','t','b')`, [dup]);
    await db.query(`insert into customer_health (customer_id, recorded_by, allergies, pregnancy) values ($1,$2,'حساسية بنسلين','no')`, [dup, w.docAId]);
    await givePoints(w, dup, 900); await givePoints(w, keep, 100);
    const r = await merge(owner, dup, keep);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: keep, status: 'active', points_balance: 1000, merge: { from_customer_id: dup, moved: { visits: 1, consultations: 1, notifications: 1, customer_devices: 1 }, points_moved: 900, health_copied: true } });
    expect(await one(`select status, merged_into_id::int as m from customers where id = $1`, [dup])).toEqual({ status: 'merged', m: keep });
    expect(Number((await one(`select points_balance from customers where id = $1`, [dup])).points_balance)).toBe(0);
    expect((await one(`select customer_id::int as c from visits where id = $1`, [b.body.id])).c).toBe(keep);
    expect((await one(`select customer_id::int as c from consultations where visit_id = $1`, [b.body.id])).c).toBe(keep);
    expect(Number((await one(`select count(*)::int as n from customer_devices where customer_id = $1`, [keep])).n)).toBe(1);
    expect((await db.query(`select entry_type, points::int as p, customer_id::int as c from points_ledger where merge_id = $1 order by id`, [r.body.merge.id])).rows).toEqual([{ entry_type: 'merge_out', p: -900, c: dup }, { entry_type: 'merge_in', p: 900, c: keep }]);
    const h = await one(`select allergies, notes from customer_health where customer_id = $1 order by id desc limit 1`, [keep]);
    expect(h.allergies).toBe('حساسية بنسلين'); expect(h.notes).toContain('منقول من ملف مدموج');
    expect(await one(`select reason, before_values->>'from_customer_id' as f, actor_role from audit_log where action = 'customer.merge' and entity_id = $1`, [keep])).toEqual({ reason: 'نفس الشخص انسجل مرتين', f: String(dup), actor_role: 'owner' });
    expect((await one(`select count(*)::int as n from customer_merges where from_customer_id = $1 and into_customer_id = $2`, [dup, keep])).n).toBe(1);
    // المدموج ما يظهر بالبحث ورقمه يتحرر، وما ينحجز له
    expect((await get(w.cash, `/customers?q=${(await one(`select public_code from customers where id = $1`, [dup])).public_code}`)).body.customers?.map?.((c: any) => c.id) ?? []).not.toContain(dup);
    expect((await post(w.cash, '/bookings', { customer_id: dup, doctor_id: w.docAId, date: day(5) })).body.code).toBe('CUSTOMER_MERGED');
    expect((await merge(owner, dup, keep)).body.code).toBe('CUSTOMER_MERGED');                                         // مرتين
    expect((await merge(owner, keep, dup)).body.code).toBe('CUSTOMER_MERGED');
  });
  it('رقم المكرر يتحرر بعد الدمج (يقدر ينسجل ملف جديد بنفس الرقم)', async () => {
    const dup = await customer(w, 'مكرر'); const keep = await customer(w, 'الأصلي');
    const phone = (await one(`select phone from customers where id = $1`, [dup])).phone as string;
    expect((await merge(owner, dup, keep)).status).toBe(201);
    const again = await post(w.cash, '/customers', { full_name: 'نفس الرقم', phone: phone.replace('+964', '0') });
    expect(again.status).toBe(201);
  });
  it('ما ينندمج إذا للمكرر علاجات أو مدفوعات، والباقي ما يتأثر', async () => {
    const dup = await customer(w, 'مكرر'); const keep = await customer(w, 'الأصلي');
    const b = await post(w.cash, '/bookings', { customer_id: dup, doctor_id: w.docAId, date: today });
    expect((await http().post('/payments/consultation').set(auth(w.cash)).set('Idempotency-Key', key()).send({ consultation_id: b.body.consultation.id, tenders: [{ method_id: w.cashMethod, amount: 30000 }] })).status).toBe(201);
    const r = await merge(owner, dup, keep);
    expect(r.status).toBe(409); expect(r.body).toMatchObject({ code: 'HAS_TREATMENTS', payments: 1, consultations: 1 });
    expect((await one(`select status from customers where id = $1`, [dup])).status).toBe('active');
    expect((await one(`select customer_id::int as c from visits where id = $1`, [b.body.id])).c).toBe(dup);
    // العكس: الملف اللي بيه علاجات يكون هو الباقي (into): مسموح
    const empty = await customer(w, 'فاضي');
    expect((await merge(owner, empty, dup)).status).toBe(201);
  });
  it('حجزين فعالين بنفس اليوم للملفين: ممنوع مع التواريخ، وبعد نقل واحد يصير مسموح', async () => {
    const dup = await customer(w, 'مكرر'); const keep = await customer(w, 'الأصلي');
    const a = await post(w.cash, '/bookings', { customer_id: dup, doctor_id: w.docAId, date: day(6) }); await post(w.cash, '/bookings', { customer_id: keep, doctor_id: w.docAId, date: day(6) });
    const r = await merge(owner, dup, keep);
    expect(r.status).toBe(409); expect(r.body).toMatchObject({ code: 'SAME_DAY_VISITS', dates: [day(6)] });
    expect((await post(w.cash, `/bookings/${a.body.id}/move`, { date: day(7) })).status).toBe(201);
    expect((await merge(owner, dup, keep)).status).toBe(201);
  });
  it('الرفض: غير المالك، سبب ناقص، نفس الملف، ملف غير موجود، وبدون توكن', async () => {
    const dup = await customer(w, 'مكرر'); const keep = await customer(w, 'الأصلي');
    for (const t of [w.mgr, w.cash, w.docA]) expect((await merge(t, dup, keep)).status).toBe(403);
    expect((await http().post(`/customers/${dup}/merge`).send({ into_id: keep, reason: 'سبب' })).status).toBe(401);
    for (const reason of ['', '  ', 'ab', '     ']) expect([reason, (await merge(owner, dup, keep, reason)).status]).toEqual([reason, 400]);
    expect((await post(owner, `/customers/${dup}/merge`, { reason: 'سبب' })).status).toBe(400);
    const same = await merge(owner, dup, dup); expect(same.status).toBe(400); expect(same.body.code).toBe('SAME_CUSTOMER');
    expect((await merge(owner, dup, 99999999)).status).toBe(404); expect((await merge(owner, 99999999, keep)).status).toBe(404);
    expect((await one(`select status from customers where id = $1`, [dup])).status).toBe('active');
  });
  it('الدمج يوقف دخول المكرر بالتطبيق وتوكناته، والصحة ما تنتسخ إذا للباقي سجل أحدث', async () => {
    const dup = await customer(w, 'مكرر'); const keep = await customer(w, 'الأصلي');
    await db.query(`update customers set app_registered_at = now() where id = $1`, [dup]);
    await db.query(`insert into refresh_tokens (customer_id, token_hash, expires_at) values ($1, $2, now() + interval '1 day')`, [dup, `h-${Date.now()}-${seq}`]);
    await db.query(`insert into customer_health (customer_id, recorded_by, allergies) values ($1,$2,'قديم')`, [dup, w.docAId]);
    await new Promise((r) => setTimeout(r, 20));
    await db.query(`insert into customer_health (customer_id, recorded_by, allergies) values ($1,$2,'أحدث عند الباقي')`, [keep, w.docAId]);
    const r = await merge(owner, dup, keep);
    expect(r.status).toBe(201); expect(r.body.merge.health_copied).toBe(false);
    expect((await one(`select allergies from customer_health where customer_id = $1 order by id desc limit 1`, [keep])).allergies).toBe('أحدث عند الباقي');
    expect((await one(`select count(*)::int as n from refresh_tokens where customer_id = $1 and revoked_at is null`, [dup])).n).toBe(0);
    expect((await one(`select app_deleted_at from customers where id = $1`, [dup])).app_deleted_at).not.toBeNull();
  });
  it('دمجين متزامنين لنفس المكرر: واحد ينجح بس والنقاط تنتقل مرة وحدة', async () => {
    const dup = await customer(w, 'مكرر'); const k1 = await customer(w, 'أصلي1'); const k2 = await customer(w, 'أصلي2');
    await givePoints(w, dup, 500);
    const rs = await Promise.all([merge(owner, dup, k1), merge(owner, dup, k2)]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    const total = Number((await one(`select coalesce(sum(points_balance),0)::int as n from customers where id = any($1::bigint[])`, [[dup, k1, k2]])).n);
    expect(total).toBe(500);
  });
});
