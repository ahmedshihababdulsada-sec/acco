import { chmod, mkdir, readdir, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BackupConfig, pgTool } from './config';
import { decryptFile } from './crypto';
import { readMetas, BaseMeta } from './base';
import { run } from './proc';
import { Remote } from './remote';
import { readSection, updateSection } from './status';

const confQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export interface RestoreOptions {
  targetDir: string; targetTime?: string; baseId?: string;
  privateKeyPem: string; passphrase?: string;
  remoteSpec: string; privateKeyPath: string;       // تنكتب بـrestore_command
  cliPath: string; nodePath?: string;
}

/**
 * وقت الاسترجاع: يقبل "2026-11-14 10:30:00" (بتوقيت العيادة)، أو مع فرق توقيت "+03" / "+03:00" / "Z"، أو ISO.
 * يرجع التاريخ (لاختيار النسخة) والنص بصيغة صريحة الفرق (لـPostgreSQL) حتى ما يلتبس التوقيت.
 */
export function parseTargetTime(input: string, tzOffsetMin = 180): { date: Date; pg: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(input.trim());
  if (!m) throw new Error(`وقت غير صالح: ${input} (استخدم مثلاً 2026-11-14 10:30:00 أو 2026-11-14 10:30:00+03)`);
  const [, y, mo, d, h, mi, sec, frac, tz] = m;
  let off = tzOffsetMin;
  if (tz === 'Z') off = 0;
  else if (tz) { const sign = tz[0] === '-' ? -1 : 1; const digits = tz.slice(1).replace(':', ''); off = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || '0')); }
  const ms = Math.round(Number(frac ?? '0') * 1000);
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec, ms) - off * 60_000);
  if (Number.isNaN(date.getTime()) || +mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +sec > 59) throw new Error(`وقت غير صالح: ${input}`);
  const sign = off < 0 ? '-' : '+'; const a = Math.abs(off);
  return { date, pg: `${y}-${mo}-${d} ${h}:${mi}:${sec}${frac ?? ''}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}${a % 60 ? ':' + String(a % 60).padStart(2, '0') : ''}` };
}

/** يختار النسخة الكاملة: المحددة، أو أحدث وحدة انتهت قبل وقت الاسترجاع المطلوب، أو الأحدث. */
export function chooseBase(metas: BaseMeta[], baseId?: string, targetTime?: string, tzOffsetMin = 180): BaseMeta {
  if (!metas.length) throw new Error('ما أكو أي نسخة كاملة مكتملة بالتخزين');
  if (baseId) { const m = metas.find((x) => x.id === baseId); if (!m) throw new Error(`النسخة ${baseId} غير موجودة`); return m; }
  if (!targetTime) return metas[metas.length - 1];
  const t = parseTargetTime(targetTime, tzOffsetMin).date.getTime();
  const ok = metas.filter((m) => Date.parse(m.finished_at) <= t);
  if (!ok.length) throw new Error('ما أكو نسخة كاملة قبل هذا الوقت: اختر وقتاً أحدث');
  return ok[ok.length - 1];
}

/**
 * يجهز مجلد بيانات PostgreSQL جديد من النسخة الكاملة + يضبط الاسترجاع الزمني (PITR): restore_command يجيب WAL من التخزين ويفك تشفيره.
 * ما يشغل PostgreSQL: المستخدم (أو verify) يشغله على المجلد. ما ينكتب فوق مجلد موجود فيه بيانات.
 */
export async function restoreBase(cfg: BackupConfig, remote: Remote, o: RestoreOptions): Promise<BaseMeta> {
  const existing = await readdir(o.targetDir).catch(() => [] as string[]);
  if (existing.length) throw new Error(`المجلد ${o.targetDir} مو فاضي: ما نكتب فوق بيانات موجودة`);
  const target = o.targetTime ? parseTargetTime(o.targetTime, cfg.tzOffsetMin) : null;
  const meta = chooseBase(await readMetas(remote, cfg.workDir), o.baseId, o.targetTime, cfg.tzOffsetMin);
  await mkdir(o.targetDir, { recursive: true }); await chmod(o.targetDir, 0o700);
  await mkdir(cfg.workDir, { recursive: true });
  for (const f of meta.files.filter((x) => x.name === 'base.tar.gz' || x.name === 'pg_wal.tar.gz')) {
    const enc = join(cfg.workDir, `restore-${meta.id}-${f.name}.enc`); const plain = join(cfg.workDir, `restore-${meta.id}-${f.name}`);
    try {
      await remote.get(`base/${meta.id}/${f.name}.enc`, enc);
      await decryptFile(enc, plain, o.privateKeyPem, o.passphrase);
      const dest = f.name === 'base.tar.gz' ? o.targetDir : join(o.targetDir, 'pg_wal');
      await mkdir(dest, { recursive: true });
      await run('tar', ['-xzf', plain, '-C', dest]);
    } finally { await rm(enc, { force: true }); await rm(plain, { force: true }); }
  }
  const node = o.nodePath ?? process.execPath;
  const restoreCmd = `env BACKUP_REMOTE=${shQuote(o.remoteSpec)} BACKUP_PRIVATE_KEY=${shQuote(o.privateKeyPath)} ${shQuote(node)} ${shQuote(o.cliPath)} restore-wal "%f" "%p"`;
  const lines = [`restore_command = ${confQuote(restoreCmd)}`, `recovery_target_action = 'promote'`, `archive_mode = off`];
  if (target) lines.push(`recovery_target_time = ${confQuote(target.pg)}`);
  await appendFile(join(o.targetDir, 'postgresql.auto.conf'), `\n# --- استرجاع من النسخ الاحتياطي ---\n${lines.join('\n')}\n`);
  await writeFile(join(o.targetDir, 'recovery.signal'), '');
  return meta;
}

export interface VerifyCheck { name: string; sql: string; ok: (value: string) => boolean }
export interface VerifyResult { ok: boolean; base_id: string; checks: { name: string; value: string; ok: boolean }[]; seconds: number }

export const DEFAULT_CHECKS: VerifyCheck[] = [
  { name: 'فحص سلامة النظام (v_integrity_checks) لازم صفر', sql: 'select count(*) from v_integrity_checks', ok: (v) => Number(v) === 0 },
  { name: 'عدد الوصلات المسترجعة', sql: 'select count(*) from payments', ok: (v) => Number(v) >= 0 },
];

/**
 * فحص الاسترجاع (شهرياً): يسترجع آخر نسخة + كل WAL بمجلد مؤقت، يشغل PostgreSQL عليه (socket فقط، بدون شبكة، بدون أرشفة)، ينتظر انتهاء
 * الاسترجاع، يشغل فحوص السلامة، ثم يمسح كل شي. نسخة ما انجرب استرجاعها ما تنحسب نسخة.
 */
export async function verifyRestore(cfg: BackupConfig, remote: Remote, o: Omit<RestoreOptions, 'targetDir'> & { checks?: VerifyCheck[]; port?: number; dbName?: string; dbUser?: string; timeoutSec?: number }): Promise<VerifyResult> {
  const t0 = Date.now(); const dir = join(cfg.workDir, `verify-${Date.now()}`); const sock = join(cfg.workDir, `vsock-${Date.now()}`);
  await mkdir(sock, { recursive: true });
  const port = o.port ?? 55432 + Math.floor(Math.random() * 400);
  const db = o.dbName ?? (cfg.databaseUrl ? new URL(cfg.databaseUrl).pathname.slice(1) : 'postgres');
  const user = o.dbUser ?? (cfg.databaseUrl ? decodeURIComponent(new URL(cfg.databaseUrl).username) : 'postgres');
  let started = false; let meta: BaseMeta | null = null;
  try {
    meta = await restoreBase(cfg, remote, { ...o, targetDir: dir });
    // أحيانا الإعدادات ما تنتسخ (مثلاً Debian يحطها برا مجلد البيانات)، فنضمن الملفات ونسمح بالدخول المحلي بس
    for (const f of ['postgresql.conf', 'pg_ident.conf']) if (!(await stat(join(dir, f)).then(() => true).catch(() => false))) await writeFile(join(dir, f), '');
    await writeFile(join(dir, 'pg_hba.conf'), 'local all all trust\n');
    await appendFile(join(dir, 'postgresql.auto.conf'), `port = ${port}\nlisten_addresses = ''\nunix_socket_directories = ${confQuote(sock)}\nhba_file = ${confQuote(join(dir, 'pg_hba.conf'))}\nident_file = ${confQuote(join(dir, 'pg_ident.conf'))}\nhot_standby = on\n`);
    await run(pgTool(cfg, 'pg_ctl'), ['-D', dir, '-w', '-t', String(o.timeoutSec ?? 1800), '-l', join(cfg.workDir, `verify-${meta.id}.log`), 'start'], { env: { ...process.env, ...(o.passphrase ? { BACKUP_PRIVATE_KEY_PASSPHRASE: o.passphrase } : {}) } });
    started = true;
    const psql = async (sql: string) => (await run(pgTool(cfg, 'psql'), ['-h', sock, '-p', String(port), '-U', user, '-d', db, '-Atc', sql])).stdout.trim();
    const deadline = Date.now() + (o.timeoutSec ?? 1800) * 1000;
    while ((await psql('select pg_is_in_recovery()').catch(() => 't')) !== 'f') {
      if (Date.now() > deadline) throw new Error('انتهت المهلة والاسترجاع ما خلص');
      await new Promise((r) => setTimeout(r, 500));
    }
    const checks: VerifyResult['checks'] = [];
    for (const c of o.checks ?? DEFAULT_CHECKS) { const value = await psql(c.sql); checks.push({ name: c.name, value, ok: c.ok(value) }); }
    return { ok: checks.every((c) => c.ok), base_id: meta.id, checks, seconds: Math.round((Date.now() - t0) / 1000) };
  } finally {
    if (started) await run(pgTool(cfg, 'pg_ctl'), ['-D', dir, '-m', 'immediate', '-w', 'stop'], { allowFail: true });
    await rm(dir, { recursive: true, force: true }); await rm(sock, { recursive: true, force: true });
  }
}

export async function recordVerify(cfg: BackupConfig, r: VerifyResult | Error, now = new Date()): Promise<void> {
  if (r instanceof Error || !r.ok) {
    const msg = r instanceof Error ? r.message : r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.value}`).join(' | ');
    await updateSection(cfg.stateDir, 'verify', { last_run_at: now.toISOString(), last_error: msg, last_error_at: now.toISOString() });
  } else await updateSection(cfg.stateDir, 'verify', { last_run_at: now.toISOString(), last_ok_at: now.toISOString(), base_id: r.base_id, seconds: r.seconds, checks: r.checks });
}

/** ينشر حالة فحص الاسترجاع للتخزين (JSON عادي بدون بيانات حساسة) ليقرأها السيرفر ويعرضها للمالك. */
export async function publishVerify(cfg: BackupConfig, remote: Remote): Promise<void> {
  const st = await readSection(cfg.stateDir, 'verify'); if (!st) return;
  await mkdir(cfg.workDir, { recursive: true });
  const tmp = join(cfg.workDir, 'verify-status.json'); await writeFile(tmp, JSON.stringify(st));
  try { await remote.put(tmp, 'status/verify.json'); } finally { await rm(tmp, { force: true }); }
}
