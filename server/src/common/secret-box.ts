import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** تشفير AES-256-GCM لأسرار الحقول (مفتاح TOTP). الصيغة: v1.iv.tag.ciphertext بـ base64url. */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(boxed: string, key: Buffer): string {
  const [v, iv, tag, ct] = boxed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('صيغة السر المشفر غير معروفة');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
