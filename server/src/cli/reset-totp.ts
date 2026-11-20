/**
 * إعادة تعيين التحقق الثنائي للمالك (لو ضاع التلفون ورموز الاسترجاع). يتنفذ من السيرفر بس:
 *   node dist/cli/reset-totp.js --owner owner
 * المالك أعلى دور ما أحد فوقه يعيد له، فالإعادة بصلاحية الوصول للسيرفر. بعدها يسوي الإعداد من جديد بأول دخول.
 */
import { Client } from 'pg';

export async function resetTotp(c: Pick<Client, 'query'>, username: string): Promise<boolean> {
  const u = await c.query(`select id from users where lower(username) = lower($1) and role = 'owner' for update`, [username]);
  if (!u.rowCount) return false;
  const id = u.rows[0].id;
  await c.query(`update users set totp_secret_enc = null, totp_enabled_at = null, totp_last_step = null, failed_logins = 0, locked_until = null where id = $1`, [id]);
  await c.query(`delete from totp_recovery_codes where user_id = $1`, [id]);
  await c.query(`update refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null`, [id]); // كل الأجهزة تطلع
  await c.query(`insert into audit_log (actor_role, action, entity_type, entity_id, reason) values ('system', 'auth.totp_reset', 'user', $1, 'server cli')`, [id]);
  return true;
}

async function main() {
  const i = process.argv.indexOf('--owner');
  const username = i >= 0 ? process.argv[i + 1] : undefined;
  if (!username) { console.error('ناقص: --owner <اسم المستخدم>'); process.exit(2); }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL مطلوب'); process.exit(2); }
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query('begin');
    const ok = await resetTotp(c, username);
    if (!ok) throw new Error('ما لقيت مالك بهذا الاسم');
    await c.query('commit');
    console.log('انعاد التحقق الثنائي للمالك وانسحبت كل جلساته. يسوي الإعداد من جديد بأول دخول.');
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    console.error('فشل:', (e as Error).message);
    process.exitCode = 1;
  } finally { await c.end(); }
}
if (require.main === module) void main();
