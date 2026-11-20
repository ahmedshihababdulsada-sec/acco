export interface AppConfig {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  totpEncKey: Buffer;      // مفتاح تشفير أسرار TOTP (32 بايت)
  totpIssuer: string;      // الاسم اللي يظهر بتطبيق المصادقة
  accessTtlSeconds: number;
  refreshTtlDays: number;
  loginMaxFailures: number;
  lockMinutes: number;
  trustProxy: boolean;
  uploadDir: string;       // مجلد الملفات المرفوعة (صور الإثبات...). التخزين السحابي لاحقاً عند التنصيب
  maxUploadBytes: number;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

function int(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${key} لازم يكون رقم صحيح موجب`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL مطلوب');
  const jwtSecret = env.JWT_SECRET ?? '';
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET لازم يكون 32 حرف على الأقل');
  const totpEncKey = Buffer.from(env.TOTP_ENC_KEY ?? '', 'base64');
  if (totpEncKey.length !== 32) throw new Error('TOTP_ENC_KEY لازم يكون 32 بايت بصيغة base64 (مثال: openssl rand -base64 32)');
  return {
    port: int(env, 'PORT', 3000),
    databaseUrl,
    jwtSecret,
    totpEncKey,
    totpIssuer: env.TOTP_ISSUER?.trim() || 'Clinic',
    accessTtlSeconds: int(env, 'ACCESS_TTL_SECONDS', 900),
    refreshTtlDays: int(env, 'REFRESH_TTL_DAYS', 30),
    loginMaxFailures: int(env, 'LOGIN_MAX_FAILURES', 5),
    lockMinutes: int(env, 'LOCK_MINUTES', 15),
    trustProxy: env.TRUST_PROXY === '1',
    uploadDir: env.UPLOAD_DIR?.trim() || './uploads',
    maxUploadBytes: int(env, 'MAX_UPLOAD_BYTES', 8 * 1024 * 1024),
  };
}
