import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Section = 'base' | 'logical' | 'wal' | 'uploads' | 'prune' | 'verify';
export interface SectionState {
  last_ok_at?: string; last_run_at?: string; last_error?: string; last_error_at?: string;
  [k: string]: unknown;
}

/** كل مهمة تكتب ملفها (ما أكو تعارض بين المؤقتات). الكتابة ذرية. */
export async function updateSection(stateDir: string, section: Section, patch: SectionState): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const cur = (await readSection(stateDir, section)) ?? {};
  const next = { ...cur, ...patch };
  const file = join(stateDir, `${section}.json`); const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(next)); await rename(tmp, file);
}

export async function readSection(stateDir: string, section: Section): Promise<SectionState | null> {
  try { return JSON.parse(await readFile(join(stateDir, `${section}.json`), 'utf8')) as SectionState; } catch { return null; }
}

export interface Problem { level: 'error' | 'warn'; code: string; message: string }
export interface BackupHealth {
  configured: boolean; ok: boolean; problems: Problem[];
  base_last_ok_at: string | null; wal_last_run_at: string | null; wal_spool_files: number; uploads_last_ok_at: string | null; verify_last_ok_at: string | null;
}

const H = 3_600_000; const MIN = 60_000;
export const LIMITS = { baseMaxAgeMs: 26 * H, walRunMaxAgeMs: 15 * MIN, spoolOldestMaxAgeMs: 15 * MIN, uploadsMaxAgeMs: 26 * H, verifyMaxAgeMs: 35 * 24 * H };

const ago = (ms: number) => (ms >= 48 * H ? `${Math.floor(ms / (24 * H))} يوم` : ms >= H ? `${Math.floor(ms / H)} ساعة` : `${Math.max(1, Math.floor(ms / MIN))} دقيقة`);

/** حالة النسخ الاحتياطي بصيغة يفهمها المالك: مشاكل واضحة بدل أرقام. تُحسب من ملفات الحالة (الوقت يتمرر للاختبار). */
export function evaluateHealth(s: Partial<Record<Section, SectionState | null>>, now: Date, configured: boolean): BackupHealth {
  const problems: Problem[] = []; const t = now.getTime();
  const at = (v: unknown) => (typeof v === 'string' ? Date.parse(v) : NaN);
  const base = s.base; const wal = s.wal; const up = s.uploads; const ver = s.verify;
  const out = (): BackupHealth => ({
    configured, ok: !problems.some((p) => p.level === 'error') && configured, problems,
    base_last_ok_at: (base?.last_ok_at as string) ?? null, wal_last_run_at: (wal?.last_run_at as string) ?? null, wal_spool_files: Number(wal?.spool_files ?? 0),
    uploads_last_ok_at: (up?.last_ok_at as string) ?? null, verify_last_ok_at: (ver?.last_ok_at as string) ?? null,
  });
  if (!configured) { problems.push({ level: 'error', code: 'NOT_CONFIGURED', message: 'النسخ الاحتياطي غير مضبوط على هذا السيرفر' }); return out(); }

  const failing = (name: string, st?: SectionState | null) => !!st?.last_error_at && (!st.last_ok_at || Date.parse(st.last_error_at) > Date.parse(st.last_ok_at));
  const b = at(base?.last_ok_at);
  if (Number.isNaN(b)) problems.push({ level: 'error', code: 'BASE_NEVER', message: 'ما انعملت نسخة كاملة ناجحة بعد' });
  else if (t - b > LIMITS.baseMaxAgeMs) problems.push({ level: 'error', code: 'BASE_STALE', message: `آخر نسخة كاملة ناجحة قبل ${ago(t - b)}` });
  if (failing('base', base)) problems.push({ level: 'error', code: 'BASE_FAILED', message: `فشلت آخر محاولة نسخ كامل: ${base?.last_error}` });

  const w = at(wal?.last_run_at);
  if (Number.isNaN(w)) problems.push({ level: 'error', code: 'WAL_NEVER', message: 'رفع سجل التغييرات (WAL) ما اشتغل بعد' });
  else if (t - w > LIMITS.walRunMaxAgeMs) problems.push({ level: 'error', code: 'WAL_STALE', message: `رفع سجل التغييرات متوقف منذ ${ago(t - w)}: الحماية المستمرة مو شغالة` });
  const oldest = at(wal?.oldest_spool_at);
  if (!Number.isNaN(oldest) && t - oldest > LIMITS.spoolOldestMaxAgeMs) problems.push({ level: 'error', code: 'WAL_BACKLOG', message: `${wal?.spool_files} ملف WAL ينتظر الرفع من ${ago(t - oldest)}` });
  if (failing('wal', wal)) problems.push({ level: 'error', code: 'WAL_FAILED', message: `فشل رفع WAL: ${wal?.last_error}` });

  const u = at(up?.last_ok_at);
  if (Number.isNaN(u)) problems.push({ level: 'warn', code: 'UPLOADS_NEVER', message: 'ما انعملت نسخة لمجلد الصور بعد' });
  else if (t - u > LIMITS.uploadsMaxAgeMs) problems.push({ level: 'error', code: 'UPLOADS_STALE', message: `آخر نسخة للصور قبل ${ago(t - u)}` });
  if (failing('uploads', up)) problems.push({ level: 'error', code: 'UPLOADS_FAILED', message: `فشل نسخ الصور: ${up?.last_error}` });

  const v = at(ver?.last_ok_at);
  if (failing('verify', ver)) problems.push({ level: 'error', code: 'VERIFY_FAILED', message: `فحص الاسترجاع فشل: ${ver?.last_error}` });
  else if (Number.isNaN(v)) problems.push({ level: 'warn', code: 'VERIFY_NEVER', message: 'ما انجرّب استرجاع نسخة بعد (لازم يتجرب شهرياً)' });
  else if (t - v > LIMITS.verifyMaxAgeMs) problems.push({ level: 'warn', code: 'VERIFY_STALE', message: `آخر تجربة استرجاع ناجحة قبل ${ago(t - v)}` });
  if (failing('prune', s.prune)) problems.push({ level: 'warn', code: 'PRUNE_FAILED', message: `فشل تنظيف النسخ القديمة: ${s.prune?.last_error}` });
  if (failing('logical', s.logical)) problems.push({ level: 'warn', code: 'LOGICAL_FAILED', message: `فشل التفريغ المنطقي: ${s.logical?.last_error}` });
  return out();
}

/** نتيجة فحص الاسترجاع: ممكن تكون محلية أو منشورة بالتخزين من جهاز المالك (المفتاح الخاص ما ينحط على السيرفر): نأخذ الأحدث تشغيلاً. */
export function pickVerify(local: SectionState | null | undefined, remote: SectionState | null | undefined): SectionState | null {
  const t = (x?: SectionState | null) => (x?.last_run_at ? Date.parse(String(x.last_run_at)) : NaN);
  if (!local && !remote) return null;
  if (!local) return remote ?? null;
  if (!remote) return local;
  const a = t(local); const b = t(remote);
  if (Number.isNaN(a)) return remote; if (Number.isNaN(b)) return local;
  return b > a ? remote : local;
}
