import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Errors, apiError } from '../common/errors';
import { Queryable } from '../db/db.service';

const KEY_RE = /^[A-Za-z0-9_\-:.]{8,100}$/;

export interface Replay { status: number; body: unknown }

/**
 * مفتاح منع التكرار (القسم 12 أ). يتسجل بنفس معاملة العملية: إذا فشلت العملية يتراجع المفتاح معاها (فإعادة المحاولة تشتغل من جديد)،
 * وإذا نجحت يتخزن الرد بنفس اللحظة. طلب ثاني بنفس المفتاح وقت تنفيذ الأول يوقف على الفهرس الفريد لحد ما يخلص الأول، وبعدين يرجع نفس الرد.
 */
@Injectable()
export class IdempotencyService {
  static validate(key: string | undefined): string {
    if (!key) throw apiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'ترويسة Idempotency-Key مطلوبة لهذي العملية');
    if (!KEY_RE.test(key)) throw apiError(400, 'IDEMPOTENCY_KEY_INVALID', 'مفتاح منع التكرار لازم 8 إلى 100 حرف (أحرف وأرقام و - _ : .)');
    return key;
  }

  /** null = أول مرة (كمل التنفيذ). غير null = نفس الطلب انعاد: رجّع الرد المخزن. */
  async begin(q: Queryable, userId: number, key: string, endpoint: string, body: unknown): Promise<Replay | null> {
    const hash = createHash('sha256').update(JSON.stringify(canonical({ endpoint, body }))).digest('hex');
    await q.query(`delete from idempotency_keys where actor_type = 'user' and actor_id = $1 and key = $2 and expires_at < now()`, [userId, key]);
    const ins = await q.query(
      `insert into idempotency_keys (actor_type, actor_id, key, endpoint, request_hash) values ('user', $1, $2, $3, $4) on conflict do nothing returning key`,
      [userId, key, endpoint, hash]);
    if (ins.rowCount) return null;
    const row = (await q.query(`select endpoint, request_hash, status, response_status, response_body from idempotency_keys where actor_type = 'user' and actor_id = $1 and key = $2`, [userId, key])).rows[0];
    if (!row) throw Errors.conflict('IDEMPOTENCY_RETRY', 'حاول مرة ثانية');
    if (row.request_hash !== hash || row.endpoint !== endpoint) throw apiError(422, 'IDEMPOTENCY_KEY_REUSED', 'نفس المفتاح انستخدم لطلب مختلف');
    if (row.status !== 'done') throw Errors.conflict('IDEMPOTENCY_IN_PROGRESS', 'الطلب قيد التنفيذ');
    return { status: Number(row.response_status), body: row.response_body };
  }

  async finish(q: Queryable, userId: number, key: string, status: number, body: unknown, resourceType: string, resourceId: number): Promise<void> {
    await q.query(
      `update idempotency_keys set status = 'done', response_status = $3, response_body = $4, resource_type = $5, resource_id = $6 where actor_type = 'user' and actor_id = $1 and key = $2`,
      [userId, key, status, JSON.stringify(body), resourceType, resourceId]);
  }
}

/** ترتيب ثابت للمفاتيح حتى نفس الطلب بترتيب حقول مختلف يطلع نفس البصمة */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as any)[k])]));
  return v;
}
