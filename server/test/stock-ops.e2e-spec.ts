import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = () => Buffer.concat([PNG, randomBytes(64)]);

interface World { id: number; code: string; mgr: string; mgrId: number; cash: string; doctorId: number; serviceId: number }

describe('التالف والجرد وتنبيهات المخزون', () => {
  let app: INestApplication; let db: Pool; let today: string; let nurse: string; let doc1: string;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  let nameSeq = 0; let fixSeq = 0;

  async function world(code: string): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name) values ($1,$1) returning id`, [code])).rows[0].id);
    await db.query(`insert into safes (branch_id) values ($1)`, [id]);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id); await seedUser(db, `cash_${code}`, 'cashier', id);
    const doctorId = await seedUser(db, `doc_${code}`, 'doctor', id);
    const serviceId = Number((await db.query(`insert into services (branch_id, name_ar, kind, pricing_model, is_active) values ($1,'جلسة','treatment','fixed',true) returning id`, [id])).rows[0].id);
    await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',100000000,'opening_balance','تجربة',$2)`, [id, mgrId]);
    return { id, code, mgr: await tokenFor(app, `mgr_${code}`), mgrId, cash: await tokenFor(app, `cash_${code}`), doctorId, serviceId };
  }
  const attach = async (w: World) => (await http().post('/attachments').set(auth(w.mgr)).field('kind', 'purchase_receipt').attach('file', png(), { filename: 'a.png' })).body.id as number;
  const material = async (w: World, over: Record<string, unknown> = {}) => (await post(w.mgr, '/materials', { name: `م ${++nameSeq}-${Math.random().toString(36).slice(2, 6)}`, base_unit: 'cc', pack_unit: 'كرتون', mid_unit: 'علبة', mid_per_pack: 10, base_per_mid: 1, ...over })).body;
  const supplier = async (w: World) => (await post(w.mgr, '/suppliers', { name: `مورد ${++nameSeq}-${Math.random().toString(36).slice(2, 6)}` })).body;
  /** يشتري `packs` كرتون (10 cc) بإجمالي `total`، ويرجع الدفعة */
  async function stock(w: World, m: any, packs: number, total: number, expiryDays = 365) {
    const s = await supplier(w);
    const r = await post(w.mgr, '/purchases', { supplier_id: s.id, purchase_date: today, receipt_attachment_id: await attach(w), items: [{ material_id: m.id, qty_pack: packs, line_total: total, expiry_date: addDays(today, expiryDays) }], payment: { mode: 'credit' } });
    expect(r.status).toBe(201);
    return { batchId: r.body.items[0].batch_id as number, purchase: r.body };
  }
  const batchQty = async (id: number) => Number((await one(`select qty_on_hand::float as q from material_batches where id = $1`, [id])).q);
  const onHand = async (mid: number) => Number((await one(`select on_hand::float as q from v_material_stock where material_id = $1`, [mid])).q);
  const expire = (batchId: number, daysAgo = 1) => db.query(`update material_batches set expiry_date = clinic_today() - $2::int where id = $1`, [batchId, daysAgo]);
  /** يحجز كمية من المادة لجلسة مدفوعة (session_material_needs) */
  async function reserve(w: World, materialId: number, qty: number) {
    fixSeq++;
    const c = (await one(`insert into customers (branch_id, public_code, phone, full_name, source) values ($1,$2,$3,'زبون محجوز','cashier') returning id`, [w.id, `RS${fixSeq}${Date.now() % 1e6}`, `+9647${String(500000000 + fixSeq)}`])).id;
    const v = (await one(`insert into visits (branch_id, customer_id, visit_date, seq_no, status, source, doctor_id) values ($1,$2,clinic_today(),$3,'arrived','cashier',$4) returning id`, [w.id, c, 800 + fixSeq, w.doctorId])).id;
    const cons = (await one(`insert into consultations (branch_id, visit_id, customer_id, doctor_id, status, entered_at, finished_at) values ($1,$2,$3,$4,'finished',now(),now()) returning id`, [w.id, v, c, w.doctorId])).id;
    const plan = (await one(`insert into treatment_plans (branch_id, customer_id, consultation_id, doctor_id, status) values ($1,$2,$3,$4,'active') returning id`, [w.id, c, cons, w.doctorId])).id;
    const item = (await one(`insert into plan_items (plan_id, service_id, sessions_count, first_session_date) values ($1,$2,1,clinic_today()) returning id`, [plan, w.serviceId])).id;
    const sess = (await one(`insert into treatment_sessions (branch_id, customer_id, plan_item_id, seq_no, status, scheduled_date, doctor_planned_date, visit_id) values ($1,$2,$3,1,'paid',clinic_today(),clinic_today(),$4) returning id`, [w.id, c, item, v])).id;
    await db.query(`insert into session_material_needs (treatment_session_id, material_id, qty_base) values ($1,$2,$3)`, [sess, materialId, String(qty)]);
    return sess as number;
  }
  const adjust = (w: World, materialId: number, qty: number, cost = 1000) => db.query(`insert into stock_movements (branch_id, material_id, movement_type, qty_delta, unit_cost, cost_amount) values ($1,$2,'count_adjust',$3,$4,$5)`, [w.id, materialId, String(qty), cost, Math.round(qty * cost)]);
  /** يمسك قفل دفعة بمعاملة مفتوحة وينقص منها (مثل عملية ثانية جارية) ويرجع دالة الإنهاء. نستخدمه لاختبار الأقفال بشكل حتمي. */
  async function holdBatchAndShrink(batchId: number, qty: number) {
    const c = await db.connect(); let done = false;
    await c.query('begin');
    const b = (await c.query(`select material_id, branch_id, unit_cost from material_batches where id = $1 for update`, [batchId])).rows[0];
    await c.query(`insert into stock_movements (branch_id, material_id, batch_id, movement_type, qty_delta, unit_cost, cost_amount) values ($1,$2,$3,'count_adjust',$4,$5,$6)`, [b.branch_id, b.material_id, batchId, String(-qty), b.unit_cost, -Math.round(qty * Number(b.unit_cost))]);
    return { release: async () => { if (done) return; done = true; try { await c.query('commit'); } finally { c.release(); } } };
  }
  const waste = (t: string, body: object) => post(t, '/stock/waste', body);
  const count = (t: string, lines: object[], note?: string) => post(t, '/stock/counts', { ...(note ? { note } : {}), lines });
  const bline = (batch_id: number, actual_qty: number, expected_system_qty: number, note?: string) => ({ kind: 'batch', batch_id, actual_qty, expected_system_qty, ...(note ? { note } : {}) });

  beforeAll(async () => {
    app = await makeApp(); db = pool();
    today = (await db.query(`select clinic_today()::text as d`)).rows[0].d;
    [nurse, doc1] = await Promise.all(['nurse1', 'doc1'].map((u) => tokenFor(app, u)));
  });
  afterAll(async () => { await app.close(); await db.end(); });

  // ------------------------------------------------------------------------------------------------
  describe('التالف', () => {
    let w: World; let w2: World;
    beforeAll(async () => { w = await world('SWA'); w2 = await world('SWA2'); });
    it('تسجيل تالف: الدفعة تنقص، حركة waste بكلفة الدفعة (الكمية × الكلفة)، وسجل وحركات', async () => {
      const m = await material(w); const { batchId } = await stock(w, m, 10, 1000000);          // 100 cc بمليون = 10,000 للـ cc
      const r = await waste(w.mgr, { batch_id: batchId, qty: 10, reason: 'damaged', note: '  وقعت  ' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ batch_id: batchId, qty: 10, reason: 'damaged', note: 'وقعت', cost_amount: 100000, wasted_on: today, material: { id: m.id, unit: 'cc' } });
      expect(await batchQty(batchId)).toBe(90);
      expect(await one(`select movement_type, qty_delta::float as q, cost_amount::int as c from stock_movements where waste_id = $1`, [r.body.id])).toEqual({ movement_type: 'waste', q: -10, c: -100000 });
      expect(await onHand(m.id)).toBe(90);
      expect((await db.query(`select 1 from audit_log where action = 'stock.waste' and entity_id = $1`, [r.body.id])).rowCount).toBe(1);
    });
    it('تقريب الكلفة: 3.5 × 4761.9048 = 16,667', async () => {
      const m = await material(w, { mid_unit: undefined, mid_per_pack: undefined, base_per_mid: 7 }); const { batchId } = await stock(w, m, 3, 100000);     // 21 cc، 4761.9048 للوحدة
      expect((await waste(w.mgr, { batch_id: batchId, qty: 3.5, reason: 'prep_error' })).body.cost_amount).toBe(16667);
    });
    it('السبب «أخرى» يحتاج ملاحظة، والسبب والكمية والحقول تنفحص، والصلاحيات', async () => {
      const m = await material(w); const { batchId } = await stock(w, m, 1, 10000);
      expect((await waste(w.mgr, { batch_id: batchId, qty: 1, reason: 'other' })).body.code).toBe('NOTE_REQUIRED');
      expect((await waste(w.mgr, { batch_id: batchId, qty: 1, reason: 'other', note: '    ' })).body.code).toBe('NOTE_REQUIRED');
      expect((await waste(w.mgr, { batch_id: batchId, qty: 1, reason: 'other', note: 'سبب' })).status).toBe(201);
      for (const bad of [{ qty: 0 }, { qty: -1 }, { qty: 0.0001 }, { reason: 'x' }, { extra: 1 }]) expect((await waste(w.mgr, { batch_id: batchId, qty: 1, reason: 'damaged', ...bad })).status).toBe(400);
      for (const t of [w.cash, doc1, nurse]) expect((await waste(t, { batch_id: batchId, qty: 1, reason: 'damaged' })).status).toBe(403);
      expect((await waste(w.mgr, { batch_id: 99999999, qty: 1, reason: 'damaged' })).status).toBe(404);
      expect((await waste(w2.mgr, { batch_id: batchId, qty: 1, reason: 'damaged' })).status).toBe(404);          // دفعة فرع ثاني
    });
    it('ما يتجاوز المتبقي بالدفعة، وما ياخذ المحجوز لجلسات مدفوعة (الصالح ناقص المحجوز)', async () => {
      const m = await material(w); const { batchId } = await stock(w, m, 10, 100000);                            // 100 cc
      const over = await waste(w.mgr, { batch_id: batchId, qty: 100.001, reason: 'damaged' });
      expect(over.status).toBe(409); expect(over.body).toMatchObject({ code: 'WASTE_EXCEEDS_BATCH', available: 100, requested: 100.001 });
      await reserve(w, m.id, 95);
      const res = await waste(w.mgr, { batch_id: batchId, qty: 6, reason: 'damaged' });
      expect(res.status).toBe(409); expect(res.body).toMatchObject({ code: 'WASTE_RESERVED', available_to_waste: 5, reserved: 95, requested: 6 });
      expect(await batchQty(batchId)).toBe(100);
      expect((await waste(w.mgr, { batch_id: batchId, qty: 5, reason: 'damaged' })).status).toBe(201);
      expect((await waste(w.mgr, { batch_id: batchId, qty: 0.001, reason: 'damaged' })).body.code).toBe('WASTE_RESERVED');
    });
    it('الدفعة المنتهية تنسجل كلها (جزئي مرفوض)، والمحجوز ما يمنعها، والكلفة الكاملة', async () => {
      const m = await material(w); const exp = await stock(w, m, 1, 50000, 100); const ok = await stock(w, m, 2, 100000, 400);   // 10 منتهية + 20 سليمة
      await expire(exp.batchId);
      await reserve(w, m.id, 20);                                                                                  // كل السليم محجوز
      const part = await waste(w.mgr, { batch_id: exp.batchId, qty: 4, reason: 'expired' });
      expect(part.status).toBe(409); expect(part.body).toMatchObject({ code: 'EXPIRED_FULL_ONLY', available: 10, requested: 4 });
      const full = await waste(w.mgr, { batch_id: exp.batchId, qty: 10, reason: 'expired' });
      expect(full.status).toBe(201); expect(full.body.cost_amount).toBe(50000);
      expect(await batchQty(exp.batchId)).toBe(0); expect(await batchQty(ok.batchId)).toBe(20);
      expect((await waste(w.mgr, { batch_id: ok.batchId, qty: 1, reason: 'damaged' })).body.code).toBe('WASTE_RESERVED');
    });
    it('5 تالف متزامن 3 وحدات من دفعة فيها 10: ثلاثة تنجح واثنين WASTE_EXCEEDS_BATCH', async () => {
      const m = await material(w); const { batchId } = await stock(w, m, 1, 10000);
      const rs = await Promise.all(Array.from({ length: 5 }, () => waste(w.mgr, { batch_id: batchId, qty: 3, reason: 'damaged' })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(3);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'WASTE_EXCEEDS_BATCH')).toHaveLength(2);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(await batchQty(batchId)).toBe(1);
    });
    it('تالف ومرتجع مورد متزامنين على نفس الدفعة (10 وحدات، كل عملية 4): اثنتين بس تنجحان، والباقي 409 بدون خطأ 500', async () => {
      const m = await material(w); const { batchId, purchase } = await stock(w, m, 1, 10000);
      const item = purchase.items[0].id;
      const ops = [
        ...Array.from({ length: 3 }, () => waste(w.mgr, { batch_id: batchId, qty: 4, reason: 'damaged' })),
        ...Array.from({ length: 3 }, () => post(w.mgr, '/supplier-returns', { purchase_id: purchase.id, reason: 'سباق', items: [{ purchase_item_id: item, qty_base: 4 }] })),
      ];
      const rs = await Promise.all(ops);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(rs.filter((r) => r.status === 201)).toHaveLength(2);
      expect(rs.filter((r) => r.status === 409)).toHaveLength(4);
      expect(await batchQty(batchId)).toBe(2);
      expect(await onHand(m.id)).toBe(2);
    });
    it('عملية جارية على نفس الدفعة (حتمي): نقصت 8 من 10 والتالف يوصل بكمية قديمة → ينتظر ويعيد القراءة ويرفض بدل ما ينهار', async () => {
      const m = await material(w); const { batchId } = await stock(w, m, 1, 10000);
      const hold = await holdBatchAndShrink(batchId, 8);
      let res: any;
      try {
        const p = waste(w.mgr, { batch_id: batchId, qty: 4, reason: 'damaged' }).then((r) => { res = r; return r; });
        await new Promise((r) => setTimeout(r, 400));
        await hold.release();
        await p;
      } finally { await hold.release(); }
      expect(res.status).toBe(409); expect(res.body).toMatchObject({ code: 'WASTE_EXCEEDS_BATCH', available: 2, requested: 4 });
      expect(await batchQty(batchId)).toBe(2);
    });
    it('تالف متزامن على دفعتين لنفس المادة والمحجوز يترك 6 بس: كمية التالف الكلية ما تتجاوز المتاح', async () => {
      const m = await material(w); const a = await stock(w, m, 1, 10000, 100); const b = await stock(w, m, 1, 10000, 200);       // 10 + 10 = 20
      await reserve(w, m.id, 14);                                                                                  // المتاح للتالف 6
      const rs = await Promise.all([a.batchId, b.batchId, a.batchId, b.batchId, a.batchId].map((id) => waste(w.mgr, { batch_id: id, qty: 3, reason: 'damaged' })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(2);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'WASTE_RESERVED')).toHaveLength(3);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(await onHand(m.id)).toBe(14);
    });
    it('القائمة: شهر الحالي، إجمالي الكلفة وحسب السبب، فلتر المادة، وتحقق المدخلات، وبفرعها بس', async () => {
      const x = await world('SWB'); const m1 = await material(x); const m2 = await material(x);
      const b1 = (await stock(x, m1, 10, 1000000)).batchId; const b2 = (await stock(x, m2, 10, 500000)).batchId;
      await waste(x.mgr, { batch_id: b1, qty: 2, reason: 'damaged' }); await waste(x.mgr, { batch_id: b1, qty: 1, reason: 'prep_error' }); await waste(x.mgr, { batch_id: b2, qty: 4, reason: 'damaged' });
      const r = (await get(x.mgr, '/stock/waste')).body;
      expect(r.waste).toHaveLength(3); expect(r.total_cost).toBe(20000 + 10000 + 20000);
      expect(r.by_reason.find((x: any) => x.reason === 'damaged')).toMatchObject({ cost: 40000, count: 2 });
      expect((await get(x.mgr, `/stock/waste?material_id=${m2.id}`)).body.total_cost).toBe(20000);
      const prev = (await get(x.mgr, `/stock/waste?month=${addDays(today, -40).slice(0, 7)}`)).body;
      expect(prev.waste).toEqual([]); expect(prev.total_cost).toBe(0); expect(prev.by_reason).toEqual([]);                  // الإجمالي أيضاً يتبع المدى
      expect((await get(x.mgr, '/stock/waste?month=2026-13')).body.code).toBe('INVALID_MONTH');
      expect((await get(x.mgr, `/stock/waste?from=${today}&to=${addDays(today, -1)}`)).body.code).toBe('INVALID_RANGE');
      expect((await get(w2.mgr, '/stock/waste')).body.waste.every((e: any) => e.batch_id !== b1)).toBe(true);
      for (const t of [x.cash, doc1, nurse]) expect((await get(t, '/stock/waste')).status).toBe(403);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('الجرد', () => {
    let w: World; let w2: World;
    beforeAll(async () => { w = await world('SCA'); w2 = await world('SCA2'); });
    it('الورقة: الدفعات الصالحة بكمية النظام، المنتهية والفارغة مستبعدة، والسالب ينذكر، وعدد المنتهي للتالف', async () => {
      const x = await world('SCB');
      const ok = await material(x); const okB = (await stock(x, ok, 1, 10000)).batchId;
      const old = await material(x); const oldB = (await stock(x, old, 1, 10000)).batchId; await expire(oldB);
      const empty = await material(x); const emptyB = (await stock(x, empty, 1, 10000)).batchId; await waste(x.mgr, { batch_id: emptyB, qty: 10, reason: 'damaged' });
      const neg = await material(x); await stock(x, neg, 1, 20000); await adjust(x, neg.id, -10); await adjust(x, neg.id, -5);     // موجود 10 بدفعة، −15 بدون دفعة → −5
      const sheet = (await get(x.mgr, '/stock/counts/sheet')).body;
      const ids = sheet.batches.map((b: any) => b.batch_id);
      expect(ids).toContain(okB); expect(ids).not.toContain(oldB); expect(ids).not.toContain(emptyB);
      expect(sheet.batches.find((b: any) => b.batch_id === okB)).toMatchObject({ system_qty: 10, material: { id: ok.id } });
      expect(sheet.negative_materials).toEqual([{ material: { id: neg.id, name: neg.name, unit: 'cc' }, system_qty: -5, last_unit_cost: 2000, has_batches: true }]);
      expect(sheet.expired_batches_to_waste).toBe(1);
      await adjust(x, neg.id, 15);
    });
    it('جرد دفعة: النقص والزيادة والمطابق، حركات count_adjust بالكلفة، والباقي ما يتغير، وقيمة النقص والزيادة بالسجل', async () => {
      const a = await material(w); const b = await material(w); const c = await material(w);
      const A = (await stock(w, a, 10, 1000000)).batchId; const B = (await stock(w, b, 5, 250000)).batchId; const C = (await stock(w, c, 1, 10000)).batchId;
      const r = await count(w.mgr, [bline(A, 90, 100, 'كسر 10'), bline(B, 53, 50, 'زيادة 3'), bline(C, 10, 10)], 'جرد شهري');
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ status: 'posted', count_date: today, note: 'جرد شهري', shortage_value: 100000, surplus_value: 15000 });
      expect(r.body.lines.map((l: any) => [l.kind, l.system_qty, l.actual_qty, l.diff_qty])).toEqual([['batch', 100, 90, -10], ['batch', 50, 53, 3], ['batch', 10, 10, 0]]);
      expect(await batchQty(A)).toBe(90); expect(await batchQty(B)).toBe(53); expect(await batchQty(C)).toBe(10);
      const mv = (await db.query(`select movement_type, qty_delta::float as q, cost_amount::int as c, batch_id::int as b from stock_movements where movement_type = 'count_adjust' and material_id = any($1::bigint[]) order by id`, [[a.id, b.id, c.id]])).rows;
      expect(mv).toEqual([{ movement_type: 'count_adjust', q: -10, c: -100000, b: A }, { movement_type: 'count_adjust', q: 3, c: 15000, b: B }]);        // المطابق بدون حركة
      expect((await get(w.mgr, `/stock/counts/${r.body.id}`)).body.id).toBe(r.body.id);
      expect((await get(w.mgr, '/stock/counts')).body.counts[0].id).toBe(r.body.id);
      expect((await db.query(`select 1 from audit_log where action = 'stock.count' and entity_id = $1`, [r.body.id])).rowCount).toBe(1);
      expect(await onHand(a.id)).toBe(90);
    });
    it('الفرق بدون ملاحظة → 409 وما ينكتب شي (حتى لو الأسطر الثانية سليمة)', async () => {
      const a = await material(w); const b = await material(w);
      const A = (await stock(w, a, 1, 10000)).batchId; const B = (await stock(w, b, 1, 10000)).batchId;
      const before = Number((await one(`select count(*)::int as n from stock_counts where branch_id = $1`, [w.id])).n);
      const r = await count(w.mgr, [bline(A, 8, 10, 'سبب'), bline(B, 7, 10)]);
      expect(r.status).toBe(409); expect(r.body).toMatchObject({ code: 'NOTE_REQUIRED', system_qty: 10, actual_qty: 7 });
      expect((await count(w.mgr, [bline(B, 7, 10, '    ')])).body.code).toBe('NOTE_REQUIRED');
      expect(await batchQty(A)).toBe(10); expect(await batchQty(B)).toBe(10);
      expect(Number((await one(`select count(*)::int as n from stock_counts where branch_id = $1`, [w.id])).n)).toBe(before);
    });
    it('كمية النظام تغيرت من فتحت الورقة → STOCK_CHANGED، والدفعة المنتهية BATCH_EXPIRED، والمكرر، والسطر الغلط', async () => {
      const m = await material(w); const { batchId } = await stock(w, m, 1, 10000);
      await waste(w.mgr, { batch_id: batchId, qty: 2, reason: 'damaged' });
      const r = await count(w.mgr, [bline(batchId, 8, 10, 'سبب')]);
      expect(r.status).toBe(409); expect(r.body).toMatchObject({ code: 'STOCK_CHANGED', batch_id: batchId, current_system_qty: 8 });
      expect((await count(w.mgr, [bline(batchId, 7, 8, 'سبب')])).status).toBe(201);
      const e = await material(w); const eb = (await stock(w, e, 1, 10000)).batchId; await expire(eb);
      expect((await count(w.mgr, [bline(eb, 5, 10, 'سبب')])).body.code).toBe('BATCH_EXPIRED');
      expect((await count(w.mgr, [bline(batchId, 7, 7), bline(batchId, 7, 7)])).body.code).toBe('DUPLICATE_LINE');
      expect((await count(w.mgr, [{ kind: 'batch', batch_id: batchId, material_id: 1, actual_qty: 1, expected_system_qty: 1 }])).body.code).toBe('INVALID_LINE');
      expect((await count(w.mgr, [{ kind: 'material_level', batch_id: batchId, actual_qty: 1, expected_system_qty: 1 }])).body.code).toBe('INVALID_LINE');
      for (const bad of [{ actual_qty: -1 }, { actual_qty: 0.0001 }, { kind: 'x' }]) expect((await count(w.mgr, [{ ...bline(batchId, 7, 7), ...bad }])).status).toBe(400);
      expect((await count(w.mgr, [])).status).toBe(400);
    });
    it('الكمية الفعلية ما تنزل تحت المحجوز لجلسات مدفوعة، والمطابق مع المحجوز مسموح', async () => {
      const m = await material(w); const { batchId } = await stock(w, m, 10, 100000);                            // 100
      await reserve(w, m.id, 90);
      const r = await count(w.mgr, [bline(batchId, 80, 100, 'نقص')]);
      expect(r.status).toBe(409); expect(r.body).toMatchObject({ code: 'BELOW_RESERVED', reserved: 90, would_be_valid: 80 });
      expect(await batchQty(batchId)).toBe(100);
      expect((await count(w.mgr, [bline(batchId, 90, 100, 'نقص')])).status).toBe(201);
      expect((await count(w.mgr, [bline(batchId, 120, 90, 'زيادة')])).status).toBe(201);                        // الزيادة دائماً
    });
    it('الصلاحيات وفصل الفروع: الكاشير والطبيب والممرض 403، دفعة فرع ثاني 404، وغير موجودة 404', async () => {
      const m = await material(w); const { batchId } = await stock(w, m, 1, 10000);
      for (const t of [w.cash, doc1, nurse]) { expect((await count(t, [bline(batchId, 5, 10, 'x1')])).status).toBe(403); expect((await get(t, '/stock/counts/sheet')).status).toBe(403); expect((await get(t, '/stock/counts')).status).toBe(403); }
      expect((await count(w2.mgr, [bline(batchId, 5, 10, 'سبب')])).status).toBe(404);
      expect((await count(w.mgr, [bline(99999999, 5, 10, 'سبب')])).status).toBe(404);
      expect((await get(w2.mgr, '/stock/counts/99999999')).status).toBe(404);
      const own = (await count(w.mgr, [bline(batchId, 9, 10, 'سبب')])).body;
      expect((await get(w2.mgr, `/stock/counts/${own.id}`)).status).toBe(404);
    });
    it('تصحيح مادة سالبة بدفعة جديدة: السالب يتصفر والكمية الفعلية تدخل بدفعة (source=count) بآخر سعر شراء وصلاحية جديدة', async () => {
      const m = await material(w); const { batchId } = await stock(w, m, 1, 20000);                              // آخر كلفة 2,000 للـ cc
      await waste(w.mgr, { batch_id: batchId, qty: 10, reason: 'damaged' });                                     // الدفعة صارت فاضية
      await adjust(w, m.id, -5);                                                                                  // صرف فعلي 5 بدون دفعة → سالب
      expect(await onHand(m.id)).toBe(-5);
      const lvl = { kind: 'material_level', material_id: m.id, actual_qty: 3, expected_system_qty: -5, note: 'جردنا الكريم', new_batch_expiry: addDays(today, 200) };
      const r = await count(w.mgr, [lvl]);
      expect(r.status).toBe(201);
      expect(r.body.lines[0]).toMatchObject({ kind: 'material_level', system_qty: -5, actual_qty: 3, diff_qty: 8, new_batch_expiry: addDays(today, 200) });
      expect(await onHand(m.id)).toBe(3);
      const mat = (await get(w.mgr, `/materials/${m.id}`)).body;
      expect(mat.batches.find((b: any) => b.source === 'count')).toMatchObject({ qty_initial: 3, qty_on_hand: 3, unit_cost: 2000, expiry_date: addDays(today, 200), status: 'ok' });
      expect(mat.flags.negative).toBe(false);
      expect((await db.query(`select qty_delta::float as q, batch_id from stock_movements where count_line_id = (select id from stock_count_lines where count_id = $1) order by id`, [r.body.id])).rows.map((x) => [x.q, x.batch_id === null])).toEqual([[5, true], [3, false]]);
    });
    it('المادة السالبة: لازم ملاحظة وصلاحية وكلفة، والكلفة الصريحة تنفع بدون آخر سعر، والفعلي صفر يصفّر السالب بدون دفعة', async () => {
      const m = await material(w);                                                                                // بدون أي شراء: ما أكو آخر سعر
      await adjust(w, m.id, -4);
      const base = { kind: 'material_level', material_id: m.id, expected_system_qty: -4 };
      expect((await count(w.mgr, [{ ...base, actual_qty: 2, new_batch_expiry: addDays(today, 90) }])).body.code).toBe('NOTE_REQUIRED');
      expect((await count(w.mgr, [{ ...base, actual_qty: 2, note: 'سبب' }])).body.code).toBe('EXPIRY_REQUIRED');
      expect((await count(w.mgr, [{ ...base, actual_qty: 2, note: 'سبب', new_batch_expiry: today }])).body.code).toBe('EXPIRY_PAST');
      expect((await count(w.mgr, [{ ...base, actual_qty: 2, note: 'سبب', new_batch_expiry: addDays(today, 90) }])).body.code).toBe('COST_REQUIRED');
      expect(await onHand(m.id)).toBe(-4);
      const zero = await count(w.mgr, [{ ...base, actual_qty: 0, note: 'ما أكو شي فعلاً', new_batch_unit_cost: 500 }]);
      expect(zero.status).toBe(201);
      expect(await onHand(m.id)).toBe(0);
      expect((await get(w.mgr, `/materials/${m.id}`)).body.batches).toEqual([]);                                  // ما انفتحت دفعة
      const m2 = await material(w); await adjust(w, m2.id, -4);
      expect((await count(w.mgr, [{ kind: 'material_level', material_id: m2.id, actual_qty: 2, expected_system_qty: -4, note: 'سبب', new_batch_expiry: addDays(today, 90), new_batch_unit_cost: 750 }])).status).toBe(201);
      expect((await get(w.mgr, `/materials/${m2.id}`)).body.batches[0]).toMatchObject({ unit_cost: 750, qty_on_hand: 2 });
    });
    it('المادة غير السالبة أو اللي عندها دفعات تنجرد بالدفعات (NOT_NEGATIVE / HAS_BATCHES)، وكمية النظام تتأكد، والمحجوز ما ينتهك', async () => {
      const fine = await material(w); await stock(w, fine, 1, 10000);
      expect((await count(w.mgr, [{ kind: 'material_level', material_id: fine.id, actual_qty: 5, expected_system_qty: 10, note: 'سبب', new_batch_expiry: addDays(today, 90) }])).body.code).toBe('NOT_NEGATIVE');
      const mixed = await material(w); await stock(w, mixed, 1, 10000); await adjust(w, mixed.id, -25);          // موجود 10 بدفعة، −25 بدون → −15
      expect((await count(w.mgr, [{ kind: 'material_level', material_id: mixed.id, actual_qty: 5, expected_system_qty: -15, note: 'سبب', new_batch_expiry: addDays(today, 90) }])).body.code).toBe('HAS_BATCHES');
      await adjust(w, mixed.id, 25);
      const neg = await material(w); await adjust(w, neg.id, -4);
      const stale = await count(w.mgr, [{ kind: 'material_level', material_id: neg.id, actual_qty: 1, expected_system_qty: -9, note: 'سبب', new_batch_expiry: addDays(today, 90), new_batch_unit_cost: 100 }]);
      expect(stale.status).toBe(409); expect(stale.body).toMatchObject({ code: 'STOCK_CHANGED', current_system_qty: -4 });
      await reserve(w, neg.id, 5);
      const low = await count(w.mgr, [{ kind: 'material_level', material_id: neg.id, actual_qty: 3, expected_system_qty: -4, note: 'سبب', new_batch_expiry: addDays(today, 90), new_batch_unit_cost: 100 }]);
      expect(low.status).toBe(409); expect(low.body).toMatchObject({ code: 'BELOW_RESERVED', reserved: 5, actual_qty: 3 });
      await adjust(w, neg.id, 4);
      expect((await count(w.mgr, [{ kind: 'material_level', material_id: neg.id, actual_qty: 1, expected_system_qty: 0, note: 'x' }])).body.code).toBe('NOT_NEGATIVE');
    });
    it('عملية جارية على نفس الدفعة بالجرد (حتمي): نقصت 2 من 10 والجرد جاي بكمية النظام القديمة → STOCK_CHANGED مو نجاح على كمية قديمة', async () => {
      const m = await material(w); const { batchId } = await stock(w, m, 1, 10000);
      const hold = await holdBatchAndShrink(batchId, 2);
      let res: any;
      try {
        const p = count(w.mgr, [bline(batchId, 9, 10, 'سباق')]).then((r) => { res = r; return r; });
        await new Promise((r) => setTimeout(r, 400));
        await hold.release();
        await p;
      } finally { await hold.release(); }
      expect(res.status).toBe(409); expect(res.body).toMatchObject({ code: 'STOCK_CHANGED', current_system_qty: 8 });
      expect(await batchQty(batchId)).toBe(8);
    });
    it('تصحيح مادة سالبة 4 مرات متزامنة: دفعة جديدة واحدة بس والسالب يتصفر مرة وحدة', async () => {
      const m = await material(w); await adjust(w, m.id, -6);
      const lvl = { kind: 'material_level', material_id: m.id, actual_qty: 4, expected_system_qty: -6, note: 'سباق', new_batch_expiry: addDays(today, 120), new_batch_unit_cost: 900 };
      const rs = await Promise.all(Array.from({ length: 4 }, () => count(w.mgr, [lvl])));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(rs.filter((r) => r.status === 409).every((r) => ['STOCK_CHANGED', 'NOT_NEGATIVE'].includes(r.body.code))).toBe(true);
      expect(await onHand(m.id)).toBe(4);
      expect(Number((await one(`select count(*)::int as n from material_batches where material_id = $1`, [m.id])).n)).toBe(1);
    });
    it('المالك ما يخلط فروع بجرد واحد (MIXED_BRANCHES)', async () => {
      const owner = await tokenFor(app, 'owner');
      const a = await material(w); const A = (await stock(w, a, 1, 10000)).batchId;
      const b = await material(w2); const B = (await stock(w2, b, 1, 10000)).batchId;
      const r = await count(owner, [bline(A, 9, 10, 'سبب'), bline(B, 9, 10, 'سبب')]);
      expect(r.status).toBe(400); expect(r.body.code).toBe('MIXED_BRANCHES');
      expect(await batchQty(A)).toBe(10); expect(await batchQty(B)).toBe(10);
    });
    it('جرد متزامن لنفس الدفعة 5 مرات: واحد ينجح والباقي STOCK_CHANGED، والمخزون متسق', async () => {
      const m = await material(w); const { batchId } = await stock(w, m, 10, 100000);
      const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => count(w.mgr, [bline(batchId, 90 - i, 100, `عدّ ${i}`)])));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'STOCK_CHANGED')).toHaveLength(4);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(await onHand(m.id)).toBe(await batchQty(batchId));
    });
    it('جرد وتالف بنفس اللحظة لنفس الدفعة: النتيجة سليمة والمخزون = الدفعة', async () => {
      for (let i = 0; i < 3; i++) {
        const m = await material(w); const { batchId } = await stock(w, m, 1, 10000);
        const [c, wst] = await Promise.all([count(w.mgr, [bline(batchId, 8, 10, 'سباق')]), waste(w.mgr, { batch_id: batchId, qty: 2, reason: 'damaged' })]);
        expect([c.status, wst.status].filter((s) => s >= 500)).toHaveLength(0);
        expect(await onHand(m.id)).toBe(await batchQty(batchId));
        expect(await batchQty(batchId)).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('تنبيهات المخزون', () => {
    it('قليل على المتاح (مو الموجود)، ينتهي قريب، منتهي، وسالب، مع الأعداد، وبفرعها، والمعطل مستبعد', async () => {
      const x = await world('SGA'); const other = await world('SGA2');
      const low = await material(x, { low_threshold: 50 }); await stock(x, low, 10, 100000);                       // 100 موجود
      await reserve(x, low.id, 60);                                                                                // المتاح 40 < 50
      const fine = await material(x, { low_threshold: 50 }); await stock(x, fine, 10, 100000);                     // 100 ≥ 50
      const near = await material(x); const nearB = (await stock(x, near, 1, 10000, 10)).batchId;
      const old = await material(x); const oldB = (await stock(x, old, 1, 10000)).batchId; await expire(oldB, 3);
      const neg = await material(x); await adjust(x, neg.id, -2);
      const off = await material(x, { low_threshold: 999 }); await stock(x, off, 1, 10000); await post(x.mgr, `/materials/${off.id}`, {}); // يبقى فعال لحد التعطيل
      const offVer = (await get(x.mgr, `/materials/${off.id}`)).body.version;
      await http().put(`/materials/${off.id}`).set(auth(x.mgr)).send({ expected_version: offVer, is_active: false });
      await stock(other, await material(other, { low_threshold: 500 }), 1, 10000);
      const a = (await get(x.mgr, '/stock/alerts')).body;
      expect(a.near_expiry_days).toBe(30);
      expect(a.low.map((l: any) => l.material.id)).toEqual(expect.arrayContaining([low.id])); expect(a.low.map((l: any) => l.material.id)).not.toContain(fine.id);
      expect(a.low.find((l: any) => l.material.id === low.id)).toMatchObject({ available: 40, on_hand: 100, reserved: 60, threshold: 50 });
      expect(a.low.map((l: any) => l.material.id)).not.toContain(neg.id);                                         // السالب بقائمته
      expect(a.low.map((l: any) => l.material.id)).not.toContain(off.id);                                         // المعطل مستبعد
      expect(a.near_expiry).toEqual([expect.objectContaining({ batch_id: nearB, qty_on_hand: 10, value: 10000, material: expect.objectContaining({ id: near.id }) })]);
      expect(a.expired).toEqual([expect.objectContaining({ batch_id: oldB, qty_on_hand: 10, expiry_date: addDays(today, -3) })]);
      expect(a.negative).toEqual([{ material: { id: neg.id, name: neg.name, unit: 'cc' }, on_hand: -2 }]);
      expect(a.counts).toMatchObject({ near_expiry: 1, expired: 1, negative: 1 }); expect(a.counts.total).toBe(a.counts.low + 3);
      expect((await get(other.mgr, '/stock/alerts')).body.near_expiry).toEqual([]);
      await adjust(x, neg.id, 2);
    });
    it('تنبيه «ينتهي قريب» يتبع إعداد المالك، والدفعة الفارغة ما تنذكر، والصلاحيات', async () => {
      const x = await world('SGB'); const m = await material(x); const { batchId } = await stock(x, m, 1, 10000, 100);
      expect((await get(x.mgr, '/stock/alerts')).body.near_expiry).toEqual([]);
      await db.query(`insert into settings (branch_id, key, value, version) values ($1,'stock.near_expiry_days','120',1)`, [x.id]);
      expect((await get(x.mgr, '/stock/alerts')).body).toMatchObject({ near_expiry_days: 120, near_expiry: [expect.objectContaining({ batch_id: batchId })] });
      await waste(x.mgr, { batch_id: batchId, qty: 10, reason: 'damaged' });
      expect((await get(x.mgr, '/stock/alerts')).body.near_expiry).toEqual([]);
      for (const t of [x.cash, doc1, nurse]) expect((await get(t, '/stock/alerts')).status).toBe(403);
    });
  });

  it('فحص نهائي: أرصدة الدفعات = حركاتها، وكلفة التالف = كلفة حركته، وفروقات الجرد = حركاتها', async () => {
    const bad = await db.query(`select * from v_integrity_checks where check_name = 'batch_qty_mismatch'`);
    expect(bad.rows).toEqual([]);
    const wasteCost = await db.query(`select w.id from stock_waste w join stock_movements m on m.waste_id = w.id where m.cost_amount <> -w.cost_amount or m.qty_delta <> -w.qty`);
    expect(wasteCost.rows).toEqual([]);
    const wasteNoMove = await db.query(`select w.id from stock_waste w where not exists (select 1 from stock_movements m where m.waste_id = w.id)`);
    expect(wasteNoMove.rows).toEqual([]);
    const countDiff = await db.query(`select l.id from stock_count_lines l where l.line_kind = 'batch' and abs(l.diff_qty - coalesce((select sum(m.qty_delta) from stock_movements m where m.count_line_id = l.id), 0)) > 0.0005`);
    expect(countDiff.rows).toEqual([]);
    const negBatch = await db.query(`select id from material_batches where qty_on_hand < 0`);
    expect(negBatch.rows).toEqual([]);
  });
});
