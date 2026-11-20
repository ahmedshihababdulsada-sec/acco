import { hash } from '@node-rs/argon2';
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.factory';
import { clock } from '../src/common/clock';
import { stepAt, totpAt } from '../src/auth/totp';
import { TEST_OWNER_TOTP_SECRET } from './global-setup';

export const PASSWORD = 'Pass#12345678';

export async function makeApp(): Promise<INestApplication> {
  const app = await createApp();
  await app.init();
  return app;
}

export const pool = () => new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

export async function branchId(db: Pool, code: string): Promise<number> {
  return Number((await db.query(`select id from branches where code = $1`, [code])).rows[0].id);
}

/** ينشئ مستخدم جديد مباشرة بالقاعدة (للاختبارات اللي تخرب حالة الحساب). */
export async function seedUser(db: Pool, username: string, role: string, branch: number | null, opts: { mustChange?: boolean; active?: boolean } = {}) {
  const pw = await hash(PASSWORD);
  const r = await db.query(
    `insert into users (username, password_hash, full_name, role, branch_id, must_change_password, is_active, deactivated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [username, pw, `${role} ${username}`, role, branch, opts.mustChange ?? false, opts.active ?? true, (opts.active ?? true) ? null : new Date()]);
  if (role === 'doctor') await db.query(`insert into doctors (user_id) values ($1)`, [r.rows[0].id]);
  return Number(r.rows[0].id);
}

export async function login(app: INestApplication, username: string, password = PASSWORD) {
  const res = await request(app.getHttpServer()).post('/auth/login').send({ username, password });
  return res;
}

/** يمرر خطوة TOTP كاملة لمالك (login ← verify). الساعة مزيفة وتتقدم بحيث كل دخول يستخدم خطوة جديدة (يحترم منع إعادة الاستخدام). */
export async function ownerLogin(app: INestApplication, db: Pool, username = 'owner', secret = TEST_OWNER_TOTP_SECRET) {
  const l = await login(app, username);
  if (l.body.status !== 'totp_required') throw new Error(`متوقع totp_required: ${JSON.stringify(l.body)}`);
  const last = (await db.query(`select totp_last_step from users where lower(username) = lower($1)`, [username])).rows[0]?.totp_last_step;
  const step = Math.max(stepAt(Date.now()), last ? Number(last) + 1 : 0);
  clock.now = () => step * 30_000 + 1_000;
  return request(app.getHttpServer()).post('/auth/totp/verify')
    .send({ challenge_token: l.body.challenge_token, code: totpAt(secret, clock.now()) });
}

export async function tokenFor(app: INestApplication, username: string): Promise<string> {
  if (username === 'owner') {
    const db = pool();
    try {
      const res = await ownerLogin(app, db);
      if (res.status !== 200) throw new Error(`owner login failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.access_token;
    } finally { await db.end(); }
  }
  const res = await login(app, username);
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.access_token;
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
