import { INestApplication } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { updateSection } from '../src/ops/backup/status';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

describe('حالة النسخ الاحتياطي (المالك)', () => {
  let app: INestApplication; let owner: string; let mgr: string; let cash: string; let dir: string;
  const saved = { r: process.env.BACKUP_REMOTE, k: process.env.BACKUP_PUBLIC_KEY, s: process.env.BACKUP_STATE_DIR };
  const get = (t?: string) => { const r = request(app.getHttpServer()).get('/ops/backup-status'); return t ? r.set(auth(t)) : r; };
  beforeAll(async () => {
    app = await makeApp(); const db = pool();
    const code = 'OPS'; const id = Number((await db.query(`insert into branches (code, name) values ($1,$1) returning id`, [code])).rows[0].id);
    await seedUser(db, 'mgr_ops', 'manager', id); await seedUser(db, 'cash_ops', 'cashier', id); await db.end();
    owner = await tokenFor(app, 'owner'); mgr = await tokenFor(app, 'mgr_ops'); cash = await tokenFor(app, 'cash_ops');
    dir = mkdtempSync(join(tmpdir(), 'ops-state-')); process.env.BACKUP_STATE_DIR = dir; process.env.OPS_REMOTE_CACHE_SECONDS = '0';
  });
  afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); for (const [k, v] of [['BACKUP_REMOTE', saved.r], ['BACKUP_PUBLIC_KEY', saved.k], ['BACKUP_STATE_DIR', saved.s]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it('المالك فقط: المدير والكاشير 403 وبدون توكن 401', async () => {
    expect((await get(owner)).status).toBe(200);
    for (const t of [mgr, cash]) expect((await get(t)).status).toBe(403);
    expect((await get()).status).toBe(401);
  });
  it('غير مضبوط: يقول للمالك بوضوح', async () => {
    delete process.env.BACKUP_REMOTE; delete process.env.BACKUP_PUBLIC_KEY;
    const r = await get(owner);
    expect(r.body).toMatchObject({ configured: false, ok: false }); expect(r.body.problems[0].code).toBe('NOT_CONFIGURED');
  });
  it('مضبوط بدون نسخ بعد: مشاكل واضحة؛ وبعد تسجيل نجاح المهام: سليم', async () => {
    process.env.BACKUP_REMOTE = 'dir:/tmp/x'; process.env.BACKUP_PUBLIC_KEY = '/tmp/pub.pem';
    const a = await get(owner);
    expect(a.body.configured).toBe(true); expect(a.body.ok).toBe(false);
    expect(a.body.problems.map((p: { code: string }) => p.code)).toEqual(expect.arrayContaining(['BASE_NEVER', 'WAL_NEVER']));
    const now = new Date().toISOString();
    await updateSection(dir, 'base', { last_ok_at: now }); await updateSection(dir, 'wal', { last_run_at: now, spool_files: 0 }); await updateSection(dir, 'uploads', { last_ok_at: now }); await updateSection(dir, 'verify', { last_ok_at: now });
    const b = await get(owner);
    expect(b.body.ok).toBe(true); expect(b.body.problems).toEqual([]); expect(b.body.base_last_ok_at).toBe(now);
  });
  it('فشل مسجل يطلع للمالك بنص الخطأ', async () => {
    await updateSection(dir, 'wal', { last_error: 'الإنترنت مقطوع', last_error_at: new Date(Date.now() + 1000).toISOString() });
    const r = await get(owner);
    expect(r.body.ok).toBe(false); expect(r.body.problems.find((p: { code: string }) => p.code === 'WAL_FAILED').message).toContain('الإنترنت مقطوع');
  });

  it('فحص الاسترجاع المنشور بالتخزين (من جهاز المالك) يُقرأ ويُعرض، والأحدث تشغيلاً يفوز، والتخزين المعطل ما يخرب الصفحة', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'ops-remote-')); mkdirSync(join(remote, 'status'));
    try {
      process.env.BACKUP_REMOTE = `dir:${remote}`; process.env.BACKUP_PUBLIC_KEY = '/tmp/pub.pem';
      const fresh = new Date().toISOString();
      await updateSection(dir, 'verify', { last_run_at: new Date(Date.now() - 40 * 86400e3).toISOString(), last_ok_at: new Date(Date.now() - 40 * 86400e3).toISOString(), last_error: undefined, last_error_at: undefined });
      await updateSection(dir, 'wal', { last_run_at: fresh, last_ok_at: fresh, last_error: undefined, last_error_at: undefined });
      expect((await get(owner)).body.problems.map((p: { code: string }) => p.code)).toContain('VERIFY_STALE');          // محلي قديم
      writeFileSync(join(remote, 'status', 'verify.json'), JSON.stringify({ last_run_at: fresh, last_ok_at: fresh }));
      const ok = await get(owner); expect(ok.body.verify_last_ok_at).toBe(fresh); expect(ok.body.problems.map((p: { code: string }) => p.code)).not.toContain('VERIFY_STALE');
      writeFileSync(join(remote, 'status', 'verify.json'), JSON.stringify({ last_run_at: new Date(Date.now() + 1000).toISOString(), last_error: 'تالف', last_error_at: new Date(Date.now() + 1000).toISOString() }));
      expect((await get(owner)).body.problems.find((p: { code: string }) => p.code === 'VERIFY_FAILED').message).toContain('تالف');
      writeFileSync(join(remote, 'status', 'verify.json'), '{ not json');                                                 // ملف تالف: نرجع للمحلي بدون خطأ
      const bad = await get(owner); expect(bad.status).toBe(200);
      process.env.BACKUP_REMOTE = 'dir:/nonexistent/path/zzz'; expect((await get(owner)).status).toBe(200);              // تخزين غير متاح
    } finally { rmSync(remote, { recursive: true, force: true }); }
  });
});
