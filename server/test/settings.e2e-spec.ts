import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { SETTINGS } from '../src/settings/settings.registry';
import { SettingsService } from '../src/settings/settings.service';
import { auth, branchId, makeApp, pool, tokenFor } from './helpers';

describe('الإعدادات', () => {
  let app: INestApplication; let db: Pool; let b1: number; let b2: number;
  let owner: string; let mgr1: string; let mgr2: string; let cash: string;
  const http = () => request(app.getHttpServer());
  const put = (t: string, key: string, body: object) => http().put(`/settings/${key}`).set(auth(t)).send(body);

  beforeAll(async () => {
    app = await makeApp(); db = pool(); b1 = await branchId(db, 'B1'); b2 = await branchId(db, 'B2');
    [owner, mgr1, mgr2, cash] = await Promise.all(['owner', 'mgr1', 'mgr2', 'cash1'].map((u) => tokenFor(app, u)));
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it('القراءة للمالك والمدير بس', async () => {
    expect((await http().get('/settings').set(auth(cash))).status).toBe(403);
    expect((await http().get('/settings').set(auth(mgr1))).status).toBe(200);
  });

  it('القائمة: كل المفاتيح بقيمها الافتراضية، وcan_edit حسب الدور', async () => {
    const m = (await http().get('/settings').set(auth(mgr1))).body;
    expect(m.branch_id).toBe(b1);
    expect(m.settings).toHaveLength(SETTINGS.length);
    const by = (k: string) => m.settings.find((s: any) => s.key === k);
    expect(by('booking.daily_limit')).toMatchObject({ value: 30, is_default: true, version: 0, can_edit: true });
    expect(by('points.max_percent')).toMatchObject({ value: 50, can_edit: false });
    expect(by('booking.free_followup_days')).toMatchObject({ value: 7, can_edit: false });
    expect(by('money.rounding_step').value).toBe(250);
    const o = (await http().get(`/settings?branch_id=${b1}`).set(auth(owner))).body;
    expect(o.settings.find((s: any) => s.key === 'points.max_percent').can_edit).toBe(true);
  });

  it('المدير يغيّر الحد اليومي: نسخة 1، ثم تاريخ، وينسجل بسجل الحركات', async () => {
    const r = await put(mgr1, 'booking.daily_limit', { value: 40, expected_version: 0, reason: 'زيادة الدوام' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ key: 'booking.daily_limit', value: 40, version: 1 });
    const m = (await http().get('/settings').set(auth(mgr1))).body.settings.find((s: any) => s.key === 'booking.daily_limit');
    expect(m).toMatchObject({ value: 40, is_default: false, version: 1 });
    const h = (await http().get('/settings/booking.daily_limit/history').set(auth(mgr1))).body;
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ version: 1, value: 40, reason: 'زيادة الدوام' });
    const a = (await db.query(`select actor_role, before_values, after_values from audit_log where action='settings.update' and after_values->>'key'='booking.daily_limit' and after_values->>'value'='40' and actor_role='manager'`)).rows[0];
    expect(a.actor_role).toBe('manager');
    expect(a.before_values).toEqual({ value: 30, version: 0 });
    expect(a.after_values).toMatchObject({ value: 40, version: 1 });
  });

  it('قفل تفاؤلي: النسخة القديمة ترفض 409، والصحيحة تنجح وتزيد النسخة', async () => {
    const stale = await put(mgr1, 'booking.daily_limit', { value: 50, expected_version: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('SETTING_CONFLICT');
    const ok = await put(mgr1, 'booking.daily_limit', { value: 35, expected_version: 1 });
    expect(ok.body.version).toBe(2);
    const h = (await http().get('/settings/booking.daily_limit/history').set(auth(mgr1))).body;
    expect(h.map((x: any) => x.version)).toEqual([2, 1]);
  });

  it('تحديثين متزامنين بنفس النسخة: واحد ينجح والباقي 409', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => put(mgr1, 'stock.near_expiry_days', { value: 10 + i, expected_version: 0 })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect((await db.query(`select count(*)::int as n from setting_history h join settings s on s.id = h.setting_id where s.key='stock.near_expiry_days' and s.branch_id=$1`, [b1])).rows[0].n).toBe(1);
  });

  it('الصلاحية حسب المفتاح: المدير ما يغيّر النقاط ولا مدة المراجعة، المالك يغيّر', async () => {
    expect((await put(mgr1, 'points.max_percent', { value: 30, expected_version: 0 })).status).toBe(403);
    expect((await put(mgr1, 'booking.free_followup_days', { value: 10, expected_version: 0 })).status).toBe(403);
    expect((await put(mgr1, 'money.rounding_step', { value: 500, expected_version: 0 })).status).toBe(403);
    expect((await put(cash, 'booking.daily_limit', { value: 10, expected_version: 0 })).status).toBe(403);
    const o = await put(owner, 'points.max_percent', { value: 30, expected_version: 0, branch_id: b1 });
    expect(o.status).toBe(200);
    expect((await http().get('/settings').set(auth(mgr1))).body.settings.find((s: any) => s.key === 'points.max_percent').value).toBe(30);
  });

  it('التحقق من القيم: حدود، نوع، نص، null المسموح', async () => {
    const bad = async (key: string, value: unknown) => {
      const r = await put(owner, key, { value, expected_version: 0, branch_id: b2 });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('INVALID_SETTING');
    };
    await bad('booking.daily_limit', 0);
    await bad('booking.daily_limit', 1001);
    await bad('booking.daily_limit', 3.5);
    await bad('booking.daily_limit', '30');
    await bad('booking.daily_limit', null);
    await bad('points.max_percent', 101);
    await bad('points.point_value', 0);
    await bad('receipt.phone', 123);
    await bad('receipt.clinic_name', 'x'.repeat(101));
    await bad('receipt.logo_attachment_id', 0);
    expect((await put(owner, 'receipt.logo_attachment_id', { value: null, expected_version: 0, branch_id: b2 })).status).toBe(200);
    const name = await put(owner, 'receipt.clinic_name', { value: '  عيادة النور  ', expected_version: 0, branch_id: b2 });
    expect(name.body.value).toBe('عيادة النور');
    const noValue = await put(owner, 'booking.daily_limit', { expected_version: 0, branch_id: b2 });
    expect(noValue.status).toBe(400);
  });

  it('مفتاح غير معروف → 404، وحقول زيادة → 400', async () => {
    expect((await put(owner, 'no.such.key', { value: 1, expected_version: 0, branch_id: b1 })).status).toBe(404);
    expect((await put(owner, 'booking.daily_limit', { value: 5, expected_version: 0, branch_id: b1, extra: 1 })).status).toBe(400);
    expect((await http().get('/settings/no.such.key/history').set(auth(owner))).status).toBe(404);
  });

  it('كل فرع إعداداته مستقلة، والمدير ما يتعدى فرعه، والمالك لازم يحدد الفرع إذا أكثر من فرع', async () => {
    expect((await http().get('/settings').set(auth(mgr2))).body.settings.find((s: any) => s.key === 'booking.daily_limit')).toMatchObject({ value: 30, is_default: true });
    expect((await put(mgr1, 'booking.daily_limit', { value: 20, expected_version: 2, branch_id: b2 })).status).toBe(403);
    expect((await http().get(`/settings?branch_id=${b2}`).set(auth(mgr1))).status).toBe(403);
    const noBranch = await put(owner, 'booking.daily_limit', { value: 20, expected_version: 0 });
    expect(noBranch.status).toBe(400);
    expect(noBranch.body.code).toBe('BRANCH_REQUIRED');
    expect((await put(owner, 'booking.daily_limit', { value: 20, expected_version: 0, branch_id: 999999 })).body.code).toBe('BRANCH_NOT_FOUND');
  });

  it('القيمة الفعالة: إعداد الفرع، ثم العام، ثم الافتراضي (تستخدمها بقية الوحدات)', async () => {
    const svc = app.get(SettingsService);
    expect(await svc.effective(db, b1, 'booking.daily_limit')).toBe(35);       // إعداد الفرع
    expect(await svc.effective(db, b2, 'money.rounding_step')).toBe(250);       // الافتراضي
    await db.query(`insert into settings (branch_id, key, value) values (null, 'money.rounding_step', '500'::jsonb)`);
    expect(await svc.effective(db, b2, 'money.rounding_step')).toBe(500);       // العام
    await db.query(`insert into settings (branch_id, key, value) values ($1, 'money.rounding_step', '1000'::jsonb)`, [b2]);
    expect(await svc.effective(db, b2, 'money.rounding_step')).toBe(1000);      // الفرع يغلب العام
    expect(await svc.effective(db, b1, 'money.rounding_step')).toBe(500);
    await expect(svc.effective(db, b1, 'nope')).rejects.toThrow();
    // الدالة بالقاعدة (تستخدمها الـ views) تقرأ نفس القيم
    expect(Number((await db.query(`select setting_int($1, 'booking.daily_limit', 1) as v`, [b1])).rows[0].v)).toBe(35);
  });

  it('تاريخ الإعداد للمدير والمالك بس', async () => {
    expect((await http().get('/settings/booking.daily_limit/history').set(auth(cash))).status).toBe(403);
  });
});
