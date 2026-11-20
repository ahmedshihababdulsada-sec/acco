/**
 * عيادة تجريبية للتطوير والتجربة (مو للإنتاج): تُنشئ قاعدة demo كاملة بعيادة وموظفين وخدمات ومواد وزبائن وحجوزات.
 *   DATABASE_URL=postgres://clinic@127.0.0.1:5544/clinic_demo JWT_SECRET=... TOTP_ENC_KEY=... node dist/cli/demo.js
 * ترفض الاشتغال إلا على قاعدة اسمها يحتوي demo وفاضية. كل الحسابات برمز Demo#12345678، ومفتاح TOTP للمالك ثابت (يظهر بالنهاية).
 */
import { Client } from 'pg';
import { INestApplication } from '@nestjs/common';
import { createApp } from '../app.factory';
import { encryptSecret } from '../common/secret-box';
import { hashPassword } from '../common/passwords';

export const DEMO_PASSWORD = 'Demo#12345678';
export const DEMO_OWNER_TOTP = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !/demo/.test(url.split('/').pop() ?? '')) { console.error('رفضت: DATABASE_URL لازم يشير لقاعدة اسمها يحتوي demo'); process.exit(2); }
  const keyB64 = process.env.TOTP_ENC_KEY ?? '';
  const db = new Client({ connectionString: url }); await db.connect();
  if (Number((await db.query(`select count(*)::int as n from users`)).rows[0].n) > 0) { console.error('القاعدة مو فاضية'); process.exit(2); }
  const pw = await hashPassword(DEMO_PASSWORD);

  // ---- العيادة والموظفين (مباشرة بالقاعدة)
  const b = (await db.query(`insert into branches (code, name) values ('DEMO','مركز الياسمين للتجميل') returning id`)).rows[0].id;
  await db.query(`insert into safes (branch_id) values ($1)`, [b]);
  await db.query(`insert into payment_methods (branch_id, name_ar, kind, sort_order) values ($1,'كاش','cash',0)`, [b]);
  await db.query(`insert into clinic_weekdays (branch_id, weekday, is_open) select $1, d, true from generate_series(1,7) d`, [b]);
  const user = async (username: string, name: string, role: string, branch: number | null) =>
    Number((await db.query(`insert into users (username, password_hash, full_name, role, branch_id, must_change_password) values ($1,$2,$3,$4,$5,false) returning id`, [username, pw, name, role, branch])).rows[0].id);
  await user('owner', 'المالك', 'owner', null);
  await db.query(`update users set totp_secret_enc = $1, totp_enabled_at = now() where username = 'owner'`, [encryptSecret(DEMO_OWNER_TOTP, Buffer.from(keyB64, 'base64'))]);
  const mgr = await user('manager', 'أحمد المدير', 'manager', b);
  await user('cashier', 'نور الكاشير', 'cashier', b); await user('nurse', 'ريم الممرضة', 'nurse', b);
  const doc = await user('doctor', 'د. سارة', 'doctor', b); await db.query(`insert into doctors (user_id, title, room) values ($1,'أخصائية جلدية','غرفة 1')`, [doc]);
  await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',5000000,'opening_balance','رصيد افتتاحي تجريبي',$2)`, [b, mgr]);
  const cons = Number((await db.query(`insert into services (branch_id, name_ar, kind, pricing_model, is_active) values ($1,'كشفية','consultation','fixed',true) returning id`, [b])).rows[0].id);
  await db.query(`insert into service_prices (service_id, price, set_by) values ($1,30000,$2)`, [cons, mgr]);
  const mat = async (name: string, unit: string) => Number((await db.query(`insert into materials (branch_id, name, base_unit, pack_unit, low_threshold, last_unit_cost) values ($1,$2,$3,'علبة',5,1000) returning id`, [b, name, unit])).rows[0].id);
  const botoxMat = await mat('بوتكس', 'cc'); const fillerMat = await mat('فيلر', 'ml');
  for (const [m, qty, cost] of [[botoxMat, 60, 15000], [fillerMat, 40, 40000]] as const) {
    const batch = Number((await db.query(`insert into material_batches (branch_id, material_id, source, received_on, expiry_date, unit_cost, qty_initial, qty_on_hand) values ($1,$2,'opening',clinic_today(),clinic_today() + 365,$3,$4,0) returning id`, [b, m, cost, qty])).rows[0].id);
    await db.query(`insert into stock_movements (branch_id, material_id, batch_id, movement_type, qty_delta, unit_cost, cost_amount, created_by) values ($1,$2,$3,'opening',$4,$5,$6,$7)`, [b, m, batch, String(qty), cost, qty * cost, mgr]);
  }
  await db.end();

  // ---- بقية البيانات عبر الـ API (نفس قواعد العمل)
  const app: INestApplication = await createApp(); await app.listen(0);
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  const call = async (token: string | null, method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.status >= 400) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
    return j as any;
  };
  const login = async (u: string) => (await call(null, 'POST', '/auth/login', { username: u, password: DEMO_PASSWORD })).access_token as string;
  const M = await login('manager'); const C = await login('cashier');
  const days = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_time: '09:00', end_time: '17:00' }));
  const today = new Date().toISOString().slice(0, 10);
  await call(M, 'PUT', `/schedule/doctors/${doc}/weekly`, { days, effective_from: today });
  const lim = (await call(M, 'GET', '/settings')).settings.find((s: any) => s.key === 'booking.daily_limit');
  await call(M, 'PUT', '/settings/booking.daily_limit', { value: 25, expected_version: lim.version });
  await call(M, 'POST', '/payment-methods', { name_ar: 'كي كارد', device_label: 'جهاز الاستقبال' });
  const botox = (await call(M, 'POST', '/services', { name_ar: 'بوتكس', pricing_model: 'per_unit', price: 50000 })).id;
  const bf = (await call(M, 'POST', `/services/${botox}/fields`, { field_key: 'cc', label_ar: 'كم cc', field_type: 'number', unit_label: 'cc', pricing_role: 'quantity', is_required: true })).fields[0];
  await call(M, 'PUT', `/services/${botox}/materials`, { items: [{ material_id: botoxMat, formula: 'per_field_value', field_id: bf.id, factor: '1' }] });
  await call(M, 'POST', `/services/${botox}/activate`);
  const filler = (await call(M, 'POST', '/services', { name_ar: 'فيلر', pricing_model: 'per_unit', price: 120000 })).id;
  const ff = (await call(M, 'POST', `/services/${filler}/fields`, { field_key: 'ml', label_ar: 'كم ml', field_type: 'number', unit_label: 'ml', pricing_role: 'quantity', is_required: true })).fields[0];
  await call(M, 'PUT', `/services/${filler}/materials`, { items: [{ material_id: fillerMat, formula: 'per_field_value', field_id: ff.id, factor: '1' }] });
  await call(M, 'POST', `/services/${filler}/activate`);
  for (const [name, price] of [['تنظيف بشرة', 40000], ['ليزر إزالة الشعر', 60000]] as const) {
    const s = (await call(M, 'POST', '/services', { name_ar: name, pricing_model: 'fixed', price })).id; await call(M, 'POST', `/services/${s}/activate`);
  }
  await call(M, 'POST', '/offers', { service_id: botox, title: 'عرض البوتكس', percent: 10, start_date: today, end_date: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10) });
  const names = ['سارة علي', 'زينب حسن', 'مريم كاظم', 'هدى جاسم', 'رنا عباس', 'ليلى محمد'];
  const customers: number[] = [];
  for (const [i, n] of names.entries()) customers.push((await call(C, 'POST', '/customers', { full_name: n, phone: `0770${String(1000000 + i * 1111)}` })).id);
  await call(await login('cashier'), 'POST', '/shifts/open', { opening_float: 50000 }).catch(() => undefined);
  for (const c of customers.slice(0, 4)) await call(C, 'POST', '/bookings', { customer_id: c, doctor_id: doc, date: today });
  await app.close();
  console.log('تم تجهيز العيادة التجريبية (مركز الياسمين).');
  console.log(`الحسابات (الرمز ${DEMO_PASSWORD}): owner (TOTP ${DEMO_OWNER_TOTP})، manager، cashier، nurse، doctor`);
}
main().catch((e) => { console.error(e); process.exit(1); });
