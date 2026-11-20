import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** TOTP حسب RFC 6238 (HMAC-SHA1، 6 خانات، خطوة 30 ثانية) ليتوافق مع Google/Microsoft Authenticator وغيرهم. */
export const STEP_SECONDS = 30;
export const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('base32 غير صحيح');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** مفتاح عشوائي 160 بت (الحجم الموصى به)، مشفر base32 لتطبيق المصادقة. */
export const generateSecret = (): string => base32Encode(randomBytes(20));

export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepAt = (ms: number): number => Math.floor(ms / 1000 / STEP_SECONDS);

export const totpAt = (secretB32: string, ms: number): string => hotp(base32Decode(secretB32), stepAt(ms));

/**
 * يرجع الخطوة اللي طابقت (ضمن ±نافذة، افتراضياً ±1 = 30 ثانية تسامح لفرق الساعة) أو null.
 * الفحص كله يمشي حتى لو لقينا تطابق بدري، والمقارنة بوقت ثابت.
 */
export function findValidStep(secretB32: string, code: string, nowMs: number, window = 1): number | null {
  const normalized = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return null;
  const secret = base32Decode(secretB32);
  const current = stepAt(nowMs);
  let match: number | null = null;
  for (let step = current - window; step <= current + window; step++) {
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(normalized)) && match === null) match = step;
  }
  return match;
}

export function otpauthUri(secretB32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
