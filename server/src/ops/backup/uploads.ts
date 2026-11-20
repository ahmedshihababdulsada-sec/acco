import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { BackupConfig } from './config';
import { decryptFile, encryptFile } from './crypto';
import { Remote } from './remote';

export async function listLocal(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let names: string[]; try { names = await readdir(dir); } catch { return; }
    for (const n of names) { const full = join(dir, n); if ((await stat(full)).isDirectory()) await walk(full); else if (!n.endsWith('.partial')) out.push(relative(root, full).split(sep).join('/')); }
  };
  await walk(root);
  return out.sort();
}

export const uploadKey = (rel: string): string => `uploads/${rel}.enc`;

/**
 * نسخ صور الإثبات وقبل/بعد والشعار: الملفات ما تتعدل أبداً (اسمها عشوائي)، فنرفع الجديد بس (مشفراً) وما نعيد رفع القديم.
 * التحقق بعد كل رفع (الحجم). الملف المحلي المحذوف يبقى بالنسخة لحد انتهاء مدة الاحتفاظ (تنظف prune).
 */
export async function syncUploads(cfg: BackupConfig, remote: Remote, publicKeyPem: string): Promise<{ uploaded: number; total: number; keys: Set<string> }> {
  await mkdir(cfg.workDir, { recursive: true });
  const local = await listLocal(cfg.uploadDir);
  const have = new Set((await remote.list('uploads/')).map((e) => e.key));
  let uploaded = 0;
  for (const rel of local) {
    const key = uploadKey(rel); if (have.has(key)) continue;
    const enc = join(cfg.workDir, `up-${Date.now()}-${uploaded}.enc`);
    try {
      const r = await encryptFile(join(cfg.uploadDir, rel), enc, publicKeyPem);
      await remote.put(enc, key);
      const got = (await remote.list(key)).find((e) => e.key === key);
      if (!got || got.size !== r.cipherSize) throw new Error(`الملف البعيد ما طابق الحجم بعد الرفع: ${key}`);
      uploaded++;
    } finally { await rm(enc, { force: true }); }
  }
  return { uploaded, total: local.length, keys: new Set(local.map(uploadKey)) };
}

/** استرجاع كل الصور لمجلد جديد (ما نكتب فوق ملف موجود). */
export async function restoreUploads(remote: Remote, privateKeyPem: string, passphrase: string | undefined, workDir: string, targetDir: string): Promise<number> {
  await mkdir(targetDir, { recursive: true }); await mkdir(workDir, { recursive: true });
  let n = 0;
  for (const e of await remote.list('uploads/')) {
    const rel = e.key.slice('uploads/'.length).replace(/\.enc$/, ''); const dest = join(targetDir, rel);
    if (await stat(dest).then(() => true).catch(() => false)) continue;
    await mkdir(join(dest, '..'), { recursive: true });
    const tmp = join(workDir, `rest-${n}.enc`);
    try { await remote.get(e.key, tmp); await decryptFile(tmp, dest, privateKeyPem, passphrase); n++; } finally { await rm(tmp, { force: true }); }
  }
  return n;
}
