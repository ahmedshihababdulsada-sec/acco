import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { newPublicCode } from '../src/customers/customers.service';
import { auth, branchId, makeApp, pool, tokenFor } from './helpers';

describe('الزبائن', () => {
  let app: INestApplication; let db: Pool; let b1: number;
  let owner: string; let mgr1: string; let mgr2: string; let cash: string; let doc: string; let nurse: string;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const patch = (t: string, url: string, body: object) => http().patch(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);

  beforeAll(async () => {
    app = await makeApp(); db = pool(); b1 = await branchId(db, 'B1');
    [owner, mgr1, mgr2, cash, doc, nurse] = await Promise.all(['owner', 'mgr1', 'mgr2', 'cash1', 'doc1', 'nurse1'].map((u) => tokenFor(app, u)));
  });
  afterAll(async () => { await app.close(); await db.end(); });

  describe('الصلاحيات', () => {
    it('الطبيب والممرض ما يسجلون ولا يبحثون، والكاشير والمدير والمالك يقدرون', async () => {
      for (const t of [doc, nurse]) {
        expect((await post(t, '/customers', { full_name: 'زبون', phone: '07700000001' })).status).toBe(403);
        expect((await get(t, '/customers?q=زبون')).status).toBe(403);
      }
      expect((await post(cash, '/customers', { full_name: 'صلاحية كاشير', phone: '07700000002' })).status).toBe(201);
      expect((await post(mgr1, '/customers', { full_name: 'صلاحية مدير', phone: '07700000003' })).status).toBe(201);
      expect((await post(owner, '/customers', { full_name: 'صلاحية مالك', phone: '07700000004', branch_id: b1 })).status).toBe(201);
      expect((await http().get('/customers?q=زبون')).status).toBe(401);
    });
    it('تغيير الرقم للمالك بس', async () => {
      const c = (await post(cash, '/customers', { full_name: 'تغيير رقم صلاحية', phone: '07700000005' })).body;
      for (const t of [cash, mgr1, doc]) expect((await put(t, `/customers/${c.id}/phone`, { phone: '07700000006', reason: 'سبب' })).status).toBe(403);
      expect((await put(owner, `/customers/${c.id}/phone`, { phone: '07700000006', reason: 'سبب' })).status).toBe(200);
    });
  });

  describe('التسجيل', () => {
    it('يسجل بصيغة موحدة مع رمز مميز، وفرع الموظف', async () => {
      const r = await post(cash, '/customers', { full_name: '  سارة   أحمد ', phone: '0770 111-2233', gender: 'female', birth_date: '1995-04-12' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ full_name: 'سارة أحمد', phone: '+9647701112233', gender: 'female', birth_date: '1995-04-12', source: 'cashier', status: 'active', points_balance: 0, branch_id: b1 });
      expect(r.body.public_code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
      const row = (await db.query(`select created_by from customers where id = $1`, [r.body.id])).rows[0];
      expect(Number(row.created_by)).toBe(Number((await db.query(`select id from users where username='cash1'`)).rows[0].id));
      expect((await db.query(`select 1 from audit_log where action = 'customer.create' and entity_id = $1`, [r.body.id])).rowCount).toBe(1);
    });
    it('الرقم المكرر (بأي صيغة) → 409 مع بيانات الموجود', async () => {
      const first = (await post(cash, '/customers', { full_name: 'مكرر أول', phone: '07709990001' })).body;
      for (const phone of ['07709990001', '+9647709990001', '٠٧٧٠٩٩٩٠٠٠١', '009647709990001']) {
        const r = await post(mgr1, '/customers', { full_name: 'مكرر ثاني', phone });
        expect(r.status).toBe(409);
        expect(r.body).toMatchObject({ code: 'PHONE_EXISTS', customer: { id: first.id, full_name: 'مكرر أول', public_code: first.public_code } });
      }
    });
    it('تسجيل متزامن لنفس الرقم: واحد ينجح والباقي 409', async () => {
      const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => post(i % 2 ? cash : mgr1, '/customers', { full_name: `سباق ${i}`, phone: '07709990002' })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'PHONE_EXISTS')).toHaveLength(7);
      expect((await db.query(`select count(*)::int as n from customers where phone = '+9647709990002'`)).rows[0].n).toBe(1);
    });
    it('رمز المشبوه، اسم قصير، تاريخ ميلاد غلط، حقل زايد → 400', async () => {
      const bad = async (body: object) => (await post(cash, '/customers', { full_name: 'اسم', phone: '07709990003', ...body })).status;
      expect(await bad({ phone: '12345' })).toBe(400);
      expect(await bad({ full_name: 'ا' })).toBe(400);
      expect(await bad({ full_name: '   ' })).toBe(400);
      expect(await bad({ birth_date: '2999-01-01' })).toBe(400);
      expect(await bad({ birth_date: '1850-01-01' })).toBe(400);
      expect(await bad({ birth_date: '2020-02-30' })).toBe(400);
      expect(await bad({ gender: 'x' })).toBe(400);
      expect(await bad({ points_balance: 1000 })).toBe(400);
      expect((await db.query(`select 1 from customers where phone = '+9647709990003'`)).rowCount).toBe(0);
    });
    it('المالك لازم يحدد الفرع لو أكثر من فرع، وغير المالك ما يسجل بفرع ثاني', async () => {
      expect((await post(owner, '/customers', { full_name: 'بدون فرع', phone: '07709990004' })).status).toBe(400);
      expect((await post(mgr2, '/customers', { full_name: 'فرع ثاني', phone: '07709990004', branch_id: b1 })).status).toBe(403);
      const ok = await post(mgr2, '/customers', { full_name: 'فرع ثاني', phone: '07709990004' });
      expect(ok.status).toBe(201);
      expect(ok.body.branch_id).not.toBe(b1);
    });
    it('الرموز المميزة فريدة ومن الأحرف المسموحة', () => {
      const set = new Set(Array.from({ length: 2000 }, () => newPublicCode()));
      expect(set.size).toBe(2000);
      for (const c of set) expect(c).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    });
  });

  describe('البحث والعرض', () => {
    let target: any;
    beforeAll(async () => { target = (await post(cash, '/customers', { full_name: 'نور الهدى كاظم', phone: '07705550001' })).body; });
    it('بالرقم الكامل بأي صيغة، وبجزء من الرقم، وبالرمز، وبالاسم', async () => {
      for (const q of ['07705550001', '+9647705550001', '9647705550001', '5550001', encodeURIComponent(target.public_code), encodeURIComponent(target.public_code.toLowerCase()), encodeURIComponent('الهدى')]) {
        const r = await get(mgr2, `/customers?q=${q}`);          // مدير فرع ثاني: الزبائن مشتركين
        expect(r.status).toBe(200);
        expect(r.body.map((c: any) => c.id)).toContain(target.id);
      }
    });
    it('الاستعلام القصير 400، وحروف LIKE الخاصة ما تطابق الكل', async () => {
      expect((await get(cash, '/customers?q=ن')).status).toBe(400);
      expect((await get(cash, '/customers')).status).toBe(400);
      const r = await get(cash, `/customers?q=${encodeURIComponent('%%')}`);
      expect(r.status).toBe(200);
      expect(r.body).toHaveLength(0);
      expect((await get(cash, `/customers?q=${encodeURIComponent('_____')}`)).body).toHaveLength(0);
    });
    it('الملف الشخصي يبين الحجوزات القادمة، وغير الموجود 404', async () => {
      const r = await get(cash, `/customers/${target.id}`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ id: target.id, full_name: 'نور الهدى كاظم', upcoming_visits: [] });
      expect((await get(cash, '/customers/99999999')).status).toBe(404);
      expect((await get(cash, '/customers/abc')).status).toBe(400);
    });
    it('الزبون المدموج ما يظهر بالبحث', async () => {
      const m = (await post(cash, '/customers', { full_name: 'ملف مدموج قديم', phone: '07705550002' })).body;
      await db.query(`update customers set status = 'merged', merged_into_id = $2 where id = $1`, [m.id, target.id]);
      expect((await get(cash, `/customers?q=${encodeURIComponent('ملف مدموج')}`)).body).toHaveLength(0);
      // ورقمه يصير متاح للتسجيل من جديد
      expect((await post(cash, '/customers', { full_name: 'نفس الرقم جديد', phone: '07705550002' })).status).toBe(201);
    });
  });

  describe('التعديل وتغيير الرقم', () => {
    let c: any;
    beforeAll(async () => { c = (await post(cash, '/customers', { full_name: 'تعديل زبون', phone: '07706660001', gender: 'male' })).body; });
    it('الكاشير يعدل الاسم والجنس والميلاد ولا يغير الرقم، والتعديل يتسجل', async () => {
      const r = await patch(cash, `/customers/${c.id}`, { full_name: ' اسم   جديد ', birth_date: '1990-01-01', notify_offers: false });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ full_name: 'اسم جديد', birth_date: '1990-01-01', gender: 'male', notify_offers: false, phone: '+9647706660001' });
      expect((await patch(cash, `/customers/${c.id}`, { phone: '07706660009' })).status).toBe(400);      // الرقم ماله مسار تعديل عادي
      const a = (await db.query(`select before_values, after_values from audit_log where action = 'customer.update' and entity_id = $1`, [c.id])).rows[0];
      expect(a.before_values.full_name).toBe('تعديل زبون');
      expect(a.after_values.full_name).toBe('اسم جديد');
    });
    it('المالك يغير الرقم بسبب، ويرفض المكرر والسبب الفارغ، والرقم القديم يتحرر', async () => {
      expect((await put(owner, `/customers/${c.id}/phone`, { phone: '07706660002', reason: '  ' })).status).toBe(400);
      expect((await put(owner, `/customers/${c.id}/phone`, { phone: '07706660002', reason: '       ' })).status).toBe(400);       // فراغات بس
      expect((await db.query(`select phone from customers where id = $1`, [c.id])).rows[0].phone).toBe('+9647706660001');
      const other = (await post(cash, '/customers', { full_name: 'رقم محجوز', phone: '07706660003' })).body;
      const dup = await put(owner, `/customers/${c.id}/phone`, { phone: '07706660003', reason: 'غلط بالتسجيل' });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('PHONE_EXISTS');
      const ok = await put(owner, `/customers/${c.id}/phone`, { phone: '0770 666 0002', reason: 'غير رقمه' });
      expect(ok.status).toBe(200);
      expect(ok.body.phone).toBe('+9647706660002');
      const a = (await db.query(`select reason, before_values, after_values from audit_log where action = 'customer.change_phone' and entity_id = $1`, [c.id])).rows[0];
      expect(a).toMatchObject({ reason: 'غير رقمه', before_values: { phone: '+9647706660001' }, after_values: { phone: '+9647706660002' } });
      expect((await post(cash, '/customers', { full_name: 'ورث الرقم القديم', phone: '07706660001' })).status).toBe(201);
      expect(other.id).toBeGreaterThan(0);
    });
    it('تغيير الرقم لنفس الرقم ما يسوي شي، وغير الموجود 404', async () => {
      const same = await put(owner, `/customers/${c.id}/phone`, { phone: '07706660002', reason: 'نفسه' });
      expect(same.status).toBe(200);
      expect((await put(owner, '/customers/99999999/phone', { phone: '07706660088', reason: 'سبب' })).status).toBe(404);
      expect((await patch(cash, '/customers/99999999', { full_name: 'اسم جديد' })).status).toBe(404);
    });
    it('الملف المدموج ما ينعدل', async () => {
      const m = (await post(cash, '/customers', { full_name: 'مدموج للتعديل', phone: '07706660004' })).body;
      await db.query(`update customers set status = 'merged', merged_into_id = $2 where id = $1`, [m.id, c.id]);
      expect((await patch(cash, `/customers/${m.id}`, { full_name: 'تغيير' })).status).toBe(409);
      expect((await put(owner, `/customers/${m.id}/phone`, { phone: '07706660005', reason: 'سبب' })).status).toBe(409);
    });
  });
});
