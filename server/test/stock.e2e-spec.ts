import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = () => Buffer.concat([PNG, randomBytes(64)]);

interface World { id: number; code: string; mgr: string; mgrId: number; cash: string }

describe('المواد والموردين وفواتير الشراء', () => {
  let app: INestApplication; let db: Pool; let today: string; let owner: string; let nurse: string; let doc1: string;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  let nameSeq = 0;

  async function world(code: string, funds = 10000000): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name) values ($1,$1) returning id`, [code])).rows[0].id);
    await db.query(`insert into safes (branch_id) values ($1)`, [id]);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id); await seedUser(db, `cash_${code}`, 'cashier', id);
    if (funds > 0) await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',$2,'opening_balance','تجربة',$3)`, [id, funds, mgrId]);
    return { id, code, mgr: await tokenFor(app, `mgr_${code}`), mgrId, cash: await tokenFor(app, `cash_${code}`) };
  }
  const safeBalance = async (w: World) => Number((await one(`select balance from safes where branch_id = $1`, [w.id])).balance);
  const upload = (t: string, kind: string) => http().post('/attachments').set(auth(t)).field('kind', kind).attach('file', png(), { filename: 'a.png' });
  const attach = async (w: World, kind: string) => { const r = await upload(w.mgr, kind); expect(r.status).toBe(201); return r.body.id as number; };
  /** مادة: كرتون = 10 علبة × 1 cc = 10 cc (افتراضي) */
  async function material(w: World, over: Record<string, unknown> = {}) {
    const r = await post(w.mgr, '/materials', { name: `مادة ${++nameSeq}-${Math.random().toString(36).slice(2, 6)}`, base_unit: 'cc', pack_unit: 'كرتون', mid_unit: 'علبة', mid_per_pack: 10, base_per_mid: 1, ...over });
    expect(r.status).toBe(201); return r.body;
  }
  async function supplier(w: World, over: Record<string, unknown> = {}) {
    const r = await post(w.mgr, '/suppliers', { name: `مورد ${++nameSeq}-${Math.random().toString(36).slice(2, 6)}`, ...over });
    expect(r.status).toBe(201); return r.body;
  }
  const exp = (days = 365) => addDays(today, days);
  const line = (material_id: number, qty_pack: number, line_total: number, expiry_date = exp()) => ({ material_id, qty_pack, line_total, expiry_date });
  async function buy(w: World, supplier_id: number, items: object[], payment: object = { mode: 'credit' }, over: Record<string, unknown> = {}, token = w.mgr) {
    return post(token, '/purchases', { supplier_id, purchase_date: today, receipt_attachment_id: await attach(w, 'purchase_receipt'), items, payment, ...over });
  }
  const owed = async (supplierId: number) => Number((await one(`select balance_owed from v_supplier_balance where supplier_id = $1`, [supplierId])).balance_owed);

  beforeAll(async () => {
    app = await makeApp(); db = pool();
    today = (await db.query(`select clinic_today()::text as d`)).rows[0].d;
    [owner, nurse, doc1] = await Promise.all(['owner', 'nurse1', 'doc1'].map((u) => tokenFor(app, u)));
  });
  afterAll(async () => { await app.close(); await db.end(); });

  // ------------------------------------------------------------------------------------------------
  describe('المواد', () => {
    let w: World; let w2: World;
    beforeAll(async () => { w = await world('STA'); w2 = await world('STA2'); });
    it('الإنشاء: كرتون = 10 علبة × 1 cc = 10 cc، والصلاحيات (المدير والمالك بس)', async () => {
      const m = await material(w, { name: '  بوتكس   ', low_threshold: 5 });
      expect(m).toMatchObject({ name: 'بوتكس', is_active: true, version: 1, low_threshold: 5, last_unit_cost: null,
        units: { base_unit: 'cc', pack_unit: 'كرتون', mid_unit: 'علبة', mid_per_pack: 10, base_per_mid: 1, base_per_pack: 10 },
        stock: { on_hand: 0, valid: 0, expired: 0, near_expiry: 0, reserved: 0, available: 0 }, batches: [] });
      for (const t of [w.cash, doc1, nurse]) { expect((await post(t, '/materials', { name: 'x1', base_unit: 'cc', pack_unit: 'ك' })).status).toBe(403); expect((await get(t, '/materials')).status).toBe(403); }
      expect((await post(owner, '/materials', { name: 'مادة مالك', base_unit: 'cc', pack_unit: 'ك' })).status).toBe(400);               // أكثر من فرع
      expect((await post(owner, '/materials', { name: 'مادة مالك', base_unit: 'cc', pack_unit: 'ك', branch_id: w.id })).status).toBe(201);
    });
    it('بدون وحدة وسطية: الكرتون = base_per_mid من وحدة الاستهلاك، والوسطية وعددها يجون سوا', async () => {
      const m = await material(w, { mid_unit: undefined, mid_per_pack: undefined, base_per_mid: 20 });
      expect(m.units).toMatchObject({ mid_unit: null, mid_per_pack: null, base_per_pack: 20 });
      const half = await material(w, { mid_per_pack: 2.5, base_per_mid: 4 });
      expect(half.units.base_per_pack).toBe(10);
      expect((await post(w.mgr, '/materials', { name: 'ناقصة', base_unit: 'cc', pack_unit: 'ك', mid_unit: 'علبة' })).body.code).toBe('MID_UNIT_INCOMPLETE');
      expect((await post(w.mgr, '/materials', { name: 'ناقصة2', base_unit: 'cc', pack_unit: 'ك', mid_per_pack: 5 })).body.code).toBe('MID_UNIT_INCOMPLETE');
    });
    it('الاسم فريد (بدون حساسية للحالة)، والتحقق من المدخلات، والفروع مستقلة', async () => {
      await material(w, { name: 'Filler' });
      expect((await post(w.mgr, '/materials', { name: 'filler', base_unit: 'cc', pack_unit: 'ك' })).body.code).toBe('MATERIAL_EXISTS');
      expect((await post(w2.mgr, '/materials', { name: 'filler', base_unit: 'cc', pack_unit: 'ك' })).status).toBe(201);
      for (const bad of [{ name: 'ا' }, { base_unit: '' }, { low_threshold: -1 }, { mid_per_pack: 0, mid_unit: 'x' }, { base_per_mid: 0.0001 }, { low_threshold: 1.2345 }, { extra: 1 }])
        expect((await post(w.mgr, '/materials', { name: `ok-${Math.random()}`, base_unit: 'cc', pack_unit: 'ك', ...bad })).status).toBe(400);
    });
    it('التعديل: الاسم والحد والتعطيل بنسخة، وبدون تغيير 400، وفرع ثاني 404', async () => {
      const m = await material(w);
      const r = await put(w.mgr, `/materials/${m.id}`, { expected_version: 1, name: 'اسم جديد', low_threshold: 7, is_active: false });
      expect(r.status).toBe(200); expect(r.body).toMatchObject({ name: 'اسم جديد', low_threshold: 7, is_active: false, version: 2 });
      expect((await put(w.mgr, `/materials/${m.id}`, { expected_version: 1, name: 'قديم' })).body).toMatchObject({ code: 'VERSION_CONFLICT', current_version: 2 });
      expect((await put(w.mgr, `/materials/${m.id}`, { expected_version: 2 })).body.code).toBe('NO_CHANGE');
      expect((await put(w2.mgr, `/materials/${m.id}`, { expected_version: 2, name: 'x2' })).status).toBe(404);
      expect((await get(w2.mgr, `/materials/${m.id}`)).status).toBe(404);
      const other = await material(w, { name: 'مادة ثانية للتعارض' });
      expect((await put(w.mgr, `/materials/${m.id}`, { expected_version: 2, name: other.name })).body.code).toBe('MATERIAL_EXISTS');
      expect((await get(w.mgr, '/materials')).body.materials.map((x: any) => x.id)).not.toContain(m.id);
      expect((await get(w.mgr, '/materials?all=1')).body.materials.map((x: any) => x.id)).toContain(m.id);
    });
    it('الوحدات تتعدل قبل أي حركة وتنقفل بعدها، والاسم والحد يبقون قابلين للتعديل', async () => {
      const m = await material(w); const s = await supplier(w);
      const free = await put(w.mgr, `/materials/${m.id}`, { expected_version: 1, base_per_mid: 2 });
      expect(free.body.units.base_per_pack).toBe(20);
      expect((await buy(w, s.id, [line(m.id, 1, 50000)])).status).toBe(201);
      const locked = await put(w.mgr, `/materials/${m.id}`, { expected_version: 2, base_per_mid: 3 });
      expect(locked.status).toBe(409); expect(locked.body.code).toBe('UNITS_LOCKED');
      expect((await put(w.mgr, `/materials/${m.id}`, { expected_version: 2, pack_unit: 'صندوق' })).body.code).toBe('UNITS_LOCKED');
      expect((await put(w.mgr, `/materials/${m.id}`, { expected_version: 2, name: 'اسم بعد الحركة', low_threshold: 9 })).status).toBe(200);
      expect((await one(`select base_per_pack::int as b from materials where id = $1`, [m.id])).b).toBe(20);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('الموردين وكشف الحساب', () => {
    let w: World; let w2: World;
    beforeAll(async () => { w = await world('STB'); w2 = await world('STB2'); });
    it('إنشاء مورد برصيد افتتاحي، والاسم فريد حتى بين المعطلين، والتلفون المكرر تحذير بس', async () => {
      const a = await supplier(w, { name: '  شركة   النور ', phone: '07701111111', opening_balance: 300000, notes: 'ملاحظة' });
      expect(a).toMatchObject({ name: 'شركة النور', phone: '07701111111', opening_balance: 300000, balance_owed: 300000, is_active: true, has_credit: false, warnings: [] });
      expect((await post(w.mgr, '/suppliers', { name: 'شركة النور' })).body.code).toBe('SUPPLIER_EXISTS');
      expect((await post(w.mgr, '/suppliers', { name: ' شركة  النور ' })).status).toBe(409);
      await put(w.mgr, `/suppliers/${a.id}`, { is_active: false });
      expect((await post(w.mgr, '/suppliers', { name: 'شركة النور' })).status).toBe(409);                   // حتى المعطل
      const dup = await post(w.mgr, '/suppliers', { name: 'شركة ثانية', phone: '07701111111' });
      expect(dup.status).toBe(201); expect(dup.body.warnings).toEqual([{ code: 'PHONE_DUPLICATE', supplier_id: a.id, supplier_name: 'شركة النور' }]);
      expect((await post(w2.mgr, '/suppliers', { name: 'شركة النور' })).status).toBe(201);                  // فرع ثاني
    });
    it('الصلاحيات والتحقق وفصل الفروع', async () => {
      for (const t of [w.cash, doc1, nurse]) { expect((await post(t, '/suppliers', { name: 'ممنوع' })).status).toBe(403); expect((await get(t, '/suppliers')).status).toBe(403); }
      for (const bad of [{ name: 'ا' }, { opening_balance: -1 }, { opening_balance: 1.5 }, { extra: 1 }]) expect((await post(w.mgr, '/suppliers', { name: `مورد-${Math.random()}`, ...bad })).status).toBe(400);
      const s = await supplier(w);
      expect((await get(w2.mgr, `/suppliers/${s.id}/statement`)).status).toBe(404);
      expect((await put(w2.mgr, `/suppliers/${s.id}`, { notes: 'x' })).status).toBe(404);
      expect((await get(w2.mgr, '/suppliers')).body.suppliers.map((x: any) => x.id)).not.toContain(s.id);
      expect((await put(w.mgr, `/suppliers/${s.id}`, {})).body.code).toBe('NO_CHANGE');
    });
    it('الافتتاحي يتعدل لحد أول حركة وبعدها ينقفل، والتعطيل يمنع فواتير جديدة بس والتسديد يبقى', async () => {
      const s = await supplier(w, { opening_balance: 100000 }); const m = await material(w);
      expect((await put(w.mgr, `/suppliers/${s.id}`, { opening_balance: 150000 })).body).toMatchObject({ opening_balance: 150000, balance_owed: 150000 });
      expect((await buy(w, s.id, [line(m.id, 1, 50000)])).status).toBe(201);
      const locked = await put(w.mgr, `/suppliers/${s.id}`, { opening_balance: 10 });
      expect(locked.status).toBe(409); expect(locked.body.code).toBe('OPENING_LOCKED');
      expect((await put(w.mgr, `/suppliers/${s.id}`, { opening_balance: 150000, name: s.name + ' ب' })).status).toBe(200);        // نفس القيمة ما تنعد تغيير
      await put(w.mgr, `/suppliers/${s.id}`, { is_active: false });
      expect((await buy(w, s.id, [line(m.id, 1, 1000)])).body.code).toBe('SUPPLIER_INACTIVE');
      expect((await post(w.mgr, `/suppliers/${s.id}/payments`, { amount: 10000, pay_source: 'safe', paid_on: today })).status).toBe(201);
      expect((await get(w.mgr, '/suppliers')).body.suppliers.map((x: any) => x.id)).not.toContain(s.id);
      expect((await get(w.mgr, '/suppliers?all=1')).body.suppliers.map((x: any) => x.id)).toContain(s.id);
    });
    it('الافتتاحي ينقفل بأول تسديد أيضاً (بدون فاتورة)', async () => {
      const s = await supplier(w, { opening_balance: 100000 });
      expect((await post(w.mgr, `/suppliers/${s.id}/payments`, { amount: 10000, pay_source: 'safe', paid_on: today })).status).toBe(201);
      expect((await put(w.mgr, `/suppliers/${s.id}`, { opening_balance: 50000 })).body.code).toBe('OPENING_LOCKED');
    });
    it('كشف الحساب: افتتاحي + فواتير − مرتجعات − تسديدات برصيد جاري يطابق v_supplier_balance، والملغاة ما تنحسب', async () => {
      const s = await supplier(w, { opening_balance: 1000000 }); const m = await material(w);
      const p1 = await buy(w, s.id, [line(m.id, 10, 1100000)], { mode: 'credit' });                         // +1,100,000 → 2,100,000
      expect((await post(w.mgr, `/suppliers/${s.id}/payments`, { amount: 300000, pay_source: 'safe', paid_on: today })).status).toBe(201);   // → 1,800,000
      const ret = await post(w.mgr, '/supplier-returns', { purchase_id: p1.body.id, reason: 'تالف', items: [{ purchase_item_id: p1.body.items[0].id, qty_base: 10 }] });   // 10 cc من 100 = −110,000
      expect(ret.status).toBe(201); expect(ret.body.credit_amount).toBe(110000);
      const p2 = await buy(w, s.id, [line(m.id, 1, 50000)]);
      await post(owner, `/purchases/${p2.body.id}/void`, { reason: 'غلط' });
      const st = await get(w.mgr, `/suppliers/${s.id}/statement`);
      expect(st.status).toBe(200);
      expect(st.body.opening_balance).toBe(1000000);
      expect(st.body.lines.map((l: any) => [l.kind, l.amount, l.status, l.balance_after])).toEqual([
        ['purchase', 1100000, 'posted', 2100000], ['payment', 300000, 'posted', 1800000], ['return', 110000, 'posted', 1690000], ['purchase', 50000, 'voided', 1690000]].sort(() => 0));
      expect(st.body.balance_owed).toBe(1690000);
      expect(st.body.balance_owed).toBe(await owed(s.id));
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('فاتورة الشراء', () => {
    let w: World; let w2: World;
    beforeAll(async () => { w = await world('STC'); w2 = await world('STC2'); });
    it('دفع كامل من الخزنة: دفعة بالمخزون بتاريخ صلاحيتها، حركة شراء، آخر كلفة، تسديد مربوط بالفاتورة، والخزنة تنقص', async () => {
      const m = await material(w); const s = await supplier(w); const before = await safeBalance(w);
      const r = await buy(w, s.id, [line(m.id, 2, 100000, exp(200))], { mode: 'full', pay_source: 'safe' }, { invoice_no: ' INV-100 ' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ invoice_no: 'INV-100', purchase_date: today, total_amount: 100000, paid_on_invoice: 100000, unpaid_on_invoice: 0, status: 'posted', supplier: { id: s.id } });
      expect(r.body.items[0]).toMatchObject({ qty_pack: 2, qty_base: 20, unit_cost: 5000, line_total: 100000, expiry_date: exp(200), qty_on_hand: 20, material: { id: m.id } });
      expect(r.body.payments).toEqual([{ id: expect.any(Number), amount: 100000, pay_source: 'safe', bank_name: null }]);
      expect(await safeBalance(w)).toBe(before - 100000);
      const mv = await one(`select movement_type, qty_delta::float as q, unit_cost::float as u, cost_amount::int as c from stock_movements where purchase_item_id = $1`, [r.body.items[0].id]);
      expect(mv).toEqual({ movement_type: 'purchase', q: 20, u: 5000, c: 100000 });
      const mat = (await get(w.mgr, `/materials/${m.id}`)).body;
      expect(mat.last_unit_cost).toBe(5000); expect(mat.stock).toMatchObject({ on_hand: 20, valid: 20, available: 20 });
      expect(mat.batches).toEqual([expect.objectContaining({ source: 'purchase', expiry_date: exp(200), qty_on_hand: 20, unit_cost: 5000, invoice_no: 'INV-100', status: 'ok' })]);
      expect(await owed(s.id)).toBe(0);
      expect((await db.query(`select 1 from audit_log where action = 'purchase.create' and entity_id = $1`, [r.body.id])).rowCount).toBe(1);
    });
    it('آجلة: الحساب يزيد والخزنة ما تتحرك، وجزئي: المدفوع الآن بالخزنة والباقي علينا، وإلكتروني ما يلمس الخزنة', async () => {
      const m = await material(w); const s = await supplier(w); const b0 = await safeBalance(w);
      const credit = await buy(w, s.id, [line(m.id, 1, 80000)], { mode: 'credit' });
      expect(credit.body).toMatchObject({ paid_on_invoice: 0, unpaid_on_invoice: 80000 }); expect(await safeBalance(w)).toBe(b0); expect(await owed(s.id)).toBe(80000);
      const part = await buy(w, s.id, [line(m.id, 1, 100000)], { mode: 'partial', amount: 40000, pay_source: 'safe' });
      expect(part.body).toMatchObject({ paid_on_invoice: 40000, unpaid_on_invoice: 60000 }); expect(await safeBalance(w)).toBe(b0 - 40000); expect(await owed(s.id)).toBe(80000 + 60000);
      const el = await buy(w, s.id, [line(m.id, 1, 30000)], { mode: 'full', pay_source: 'electronic', bank_name: ' مصرف الرافدين ' });
      expect(el.body.payments[0]).toMatchObject({ pay_source: 'electronic', bank_name: 'مصرف الرافدين' }); expect(await safeBalance(w)).toBe(b0 - 40000);
    });
    it('قواعد الدفع: الجزئي من 1 إلى أقل من الإجمالي، والإلكتروني بمصرف، والآجل بدون بيانات دفع، والكامل بدون مبلغ', async () => {
      const m = await material(w); const s = await supplier(w); const it = [line(m.id, 1, 50000)];
      const code = async (payment: object) => (await buy(w, s.id, it, payment)).body.code;
      expect(await code({ mode: 'partial', amount: 50000, pay_source: 'safe' })).toBe('PARTIAL_RANGE');
      expect(await code({ mode: 'partial', amount: 60000, pay_source: 'safe' })).toBe('PARTIAL_RANGE');
      expect(await code({ mode: 'partial', pay_source: 'safe' })).toBe('AMOUNT_REQUIRED');
      expect(await code({ mode: 'full', amount: 50000, pay_source: 'safe' })).toBe('AMOUNT_NOT_ALLOWED');
      expect(await code({ mode: 'full' })).toBe('PAY_SOURCE_REQUIRED');
      expect(await code({ mode: 'full', pay_source: 'electronic' })).toBe('BANK_REQUIRED');
      expect(await code({ mode: 'full', pay_source: 'safe', bank_name: 'م' })).toBe('BANK_NOT_ALLOWED');
      expect(await code({ mode: 'credit', pay_source: 'safe' })).toBe('PAYMENT_NOT_ALLOWED');
      expect(await code({ mode: 'credit', amount: 5 })).toBe('PAYMENT_NOT_ALLOWED');
      for (const payment of [{ mode: 'weird' }, {}, { mode: 'partial', amount: 0, pay_source: 'safe' }, { mode: 'partial', amount: 1.5, pay_source: 'safe' }]) expect((await buy(w, s.id, it, payment)).status).toBe(400);
      expect((await post(w.mgr, '/purchases', { supplier_id: s.id, purchase_date: today, receipt_attachment_id: await attach(w, 'purchase_receipt'), items: it })).status).toBe(400);   // بدون payment
      expect(Number((await one(`select count(*)::int as n from purchases where supplier_id = $1`, [s.id])).n)).toBe(0);
    });
    it('التحويل والتقريب: 3 كراتون × 7 cc = 21، والكلفة 4761.9048 للوحدة، وقيمة حركة المخزون = سطر الفاتورة بالضبط', async () => {
      const m = await material(w, { mid_unit: undefined, mid_per_pack: undefined, base_per_mid: 7 }); const s = await supplier(w);
      const r = await buy(w, s.id, [line(m.id, 3, 100000), line(m.id, 0.5, 12345, exp(100))]);
      expect(r.status).toBe(201);
      expect(r.body.items[0]).toMatchObject({ qty_base: 21, unit_cost: 4761.9048, line_total: 100000 });
      expect(r.body.items[1]).toMatchObject({ qty_base: 3.5, unit_cost: 3527.1429, line_total: 12345 });
      expect(r.body.total_amount).toBe(112345);
      for (const i of r.body.items) expect(Number((await one(`select cost_amount::int as c from stock_movements where purchase_item_id = $1`, [i.id])).c)).toBe(i.line_total);
      expect((await get(w.mgr, `/materials/${m.id}`)).body.batches).toHaveLength(2);                          // دفعتين بصلاحيتين مختلفتين
    });
    it('كمية كبيرة: قيمة حركة المخزون = إجمالي السطر بالضبط حتى لو الكلفة المقربة × الكمية تطلع غير هيج (30,001 وحدة بـ 100,000)', async () => {
      const m = await material(w); const s = await supplier(w);
      const r = await buy(w, s.id, [line(m.id, 3000.1, 100000)]);
      expect(r.status).toBe(201);
      expect(r.body.items[0]).toMatchObject({ qty_base: 30001, unit_cost: 3.3332, line_total: 100000 });
      expect(Math.round(30001 * 3.3332)).not.toBe(100000);                                                 // الحساب الساذج يطلع غير هيج
      expect(Number((await one(`select cost_amount::int as c from stock_movements where purchase_item_id = $1`, [r.body.items[0].id])).c)).toBe(100000);
    });
    it('التحقق: صلاحية بعد اليوم، تاريخ فاتورة مو مستقبل، كميات وأسعار، إجمالي صفر، مواد غلط', async () => {
      const m = await material(w); const s = await supplier(w); const ok = [line(m.id, 1, 1000)];
      expect((await buy(w, s.id, [line(m.id, 1, 1000, today)])).body.code).toBe('EXPIRY_PAST');
      expect((await buy(w, s.id, [line(m.id, 1, 1000, addDays(today, -1))])).body.code).toBe('EXPIRY_PAST');
      expect((await buy(w, s.id, [line(m.id, 1, 1000, addDays(today, 1))])).status).toBe(201);               // غداً مسموح
      expect((await buy(w, s.id, ok, { mode: 'credit' }, { purchase_date: addDays(today, 1) })).body.code).toBe('FUTURE_DATE');
      expect((await buy(w, s.id, ok, { mode: 'credit' }, { purchase_date: '2026-02-30' })).body.code).toBe('INVALID_DATE');
      expect((await buy(w, s.id, [line(m.id, 1, 0)])).body.code).toBe('TOTAL_ZERO');
      expect((await buy(w, s.id, [line(m.id, 1, 0), line(m.id, 1, 500)])).status).toBe(201);                 // سطر مجاني مع غيره مسموح
      for (const bad of [line(m.id, 0, 100), line(m.id, -1, 100), line(m.id, 1.0005, 100), line(m.id, 1, -5), line(m.id, 1, 1.5)]) expect((await buy(w, s.id, [bad])).status).toBe(400);
      expect((await buy(w, s.id, [])).status).toBe(400);
      expect((await buy(w, s.id, [line(99999999, 1, 100)])).body.code).toBe('MATERIAL_INVALID');
      const foreign = await material(w2);
      expect((await buy(w, s.id, [line(foreign.id, 1, 100)])).body.code).toBe('MATERIAL_INVALID');
      await put(w.mgr, `/materials/${m.id}`, { expected_version: 1, is_active: false });
      expect((await buy(w, s.id, [line(m.id, 1, 100)])).body.code).toBe('MATERIAL_INACTIVE');
    });
    it('المورد: غير موجود 404، من فرع ثاني 404، والكاشير 403، وحقل زايد 400', async () => {
      const m = await material(w); const s = await supplier(w); const other = await supplier(w2);
      expect((await buy(w, 99999999, [line(m.id, 1, 100)])).status).toBe(404);
      expect((await buy(w, other.id, [line(m.id, 1, 100)])).status).toBe(404);
      expect((await buy(w, s.id, [line(m.id, 1, 100)], { mode: 'credit' }, {}, w.cash)).status).toBe(403);
      expect((await buy(w, s.id, [line(m.id, 1, 100)], { mode: 'credit' }, { total_amount: 5 })).status).toBe(400);
    });
    it('صورة الوصل: إلزامية، بنوعها، بفرعها، غير محذوفة، ومرة وحدة (6 طلبات متزامنة بنفس الصورة = فاتورة وحدة)', async () => {
      const m = await material(w); const s = await supplier(w); const it = [line(m.id, 1, 1000)];
      const post1 = (receipt: unknown) => post(w.mgr, '/purchases', { supplier_id: s.id, purchase_date: today, receipt_attachment_id: receipt, items: it, payment: { mode: 'credit' } });
      expect((await post(w.mgr, '/purchases', { supplier_id: s.id, purchase_date: today, items: it, payment: { mode: 'credit' } })).status).toBe(400);
      expect((await post1(99999999)).body.code).toBe('RECEIPT_INVALID');
      expect((await post1(await attach(w, 'expense_proof'))).body.code).toBe('RECEIPT_INVALID');
      expect((await post1(await attach(w2, 'purchase_receipt'))).body.code).toBe('RECEIPT_INVALID');
      const gone = await attach(w, 'purchase_receipt'); await db.query(`update attachments set deleted_at = now() where id = $1`, [gone]);
      expect((await post1(gone)).body.code).toBe('RECEIPT_INVALID');
      const rc = await attach(w, 'purchase_receipt');
      const rs = await Promise.all(Array.from({ length: 6 }, () => post1(rc)));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'RECEIPT_ALREADY_USED')).toHaveLength(5);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(await owed(s.id)).toBe(1000);
      expect((await get(w.mgr, `/materials/${m.id}`)).body.stock.on_hand).toBe(10);
    });
    it('رقم الفاتورة فريد عند المورد (للفعالة)، ويتكرر عند مورد ثاني', async () => {
      const m = await material(w); const a = await supplier(w); const b = await supplier(w);
      expect((await buy(w, a.id, [line(m.id, 1, 100)], { mode: 'credit' }, { invoice_no: 'X-1' })).status).toBe(201);
      expect((await buy(w, a.id, [line(m.id, 1, 100)], { mode: 'credit' }, { invoice_no: ' X-1 ' })).body.code).toBe('INVOICE_EXISTS');
      expect((await buy(w, b.id, [line(m.id, 1, 100)], { mode: 'credit' }, { invoice_no: 'X-1' })).status).toBe(201);
      expect((await buy(w, a.id, [line(m.id, 1, 100)], { mode: 'credit' })).status).toBe(201);              // بدون رقم: عادي
      expect((await buy(w, a.id, [line(m.id, 1, 100)], { mode: 'credit' })).status).toBe(201);
    });
    it('فوق رصيد الخزنة → 409 وما ينكتب شي أبداً (فاتورة، دفعات، حركات، تسديد) والوصل يبقى حر', async () => {
      const x = await world('STC3', 50000); const m = await material(x); const s = await supplier(x);
      const rc = await attach(x, 'purchase_receipt');
      const r = await post(x.mgr, '/purchases', { supplier_id: s.id, purchase_date: today, receipt_attachment_id: rc, items: [line(m.id, 1, 60000)], payment: { mode: 'full', pay_source: 'safe' } });
      expect(r.status).toBe(409); expect(r.body).toMatchObject({ code: 'SAFE_INSUFFICIENT', safe_balance: 50000, requested: 60000 });
      for (const [t, col] of [['purchases', 'branch_id'], ['material_batches', 'branch_id'], ['stock_movements', 'branch_id'], ['supplier_payments', 'branch_id']] as const)
        expect(Number((await one(`select count(*)::int as n from ${t} where ${col} = $1`, [x.id])).n)).toBe(0);
      expect(await safeBalance(x)).toBe(50000);
      expect((await post(x.mgr, '/purchases', { supplier_id: s.id, purchase_date: today, receipt_attachment_id: rc, items: [line(m.id, 1, 60000)], payment: { mode: 'partial', amount: 50000, pay_source: 'safe' } })).status).toBe(201);
      expect(await safeBalance(x)).toBe(0);
    });
    it('6 فواتير متزامنة تدفع من الخزنة 30,000 والرصيد 100,000: ثلاث تنجح وثلاث SAFE_INSUFFICIENT وبدون بقايا', async () => {
      const x = await world('STC4', 100000); const m = await material(x); const s = await supplier(x);
      const rcs = await Promise.all(Array.from({ length: 6 }, () => attach(x, 'purchase_receipt')));
      const rs = await Promise.all(rcs.map((rc) => post(x.mgr, '/purchases', { supplier_id: s.id, purchase_date: today, receipt_attachment_id: rc, items: [line(m.id, 1, 30000)], payment: { mode: 'full', pay_source: 'safe' } })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(3);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'SAFE_INSUFFICIENT')).toHaveLength(3);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(await safeBalance(x)).toBe(10000);
      expect(Number((await one(`select count(*)::int as n from purchases where branch_id = $1`, [x.id])).n)).toBe(3);
      expect((await get(x.mgr, `/materials/${m.id}`)).body.stock.on_hand).toBe(30);
      expect(await owed(s.id)).toBe(0);
    });
    it('8 فواتير متزامنة على نفس المواد بترتيب مختلف (أ،ب / ب،أ): كلها تنجح بدون تشابك والمخزون يتجمع', async () => {
      const x = await world('STC5'); const a = await material(x); const b = await material(x); const s = await supplier(x);
      const rcs = await Promise.all(Array.from({ length: 8 }, () => attach(x, 'purchase_receipt')));
      const rs = await Promise.all(rcs.map((rc, i) => post(x.mgr, '/purchases', { supplier_id: s.id, purchase_date: today, receipt_attachment_id: rc,
        items: i % 2 ? [line(a.id, 1, 1000), line(b.id, 1, 1000)] : [line(b.id, 1, 1000), line(a.id, 1, 1000)], payment: { mode: 'credit' } })));
      expect(rs.map((r) => r.status)).toEqual(new Array(8).fill(201));
      expect((await get(x.mgr, `/materials/${a.id}`)).body.stock.on_hand).toBe(80);
      expect((await get(x.mgr, `/materials/${b.id}`)).body.stock.on_hand).toBe(80);
      expect(await owed(s.id)).toBe(16000);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('تسديد المورد', () => {
    let w: World;
    beforeAll(async () => { w = await world('STD', 1000000); });
    const payTo = (t: string, id: number, body: object) => post(t, `/suppliers/${id}/payments`, { amount: 10000, pay_source: 'safe', paid_on: today, ...body });
    it('من الخزنة ينقص رصيدها بحركة supplier_payment، ويتنزل من اللي علينا، ولا يتجاوز اللي علينا', async () => {
      const s = await supplier(w, { opening_balance: 100000 }); const b0 = await safeBalance(w);
      const r = await payTo(w.mgr, s.id, { amount: 60000 });
      expect(r.status).toBe(201); expect(r.body).toMatchObject({ amount: 60000, pay_source: 'safe', balance_owed: 40000 });
      expect(await safeBalance(w)).toBe(b0 - 60000);
      expect(await one(`select direction, amount::int as amount, kind from safe_movements where supplier_payment_id = $1`, [r.body.id])).toEqual({ direction: 'out', amount: 60000, kind: 'supplier_payment' });
      const over = await payTo(w.mgr, s.id, { amount: 40001 });
      expect(over.status).toBe(409); expect(over.body).toMatchObject({ code: 'EXCEEDS_BALANCE', balance_owed: 40000, requested: 40001 });
      expect((await payTo(w.mgr, s.id, { amount: 40000 })).body.balance_owed).toBe(0);
      expect((await payTo(w.mgr, s.id, { amount: 1 })).body.code).toBe('EXCEEDS_BALANCE');                  // ما أكو شي علينا
      expect(await safeBalance(w)).toBe(b0 - 100000);
    });
    it('إلكتروني: مصرف إلزامي وما يلمس الخزنة، والصلاحيات (المدير والمالك)، والمدخلات', async () => {
      const s = await supplier(w, { opening_balance: 100000 }); const b0 = await safeBalance(w);
      expect((await payTo(w.mgr, s.id, { pay_source: 'electronic' })).body.code).toBe('BANK_REQUIRED');
      expect((await payTo(w.mgr, s.id, { pay_source: 'safe', bank_name: 'م' })).body.code).toBe('BANK_NOT_ALLOWED');
      expect((await payTo(w.mgr, s.id, { pay_source: 'electronic', bank_name: ' مصرف بغداد ' })).body).toMatchObject({ pay_source: 'electronic', bank_name: 'مصرف بغداد' });
      expect(await safeBalance(w)).toBe(b0);
      for (const t of [w.cash, doc1, nurse]) expect((await payTo(t, s.id, {})).status).toBe(403);
      expect((await payTo(owner, s.id, {})).status).toBe(201);
      for (const bad of [{ amount: 0 }, { amount: -5 }, { amount: 1.5 }, { pay_source: 'cash' }, { paid_on: 'x' }, { net: 1 }]) expect((await payTo(w.mgr, s.id, bad)).status).toBe(400);
      expect((await payTo(w.mgr, s.id, { paid_on: addDays(today, 1) })).body.code).toBe('FUTURE_DATE');
      expect((await payTo(w.mgr, 99999999, {})).status).toBe(404);
    });
    it('فوق رصيد الخزنة → 409 وما ينكتب شي، وصورة الإثبات اختيارية ومرة وحدة وبنوعها', async () => {
      const x = await world('STD2', 20000); const s = await supplier(x, { opening_balance: 100000 });
      const r = await post(x.mgr, `/suppliers/${s.id}/payments`, { amount: 30000, pay_source: 'safe', paid_on: today });
      expect(r.status).toBe(409); expect(r.body).toMatchObject({ code: 'SAFE_INSUFFICIENT', safe_balance: 20000 });
      expect(Number((await one(`select count(*)::int as n from supplier_payments where supplier_id = $1`, [s.id])).n)).toBe(0);
      const proof = await attach(x, 'supplier_payment_proof');
      expect((await post(x.mgr, `/suppliers/${s.id}/payments`, { amount: 5000, pay_source: 'safe', paid_on: today, proof_attachment_id: proof })).status).toBe(201);
      expect((await post(x.mgr, `/suppliers/${s.id}/payments`, { amount: 5000, pay_source: 'safe', paid_on: today, proof_attachment_id: proof })).body.code).toBe('PROOF_ALREADY_USED');
      expect((await post(x.mgr, `/suppliers/${s.id}/payments`, { amount: 5000, pay_source: 'safe', paid_on: today, proof_attachment_id: await attach(x, 'expense_proof') })).body.code).toBe('PROOF_INVALID');
      expect((await post(x.mgr, `/suppliers/${s.id}/payments`, { amount: 5000, pay_source: 'safe', paid_on: today, proof_attachment_id: 99999999 })).body.code).toBe('PROOF_INVALID');
    });
    it('5 تسديدات متزامنة 30,000 واللي علينا 100,000: ثلاثة تنجح واثنين EXCEEDS_BALANCE، والخزنة بالضبط 90,000', async () => {
      const x = await world('STD3', 1000000); const s = await supplier(x, { opening_balance: 100000 });
      const rs = await Promise.all(Array.from({ length: 5 }, () => post(x.mgr, `/suppliers/${s.id}/payments`, { amount: 30000, pay_source: 'safe', paid_on: today })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(3);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'EXCEEDS_BALANCE')).toHaveLength(2);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(await safeBalance(x)).toBe(1000000 - 90000);
      expect(await owed(s.id)).toBe(10000);
    });
    it('تسديد وفاتورة جديدة بنفس اللحظة: الحساب النهائي صحيح (الفواتير − التسديدات)', async () => {
      const x = await world('STD4', 10000000); const s = await supplier(x, { opening_balance: 500000 }); const m = await material(x);
      const ps = await Promise.all(Array.from({ length: 4 }, () => post(x.mgr, `/suppliers/${s.id}/payments`, { amount: 100000, pay_source: 'safe', paid_on: today })));
      const bs = await Promise.all(Array.from({ length: 4 }, async () => buy(x, s.id, [line(m.id, 1, 50000)])));
      expect([...ps, ...bs].filter((r) => r.status >= 500)).toHaveLength(0);
      const paidOk = ps.filter((r) => r.status === 201).length; const boughtOk = bs.filter((r) => r.status === 201).length;
      expect(await owed(s.id)).toBe(500000 + boughtOk * 50000 - paidOk * 100000);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('مرتجع المورد', () => {
    let w: World;
    beforeAll(async () => { w = await world('STE', 10000000); });
    const ret = (t: string, body: object) => post(t, '/supplier-returns', body);
    async function purchased(qtyPack = 10, total = 1000000, mode: object = { mode: 'credit' }) {
      const m = await material(w); const s = await supplier(w); const p = await buy(w, s.id, [line(m.id, qtyPack, total)], mode);
      expect(p.status).toBe(201); return { m, s, p: p.body, item: p.body.items[0] };
    }
    it('مرتجع جزئي: المخزون ينقص، حركة supplier_return، والكلفة بنسبة الكمية تنزل من حساب المورد', async () => {
      const { m, s, p, item } = await purchased();                                   // 10 كرتون = 100 cc بمليون → 10,000 للـ cc
      const r = await ret(w.mgr, { purchase_id: p.id, reason: 'علب تالفة', items: [{ purchase_item_id: item.id, qty_base: 25 }] });
      expect(r.status).toBe(201); expect(r.body).toMatchObject({ purchase_id: p.id, supplier_id: s.id, credit_amount: 250000, balance_owed: 750000, has_credit: false });
      expect((await get(w.mgr, `/materials/${m.id}`)).body.stock.on_hand).toBe(75);
      expect(await one(`select movement_type, qty_delta::float as q, cost_amount::int as c from stock_movements where movement_type = 'supplier_return' and material_id = $1`, [m.id])).toEqual({ movement_type: 'supplier_return', q: -25, c: -250000 });
      expect(Number((await one(`select qty_on_hand::float as q from material_batches where purchase_item_id = $1`, [item.id])).q)).toBe(75);
      expect((await db.query(`select 1 from audit_log where action = 'supplier.return' and entity_id = $1`, [r.body.id])).rowCount).toBe(1);
    });
    it('فاتورة مدفوعة ثم مرتجع: ينشأ رصيد للعيادة عند المورد (سالب)، وما ينحسب إيراد ولا يدخل الخزنة', async () => {
      const { s, p, item } = await purchased(10, 1000000, { mode: 'full', pay_source: 'safe' });
      const b0 = await safeBalance(w);
      const r = await ret(w.mgr, { purchase_id: p.id, reason: 'مرتجع', items: [{ purchase_item_id: item.id, qty_base: 40 }] });
      expect(r.body).toMatchObject({ credit_amount: 400000, balance_owed: -400000, has_credit: true });
      expect(await safeBalance(w)).toBe(b0);
      const list = (await get(w.mgr, '/suppliers')).body.suppliers.find((x: any) => x.id === s.id);
      expect(list).toMatchObject({ balance_owed: -400000, has_credit: true });
      expect((await post(w.mgr, `/suppliers/${s.id}/payments`, { amount: 1, pay_source: 'safe', paid_on: today })).body.code).toBe('EXCEEDS_BALANCE');   // ما ندفع لمورد عليه رصيد لنا
    });
    it('الكمية ما تتجاوز المتبقي بالدفعة، وبند من فاتورة ثانية، وبند مكرر، وسبب إلزامي', async () => {
      const { p, item } = await purchased(1, 100000);                                // 10 cc
      const over = await ret(w.mgr, { purchase_id: p.id, reason: 'سبب', items: [{ purchase_item_id: item.id, qty_base: 10.001 }] });
      expect(over.status).toBe(409); expect(over.body).toMatchObject({ code: 'RETURN_EXCEEDS_STOCK', available: 10, requested: 10.001 });
      const other = await purchased(1, 100000);
      expect((await ret(w.mgr, { purchase_id: p.id, reason: 'سبب', items: [{ purchase_item_id: other.item.id, qty_base: 1 }] })).body.code).toBe('ITEM_NOT_IN_PURCHASE');
      expect((await ret(w.mgr, { purchase_id: p.id, reason: 'سبب', items: [{ purchase_item_id: item.id, qty_base: 1 }, { purchase_item_id: item.id, qty_base: 1 }] })).body.code).toBe('DUPLICATE_ITEM');
      expect((await ret(w.mgr, { purchase_id: p.id, items: [{ purchase_item_id: item.id, qty_base: 1 }] })).status).toBe(400);
      expect((await ret(w.mgr, { purchase_id: p.id, reason: '   ', items: [{ purchase_item_id: item.id, qty_base: 1 }] })).status).toBe(400);
      for (const q of [0, -1, 0.0001]) expect((await ret(w.mgr, { purchase_id: p.id, reason: 'سبب', items: [{ purchase_item_id: item.id, qty_base: q }] })).status).toBe(400);
      expect((await ret(w.mgr, { purchase_id: 99999999, reason: 'سبب', items: [{ purchase_item_id: item.id, qty_base: 1 }] })).status).toBe(404);
      expect(Number((await one(`select qty_on_hand::float as q from material_batches where purchase_item_id = $1`, [item.id])).q)).toBe(10);
    });
    it('مرتجعات متكررة: آخر كمية ترجع الباقي من سعر السطر بالضبط (3 × 1 من 3 وحدات بـ 100,000 = 100,000 مو 99,999)', async () => {
      const m = await material(w, { mid_unit: undefined, mid_per_pack: undefined, base_per_mid: 3 }); const s = await supplier(w);
      const p = (await buy(w, s.id, [line(m.id, 1, 100000)])).body; const item = p.items[0];
      const credits = [];
      for (let i = 0; i < 3; i++) credits.push((await ret(w.mgr, { purchase_id: p.id, reason: `دفعة ${i + 1}`, items: [{ purchase_item_id: item.id, qty_base: 1 }] })).body.credit_amount);
      expect(credits).toEqual([33333, 33333, 33334]);
      expect(credits.reduce((a, b) => a + b, 0)).toBe(100000);
      expect(await owed(s.id)).toBe(0);
      expect((await get(w.mgr, `/materials/${m.id}`)).body.stock.on_hand).toBe(0);
    });
    it('الكلفة صفر → ما أكو شي يتنزل (409) وما يتغير شي، وفاتورة ملغاة ما ينرجع منها، وفاتورة فرع ثاني 404، والكاشير 403', async () => {
      const m = await material(w); const s = await supplier(w);
      const free = (await buy(w, s.id, [line(m.id, 1, 0), line(m.id, 1, 1000, exp(100))])).body;
      const zero = await ret(w.mgr, { purchase_id: free.id, reason: 'سبب', items: [{ purchase_item_id: free.items[0].id, qty_base: 5 }] });
      expect(zero.status).toBe(409); expect(zero.body.code).toBe('NOTHING_TO_CREDIT');
      expect(Number((await one(`select qty_on_hand::float as q from material_batches where purchase_item_id = $1`, [free.items[0].id])).q)).toBe(10);
      const { p, item } = await purchased(1, 50000);
      await post(owner, `/purchases/${p.id}/void`, { reason: 'غلط' });
      expect((await ret(w.mgr, { purchase_id: p.id, reason: 'سبب', items: [{ purchase_item_id: item.id, qty_base: 1 }] })).body.code).toBe('PURCHASE_VOIDED');
      const w2 = await world('STE2'); const other = await purchased(1, 50000);
      expect((await ret(w2.mgr, { purchase_id: other.p.id, reason: 'سبب', items: [{ purchase_item_id: other.item.id, qty_base: 1 }] })).status).toBe(404);
      expect((await ret(w.cash, { purchase_id: other.p.id, reason: 'سبب', items: [{ purchase_item_id: other.item.id, qty_base: 1 }] })).status).toBe(403);
    });
    it('5 مرتجعات متزامنة 3 وحدات من دفعة فيها 10: ثلاثة تنجح واثنين RETURN_EXCEEDS_STOCK، والمخزون والحساب متسقين', async () => {
      const { m, s, p, item } = await purchased(1, 100000);
      const rs = await Promise.all(Array.from({ length: 5 }, () => ret(w.mgr, { purchase_id: p.id, reason: 'سباق', items: [{ purchase_item_id: item.id, qty_base: 3 }] })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(3);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'RETURN_EXCEEDS_STOCK')).toHaveLength(2);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect((await get(w.mgr, `/materials/${m.id}`)).body.stock.on_hand).toBe(1);
      expect(await owed(s.id)).toBe(100000 - 90000);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('إلغاء فاتورة الشراء (المالك)', () => {
    let w: World;
    beforeAll(async () => { w = await world('STF', 10000000); });
    const voidIt = (t: string, id: number, body: object = { reason: 'الفاتورة غلط' }) => post(t, `/purchases/${id}/void`, body);
    async function posted(mode: object = { mode: 'credit' }, extra: Record<string, unknown> = {}) {
      const m = await material(w); const s = await supplier(w); const p = await buy(w, s.id, [line(m.id, 2, 100000)], mode, extra); expect(p.status).toBe(201); return { m, s, p: p.body };
    }
    it('المالك بس: المدير والكاشير 403', async () => {
      const { p } = await posted();
      for (const t of [w.mgr, w.cash, doc1, nurse]) expect((await voidIt(t, p.id)).status).toBe(403);
      expect((await voidIt(owner, p.id)).status).toBe(201);
    });
    it('تنعكس دفعاتها من المخزون (purchase_void)، وتطلع من حساب المورد، وتظهر «ملغاة» بسبب', async () => {
      const { m, s, p } = await posted();
      expect(await owed(s.id)).toBe(100000);
      const r = await voidIt(owner, p.id, { reason: 'وصل مكرر' });
      expect(r.status).toBe(201); expect(r.body).toMatchObject({ status: 'voided', void_reason: 'وصل مكرر', supplier_credit_from_void: 0 });
      expect(await owed(s.id)).toBe(0);
      const mat = (await get(w.mgr, `/materials/${m.id}`)).body;
      expect(mat.stock.on_hand).toBe(0); expect(mat.batches[0]).toMatchObject({ qty_on_hand: 0, status: 'empty' });
      expect(await one(`select movement_type, qty_delta::float as q, cost_amount::int as c from stock_movements where movement_type = 'purchase_void' and material_id = $1`, [m.id])).toEqual({ movement_type: 'purchase_void', q: -20, c: -100000 });
      expect((await db.query(`select 1 from audit_log where action = 'purchase.void' and entity_id = $1 and reason = 'وصل مكرر'`, [p.id])).rowCount).toBe(1);
    });
    it('فاتورة مدفوعة: الخزنة ما ترجع، والمدفوع يصير رصيد للعيادة عند المورد (سالب)', async () => {
      const { s, p } = await posted({ mode: 'full', pay_source: 'safe' });
      const b0 = await safeBalance(w);
      const r = await voidIt(owner, p.id);
      expect(r.body.supplier_credit_from_void).toBe(100000);
      expect(await safeBalance(w)).toBe(b0);
      expect(await owed(s.id)).toBe(-100000);
      expect((await get(w.mgr, `/suppliers/${s.id}/statement`)).body.balance_owed).toBe(-100000);
    });
    it('انصرف أو انرجع منها شي → 409 PURCHASE_USED، ومرتين 409، والسبب إلزامي، وغير موجودة 404، وفرع ثاني 404', async () => {
      const { s, p } = await posted();
      expect((await post(w.mgr, '/supplier-returns', { purchase_id: p.id, reason: 'جزء', items: [{ purchase_item_id: p.items[0].id, qty_base: 1 }] })).status).toBe(201);
      expect((await voidIt(owner, p.id)).body.code).toBe('PURCHASE_USED');
      expect((await one(`select status from purchases where id = $1`, [p.id])).status).toBe('posted');
      const q = await posted();
      expect((await voidIt(owner, q.p.id, {})).status).toBe(400);
      expect((await voidIt(owner, q.p.id, { reason: '     ' })).status).toBe(400);
      expect((await voidIt(owner, q.p.id)).status).toBe(201);
      expect((await voidIt(owner, q.p.id)).body.code).toBe('ALREADY_VOIDED');
      expect((await voidIt(owner, 99999999)).status).toBe(404);
      expect(s.id).toBeGreaterThan(0);
    });
    it('رقم الفاتورة وصورة الوصل: الرقم يرجع متاح بعد الإلغاء، والصورة تبقى محجوزة (ما تنعاد)', async () => {
      const m = await material(w); const s = await supplier(w); const rc = await attach(w, 'purchase_receipt');
      const mk = (receipt: number, invoice = 'REUSE-1') => post(w.mgr, '/purchases', { supplier_id: s.id, invoice_no: invoice, purchase_date: today, receipt_attachment_id: receipt, items: [line(m.id, 1, 1000)], payment: { mode: 'credit' } });
      const a = await mk(rc); expect(a.status).toBe(201);
      expect((await mk(await attach(w, 'purchase_receipt'))).body.code).toBe('INVOICE_EXISTS');
      await voidIt(owner, a.body.id);
      expect((await mk(await attach(w, 'purchase_receipt'))).status).toBe(201);
      expect((await mk(rc, 'REUSE-2')).body.code).toBe('RECEIPT_ALREADY_USED');
    });
    it('4 إلغاءات متزامنة: واحد ينجح والمخزون ينعكس مرة وحدة', async () => {
      const { m, s, p } = await posted();
      const rs = await Promise.all(Array.from({ length: 4 }, () => voidIt(owner, p.id)));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect((await get(w.mgr, `/materials/${m.id}`)).body.stock.on_hand).toBe(0);
      expect(Number((await one(`select count(*)::int as n from stock_movements where movement_type = 'purchase_void' and material_id = $1`, [m.id])).n)).toBe(1);
      expect(await owed(s.id)).toBe(0);
    });
    it('إلغاء مع مرتجع بنفس اللحظة: واحد بس يفوز والمخزون ما يصير سالب', async () => {
      for (let i = 0; i < 3; i++) {
        const { m, p } = await posted();
        const [v, r] = await Promise.all([voidIt(owner, p.id), post(w.mgr, '/supplier-returns', { purchase_id: p.id, reason: 'سباق', items: [{ purchase_item_id: p.items[0].id, qty_base: 20 }] })]);
        expect([v.status, r.status].filter((s) => s >= 500)).toHaveLength(0);
        expect([v.status === 201, r.status === 201].filter(Boolean)).toHaveLength(1);
        expect((await get(w.mgr, `/materials/${m.id}`)).body.stock.on_hand).toBe(0);
      }
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('رصيد المواد والتنبيهات', () => {
    let w: World;
    beforeAll(async () => { w = await world('STG'); });
    it('الدفعة المنتهية والقريبة من الانتهاء، والقليل على المتاح، وتنبيه «ينتهي قريب» بإعداد المالك', async () => {
      const m = await material(w, { low_threshold: 50 }); const s = await supplier(w);
      await buy(w, s.id, [line(m.id, 1, 10000, exp(10)), line(m.id, 2, 20000, exp(400))]);              // 10 cc تنتهي بعد 10 يوم، و20 cc سليمة
      let mat = (await get(w.mgr, `/materials/${m.id}`)).body;
      expect(mat.stock).toMatchObject({ on_hand: 30, valid: 30, expired: 0, near_expiry: 10, available: 30 });
      expect(mat.flags).toMatchObject({ low: true, negative: false, near_expiry: true, has_expired: false });
      expect(mat.batches.map((b: any) => b.status)).toEqual(['near_expiry', 'ok']);
      const ids = (await db.query(`select b.id from material_batches b where material_id = $1 order by expiry_date`, [m.id])).rows;
      await db.query(`update material_batches set expiry_date = clinic_today() - 1 where id = $1`, [ids[0].id]);                // انتهت
      mat = (await get(w.mgr, `/materials/${m.id}`)).body;
      expect(mat.stock).toMatchObject({ on_hand: 30, valid: 20, expired: 10, near_expiry: 0 }); expect(mat.flags.has_expired).toBe(true);
      expect(mat.batches[0].status).toBe('expired');
      await db.query(`insert into settings (branch_id, key, value, version) values ($1,'stock.near_expiry_days','500',1)`, [w.id]);
      mat = (await get(w.mgr, `/materials/${m.id}`)).body;
      expect(mat.stock.near_expiry).toBe(20);                                                                 // الإعداد صار 500 يوم
    });
    it('المادة السالبة (صرف أكثر من المتاح بدون دفعة) تنعلّم سالبة وقليلة، وقائمة المواد بفرعها بس', async () => {
      const m = await material(w); const s = await supplier(w);
      await buy(w, s.id, [line(m.id, 1, 10000)]);                                                              // 10 cc
      const adjust = (q: number) => db.query(`insert into stock_movements (branch_id, material_id, movement_type, qty_delta, unit_cost, cost_amount) values ($1,$2,'count_adjust',$3,1000,$4)`, [w.id, m.id, q, q * 1000]);
      await adjust(-25);                                                                                       // صرف فعلي أكثر من الموجود: بدون دفعة
      const mat = (await get(w.mgr, `/materials/${m.id}`)).body;
      expect(mat.stock).toMatchObject({ on_hand: -15, available: -15 });
      expect(mat.flags).toMatchObject({ negative: true, low: true });
      await adjust(25);                                                                                        // نرجّعها حتى يبقى فحص التطابق النهائي سليم
      const list = (await get(w.mgr, '/materials')).body.materials;
      expect(list.every((x: any) => x.branch_id === w.id)).toBe(true);
      expect((await get(w.mgr, `/materials/${m.id}`)).body.flags.negative).toBe(false);
    });
  });

  it('فحص نهائي: أرصدة الدفعات = حركاتها، الفواتير = بنودها، الخزنة = حركاتها، ومخزون كل مادة = مجموع دفعاتها + حركاتها بدون دفعة (السالب)', async () => {
    const bad = await db.query(`select * from v_integrity_checks where check_name in ('batch_qty_mismatch','purchase_total_mismatch','safe_balance_mismatch','safe_payment_without_movement','safe_expense_without_movement')`);
    expect(bad.rows).toEqual([]);
    const mismatch = await db.query(`select v.material_id from v_material_stock v where abs(v.on_hand - coalesce((select sum(qty_on_hand) from material_batches b where b.material_id = v.material_id), 0) - coalesce((select sum(qty_delta) from stock_movements m where m.material_id = v.material_id and m.batch_id is null), 0)) > 0.0005`);
    expect(mismatch.rows).toEqual([]);
    const itemsVsTotal = await db.query(`select p.id from purchases p where p.total_amount <> (select coalesce(sum(line_total),0) from purchase_items i where i.purchase_id = p.id)`);
    expect(itemsVsTotal.rows).toEqual([]);
    const paidSafeNoMove = await db.query(`select x.id from supplier_payments x where x.pay_source = 'safe' and not exists (select 1 from safe_movements m where m.supplier_payment_id = x.id)`);
    expect(paidSafeNoMove.rows).toEqual([]);
    const costVsLine = await db.query(`select m.id from stock_movements m join purchase_items i on i.id = m.purchase_item_id where m.movement_type = 'purchase' and m.cost_amount <> i.line_total`);
    expect(costVsLine.rows).toEqual([]);
  });
});
