import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { baseBackup, logicalDump, prune } from '../ops/backup/base';
import { BackupConfig, loadConfig } from '../ops/backup/config';
import { generateBackupKeyPair } from '../ops/backup/crypto';
import { privateKey, publicKey } from '../ops/backup/proc';
import { remoteFromSpec } from '../ops/backup/remote';
import { publishVerify, recordVerify, restoreBase, verifyRestore } from '../ops/backup/restore';
import { evaluateHealth, readSection, Section, updateSection } from '../ops/backup/status';
import { listLocal, restoreUploads, syncUploads, uploadKey } from '../ops/backup/uploads';
import { archiveWal, restoreWal, shipWal } from '../ops/backup/wal';

/**
 * أدوات النسخ الاحتياطي: node dist/cli/backup.js <أمر>
 *   keygen --out DIR [--passphrase-env VAR]   مفتاحين (يشتغل على جهاز المالك، مو السيرفر)
 *   archive-wal [--spool DIR] %p %f           archive_command لـPostgreSQL
 *   ship                                      رفع ملفات WAL (كل دقيقة)
 *   base | logical | uploads | prune          مهام يومية منفصلة
 *   daily                                     base + logical + uploads + prune
 *   restore --target DIR [--time T] [--base ID]   تجهيز مجلد بيانات من النسخة
 *   restore-wal %f %p                         restore_command (يستدعيه PostgreSQL)
 *   restore-uploads --target DIR              استرجاع الصور
 *   verify                                    تجربة استرجاع كاملة بمجلد مؤقت (شهرياً)
 *   status                                    صحة النسخ (JSON)
 */
function opt(args: string[], name: string): string | undefined { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; }

async function alert(cfg: BackupConfig, message: string): Promise<void> {
  console.error(`[backup] ${message}`);
  if (!cfg.alertCommand) return;
  await new Promise<void>((res) => { const p = spawn('sh', ['-c', cfg.alertCommand as string], { env: { ...process.env, BACKUP_ALERT_MESSAGE: message }, stdio: 'ignore' }); p.on('close', () => res()); p.on('error', () => res()); });
}

async function tracked(cfg: BackupConfig, section: Section, fn: () => Promise<Record<string, unknown> | void>): Promise<void> {
  const now = new Date();
  try {
    const extra = (await fn()) ?? {};
    await updateSection(cfg.stateDir, section, { last_run_at: now.toISOString(), last_ok_at: new Date().toISOString(), ...extra });
  } catch (e) {
    const msg = (e as Error).message;
    await updateSection(cfg.stateDir, section, { last_run_at: now.toISOString(), last_error: msg, last_error_at: new Date().toISOString() }).catch(() => undefined);
    await alert(cfg, `فشل النسخ الاحتياطي (${section}): ${msg}`);
    throw e;
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const cfg = loadConfig();
  const cliPath = resolve(process.argv[1]);
  switch (cmd) {
    case 'keygen': {
      const out = opt(args, 'out'); if (!out) throw new Error('حدد --out DIR');
      const pass = opt(args, 'passphrase-env') ? process.env[opt(args, 'passphrase-env') as string] : undefined;
      const k = generateBackupKeyPair(pass);
      await mkdir(out, { recursive: true });
      await writeFile(join(out, 'backup-public.pem'), k.publicKeyPem); await writeFile(join(out, 'backup-private.pem'), k.privateKeyPem, { mode: 0o600 });
      console.log(`المفتاح العام (للسيرفر): ${join(out, 'backup-public.pem')}\nالمفتاح الخاص (للمالك فقط، لا ينرفع للسيرفر): ${join(out, 'backup-private.pem')}\nالبصمة: ${k.fingerprint}`);
      return;
    }
    case 'archive-wal': {
      const spool = opt(args, 'spool') ?? cfg.spoolDir; const pos = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--spool');
      if (pos.length !== 2) throw new Error('الاستخدام: archive-wal [--spool DIR] %p %f');
      await archiveWal(spool, pos[0], pos[1]); return;
    }
    case 'ship': await tracked(cfg, 'wal', async () => { const r = await shipWal(cfg, remoteFromSpec(cfg.remote), await publicKey(cfg)); if (r.failed) throw new Error(`فشل رفع ${r.failed} ملف WAL`); }); return;
    case 'base': case 'logical': case 'uploads': case 'prune': await runCmd(cmd); return;
    case 'daily': {
      const errs: string[] = [];
      for (const c of ['base', 'logical', 'uploads', 'prune']) { try { await runCmd(c); } catch (e) { errs.push(`${c}: ${(e as Error).message}`); } }
      if (errs.length) throw new Error(errs.join(' | ')); return;
    }
    case 'restore': {
      const target = opt(args, 'target'); if (!target) throw new Error('حدد --target DIR');
      const k = await privateKey(cfg);
      const m = await restoreBase(cfg, remoteFromSpec(cfg.remote), { targetDir: resolve(target), targetTime: opt(args, 'time'), baseId: opt(args, 'base'), privateKeyPem: k.pem, passphrase: k.passphrase, remoteSpec: cfg.remote as string, privateKeyPath: cfg.privateKeyPath as string, cliPath });
      console.log(`تجهزت البيانات من ${m.id} بالمجلد ${resolve(target)}.\nشغّل PostgreSQL عليه: pg_ctl -D ${resolve(target)} start (يكمل الاسترجاع تلقائياً من سجل التغييرات ثم يصير جاهز).`); return;
    }
    case 'restore-wal': {
      if (args.length !== 2) throw new Error('الاستخدام: restore-wal %f %p');
      const k = await privateKey(cfg);
      const ok = await restoreWal(remoteFromSpec(cfg.remote), k.pem, k.passphrase, cfg.workDir, args[0], args[1]);
      if (!ok) process.exitCode = 1; return;                   // غياب الملف = نهاية الأرشيف (PostgreSQL يتعامل معه)
    }
    case 'restore-uploads': {
      const target = opt(args, 'target'); if (!target) throw new Error('حدد --target DIR');
      const k = await privateKey(cfg);
      console.log(`انسترجع ${await restoreUploads(remoteFromSpec(cfg.remote), k.pem, k.passphrase, cfg.workDir, resolve(target))} ملف`); return;
    }
    case 'verify': {
      const k = await privateKey(cfg);
      try {
        const r = await verifyRestore(cfg, remoteFromSpec(cfg.remote), { privateKeyPem: k.pem, passphrase: k.passphrase, remoteSpec: cfg.remote as string, privateKeyPath: cfg.privateKeyPath as string, cliPath });
        await recordVerify(cfg, r); await publishVerify(cfg, remoteFromSpec(cfg.remote)).catch((e) => console.error(`[backup] تعذر نشر نتيجة الفحص: ${(e as Error).message}`));
        console.log(JSON.stringify(r, null, 1));
        if (!r.ok) { await alert(cfg, 'فحص الاسترجاع فشل: بعض الفحوص ما نجحت'); process.exitCode = 1; }
      } catch (e) { await recordVerify(cfg, e as Error); await publishVerify(cfg, remoteFromSpec(cfg.remote)).catch(() => undefined); await alert(cfg, `فحص الاسترجاع فشل: ${(e as Error).message}`); throw e; }
      return;
    }
    case 'status': {
      const s: Partial<Record<Section, never>> = {};
      const read = async (n: Section) => ((s as Record<string, unknown>)[n] = await readSection(cfg.stateDir, n));
      for (const n of ['base', 'logical', 'wal', 'uploads', 'prune', 'verify'] as Section[]) await read(n);
      console.log(JSON.stringify(evaluateHealth(s as never, new Date(), !!cfg.remote && !!cfg.publicKeyPath), null, 1)); return;
    }
    default: console.error('أمر غير معروف. راجع التعليق بأعلى cli/backup.ts'); process.exitCode = 2;
  }
}
async function runCmd(c: string): Promise<void> { const cfg = loadConfig(); const remote = remoteFromSpec(cfg.remote);
  if (c === 'base') return tracked(cfg, 'base', async () => { const m = await baseBackup(cfg, remote, await publicKey(cfg)); return { last_id: m.id, last_size: m.files.reduce((a, f) => a + f.cipher_size, 0) }; });
  if (c === 'logical') return tracked(cfg, 'logical', async () => ({ last_id: await logicalDump(cfg, remote, await publicKey(cfg)) }));
  if (c === 'uploads') return tracked(cfg, 'uploads', async () => { const r = await syncUploads(cfg, remote, await publicKey(cfg)); return { files_total: r.total, last_uploaded: r.uploaded }; });
  return tracked(cfg, 'prune', async () => { const keys = new Set((await listLocal(cfg.uploadDir)).map(uploadKey)); await prune(cfg, remote, new Date(), keys); });
}

main().catch((e) => { console.error(`[backup] ${(e as Error).message}`); process.exit(1); });
