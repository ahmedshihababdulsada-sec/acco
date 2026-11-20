import { randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { Errors } from './errors';

export const hashPassword = (plain: string): Promise<string> => hash(plain);

export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  try { return await verify(stored, plain); } catch { return false; }
}

// مقارنة وهمية لما المستخدم غير موجود، حتى ما يختلف الوقت ويكشف الأسماء الموجودة
let dummy: Promise<string> | null = null;
export async function dummyVerify(plain: string): Promise<void> {
  dummy ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(await dummy, plain);
}

/** سياسة الرمز السري للموظفين: 8 أحرف على الأقل، وما يساوي اسم المستخدم. */
export function assertPasswordPolicy(password: string, username: string): void {
  if (password.length < 8) throw Errors.badRequest('WEAK_PASSWORD', 'الرمز السري لازم يكون 8 أحرف على الأقل');
  if (password.length > 128) throw Errors.badRequest('WEAK_PASSWORD', 'الرمز السري طويل جداً');
  if (password.toLowerCase() === username.toLowerCase()) throw Errors.badRequest('WEAK_PASSWORD', 'الرمز السري ما يكون نفس اسم المستخدم');
}

const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // بدون حروف متشابهة (l, 1, O, 0, I)
/** رمز مؤقت عشوائي (12 خانة)، يظهر مرة وحدة للي أنشأه ويلزم الموظف يغيّره. */
export function generateTempPassword(length = 12): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}
