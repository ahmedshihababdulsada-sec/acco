import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { PASSWORD, auth, branchId, login, makeApp, pool, seedUser, tokenFor } from './helpers';

describe('إدارة الحسابات والصلاحيات', () => {
  let app: INestApplication; let db: Pool; let b1: number; let b2: number;
  let owner: string; let mgr1: string; let mgr2: string; let cash: string; let doc: string; let nurse: string;
  const http = () => request(app.getHttpServer());
  const create = (token: string, body: object) => http().post('/staff').set(auth(token)).send(body);

  beforeAll(async () => {
    app = await makeApp(); db = pool(); b1 = await branchId(db, 'B1'); b2 = await branchId(db, 'B2');
    [owner, mgr1, mgr2, cash, doc, nurse] = await Promise.all(['owner', 'mgr1', 'mgr2', 'cash1', 'doc1', 'nurse1'].map((u) => tokenFor(app, u)));
  });
  afterAll(async () => { await app.close(); await db.end(); });

  describe('من يقدر يدخل صفحة الحسابات', () => {
    it('الكاشير والطبيب والممرض → 403', async () => {
      for (const t of [cash, doc, nurse]) {
        expect((await http().get('/staff').set(auth(t))).status).toBe(403);
        expect((await create(t, { username: 'zz1', full_name: 'اسم', role: 'cashier' })).status).toBe(403);
      }
    });
    it('المالك والمدير → 200', async () => {
      expect((await http().get('/staff').set(auth(owner))).status).toBe(200);
      expect((await http().get('/staff').set(auth(mgr1))).status).toBe(200);
    });
    it('المدير يشوف فرعه بس، والمالك يشوف كل الفروع، ولا أحد يشوف حساب المالك', async () => {
      const m = (await http().get('/staff').set(auth(mgr1))).body;
      expect(m.every((u: any) => u.branch_id === b1 && u.role !== 'owner')).toBe(true);
      expect(m.map((u: any) => u.username)).not.toContain('mgr2');
      const o = (await http().get('/staff').set(auth(owner))).body;
      const seen = new Set(o.map((u: any) => u.branch_id));    // فروع ثانية قد تنضاف من اختبارات وحدات ثانية بنفس القاعدة
      expect(seen.has(b1) && seen.has(b2)).toBe(true);
      expect(o.map((u: any) => u.role)).not.toContain('owner');
      expect(JSON.stringify(o)).not.toMatch(/password_hash|argon2|"password"/);
    });
  });

  describe('إنشاء حساب', () => {
    it('المدير ينشئ كاشير بفرعه: رمز مؤقت يظهر مرة وحدة ويلزم تغييره', async () => {
      const r = await create(mgr1, { username: 'newcash', full_name: 'كاشير جديد', role: 'cashier' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ username: 'newcash', role: 'cashier', branch_id: b1 });
      expect(r.body.temp_password).toHaveLength(12);
      const l = await login(app, 'newcash', r.body.temp_password);
      expect(l.status).toBe(200);
      expect(l.body.user.must_change_password).toBe(true);
      expect((await http().get('/staff').set(auth(l.body.access_token))).status).toBe(403);
      const row = (await db.query(`select created_by, must_change_password from users where username='newcash'`)).rows[0];
      expect(row.must_change_password).toBe(true);
      const list = (await http().get('/staff').set(auth(mgr1))).body.find((u: any) => u.username === 'newcash');
      expect(list).toBeDefined();
    });

    it('المدير ينشئ طبيب فينضاف بجدول الأطباء', async () => {
      const r = await create(mgr1, { username: 'newdoc', full_name: 'دكتور جديد', role: 'doctor', title: 'جلدية', room: '2' });
      expect(r.status).toBe(201);
      expect((await db.query(`select title, room from doctors where user_id=$1`, [r.body.id])).rows[0]).toEqual({ title: 'جلدية', room: '2' });
    });

    it('المدير ينشئ ممرض', async () => {
      expect((await create(mgr1, { username: 'newnurse', full_name: 'ممرض جديد', role: 'nurse' })).status).toBe(201);
    });

    it('المدير ما ينشئ مدير', async () => {
      const r = await create(mgr1, { username: 'newmgr', full_name: 'مدير', role: 'manager' });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('FORBIDDEN');
    });

    it('المدير ما ينشئ بفرع ثاني، وإذا ما حدد فرع ينضاف لفرعه', async () => {
      expect((await create(mgr1, { username: 'otherbranch', full_name: 'اسم', role: 'cashier', branch_id: b2 })).status).toBe(403);
      const r = await create(mgr1, { username: 'ownbranch', full_name: 'اسم', role: 'cashier', branch_id: b1 });
      expect(r.status).toBe(201);
    });

    it('المالك ينشئ مدير ويحدد الفرع (إلزامي)', async () => {
      expect((await create(owner, { username: 'mgrnobranch', full_name: 'اسم', role: 'manager' })).body.code).toBe('BRANCH_REQUIRED');
      const r = await create(owner, { username: 'newmgr2', full_name: 'مدير جديد', role: 'manager', branch_id: b2 });
      expect(r.status).toBe(201);
      expect(r.body.branch_id).toBe(b2);
      expect((await create(owner, { username: 'badbranch', full_name: 'اسم', role: 'cashier', branch_id: 999999 })).body.code).toBe('BRANCH_NOT_FOUND');
    });

    it('ما أحد ينشئ مالك من الـ API', async () => {
      const r = await create(owner, { username: 'owner2', full_name: 'مالك', role: 'owner', branch_id: b1 });
      expect(r.status).toBe(400);
    });

    it('اسم المستخدم المكرر → 409 حتى باختلاف الحروف', async () => {
      const r = await create(mgr1, { username: 'NEWCASH', full_name: 'اسم', role: 'cashier' });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('USERNAME_TAKEN');
    });

    it('بيانات غلط → 400', async () => {
      expect((await create(mgr1, { username: 'a b', full_name: 'اسم', role: 'cashier' })).status).toBe(400);
      expect((await create(mgr1, { username: 'ab', full_name: 'اسم', role: 'cashier' })).status).toBe(400);
      expect((await create(mgr1, { username: 'okname', full_name: 'اسم', role: 'janitor' })).status).toBe(400);
      expect((await create(mgr1, { username: 'okname', full_name: 'اسم', role: 'cashier', is_active: false })).status).toBe(400);
    });

    it('كل إنشاء ينسجل بسجل الحركات بدون الرمز', async () => {
      const rows = (await db.query(`select actor_role, after_values from audit_log where action='staff.create' and after_values->>'username'='newcash'`)).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_role).toBe('manager');
      expect(JSON.stringify(rows[0])).not.toMatch(/password/i);
    });
  });

  describe('تعطيل وتفعيل', () => {
    it('المدير يعطل كاشير: ما يدخل، وتوكناته تنسحب، وينسجل السبب', async () => {
      const id = await seedUser(db, 'tofire', 'cashier', b1);
      const l = (await login(app, 'tofire')).body;
      const r = await http().post(`/staff/${id}/deactivate`).set(auth(mgr1)).send({ reason: 'ترك العمل' });
      expect(r.status).toBe(204);
      expect((await login(app, 'tofire')).status).toBe(401);
      expect((await http().post('/auth/refresh').send({ refresh_token: l.refresh_token })).status).toBe(401);
      expect((await http().get('/auth/me').set(auth(l.access_token))).status).toBe(401);
      const a = (await db.query(`select reason, actor_role from audit_log where action='staff.deactivate' and entity_id=$1`, [id])).rows[0];
      expect(a).toEqual({ reason: 'ترك العمل', actor_role: 'manager' });
      const u = (await db.query(`select is_active, deactivated_at is not null as stamped from users where id=$1`, [id])).rows[0];
      expect(u).toEqual({ is_active: false, stamped: true });
    });

    it('المدير يرجّع تفعيله وينفتح الدخول', async () => {
      const id = await seedUser(db, 'torehire', 'cashier', b1, { active: false });
      expect((await http().post(`/staff/${id}/reactivate`).set(auth(mgr1)).send({})).status).toBe(204);
      expect((await login(app, 'torehire')).status).toBe(200);
    });

    it('المدير ما يعطل مدير ثاني، المالك يعطل', async () => {
      const id = await seedUser(db, 'mgr-victim', 'manager', b1);
      const r = await http().post(`/staff/${id}/deactivate`).set(auth(mgr1)).send({});
      expect(r.status).toBe(403);
      expect((await http().post(`/staff/${id}/deactivate`).set(auth(owner)).send({})).status).toBe(204);
    });

    it('المدير ما يعطل حسابه ولا حساب المالك، ولا أحد يعطل المالك', async () => {
      const me = Number((await db.query(`select id from users where username='mgr1'`)).rows[0].id);
      const ownerId = Number((await db.query(`select id from users where username='owner'`)).rows[0].id);
      expect((await http().post(`/staff/${me}/deactivate`).set(auth(mgr1)).send({})).body.code).toBe('CANNOT_DEACTIVATE_SELF');
      expect((await http().post(`/staff/${ownerId}/deactivate`).set(auth(mgr1)).send({})).status).toBe(404); // خارج نطاقه
      expect((await http().post(`/staff/${ownerId}/deactivate`).set(auth(owner)).send({})).status).toBe(400); // نفسه
    });

    it('المدير ما يشوف ولا يعطل حسابات فرع ثاني (404 مو 403)', async () => {
      const id = await seedUser(db, 'b2cashier', 'cashier', b2);
      expect((await http().post(`/staff/${id}/deactivate`).set(auth(mgr1)).send({})).status).toBe(404);
      expect((await http().post(`/staff/${id}/reset-password`).set(auth(mgr1))).status).toBe(404);
      expect((await db.query(`select is_active from users where id=$1`, [id])).rows[0].is_active).toBe(true);
    });

    it('تعطيل موظف غير موجود → 404، ورقم غير صحيح → 400', async () => {
      expect((await http().post('/staff/999999/deactivate').set(auth(owner)).send({})).status).toBe(404);
      expect((await http().post('/staff/abc/deactivate').set(auth(owner)).send({})).status).toBe(400);
    });
  });

  describe('إعادة تعيين الرمز', () => {
    it('المدير يعيد رمز كاشير: رمز مؤقت جديد، القديم ما يشتغل، ولازم يغيره، والقفل ينفتح', async () => {
      const id = await seedUser(db, 'forgot1', 'cashier', b1);
      await db.query(`update users set failed_logins = 5, locked_until = now() + interval '10 minutes' where id=$1`, [id]);
      const old = (await login(app, 'forgot1')).status;
      expect(old).toBe(401);                                      // مقفل
      const r = await http().post(`/staff/${id}/reset-password`).set(auth(mgr1));
      expect(r.status).toBe(200);
      expect(r.body.temp_password).toHaveLength(12);
      expect((await login(app, 'forgot1', PASSWORD)).status).toBe(401);
      const l = await login(app, 'forgot1', r.body.temp_password);
      expect(l.status).toBe(200);
      expect(l.body.user.must_change_password).toBe(true);
      expect(JSON.stringify((await db.query(`select after_values, before_values, reason from audit_log where action='staff.reset_password' and entity_id=$1`, [id])).rows)).not.toContain(r.body.temp_password);
    });

    it('المدير ما يعيد رمز مدير، والمالك يعيد رمز المدير', async () => {
      const id = await seedUser(db, 'forgot-mgr', 'manager', b1);
      expect((await http().post(`/staff/${id}/reset-password`).set(auth(mgr1))).status).toBe(403);
      expect((await http().post(`/staff/${id}/reset-password`).set(auth(owner))).status).toBe(200);
    });

    it('ما أحد يعيد رمز نفسه من هنا', async () => {
      const me = Number((await db.query(`select id from users where username='mgr1'`)).rows[0].id);
      expect((await http().post(`/staff/${me}/reset-password`).set(auth(mgr1))).body.code).toBe('USE_CHANGE_PASSWORD');
    });

    it('الكاشير ما يقدر', async () => {
      const id = await seedUser(db, 'victim2', 'cashier', b1);
      expect((await http().post(`/staff/${id}/reset-password`).set(auth(cash))).status).toBe(403);
    });
  });
});
