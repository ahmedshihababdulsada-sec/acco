import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import request from 'supertest';
import { base32Decode, stepAt, totpAt } from '../src/auth/totp';
import { clock } from '../src/common/clock';
import { resetTotp } from '../src/cli/reset-totp';
import { auth, branchId, login, makeApp, ownerLogin, pool, seedUser } from './helpers';

describe('التحقق الثنائي للمالك (TOTP)', () => {
  let app: INestApplication; let db: Pool; let b1: number;
  const http = () => request(app.getHttpServer());
  let t = 0;                                              // الساعة المزيفة تتقدم 30 ثانية لكل رمز
  const setNow = (steps = 1) => { t = Math.max(t, stepAt(Date.now())) + steps; clock.now = () => t * 30_000 + 1_000; };
  const codeNow = (secret: string) => totpAt(secret, clock.now());

  beforeAll(async () => { app = await makeApp(); db = pool(); b1 = await branchId(db, 'B1'); });
  afterAll(async () => { clock.now = () => Date.now(); await app.close(); await db.end(); });

  /** مالك جديد غير مفعل: دخول ← إعداد ← تفعيل. يرجع المفتاح ورموز الاسترجاع وتوكنات التفعيل. */
  async function enrolled(username: string) {
    await seedUser(db, username, 'owner', null);
    const l = await login(app, username);
    const setup = await http().post('/auth/totp/setup').send({ challenge_token: l.body.challenge_token });
    setNow();
    const enable = await http().post('/auth/totp/enable').send({ challenge_token: l.body.challenge_token, code: codeNow(setup.body.secret) });
    return { secret: setup.body.secret as string, enable, setup };
  }

  it('المالك: دخول بالرمز السري وحده ما يعطي توكنات، يعطي تحدي (setup أول مرة)', async () => {
    await seedUser(db, 'own1', 'owner', null);
    const l = await login(app, 'own1');
    expect(l.status).toBe(200);
    expect(l.body.status).toBe('totp_required');
    expect(l.body.mode).toBe('setup');
    expect(l.body.access_token).toBeUndefined();
    expect(l.body.refresh_token).toBeUndefined();
  });

  it('توكن التحدي ما يشتغل كتوكن وصول', async () => {
    const l = await login(app, 'own1');
    expect((await http().get('/auth/me').set(auth(l.body.challenge_token))).status).toBe(401);
    expect((await http().get('/staff').set(auth(l.body.challenge_token))).status).toBe(401);
  });

  it('غير المالك ما يتأثر: دخول مباشر بتوكنات', async () => {
    const r = await login(app, 'mgr1');
    expect(r.body.status).toBe('authenticated');
    expect(r.body.access_token).toBeDefined();
  });

  it('الإعداد: يرجع مفتاح ورابط otpauth، والمفتاح مشفر بالقاعدة (مو نص صريح)', async () => {
    await seedUser(db, 'own2', 'owner', null);
    const l = await login(app, 'own2');
    const s = await http().post('/auth/totp/setup').send({ challenge_token: l.body.challenge_token });
    expect(s.status).toBe(200);
    expect(s.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(s.body.otpauth_uri).toContain(`secret=${s.body.secret}`);
    expect(s.body.otpauth_uri).toContain('issuer=TestClinic');
    expect(s.body.otpauth_uri).toContain('own2');
    const row = (await db.query(`select totp_secret_enc, totp_enabled_at from users where username='own2'`)).rows[0];
    expect(row.totp_enabled_at).toBeNull();                      // معلق لحد التفعيل
    expect(row.totp_secret_enc.startsWith('v1.')).toBe(true);
    expect(row.totp_secret_enc).not.toContain(s.body.secret);
  });

  it('المفتاح المعلق ما يفتح الدخول قبل التفعيل (verify يرفض)', async () => {
    const l = await login(app, 'own2');
    expect(l.body.mode).toBe('setup');
    const secret = (await http().post('/auth/totp/setup').send({ challenge_token: l.body.challenge_token })).body.secret;
    setNow();
    const r = await http().post('/auth/totp/verify').send({ challenge_token: l.body.challenge_token, code: codeNow(secret) });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('TOTP_NOT_ENABLED');
  });

  it('التفعيل برمز غلط → 401 TOTP_INVALID، وبرمز صحيح يرجع توكنات و8 رموز استرجاع تظهر مرة وحدة', async () => {
    await seedUser(db, 'own3', 'owner', null);
    const l = await login(app, 'own3');
    const s = await http().post('/auth/totp/setup').send({ challenge_token: l.body.challenge_token });
    const bad = await http().post('/auth/totp/enable').send({ challenge_token: l.body.challenge_token, code: '000000' });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('TOTP_INVALID');
    setNow();
    const ok = await http().post('/auth/totp/enable').send({ challenge_token: l.body.challenge_token, code: codeNow(s.body.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('authenticated');
    expect(ok.body.user).toMatchObject({ username: 'own3', role: 'owner' });
    expect(ok.body.recovery_codes).toHaveLength(8);
    expect(new Set(ok.body.recovery_codes).size).toBe(8);
    expect(ok.body.recovery_codes[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect((await http().get('/auth/me').set(auth(ok.body.access_token))).status).toBe(200);
    // رموز الاسترجاع محفوظة كبصمة بس
    const stored = (await db.query(`select code_hash from totp_recovery_codes where user_id=(select id from users where username='own3')`)).rows;
    expect(stored).toHaveLength(8);
    for (const c of ok.body.recovery_codes) expect(JSON.stringify(stored)).not.toContain(c.replace('-', ''));
    // الإعداد مرة ثانية بعد التفعيل مرفوض
    const again = await http().post('/auth/totp/setup').send({ challenge_token: l.body.challenge_token });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('TOTP_ALREADY_ENABLED');
  });

  it('الدخول بعد التفعيل: mode=verify، والرمز الصحيح يدخل، والغلط يرفض', async () => {
    const { secret } = await enrolled('own4');
    const l = await login(app, 'own4');
    expect(l.body.mode).toBe('verify');
    const wrong = await http().post('/auth/totp/verify').send({ challenge_token: l.body.challenge_token, code: '123456' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('TOTP_INVALID');
    setNow();
    const ok = await http().post('/auth/totp/verify').send({ challenge_token: l.body.challenge_token, code: codeNow(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.access_token).toBeDefined();
    expect(ok.body.recovery_codes_left).toBe(8);
    expect((await http().get('/staff').set(auth(ok.body.access_token))).status).toBe(200);
  });

  it('نفس الرمز ما ينقبل مرتين (منع إعادة الاستخدام)، حتى بدخول جديد', async () => {
    const { secret } = await enrolled('own5');
    setNow();
    const code = codeNow(secret);
    const l1 = await login(app, 'own5');
    expect((await http().post('/auth/totp/verify').send({ challenge_token: l1.body.challenge_token, code })).status).toBe(200);
    const l2 = await login(app, 'own5');
    const replay = await http().post('/auth/totp/verify').send({ challenge_token: l2.body.challenge_token, code });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('TOTP_INVALID');
  });

  it('الخطوة المقبولة مرة ما تنقبل ثانية حتى لو ضمن النافذة، والخطوة الأحدث تنقبل', async () => {
    const { secret } = await enrolled('own6');
    setNow(3);
    const l = await login(app, 'own6');
    const prev = totpAt(secret, clock.now() - 30_000);       // الخطوة السابقة: ضمن النافذة وأحدث من آخر خطوة مقبولة (قبل 3 خطوات)
    const r = await http().post('/auth/totp/verify').send({ challenge_token: l.body.challenge_token, code: prev });
    expect(r.status).toBe(200);                              // أحدث من آخر خطوة مقبولة فينقبل
    const l2 = await login(app, 'own6');
    const older = totpAt(secret, clock.now() - 30_000);      // نفس الخطوة المستخدمة للتو → مرفوض
    expect((await http().post('/auth/totp/verify').send({ challenge_token: l2.body.challenge_token, code: older })).status).toBe(401);
  });

  it('رمزين متزامنين بنفس الكود: واحد بس ينجح', async () => {
    const { secret } = await enrolled('own7');
    setNow();
    const code = codeNow(secret);
    const challenges = await Promise.all([login(app, 'own7'), login(app, 'own7'), login(app, 'own7'), login(app, 'own7')]);
    const results = await Promise.all(challenges.map((c) => http().post('/auth/totp/verify').send({ challenge_token: c.body.challenge_token, code })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('5 رموز غلط تقفل الحساب، وحتى الرمز الصحيح بعدها يُرفض', async () => {
    const { secret } = await enrolled('own8');
    const l = await login(app, 'own8');
    for (let i = 0; i < 5; i++) {
      const r = await http().post('/auth/totp/verify').send({ challenge_token: l.body.challenge_token, code: '111111' });
      expect([401]).toContain(r.status);
    }
    expect((await db.query(`select locked_until > now() as locked from users where username='own8'`)).rows[0].locked).toBe(true);
    setNow();
    const r = await http().post('/auth/totp/verify').send({ challenge_token: l.body.challenge_token, code: codeNow(secret) });
    expect(r.status).toBe(401);
    expect((await login(app, 'own8')).status).toBe(401);       // كلمة السر الصحيحة هم ما تدخل وهو مقفل
    const actions = (await db.query(`select action from audit_log where entity_id=(select id from users where username='own8')`)).rows.map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.totp_failed', 'auth.account_locked']));
  });

  it('رمز الاسترجاع: ينفع مرة وحدة، ويتناقص العدد', async () => {
    const { enable } = await enrolled('own9');
    const [first, second] = enable.body.recovery_codes as string[];
    const l = await login(app, 'own9');
    const r = await http().post('/auth/totp/verify').send({ challenge_token: l.body.challenge_token, recovery_code: first.toLowerCase() });
    expect(r.status).toBe(200);
    expect(r.body.recovery_codes_left).toBe(7);
    const l2 = await login(app, 'own9');
    const reuse = await http().post('/auth/totp/verify').send({ challenge_token: l2.body.challenge_token, recovery_code: first });
    expect(reuse.status).toBe(401);
    const ok2 = await http().post('/auth/totp/verify').send({ challenge_token: l2.body.challenge_token, recovery_code: second.replace('-', '') });
    expect(ok2.status).toBe(200);
    expect(ok2.body.recovery_codes_left).toBe(6);
    expect((await db.query(`select action from audit_log where action='auth.login_recovery_code' and entity_id=(select id from users where username='own9')`)).rowCount).toBe(2);
  });

  it('verify: لازم رمز أو رمز استرجاع (واحد بس)', async () => {
    const { secret } = await enrolled('own10');
    const l = await login(app, 'own10');
    expect((await http().post('/auth/totp/verify').send({ challenge_token: l.body.challenge_token })).status).toBe(400);
    expect((await http().post('/auth/totp/verify').send({ challenge_token: l.body.challenge_token, code: codeNow(secret), recovery_code: 'AAAAA-BBBBB' })).status).toBe(400);
  });

  it('تحدي منتهي أو مزور أو من توكن وصول → 401', async () => {
    const jwt = app.get(JwtService);
    const expired = await jwt.signAsync({ purpose: 'totp_challenge', sub: 1 }, { expiresIn: -10 });
    expect((await http().post('/auth/totp/verify').send({ challenge_token: expired, code: '123456' })).status).toBe(401);
    expect((await http().post('/auth/totp/verify').send({ challenge_token: 'x'.repeat(40), code: '123456' })).status).toBe(401);
    const access = (await login(app, 'mgr1')).body.access_token;     // توكن وصول عادي ما يصلح تحدي
    expect((await http().post('/auth/totp/verify').send({ challenge_token: access, code: '123456' })).status).toBe(401);
    expect((await http().post('/auth/totp/setup').send({ challenge_token: access })).status).toBe(401);
  });

  it('تحدي مدير (مو مالك) ما يشتغل بمسارات TOTP', async () => {
    const jwt = app.get(JwtService);
    const id = Number((await db.query(`select id from users where username='mgr1'`)).rows[0].id);
    const forged = await jwt.signAsync({ purpose: 'totp_challenge', sub: id }, { expiresIn: 300 });
    expect((await http().post('/auth/totp/setup').send({ challenge_token: forged })).status).toBe(401);
  });

  it('حساب المالك الأساسي (مفعل مسبقاً) يدخل بالرمز: توكنات تشتغل، وبدون رمز ما أكو توكنات', async () => {
    const db2 = pool();
    try {
      const ok = await ownerLogin(app, db2);
      expect(ok.status).toBe(200);
      expect((await http().get('/auth/me').set(auth(ok.body.access_token))).body.role).toBe('owner');
    } finally { await db2.end(); }
  });

  it('أول دخول للمالك: بعد TOTP يلزمه تغيير الرمز السري', async () => {
    await seedUser(db, 'own11', 'owner', null, { mustChange: true });
    const l = await login(app, 'own11');
    const s = await http().post('/auth/totp/setup').send({ challenge_token: l.body.challenge_token });
    setNow();
    const e = await http().post('/auth/totp/enable').send({ challenge_token: l.body.challenge_token, code: codeNow(s.body.secret) });
    expect(e.body.user.must_change_password).toBe(true);
    const blocked = await http().get('/staff').set(auth(e.body.access_token));
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('إعادة التعيين من السيرفر: يمسح المفتاح ورموز الاسترجاع ويسحب الجلسات، وبعدها setup من جديد', async () => {
    const { secret, enable } = await enrolled('own12');
    expect((await resetTotp(db, 'nobody')).valueOf()).toBe(false);
    expect((await db.query(`select count(*)::int as n from totp_recovery_codes where user_id=(select id from users where username='own12')`)).rows[0].n).toBe(8);
    expect(await resetTotp(db, 'own12')).toBe(true);
    const row = (await db.query(`select totp_secret_enc, totp_enabled_at, totp_last_step from users where username='own12'`)).rows[0];
    expect(row).toEqual({ totp_secret_enc: null, totp_enabled_at: null, totp_last_step: null });
    expect((await db.query(`select count(*)::int as n from totp_recovery_codes where user_id=(select id from users where username='own12')`)).rows[0].n).toBe(0);
    expect((await http().post('/auth/refresh').send({ refresh_token: enable.body.refresh_token })).status).toBe(401);
    expect((await login(app, 'own12')).body.mode).toBe('setup');
    expect(base32Decode(secret).length).toBe(20);
    expect((await db.query(`select 1 from audit_log where action='auth.totp_reset' and entity_id=(select id from users where username='own12')`)).rowCount).toBe(1);
  });

  it('مدير لا يقدر يستخدم reset (الدالة تخص المالك بس)', async () => {
    expect(await resetTotp(db, 'mgr1')).toBe(false);
  });
});
