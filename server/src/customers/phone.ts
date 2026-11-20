import { Errors } from '../common/errors';

const ARABIC_DIGITS: Record<string, string> = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };

/**
 * يوحد رقم موبايل عراقي لصيغة +9647XXXXXXXXX (القسم 12 ز): 07xx = +9647xx.
 * يقبل مسافات وشرطات وأقواس وأرقام عربية، وبادئات 0 أو 964 أو +964 أو 00964. أي شي ثاني → 400.
 */
export function normalizePhone(raw: string): string {
  let s = String(raw ?? '').replace(/[٠-٩۰-۹]/g, (c) => ARABIC_DIGITS[c]).replace(/[\s\-().]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('00964')) s = s.slice(5);
  else if (s.startsWith('964')) s = s.slice(3);
  else if (s.startsWith('0')) s = s.slice(1);
  if (!/^7[0-9]{9}$/.test(s)) throw Errors.badRequest('INVALID_PHONE', 'رقم الموبايل غير صحيح (مثال: 07701234567)');
  return `+964${s}`;
}

/** للبحث: يرجع الرقم الموحد إذا النص رقم كامل، وإلا null. */
export function tryNormalizePhone(raw: string): string | null {
  try { return normalizePhone(raw); } catch { return null; }
}
