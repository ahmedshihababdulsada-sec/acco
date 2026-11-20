import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { BackupConfig } from './config';
import { decryptFile, encryptFile } from './crypto';
import { Remote } from './remote';
import { updateSection } from './status';

const sha = (p: string): Promise<string> => new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });
const SAFE_NAME = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

async function fsyncDir(dir: string): Promise<void> { const fd = await open(dir, 'r'); try { await fd.sync(); } finally { await fd.close(); } }

/**
 * archive_command الخاص بـPostgreSQL: ينسخ ملف WAL لمجلد الانتظار (spool) على نفس الجهاز بشكل متين (fsync + rename)، وما يرجع نجاح
 * إلا بعد ما الملف انحفظ فعلاً. الرفع للتخزين البعيد يسويه ship لحاله، فتعطل الإنترنت ما يوقف قاعدة البيانات.
 * إذا الملف موجود بنفس المحتوى (PostgreSQL يعيد المحاولة) = نجاح؛ بمحتوى مختلف = فشل (ما نكتب فوق).
 */
export async function archiveWal(spoolDir: string, srcPath: string, name: string): Promise<'stored' | 'exists'> {
  if (!SAFE_NAME.test(name)) throw new Error(`اسم ملف WAL غير صالح: ${name}`);
  await mkdir(spoolDir, { recursive: true });
  const dest = join(spoolDir, name);
  const existing = await stat(dest).then(() => true).catch(() => false);
  if (existing) {
    if ((await sha(dest)) === (await sha(srcPath))) return 'exists';
    throw new Error(`ملف WAL موجود بمحتوى مختلف (ما نكتب فوقه): ${name}`);
  }
  const tmp = `${dest}.tmp`;
  await pipeline(createReadStream(srcPath), createWriteStream(tmp));
  const fd = await open(tmp, 'r'); try { await fd.sync(); } finally { await fd.close(); }
  await rename(tmp, dest); await fsyncDir(spoolDir);
  return 'stored';
}

/** يشفر ويرفع كل ملفات الانتظار، ويحذف المحلي بعد التأكد من وصول الملف البعيد بنفس الحجم. يسجل الحالة (للتنبيه). */
export async function shipWal(cfg: BackupConfig, remote: Remote, publicKeyPem: string, now = new Date()): Promise<{ shipped: number; failed: number; remaining: number }> {
  await mkdir(cfg.spoolDir, { recursive: true }); await mkdir(cfg.workDir, { recursive: true });
  const names = (await readdir(cfg.spoolDir)).filter((n) => !n.endsWith('.tmp') && !n.endsWith('.partial')).sort();
  let shipped = 0; let failed = 0; let lastError: string | undefined; let lastName: string | undefined;
  for (const name of names) {
    const enc = join(cfg.workDir, `wal-${name}.enc`);
    try {
      const r = await encryptFile(join(cfg.spoolDir, name), enc, publicKeyPem);
      const key = `wal/${name}.enc`;
      await remote.put(enc, key);
      const got = (await remote.list(key)).find((e) => e.key === key);
      if (!got || got.size !== r.cipherSize) throw new Error(`الملف البعيد ما طابق الحجم بعد الرفع: ${name}`);
      await unlink(join(cfg.spoolDir, name)); shipped++; lastName = name;
    } catch (e) { failed++; lastError = (e as Error).message; }
    finally { await unlink(enc).catch(() => undefined); }
  }
  const left = (await readdir(cfg.spoolDir)).filter((n) => !n.endsWith('.tmp') && !n.endsWith('.partial'));
  let oldest: string | undefined;
  for (const n of left) { const m = (await stat(join(cfg.spoolDir, n))).mtime.toISOString(); if (!oldest || m < oldest) oldest = m; }
  await updateSection(cfg.stateDir, 'wal', {
    last_run_at: now.toISOString(), spool_files: left.length, oldest_spool_at: oldest,
    ...(shipped ? { last_shipped_name: lastName, last_shipped_at: now.toISOString() } : {}),
    ...(failed ? { last_error: lastError, last_error_at: now.toISOString() } : { last_ok_at: now.toISOString() }),
  });
  return { shipped, failed, remaining: left.length };
}

/** restore_command: يجيب ملف WAL من التخزين ويفك تشفيره. غياب الملف = نهاية الأرشيف (يرجع false مو خطأ). */
export async function restoreWal(remote: Remote, privateKeyPem: string, passphrase: string | undefined, workDir: string, name: string, destPath: string): Promise<boolean> {
  if (!SAFE_NAME.test(name)) throw new Error(`اسم ملف WAL غير صالح: ${name}`);
  await mkdir(workDir, { recursive: true });
  const tmp = join(workDir, `restore-${name}.enc`);
  try {
    const key = `wal/${name}.enc`;
    if (!(await remote.list(key)).some((e) => e.key === key)) return false;
    await remote.get(key, tmp);
    await decryptFile(tmp, destPath, privateKeyPem, passphrase);
    return true;
  } finally { await unlink(tmp).catch(() => undefined); }
}
