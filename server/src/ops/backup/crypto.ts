import { constants, createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rename, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

/**
 * تشفير النسخ الاحتياطية: هجين. كل ملف يتشفر بمفتاح AES-256-GCM عشوائي (يخصه وحده)، والمفتاح يتغلف بمفتاح RSA **العام**.
 * السيرفر يملك المفتاح العام بس، فحتى لو انسرق السيرفر والتخزين السحابي ما تنفتح النسخ. المفتاح الخاص عند المالك وحده.
 *
 * صيغة الملف: "CLBK1" | طول المفتاح المغلف (2 بايت) | المفتاح المغلف (RSA-OAEP-SHA256) | IV (12) | النص المشفر | وسم GCM (16).
 * الرأس كله مربوط بالتشفير كبيانات مصادقة (AAD): أي تعديل برأس الملف أو محتواه يفشل الفك.
 */
export const MAGIC = Buffer.from('CLBK1');
const IV_LEN = 12; const TAG_LEN = 16; const KEY_LEN = 32;

export class BackupCryptoError extends Error {}

export function generateBackupKeyPair(passphrase?: string): { publicKeyPem: string; privateKeyPem: string; fingerprint: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 4096 });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem', ...(passphrase ? { cipher: 'aes-256-cbc', passphrase } : {}) }).toString();
  return { publicKeyPem, privateKeyPem, fingerprint: keyFingerprint(publicKeyPem) };
}

/** بصمة المفتاح العام (SHA-256 على DER) للتأكد إن النسخ تتشفر بالمفتاح الصحيح */
export function keyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').match(/.{1,4}/g)!.slice(0, 8).join(':');
}

function loadPublic(pem: string): KeyObject {
  try { return createPublicKey(pem); } catch { throw new BackupCryptoError('المفتاح العام غير صالح'); }
}

export interface CryptoResult { plainSize: number; plainSha256: string; cipherSize: number }

/** يشفر ملف إلى ملف آخر (ستريم، يشتغل لملفات كبيرة). الكتابة لملف مؤقت ثم rename: ما يبقى ملف نصف مكتوب. */
export async function encryptFile(inPath: string, outPath: string, publicKeyPem: string): Promise<CryptoResult> {
  const pub = loadPublic(publicKeyPem);
  const key = randomBytes(KEY_LEN); const iv = randomBytes(IV_LEN);
  const wrapped = publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  const lenBuf = Buffer.alloc(2); lenBuf.writeUInt16BE(wrapped.length);
  const header = Buffer.concat([MAGIC, lenBuf, wrapped, iv]);
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(header);
  const hash = createHash('sha256'); let plainSize = 0; let started = false;
  const enc = new Transform({
    transform(chunk: Buffer, _e, cb) { if (!started) { this.push(header); started = true; } hash.update(chunk); plainSize += chunk.length; cb(null, cipher.update(chunk)); },
    flush(cb) { if (!started) this.push(header); this.push(cipher.final()); this.push(cipher.getAuthTag()); cb(); },
  });
  const tmp = `${outPath}.partial`;
  try {
    await pipeline(createReadStream(inPath), enc, createWriteStream(tmp));
    await rename(tmp, outPath);
  } catch (e) { await unlink(tmp).catch(() => undefined); throw e; }
  return { plainSize, plainSha256: hash.digest('hex'), cipherSize: (await stat(outPath)).size };
}

/** يفك التشفير. الناتج يكتب لملف مؤقت وما ينقل لمكانه إلا بعد نجاح فحص الوسم (سلامة الملف ومفتاح صحيح). */
export async function decryptFile(inPath: string, outPath: string, privateKeyPem: string, passphrase?: string): Promise<void> {
  let priv: KeyObject;
  try { priv = createPrivateKey({ key: privateKeyPem, ...(passphrase ? { passphrase } : {}) }); } catch { throw new BackupCryptoError('المفتاح الخاص غير صالح أو كلمة سره غلط'); }
  const size = (await stat(inPath)).size;
  if (size < MAGIC.length + 2 + IV_LEN + TAG_LEN) throw new BackupCryptoError('الملف قصير: مو نسخة مشفرة صالحة');
  const fh = await open(inPath, 'r');
  let header: Buffer; let tag: Buffer;
  try {
    const head = Buffer.alloc(MAGIC.length + 2); await fh.read(head, 0, head.length, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupCryptoError('الملف مو نسخة مشفرة (الصيغة غير معروفة)');
    const wl = head.readUInt16BE(MAGIC.length);
    const hl = MAGIC.length + 2 + wl + IV_LEN;
    if (wl < 128 || wl > 1024 || size < hl + TAG_LEN) throw new BackupCryptoError('رأس الملف تالف');
    header = Buffer.alloc(hl); await fh.read(header, 0, hl, 0);
    tag = Buffer.alloc(TAG_LEN); await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
  } finally { await fh.close(); }
  const wl = header.readUInt16BE(MAGIC.length);
  const wrapped = header.subarray(MAGIC.length + 2, MAGIC.length + 2 + wl); const iv = header.subarray(MAGIC.length + 2 + wl);
  let key: Buffer;
  try { key = privateDecrypt({ key: priv, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrapped); } catch { throw new BackupCryptoError('المفتاح الخاص ما يطابق هذي النسخة'); }
  const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(header); decipher.setAuthTag(tag);
  const tmp = `${outPath}.partial`;
  try {
    const bodyEnd = size - TAG_LEN;                                   // آخر 16 بايت هي الوسم
    if (bodyEnd > header.length) await pipeline(createReadStream(inPath, { start: header.length, end: bodyEnd - 1 }), decipher, createWriteStream(tmp));
    else { decipher.final(); await pipeline(Readable.from([]), createWriteStream(tmp)); }   // نص فاضي: نفحص الوسم بس
    await rename(tmp, outPath);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    if (e instanceof BackupCryptoError) throw e;
    throw new BackupCryptoError('فشل فك التشفير: الملف تالف أو انتعدل');
  }
}
