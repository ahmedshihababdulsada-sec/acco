import { hash } from '@node-rs/argon2';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { encryptSecret } from '../src/common/secret-box';

export const TEST_PASSWORD = 'Pass#12345678';
/** مفتاح TOTP ثابت لحساب المالك 'owner' بالاختبارات (RFC 6238: ASCII 12345678901234567890 بصيغة base32) */
export const TEST_OWNER_TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

/** يبني قاعدة clinic_api_test من schema.sql ويزرع المستخدمين الأساسيين. السيرفر المحلي (المنفذ 5544) لازم يكون شغال. */
export default async function globalSetup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://clinic@127.0.0.1:5544/clinic_api_test';
  const adminUrl = url.replace(/\/[^/]+$/, '/postgres');
  const dbName = url.split('/').pop()!;
  if (!/^clinic_[a-z_]*test$/.test(dbName)) throw new Error(`رفضت: اسم القاعدة "${dbName}" مو قاعدة اختبار`);

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect().catch((e) => { throw new Error(`ما قدرت أتصل بـ PostgreSQL على المنفذ 5544. شغّل السيرفر (database/README.md). ${e.message}`); });
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.query(`create database ${dbName}`);
  await admin.end();

  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query(readFileSync(join(__dirname, '../../database/schema.sql'), 'utf8'));

  const pw = await hash(TEST_PASSWORD);
  const b1 = (await c.query(`insert into branches (code, name) values ('B1','الفرع الأول') returning id`)).rows[0].id;
  const b2 = (await c.query(`insert into branches (code, name) values ('B2','الفرع الثاني') returning id`)).rows[0].id;
  const add = (username: string, role: string, branch: number | null) =>
    c.query(`insert into users (username, password_hash, full_name, role, branch_id, must_change_password) values ($1,$2,$3,$4,$5,false)`,
      [username, pw, `${role} ${username}`, role, branch]);
  await add('owner', 'owner', null);
  await c.query(`update users set totp_secret_enc = $1, totp_enabled_at = now() where username = 'owner'`,
    [encryptSecret(TEST_OWNER_TOTP_SECRET, Buffer.alloc(32, 7))]);
  await add('mgr1', 'manager', b1);
  await add('mgr1b', 'manager', b1);
  await add('mgr2', 'manager', b2);
  await add('cash1', 'cashier', b1);
  await add('doc1', 'doctor', b1);
  await add('nurse1', 'nurse', b1);
  await c.query(`insert into doctors (user_id) select id from users where username = 'doc1'`);
  // طريقة الكاش لكل فرع (مثل ما يسوي أمر التهيئة)
  for (const b of [b1, b2]) await c.query(`insert into payment_methods (branch_id, name_ar, kind, sort_order) values ($1,'كاش','cash',0)`, [b]);
  for (const b of [b1, b2]) await c.query(`insert into safes (branch_id, balance) values ($1, 0)`, [b]);                // مثل أمر التهيئة
  await c.end();
}
