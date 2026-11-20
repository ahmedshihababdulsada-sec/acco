/**
 * تهيئة عيادة جديدة (تنفّذ مرة وحدة بعد تنصيب القاعدة من schema.sql):
 *   node dist/cli/setup.js --branch-code MAIN --branch-name "الفرع الرئيسي" --owner owner --owner-name "اسم المالك"
 * ينشئ الفرع والخزنة وطريقة الكاش والكشفية (معطلة لحد ما يحدد المدير سعرها) وأيام الدوام (كلها مفتوحة، والمدير يحددها) وحساب المالك برمز مؤقت يظهر مرة وحدة (لازم يتغير بأول دخول).
 */
import { Client } from 'pg';
import { generateTempPassword, hashPassword } from '../common/passwords';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) { console.error(`ناقص: --${name}`); process.exit(2); }
  return v;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL مطلوب'); process.exit(2); }
  const code = arg('branch-code'), branchName = arg('branch-name'), username = arg('owner'), ownerName = arg('owner-name');
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('begin');
    const existing = await c.query(`select count(*)::int as n from users where role = 'owner'`);
    if (existing.rows[0].n > 0) throw new Error('يوجد مالك مسبقاً: التهيئة تتنفذ مرة وحدة بس');
    const b = await c.query(`insert into branches (code, name) values ($1,$2) returning id`, [code, branchName]);
    const branchId = b.rows[0].id;
    await c.query(`insert into safes (branch_id, balance) values ($1, 0)`, [branchId]);
    // طريقة الكاش: واحدة ثابتة لكل فرع (الطرق الإلكترونية يضيفها المدير)
    await c.query(`insert into payment_methods (branch_id, name_ar, kind, sort_order) values ($1, 'كاش', 'cash', 0)`, [branchId]);
    // الكشفية: خدمة واحدة بسعر ثابت لكل فرع. تنشأ معطلة، والمدير يحدد سعرها ويفعّلها من صفحة الخدمات
    await c.query(`insert into services (branch_id, name_ar, kind, pricing_model, is_active) values ($1, 'كشفية', 'consultation', 'fixed', false)`, [branchId]);
    // أيام الدوام: كلها مفتوحة بالبداية (ما أكو قرار بخطتنا)، والمدير يحدد أيام العيادة من صفحة الدوام والعطل قبل ما تبدي الحجوزات
    await c.query(`insert into clinic_weekdays (branch_id, weekday, is_open) select $1, d, true from generate_series(1,7) d`, [branchId]);
    const temp = generateTempPassword();
    await c.query(
      `insert into users (username, password_hash, full_name, role, branch_id, must_change_password) values ($1,$2,$3,'owner',null,true)`,
      [username, await hashPassword(temp), ownerName]);
    await c.query('commit');
    console.log(`تمت التهيئة. الفرع: ${code}`);
    console.log(`حساب المالك: ${username}`);
    console.log(`الرمز المؤقت (يظهر مرة وحدة، لازم تغيّره بأول دخول): ${temp}`);
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    console.error('فشلت التهيئة:', (e as Error).message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}
main();
