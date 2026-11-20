import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { BackupConfig } from './config';

export interface RunResult { stdout: string; stderr: string }

export function run(bin: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; allowFail?: boolean } = {}): Promise<RunResult & { code: number }> {
  return new Promise((res, rej) => {
    const p = spawn(bin, args, { env: opts.env ?? process.env, cwd: opts.cwd });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => (stdout += d)); p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => rej(new Error(`تعذر تشغيل ${bin}: ${e.message}`)));
    p.on('close', (code) => {
      if (code === 0 || opts.allowFail) res({ stdout, stderr, code: code ?? -1 });
      else rej(new Error(`${bin} ${args[0] ?? ''} فشل (${code}): ${(stderr || stdout).trim().slice(-400)}`));
    });
  });
}

export async function publicKey(cfg: BackupConfig): Promise<string> {
  if (!cfg.publicKeyPath) throw new Error('BACKUP_PUBLIC_KEY غير مضبوط (المفتاح العام للتشفير)');
  return readFile(cfg.publicKeyPath, 'utf8');
}

export async function privateKey(cfg: BackupConfig): Promise<{ pem: string; passphrase?: string }> {
  if (!cfg.privateKeyPath) throw new Error('BACKUP_PRIVATE_KEY غير مضبوط (المفتاح الخاص: يلزم للاسترجاع فقط وهو عند المالك)');
  return { pem: await readFile(cfg.privateKeyPath, 'utf8'), passphrase: cfg.privateKeyPassphrase };
}

/** معرف زمني للنسخة: 20261114T030000Z */
export const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
export function parseStamp(id: string): Date | null {
  const m = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(id);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}
