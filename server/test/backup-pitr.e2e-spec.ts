import { execFile, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { generateBackupKeyPair } from '../src/ops/backup/crypto';
import { loadConfig } from '../src/ops/backup/config';
import { DirRemote } from '../src/ops/backup/remote';
import { publishVerify, recordVerify, verifyRestore } from '../src/ops/backup/restore';

const exec = promisify(execFile);
const PGBIN = process.env.PGBIN || join(homedir(), 'Applications/Postgres.app/Contents/Versions/16/bin');
const hasPg = existsSync(join(PGBIN, 'initdb'));
const d = hasPg ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * اختبار كارثة حقيقي: PostgreSQL فعلي (مجلد مؤقت)، نسخة كاملة، تغييرات بعدها، تدمير الكلستر بالكامل، ثم استرجاع لنقطة زمنية محددة
 * من النسخ المشفرة فقط (بدون أي ملف من الأصل).
 */
d('النسخ الاحتياطي: استرجاع كامل ولحظة زمنية (PostgreSQL حقيقي)', () => {
  const root = mkdtempSync(join(tmpdir(), 'bk-e2e-'));
  const P = (n: string) => join(root, n);
  const node = process.execPath; const PORT = 5571; let cli = ''; let env: NodeJS.ProcessEnv = {};
  const keys = generateBackupKeyPair();
  const sock = P('sock'); const remoteDir = P('remote');
  const URL = `postgres://clinic@127.0.0.1:${PORT}/clinicdb`;
  const psql = (sql: string, o: { port?: number; host?: string; db?: string } = {}) => spawnSync(join(PGBIN, 'psql'), ['-h', o.host ?? sock, '-p', String(o.port ?? PORT), '-U', 'clinic', '-d', o.db ?? 'clinicdb', '-Atc', sql], { encoding: 'utf8' });
  const q = (sql: string, o: { port?: number; host?: string; db?: string } = {}) => { const r = psql(sql, o); if (r.status !== 0) throw new Error(`psql: ${r.stderr}`); return r.stdout.trim(); };
  const bk = async (...args: string[]) => exec(node, [cli, ...args], { env, maxBuffer: 20 * 1024 * 1024 });
  /** يقلب ملف WAL وينتظر لين الأرشيف يخلص المقطع المكتمل (مو بالعدّاد: العدّاد يتأخر ويخلط مع مقاطع سابقة) */
  const switchAndWait = async (o: { port?: number; host?: string } = {}) => {
    q('select pg_switch_wal()', { ...o, db: 'postgres' });
    const target = q(`select pg_walfile_name(pg_current_wal_lsn() - 1)`, { ...o, db: 'postgres' });
    let last = ''; for (let i = 0; i < 150; i++) { last = q('select coalesce(last_archived_wal, $$$$) from pg_stat_archiver', { ...o, db: 'postgres' }); if (last >= target) return; await sleep(200); }
    throw new Error(`الأرشفة ما وصلت ${target} (آخر: ${last})`);
  };
  const startRestored = async (dir: string, port: number, s: string) => {
    mkdirSync(s, { recursive: true });
    appendFileSync(join(dir, 'postgresql.auto.conf'), `\nport = ${port}\nlisten_addresses = ''\nunix_socket_directories = '${s}'\n`);
    writeFileSync(join(dir, 'pg_hba.conf'), 'local all all trust\nlocal replication all trust\n');
    const r = spawnSync(join(PGBIN, 'pg_ctl'), ['-D', dir, '-w', '-t', '120', '-l', `${dir}.log`, 'start'], { encoding: 'utf8', env: process.env });
    if (r.status !== 0) throw new Error(`pg_ctl: ${r.stdout}${r.stderr}\n${existsSync(`${dir}.log`) ? readFileSync(`${dir}.log`, 'utf8').slice(-800) : ''}`);
    for (let i = 0; i < 150 && psql('select pg_is_in_recovery()', { port, host: s }).stdout.trim() !== 'f'; i++) await sleep(300);
    expect(psql('select pg_is_in_recovery()', { port, host: s }).stdout.trim()).toBe('f');
  };
  const stopPg = (dir: string) => spawnSync(join(PGBIN, 'pg_ctl'), ['-D', dir, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });

  beforeAll(async () => {
    mkdirSync(sock, { recursive: true });
    // نبني أداة الأوامر لمجلد مؤقت (تعتمد على node فقط، ما تحتاج بقية الخادم)
    const out = P('dist');
    const b = spawnSync(join(process.cwd(), 'node_modules/.bin/tsc'), ['src/cli/backup.ts', '--outDir', out, '--module', 'commonjs', '--target', 'es2022', '--skipLibCheck', '--esModuleInterop', '--types', 'node', '--typeRoots', join(process.cwd(), 'node_modules/@types')], { encoding: 'utf8', cwd: process.cwd() });
    cli = join(out, 'cli/backup.js'); if (!existsSync(cli)) throw new Error(`build failed: ${b.stdout}${b.stderr}`);
    writeFileSync(P('pub.pem'), keys.publicKeyPem); writeFileSync(P('priv.pem'), keys.privateKeyPem, { mode: 0o600 });
    env = { ...process.env, PGBIN, BACKUP_REMOTE: `dir:${remoteDir}`, BACKUP_PUBLIC_KEY: P('pub.pem'), BACKUP_PRIVATE_KEY: P('priv.pem'), BACKUP_SPOOL_DIR: P('spool'), BACKUP_STATE_DIR: P('state'), BACKUP_WORK_DIR: P('work'), DATABASE_URL: URL, UPLOAD_DIR: P('uploads'), BACKUP_TZ_OFFSET_MIN: '180' };
    const init = spawnSync(join(PGBIN, 'initdb'), ['-D', P('pg'), '-U', 'clinic', '--auth=trust', '-E', 'UTF8'], { encoding: 'utf8' });
    if (init.status !== 0) throw new Error(init.stderr);
    appendFileSync(join(P('pg'), 'postgresql.conf'), `\nport = ${PORT}\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = '${sock}'\nwal_level = replica\nmax_wal_senders = 4\narchive_mode = on\narchive_command = '${node} ${cli} archive-wal --spool ${P('spool')} "%p" "%f"'\n`);
    const st = spawnSync(join(PGBIN, 'pg_ctl'), ['-D', P('pg'), '-w', '-l', P('pg.log'), 'start'], { encoding: 'utf8' });
    if (st.status !== 0) throw new Error(`${st.stderr}${readFileSync(P('pg.log'), 'utf8')}`);
    q('create database clinicdb', { db: 'postgres' });
    q(`create table items (id serial primary key, note text not null, secret text not null default 'SECRET_MARKER_XYZ_9981_PATIENT', at timestamptz default now())`);
  }, 180000);
  afterAll(() => { stopPg(P('pg')); for (const n of ['r1', 'r2', 'r3']) stopPg(P(n)); rmSync(root, { recursive: true, force: true }); });

  let T = '';
  it('نسخة كاملة + تغييرات + WAL مستمر ثم الرفع المشفر للتخزين البعيد', async () => {
    q(`insert into items(note) values ('A1'),('A2')`);
    // ملف صور
    mkdirSync(P('uploads/2026-11'), { recursive: true }); writeFileSync(P('uploads/2026-11/proof1.png'), Buffer.from('صورة-إثبات-1'));
    await bk('base');
    q(`insert into items(note) values ('B1'),('B2')`); await switchAndWait();
    await sleep(1200); T = q(`select to_char(now(), 'YYYY-MM-DD HH24:MI:SS.US TZH')`);
    await sleep(1200);
    q(`insert into items(note) values ('C1')`); await switchAndWait();
    const r = await bk('ship'); expect(r.stderr).toBe('');
    expect(readdirSync(P('spool'))).toEqual([]);
    const remote = new DirRemote(remoteDir);
    expect((await remote.list('wal/')).length).toBeGreaterThanOrEqual(2);
    // كل شي مشفر: لا نص واضح بالتخزين
    for (const e of await remote.list('')) { if (e.key.endsWith('meta.json')) continue; expect(readFileSync(join(remoteDir, e.key)).includes(Buffer.from('SECRET_MARKER_XYZ_9981'))).toBe(false); expect(readFileSync(join(remoteDir, e.key)).subarray(0, 5).toString()).toBe('CLBK1'); }
    await bk('uploads'); await bk('logical');
    expect(JSON.parse(readFileSync(P('state/wal.json'), 'utf8')).last_ok_at).toBeTruthy();
  }, 300000);

  it('كارثة: تدمير الكلستر بالكامل → استرجاع للحظة T (قبل C1) من النسخ المشفرة فقط', async () => {
    stopPg(P('pg')); rmSync(P('pg'), { recursive: true, force: true }); rmSync(P('uploads'), { recursive: true, force: true });
    await bk('restore', '--target', P('r1'), '--time', T);
    const auto = readFileSync(join(P('r1'), 'postgresql.auto.conf'), 'utf8');
    expect(auto).toMatch(/recovery_target_time = '\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+[+-]\d{2}'/); expect(auto).toMatch(/archive_mode = off/); expect(auto).toMatch(/recovery_target_action = 'promote'/);
    expect(auto).toMatch(/restore_command = 'env BACKUP_REMOTE=.*restore-wal "%f" "%p"'/); expect(auto).not.toContain(keys.privateKeyPem.slice(30, 60));      // المفتاح الخاص ما ينكتب بالإعدادات
    expect(existsSync(join(P('r1'), 'recovery.signal'))).toBe(true);
    await startRestored(P('r1'), 5572, P('s1'));
    expect(q(`select string_agg(note, ',' order by id) from items`, { port: 5572, host: P('s1') })).toBe('A1,A2,B1,B2');          // C1 بعد T فما يوجد
    stopPg(P('r1'));
  }, 300000);

  it('استرجاع آخر نقطة (بدون وقت): كل البيانات بما فيها C1', async () => {
    await bk('restore', '--target', P('r2'));
    await startRestored(P('r2'), 5573, P('s2'));
    expect(q(`select string_agg(note, ',' order by id) from items`, { port: 5573, host: P('s2') })).toBe('A1,A2,B1,B2,C1');
    stopPg(P('r2'));
  }, 300000);

  it('استرجاع الصور من النسخة: نفس المحتوى', async () => {
    await bk('restore-uploads', '--target', P('uploads-back'));
    expect(readFileSync(P('uploads-back/2026-11/proof1.png'), 'utf8')).toBe('صورة-إثبات-1');
  }, 60000);

  it('المفتاح الخاص الغلط يمنع الاسترجاع والمجلد ما يتجهز بيانات خاطئة', async () => {
    const other = generateBackupKeyPair(); writeFileSync(P('priv-wrong.pem'), other.privateKeyPem);
    await expect(exec(node, [cli, 'restore', '--target', P('rbad')], { env: { ...env, BACKUP_PRIVATE_KEY: P('priv-wrong.pem') } })).rejects.toThrow(/ما يطابق/);
  }, 120000);

  it('الاسترجاع يرفض مجلد فيه بيانات (ما يكتب فوق)', async () => {
    mkdirSync(P('occupied'), { recursive: true }); writeFileSync(P('occupied/x'), 'data');
    await expect(bk('restore', '--target', P('occupied'))).rejects.toThrow(/مو فاضي/);
    expect(readFileSync(P('occupied/x'), 'utf8')).toBe('data');
  });

  it('فحص الاسترجاع الشهري (verify): يسترجع بمجلد مؤقت ويشغل الفحوص ويمسح كل شي، ويسجل النجاح', async () => {
    const cfg = loadConfig(env); const remote = new DirRemote(remoteDir);
    const r = await verifyRestore(cfg, remote, { privateKeyPem: keys.privateKeyPem, remoteSpec: `dir:${remoteDir}`, privateKeyPath: P('priv.pem'), cliPath: cli, port: 5574, dbName: 'clinicdb', dbUser: 'clinic',
      checks: [{ name: 'عدد الصفوف', sql: 'select count(*) from items', ok: (v) => Number(v) === 5 }] });
    expect(r.ok).toBe(true); expect(r.checks[0]).toMatchObject({ value: '5', ok: true });
    await recordVerify(cfg, r);
    expect(JSON.parse(readFileSync(P('state/verify.json'), 'utf8')).last_ok_at).toBeTruthy();
    await publishVerify(cfg, remote);                                                     // يُنشر للتخزين ليشوفه السيرفر
    expect(JSON.parse(readFileSync(join(remoteDir, 'status', 'verify.json'), 'utf8'))).toEqual(JSON.parse(readFileSync(P('state/verify.json'), 'utf8')));
    expect(readdirSync(P('work')).filter((n) => n.startsWith('verify-') && !n.endsWith('.log'))).toEqual([]);          // المجلد المؤقت انمسح
    const bad = await verifyRestore(cfg, remote, { privateKeyPem: keys.privateKeyPem, remoteSpec: `dir:${remoteDir}`, privateKeyPath: P('priv.pem'), cliPath: cli, port: 5575, dbName: 'clinicdb', dbUser: 'clinic',
      checks: [{ name: 'يتوقع صفر', sql: 'select count(*) from items', ok: (v) => Number(v) === 0 }] });
    expect(bad.ok).toBe(false);                                                                                          // فحص فاشل يكتشف
    await recordVerify(cfg, bad);
    expect(JSON.parse(readFileSync(P('state/verify.json'), 'utf8')).last_error).toContain('يتوقع صفر');
  }, 300000);

  it('التنظيف: نسخة ثانية بنفس اليوم → تبقى الأحدث، WAL الأقدم ينحذف، والاسترجاع الأخير يظل شغال', async () => {
    const remote = new DirRemote(remoteDir);
    // بنفس السيرفر المسترجع نعمل نسخة ثانية؟ الكلستر الأصلي انهدم، فنشغل r3 (الأحدث) كمصدر ونسوي منه نسخة بنفس التخزين
    await bk('restore', '--target', P('r3')); await startRestored(P('r3'), 5576, P('s3'));
    q(`alter system set archive_mode = on`, { port: 5576, host: P('s3') });                                       // يحتاج إعادة تشغيل
    stopPg(P('r3'));
    appendFileSync(join(P('r3'), 'postgresql.auto.conf'), `\nwal_level = replica\nmax_wal_senders = 4\narchive_mode = on\narchive_command = '${node} ${cli} archive-wal --spool ${P('spool')} "%p" "%f"'\n`);
    rmSync(join(P('r3'), 'recovery.signal'), { force: true });
    const st = spawnSync(join(PGBIN, 'pg_ctl'), ['-D', P('r3'), '-w', '-t', '120', '-l', P('r3.log'), 'start'], { encoding: 'utf8' }); expect(st.status).toBe(0);
    await sleep(1500);
    const before = (await remote.list('base/')).filter((e) => e.key.endsWith('meta.json')).length; expect(before).toBe(1);
    const envR3 = { ...env, DATABASE_URL: `postgres://clinic@127.0.0.1:5576/clinicdb`, PGHOST: P('s3') };
    // pg_basebackup عبر TCP: r3 يسمع بـsocket فقط، فنستعمل socket عبر PGHOST
    await exec(node, [cli, 'base'], { env: { ...envR3, DATABASE_URL: `postgres:///clinicdb?host=${P('s3')}&port=5576&user=clinic` } });
    q(`insert into items(note) values ('D1')`, { port: 5576, host: P('s3') }); await switchAndWait({ port: 5576, host: P('s3') });
    await bk('ship');
    stopPg(P('r3'));
    const metas = (await remote.list('base/')).filter((e) => e.key.endsWith('meta.json')); expect(metas.length).toBe(2);
    await exec(node, [cli, 'prune'], { env: { ...env, BACKUP_KEEP_DAILY: '1', BACKUP_KEEP_WEEKLY: '1', BACKUP_KEEP_MONTHLY: '1' } });
    const after = (await remote.list('base/')).filter((e) => e.key.endsWith('meta.json'));
    expect(after.length).toBe(1);
    expect(after[0].key).toBe(metas[metas.length - 1].key);                                                        // الأحدث بس
    await bk('restore', '--target', P('r4'));
    await startRestored(P('r4'), 5577, P('s4'));
    expect(q(`select string_agg(note, ',' order by id) from items`, { port: 5577, host: P('s4') })).toContain('D1');
    stopPg(P('r4'));
  }, 400000);

  it('status: صحة كاملة بعد كل المهام', async () => {
    const out = await bk('status'); const h = JSON.parse(out.stdout);
    expect(h.configured).toBe(true); expect(h.base_last_ok_at).toBeTruthy(); expect(h.uploads_last_ok_at).toBeTruthy();
    expect(h.problems.find((p: { code: string }) => p.code === 'BASE_STALE')).toBeUndefined();
  });
});
