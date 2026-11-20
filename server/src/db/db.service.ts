import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { APP_CONFIG, AppConfig } from '../config/config';

/** أي شي ينفذ استعلام: الـ pool نفسه أو اتصال داخل معاملة. */
export interface Queryable {
  query<R extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
}

/** أخطاء PostgreSQL اللي المعاملة تنعاد عليها (الاختبارات أثبتت إن الـ exclusion constraint يطلع 40P01 أحياناً). */
const RETRYABLE = new Set(['40P01', '40001']);

@Injectable()
export class DbService implements OnModuleDestroy, Queryable {
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  }

  query<R extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<QueryResult<R>> {
    return this.pool.query<R>(text, params as any[]);
  }

  /** معاملة وحدة، all or nothing، وتنعاد (حتى 3 مرات) عند deadlock أو serialization failure. */
  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const client: PoolClient = await this.pool.connect();
      try {
        await client.query('begin');
        const result = await fn(client);
        await client.query('commit');
        return result;
      } catch (err: any) {
        try { await client.query('rollback'); } catch { /* الاتصال انقطع */ }
        if (RETRYABLE.has(err?.code) && attempt < 3) continue;
        throw err;
      } finally {
        client.release();
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
