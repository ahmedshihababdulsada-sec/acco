import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BackupConfig, pgTool } from './config';
import { encryptFile, keyFingerprint } from './crypto';
import { parseStamp, run, stamp } from './proc';
import { Remote } from './remote';
import { selectRetained, walToDelete } from './retention';
import { updateSection } from './status';

export interface BaseMeta {
  id: string; started_at: string; finished_at: string; start_wal: string | null; key_fingerprint: string;
  files: { name: string; plain_size: number; plain_sha256: string; cipher_size: number }[];
}

async function encryptAndPut(remote: Remote, pub: string, local: string, key: string, workDir: string) {
  const enc = join(workDir, `${key.replace(/\//g, '_')}.enc`);
  try {
    const r = await encryptFile(local, enc, pub);
    await remote.put(enc, key);
    const got = (await remote.list(key)).find((e) => e.key === key);
    if (!got || got.size !== r.cipherSize) throw new Error(`الملف البعيد ما طابق الحجم بعد الرفع: ${key}`);
    return r;
  } finally { await rm(enc, { force: true }); }
}

/**
 * نسخة كاملة (فيزيائية) بـpg_basebackup مع WAL داخلها (-X stream) فتكون كاملة بنفسها. تتشفر وتنرفع ملفاً ملفاً، و meta.json يُرفع آخر شي
 * (علامة الاكتمال): نسخة بدون meta تتعتبر ناقصة وما تُستخدم.
 */
export async function baseBackup(cfg: BackupConfig, remote: Remote, publicKeyPem: string, now = new Date()): Promise<BaseMeta> {
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL غير مضبوط');
  const id = `base-${stamp(now)}`; const dir = join(cfg.workDir, id);
  await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
  try {
    await run(pgTool(cfg, 'pg_basebackup'), ['-d', cfg.databaseUrl, '-D', dir, '-Ft', '-z', '-X', 'stream', '-c', 'fast', '-l', id]);
    const label = (await run('tar', ['-xzOf', join(dir, 'base.tar.gz'), 'backup_label'])).stdout;
    const startWal = /START WAL LOCATION: \S+ \(file ([0-9A-F]{24})\)/.exec(label)?.[1] ?? null;
    const files: BaseMeta['files'] = [];
    for (const name of (await readdir(dir)).sort()) {
      const r = await encryptAndPut(remote, publicKeyPem, join(dir, name), `base/${id}/${name}.enc`, cfg.workDir);
      files.push({ name, plain_size: r.plainSize, plain_sha256: r.plainSha256, cipher_size: r.cipherSize });
    }
    const meta: BaseMeta = { id, started_at: now.toISOString(), finished_at: new Date().toISOString(), start_wal: startWal, key_fingerprint: keyFingerprint(publicKeyPem), files };
    const metaPath = join(dir, 'meta.json.tmp');
    await writeFile(metaPath, JSON.stringify(meta));
    await remote.put(metaPath, `base/${id}/meta.json`);
    return meta;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** تفريغ منطقي (pg_dump) مشفر: شبكة أمان تنفتح على أي إصدار PostgreSQL وتسمح باسترجاع جدول واحد. */
export async function logicalDump(cfg: BackupConfig, remote: Remote, publicKeyPem: string, now = new Date()): Promise<string> {
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL غير مضبوط');
  const id = stamp(now); await mkdir(cfg.workDir, { recursive: true });
  const dump = join(cfg.workDir, `logical-${id}.dump`);
  try {
    await run(pgTool(cfg, 'pg_dump'), ['-Fc', '-d', cfg.databaseUrl, '-f', dump]);
    await encryptAndPut(remote, publicKeyPem, dump, `logical/${id}.dump.enc`, cfg.workDir);
    return id;
  } finally { await rm(dump, { force: true }); }
}

export async function readMetas(remote: Remote, workDir: string): Promise<BaseMeta[]> {
  await mkdir(workDir, { recursive: true });
  const metas: BaseMeta[] = [];
  for (const e of (await remote.list('base/')).filter((x) => x.key.endsWith('/meta.json'))) {
    const tmp = join(workDir, `meta-${e.key.split('/')[1]}.json`);
    try { await remote.get(e.key, tmp); metas.push(JSON.parse(await readFile(tmp, 'utf8')) as BaseMeta); } finally { await rm(tmp, { force: true }); }
  }
  return metas.sort((a, b) => a.finished_at.localeCompare(b.finished_at));
}

export interface PruneResult { base_deleted: string[]; logical_deleted: string[]; wal_deleted: number; uploads_deleted: number; incomplete_deleted: string[]; kept_base: string[] }

/**
 * تنظيف القديم حسب السياسة (7 يومي + 4 أسبوعي + 12 شهري). WAL ينحذف فقط لما هو أقدم من بداية أقدم نسخة محتفظ بها.
 * أمان: بدون نسخة كاملة ناجحة ما نحذف شي من WAL، ونسخة ناقصة (بدون meta) ما تنحذف قبل 24 ساعة (ممكن تكون لسه ترفع).
 */
export async function prune(cfg: BackupConfig, remote: Remote, now = new Date(), localUploadKeys?: Set<string>): Promise<PruneResult> {
  const res: PruneResult = { base_deleted: [], logical_deleted: [], wal_deleted: 0, uploads_deleted: 0, incomplete_deleted: [], kept_base: [] };
  const metas = await readMetas(remote, cfg.workDir);
  const baseEntries = await remote.list('base/');
  const byId = new Map<string, typeof baseEntries>();
  for (const e of baseEntries) { const id = e.key.split('/')[1]; byId.set(id, [...(byId.get(id) ?? []), e]); }
  const complete = new Set(metas.map((m) => m.id));

  for (const [id, entries] of byId) {                                          // نسخ ناقصة قديمة
    if (complete.has(id)) continue;
    const newest = Math.max(...entries.map((e) => e.mtime.getTime()));
    if (now.getTime() - newest > 24 * 3_600_000) { for (const e of entries) await remote.delete(e.key); res.incomplete_deleted.push(id); }
  }
  const keepBase = selectRetained(metas.map((m) => ({ id: m.id, at: new Date(m.finished_at) })), cfg.retention, cfg.tzOffsetMin);
  for (const m of metas) {
    if (keepBase.has(m.id)) { res.kept_base.push(m.id); continue; }
    for (const e of byId.get(m.id) ?? []) await remote.delete(e.key);
    res.base_deleted.push(m.id);
  }
  const logical = (await remote.list('logical/')).map((e) => ({ e, at: parseStamp(e.key) })).filter((x): x is { e: typeof x.e; at: Date } => x.at !== null);
  const keepLogical = selectRetained(logical.map((x) => ({ id: x.e.key, at: x.at })), cfg.retention, cfg.tzOffsetMin);
  for (const x of logical) if (!keepLogical.has(x.e.key)) { await remote.delete(x.e.key); res.logical_deleted.push(x.e.key); }

  const retainedMetas = metas.filter((m) => keepBase.has(m.id) && m.start_wal);
  if (retainedMetas.length) {
    const oldest = retainedMetas.map((m) => m.start_wal as string).sort((a, b) => a.slice(8).localeCompare(b.slice(8)))[0];
    const wal = await remote.list('wal/');
    for (const n of walToDelete(wal.map((e) => e.key.slice(4).replace(/\.enc$/, '')), oldest)) { await remote.delete(`wal/${n}.enc`); res.wal_deleted++; }
  }
  if (localUploadKeys) {
    const cutoff = now.getTime() - cfg.retention.monthly * 31 * 86_400_000;
    for (const e of await remote.list('uploads/')) {
      if (!localUploadKeys.has(e.key) && e.mtime.getTime() < cutoff) { await remote.delete(e.key); res.uploads_deleted++; }
    }
  }
  await updateSection(cfg.stateDir, 'prune', { last_run_at: now.toISOString(), last_ok_at: now.toISOString(), kept_base: res.kept_base.length });
  return res;
}
export const dirSize = async (p: string): Promise<number> => (await stat(p)).size;
