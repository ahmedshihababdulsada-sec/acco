import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface BackupConfig {
  remote?: string;            // dir:/path أو rclone:remote:bucket/path
  publicKeyPath?: string;     // المفتاح العام (التشفير). موجود على السيرفر
  privateKeyPath?: string;    // المفتاح الخاص: يلزم فقط لجهاز الاسترجاع (عند المالك)، مو على السيرفر
  privateKeyPassphrase?: string;
  spoolDir: string;           // WAL ينتظر الرفع
  stateDir: string;           // حالة النسخ (للتنبيهات ولشاشة المالك)
  workDir: string;
  pgBin?: string;             // مجلد أدوات PostgreSQL إذا مو بالـPATH
  databaseUrl?: string;
  uploadDir: string;
  tzOffsetMin: number;        // لتجميع النسخ بالأيام: بغداد = +180
  alertCommand?: string;
  retention: { daily: number; weekly: number; monthly: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackupConfig {
  const n = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    remote: env.BACKUP_REMOTE || undefined,
    publicKeyPath: env.BACKUP_PUBLIC_KEY || undefined,
    privateKeyPath: env.BACKUP_PRIVATE_KEY || undefined,
    privateKeyPassphrase: env.BACKUP_PRIVATE_KEY_PASSPHRASE || undefined,
    spoolDir: env.BACKUP_SPOOL_DIR || '/var/lib/clinic-backup/spool',
    stateDir: env.BACKUP_STATE_DIR || '/var/lib/clinic-backup/state',
    workDir: env.BACKUP_WORK_DIR || join(tmpdir(), 'clinic-backup'),
    pgBin: env.PGBIN || undefined,
    databaseUrl: env.DATABASE_URL || undefined,
    uploadDir: env.UPLOAD_DIR || './uploads',
    tzOffsetMin: n(env.BACKUP_TZ_OFFSET_MIN, 180),
    alertCommand: env.BACKUP_ALERT_COMMAND || undefined,
    retention: { daily: n(env.BACKUP_KEEP_DAILY, 7), weekly: n(env.BACKUP_KEEP_WEEKLY, 4), monthly: n(env.BACKUP_KEEP_MONTHLY, 12) },
  };
}

export const pgTool = (cfg: BackupConfig, name: string): string => (cfg.pgBin ? join(cfg.pgBin, name) : name);
