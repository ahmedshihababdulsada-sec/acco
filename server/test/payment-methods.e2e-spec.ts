import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { auth, branchId, makeApp, pool, seedUser, tokenFor } from './helpers';

describe('طرق الدفع', () => {
  let app: INestApplication; let db: Pool; let b1: number; let b2: number;
  let owner: string; let mgr1: string; let mgr2: string; let cash: string; let doc: string;
  const http = () => request(app.getHttpServer());
  const create = (t: string, body: object) => http().post('/payment-methods').set(auth(t)).send(body);
  const list = async (t: string, all = false) => (await http().get(`/payment-methods${all ? '?all=1' : ''}`).set(auth(t))).body as any[];

  beforeAll(async () => {
    app = await makeApp(); db = pool(); b1 = await branchId(db, 'B1'); b2 = await branchId(db, 'B2');
    [owner, mgr1, mgr2, cash, doc] = await Promise.all(['owner', 'mgr1', 'mgr2', 'cash1', 'doc1'].map((u) => tokenFor(app, u)));
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it('الطبيب ما يشوف القائمة، والكاشير والمدير يشوفون', async () => {
    expect((await http().get('/payment-methods').set(auth(doc))).status).toBe(403);
    const l = await list(cash);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ name_ar: 'كاش', kind: 'cash', is_active: true });
  });

  it('المدير يضيف طريقة إلكترونية: النوع إلكتروني دائماً، والجهاز إلزامي، وترتب بعد الكاش', async () => {
    const r = await create(mgr1, { name_ar: 'كي كارد', device_label: 'جهاز 1' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name_ar: 'كي كارد', kind: 'electronic', device_label: 'جهاز 1', is_active: true, sort_order: 1 });
    expect((await create(mgr1, { name_ar: 'سويتش' })).status).toBe(400);
    expect((await create(mgr1, { name_ar: 'سويتش', device_label: '' })).status).toBe(400);
    const blank = await create(mgr1, { name_ar: 'سويتش', device_label: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.body.code).toBe('INVALID_PAYMENT_METHOD');
    expect((await create(mgr1, { name_ar: 'سويتش', device_label: 'x', kind: 'cash' })).status).toBe(400);   // النوع ما ينرسل
  });

  it('نفس الاسم والجهاز مرفوض (حتى بمسافات وحروف مختلفة)، ونفس الاسم بجهاز ثاني مقبول', async () => {
    const dup = await create(mgr1, { name_ar: '  كي كارد ', device_label: 'جهاز 1 ' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('PAYMENT_METHOD_EXISTS');
    expect((await create(mgr1, { name_ar: 'كي كارد', device_label: 'جهاز 2' })).status).toBe(201);
  });

  it('الكاشير والطبيب ما يضيفون', async () => {
    expect((await create(cash, { name_ar: 'x1', device_label: 'y' })).status).toBe(403);
    expect((await create(doc, { name_ar: 'x1', device_label: 'y' })).status).toBe(403);
  });

  it('كل فرع قائمته، والمدير ما يشوف ولا يعدل فرع ثاني', async () => {
    expect((await list(mgr2, true)).map((m) => m.name_ar)).toEqual(['كاش']);
    const id = (await list(mgr1, true)).find((m) => m.kind === 'electronic').id;
    expect((await http().patch(`/payment-methods/${id}`).set(auth(mgr2)).send({ name_ar: 'هاك' })).status).toBe(404);
    expect((await http().post(`/payment-methods/${id}/disable`).set(auth(mgr2))).status).toBe(404);
    expect((await create(mgr1, { name_ar: 'غريب', device_label: 'z', branch_id: b2 })).status).toBe(403);
    expect((await create(owner, { name_ar: 'غريب', device_label: 'z', branch_id: b2 })).status).toBe(201);
  });

  it('التعديل: الاسم والجهاز يتغيران، والكاش ثابت، والتكرار مرفوض', async () => {
    const [cashM, kc1, kc2] = (await list(mgr1, true));
    const r = await http().patch(`/payment-methods/${kc1.id}`).set(auth(mgr1)).send({ name_ar: 'كي كارد جديد' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name_ar: 'كي كارد جديد', device_label: 'جهاز 1', kind: 'electronic' });
    const cashEdit = await http().patch(`/payment-methods/${cashM.id}`).set(auth(mgr1)).send({ name_ar: 'نقد' });
    expect(cashEdit.status).toBe(409);
    expect(cashEdit.body.code).toBe('CASH_FIXED');
    const clash = await http().patch(`/payment-methods/${kc2.id}`).set(auth(mgr1)).send({ name_ar: 'كي كارد جديد', device_label: 'جهاز 1' });
    expect(clash.status).toBe(409);
    expect((await http().patch(`/payment-methods/${kc2.id}`).set(auth(mgr1)).send({ kind: 'cash' })).status).toBe(400);
    expect((await http().patch('/payment-methods/999999').set(auth(mgr1)).send({ name_ar: 'xx' })).status).toBe(404);
  });

  it('الوصل القديم يحتفظ باسم الطريقة وقت الدفع بعد التغيير', async () => {
    const m = (await list(mgr1, true)).find((x) => x.device_label === 'جهاز 2');
    const cust = (await db.query(`insert into customers (branch_id, public_code, phone, full_name, source) values ($1,'PMX1','+9647800000901','زبون','cashier') returning id`, [b1])).rows[0].id;
    const cashier = (await db.query(`select id from users where username='cash1'`)).rows[0].id;
    const shift = (await db.query(`insert into shifts (branch_id, cashier_id, opening_float) values ($1,$2,0) returning id`, [b1, cashier])).rows[0].id;
    const pay = (await db.query(`insert into payments (branch_id, receipt_no, customer_id, shift_id, cashier_id, kind, gross_amount, net_amount, clinic_snapshot) values ($1,'2099-00001',$2,$3,$4,'sessions',50000,50000,'{}') returning id`, [b1, cust, shift, cashier])).rows[0].id;
    await db.query(`insert into payment_tenders (payment_id, method_id, method_name, method_kind, device_label, amount) values ($1,$2,$3,'electronic',$4,50000)`, [pay, m.id, m.name_ar, m.device_label]);
    await http().patch(`/payment-methods/${m.id}`).set(auth(mgr1)).send({ name_ar: 'اسم جديد كلياً' });
    expect((await db.query(`select method_name from payment_tenders where payment_id=$1`, [pay])).rows[0].method_name).toBe('كي كارد');
    // التعطيل يرجع تحذير شفت مفتوح انقبض بيه مبلغ بهذي الطريقة
    const d = await http().post(`/payment-methods/${m.id}/disable`).set(auth(mgr1));
    expect(d.status).toBe(200);
    expect(d.body.is_active).toBe(false);
    expect(d.body.warning).toEqual({ open_shifts: 1, collected: 50000 });
    await db.query(`update shifts set status='closed', closed_at=now() where id=$1`, [shift]);
    await http().post(`/payment-methods/${m.id}/enable`).set(auth(mgr1));
    const again = await http().post(`/payment-methods/${m.id}/disable`).set(auth(mgr1));
    expect(again.body.warning).toBeNull();                   // الشفت انسكر
    await http().post(`/payment-methods/${m.id}/enable`).set(auth(mgr1));
  });

  it('التعطيل: يختفي من قائمة الكاشير ويبقى للمدير، والكاش ما يتعطل، والتكرار بدون أثر، والتفعيل يرجعه', async () => {
    const kc = (await list(mgr1, true)).find((m) => m.kind === 'electronic');
    expect((await http().post(`/payment-methods/${kc.id}/disable`).set(auth(mgr1))).body.is_active).toBe(false);
    expect((await http().post(`/payment-methods/${kc.id}/disable`).set(auth(mgr1))).status).toBe(200);
    expect((await list(cash)).map((m) => m.id)).not.toContain(kc.id);
    expect((await list(cash, true)).map((m) => m.id)).not.toContain(kc.id);       // الكاشير ما يشوف المعطلة حتى مع all=1
    expect((await list(mgr1, true)).map((m) => m.id)).toContain(kc.id);
    expect((await list(mgr1)).map((m) => m.id)).not.toContain(kc.id);             // بدون all=1 حتى المدير يشوف الفعالة بس
    const cashId = (await list(mgr1, true)).find((m) => m.kind === 'cash').id;
    const c = await http().post(`/payment-methods/${cashId}/disable`).set(auth(mgr1));
    expect(c.status).toBe(409);
    expect(c.body.code).toBe('CASH_FIXED');
    expect((await http().post(`/payment-methods/${kc.id}/enable`).set(auth(mgr1))).body.is_active).toBe(true);
    expect((await list(cash)).map((m) => m.id)).toContain(kc.id);
  });

  it('الترتيب: فوق وتحت، والأرقام تبقى 1..n بدون تكرار، والأول فوق = لا شي', async () => {
    await seedUser(db, 'mgr-order', 'manager', b2);
    const t = await tokenFor(app, 'mgr-order');
    for (const n of ['أ', 'ب', 'ج']) await create(t, { name_ar: `طريقة ${n}`, device_label: `ج-${n}` });
    const names = async () => (await list(t, true)).map((m) => m.name_ar);
    expect(await names()).toEqual(['كاش', 'غريب', 'طريقة أ', 'طريقة ب', 'طريقة ج']);
    const idOf = async (name: string) => (await list(t, true)).find((m) => m.name_ar === name).id;
    await http().post(`/payment-methods/${await idOf('طريقة ج')}/move`).set(auth(t)).send({ direction: 'up' });
    expect(await names()).toEqual(['كاش', 'غريب', 'طريقة أ', 'طريقة ج', 'طريقة ب']);
    await http().post(`/payment-methods/${await idOf('كاش')}/move`).set(auth(t)).send({ direction: 'up' });   // الأول: ما يتحرك
    await http().post(`/payment-methods/${await idOf('طريقة ب')}/move`).set(auth(t)).send({ direction: 'down' }); // الأخير: ما يتحرك
    expect(await names()).toEqual(['كاش', 'غريب', 'طريقة أ', 'طريقة ج', 'طريقة ب']);
    const r = await http().post(`/payment-methods/${await idOf('طريقة أ')}/move`).set(auth(t)).send({ direction: 'down' });
    expect(r.body.map((m: any) => m.name_ar)).toEqual(['كاش', 'غريب', 'طريقة ج', 'طريقة أ', 'طريقة ب']);
    const orders = (await db.query(`select sort_order from payment_methods where branch_id=$1 order by sort_order`, [b2])).rows.map((x) => x.sort_order);
    expect(orders).toEqual([1, 2, 3, 4, 5]);
    expect((await http().post(`/payment-methods/${await idOf('طريقة أ')}/move`).set(auth(t)).send({ direction: 'sideways' })).status).toBe(400);
  });

  it('كل تغيير ينسجل بسجل الحركات', async () => {
    const actions = (await db.query(`select distinct action from audit_log where entity_type='payment_method'`)).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['payment_method.create', 'payment_method.update', 'payment_method.disable', 'payment_method.enable', 'payment_method.reorder']));
  });
});
