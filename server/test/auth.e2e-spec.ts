import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { PASSWORD, auth, branchId, login, makeApp, pool, seedUser, tokenFor } from './helpers';

describe('الدخول والتوكنات', () => {
  let app: INestApplication; let db: Pool; let b1: number;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => { app = await makeApp(); db = pool(); b1 = await branchId(db, 'B1'); });
  afterAll(async () => { await app.close(); await db.end(); });

  it('health مفتوح ويفحص القاعدة', async () => {
    const r = await http().get('/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ok' });
  });

  it('مسار محمي بدون توكن → 401', async () => {
    expect((await http().get('/auth/me')).status).toBe(401);
    expect((await http().get('/staff')).status).toBe(401);
  });

  it('توكن مزور أو منتهي → 401', async () => {
    expect((await http().get('/auth/me').set(auth('not.a.jwt'))).status).toBe(401);
  });

  it('دخول صحيح يرجع توكنين وبيانات المستخدم بدون كلمة السر', async () => {
    const r = await login(app, 'cash1');
    expect(r.status).toBe(200);
    expect(r.body.token_type).toBe('Bearer');
    expect(r.body.expires_in).toBe(900);
    expect(r.body.user).toMatchObject({ username: 'cash1', role: 'cashier', must_change_password: false });
    expect(JSON.stringify(r.body)).not.toMatch(/password_hash|\$argon2/);
    const me = await http().get('/auth/me').set(auth(r.body.access_token));
    expect(me.status).toBe(200);
    expect(me.body.username).toBe('cash1');
  });

  it('اسم المستخدم ما يتأثر بحالة الأحرف', async () => {
    expect((await login(app, 'CASH1')).status).toBe(200);
  });

  it('رمز غلط واسم غير موجود يرجعان نفس الرد بالضبط', async () => {
    const wrong = await login(app, 'cash1', 'wrong-password');
    const unknown = await login(app, 'nobody-here', 'wrong-password');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('بيانات ناقصة أو حقول زيادة → 400 VALIDATION', async () => {
    expect((await http().post('/auth/login').send({ username: 'x' })).status).toBe(400);
    const extra = await http().post('/auth/login').send({ username: 'x', password: 'y', admin: true });
    expect(extra.status).toBe(400);
    expect(extra.body.code).toBe('VALIDATION');
  });

  it('5 محاولات فاشلة تقفل الحساب، وحتى الرمز الصحيح يُرفض، وبعد انتهاء القفل يدخل ويتصفر العداد', async () => {
    await seedUser(db, 'locktest', 'cashier', b1);
    for (let i = 0; i < 5; i++) expect((await login(app, 'locktest', 'bad')).status).toBe(401);
    const row = (await db.query(`select failed_logins, locked_until > now() as locked from users where username='locktest'`)).rows[0];
    expect(row.failed_logins).toBe(5);
    expect(row.locked).toBe(true);
    const correct = await login(app, 'locktest');
    expect(correct.status).toBe(401);                      // مقفل
    expect(correct.body.code).toBe('INVALID_CREDENTIALS'); // نفس الرد العام
    await db.query(`update users set locked_until = now() - interval '1 minute' where username='locktest'`);
    expect((await login(app, 'locktest')).status).toBe(200);
    expect((await db.query(`select failed_logins, locked_until from users where username='locktest'`)).rows[0]).toEqual({ failed_logins: 0, locked_until: null });
    const actions = (await db.query(`select action from audit_log where entity_type='user' and entity_id=(select id from users where username='locktest')`)).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.login_failed', 'auth.account_locked', 'auth.login_rejected', 'auth.login']));
  });

  it('محاولات فاشلة متزامنة ما تضيع من العداد', async () => {
    await seedUser(db, 'conc1', 'cashier', b1);
    await Promise.all(Array.from({ length: 4 }, () => login(app, 'conc1', 'bad')));
    expect((await db.query(`select failed_logins from users where username='conc1'`)).rows[0].failed_logins).toBe(4);
  });

  it('حساب معطل ما يدخل', async () => {
    await seedUser(db, 'inactive1', 'cashier', b1, { active: false });
    expect((await login(app, 'inactive1')).status).toBe(401);
  });

  it('تجديد التوكن يدور: القديم يتحرق، وإعادة استخدامه تسحب كل التوكنات', async () => {
    await seedUser(db, 'refresh1', 'nurse', b1);
    const first = (await login(app, 'refresh1')).body;
    const second = await http().post('/auth/refresh').send({ refresh_token: first.refresh_token });
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.refresh_token);
    expect((await http().get('/auth/me').set(auth(second.body.access_token))).status).toBe(200);
    // إعادة استخدام القديم = سرقة محتملة
    const reuse = await http().post('/auth/refresh').send({ refresh_token: first.refresh_token });
    expect(reuse.status).toBe(401);
    // والجديد انسحب هو هم
    expect((await http().post('/auth/refresh').send({ refresh_token: second.body.refresh_token })).status).toBe(401);
    const actions = (await db.query(`select action from audit_log where action='auth.refresh_reuse_detected' and entity_id=(select id from users where username='refresh1')`)).rows;
    expect(actions.length).toBeGreaterThanOrEqual(1);   // كل عرض لتوكن محروق ينسجل
  });

  it('تجديد بتوكن غير معروف → 401', async () => {
    expect((await http().post('/auth/refresh').send({ refresh_token: 'x'.repeat(43) })).status).toBe(401);
  });

  it('تجديد توكن منتهي → 401', async () => {
    await seedUser(db, 'refresh2', 'nurse', b1);
    const t = (await login(app, 'refresh2')).body;
    await db.query(`update refresh_tokens set expires_at = now() - interval '1 second' where user_id = (select id from users where username='refresh2')`);
    expect((await http().post('/auth/refresh').send({ refresh_token: t.refresh_token })).status).toBe(401);
  });

  it('تجديد موظف عُطّل → 401', async () => {
    const id = await seedUser(db, 'refresh3', 'nurse', b1);
    const t = (await login(app, 'refresh3')).body;
    await db.query(`update users set is_active=false, deactivated_at=now() where id=$1`, [id]);
    expect((await http().post('/auth/refresh').send({ refresh_token: t.refresh_token })).status).toBe(401);
  });

  it('الخروج يحرق التوكن المحدد', async () => {
    await seedUser(db, 'logout1', 'nurse', b1);
    const t = (await login(app, 'logout1')).body;
    expect((await http().post('/auth/logout').set(auth(t.access_token)).send({ refresh_token: t.refresh_token })).status).toBe(204);
    expect((await http().post('/auth/refresh').send({ refresh_token: t.refresh_token })).status).toBe(401);
  });

  it('تعطيل الحساب يوقف التوكن الحالي فوراً (مو بعد انتهائه)', async () => {
    const id = await seedUser(db, 'live1', 'cashier', b1);
    const token = await tokenFor(app, 'live1');
    expect((await http().get('/auth/me').set(auth(token))).status).toBe(200);
    await db.query(`update users set is_active=false, deactivated_at=now() where id=$1`, [id]);
    expect((await http().get('/auth/me').set(auth(token))).status).toBe(401);
  });

  it('تغيير الدور بالقاعدة يسري فوراً على التوكن الحالي', async () => {
    const id = await seedUser(db, 'role1', 'manager', b1);
    const token = await tokenFor(app, 'role1');
    expect((await http().get('/staff').set(auth(token))).status).toBe(200);
    await db.query(`update users set role='nurse', branch_id=$2 where id=$1`, [id, b1]);
    expect((await http().get('/staff').set(auth(token))).status).toBe(403);
  });

  describe('أول دخول: لازم يغيّر الرمز', () => {
    it('كل شي ممنوع غير تغيير الرمز والخروج ومن أنا، وبعد التغيير ينفتح', async () => {
      await seedUser(db, 'first1', 'manager', b1, { mustChange: true });
      const l = await login(app, 'first1');
      expect(l.status).toBe(200);
      expect(l.body.user.must_change_password).toBe(true);
      const t = l.body.access_token;
      const blocked = await http().get('/staff').set(auth(t));
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
      expect((await http().get('/auth/me').set(auth(t))).status).toBe(200);

      const weak = await http().post('/auth/change-password').set(auth(t)).send({ current_password: PASSWORD, new_password: 'short' });
      expect(weak.status).toBe(400);
      expect(weak.body.code).toBe('WEAK_PASSWORD');
      const wrongCurrent = await http().post('/auth/change-password').set(auth(t)).send({ current_password: 'nope', new_password: 'NewPass#2026' });
      expect(wrongCurrent.body.code).toBe('WRONG_CURRENT_PASSWORD');
      const same = await http().post('/auth/change-password').set(auth(t)).send({ current_password: PASSWORD, new_password: PASSWORD });
      expect(same.body.code).toBe('SAME_PASSWORD');
      const asUsername = await http().post('/auth/change-password').set(auth(t)).send({ current_password: PASSWORD, new_password: 'FIRST1' });
      expect(asUsername.status).toBe(400);

      expect((await http().post('/auth/change-password').set(auth(t)).send({ current_password: PASSWORD, new_password: 'NewPass#2026' })).status).toBe(204);
      expect((await http().get('/staff').set(auth(t))).status).toBe(200);
      expect((await login(app, 'first1', PASSWORD)).status).toBe(401);
      expect((await login(app, 'first1', 'NewPass#2026')).status).toBe(200);
      // التوكن القديم للتجديد انسحب
      expect((await http().post('/auth/refresh').send({ refresh_token: l.body.refresh_token })).status).toBe(401);
    });
  });
});
