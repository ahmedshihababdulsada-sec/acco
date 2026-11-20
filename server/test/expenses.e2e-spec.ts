import { INestApplication } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = () => Buffer.concat([PNG, randomBytes(64)]);                       // فريد بكل مرة (بصمة مختلفة)
const jpg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(64)]);
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(64)]);
const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP'), randomBytes(32)]);

interface World { id: number; code: string; mgr: string; mgrId: number; cash: string }

describe('رفع الملفات والمصاريف وسحب المالك', () => {
  let app: INestApplication; let db: Pool; let today: string; let owner: string; let nurse: string; let doc1: string;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const patch = (t: string, url: string, body: object) => http().patch(url).set(auth(t)).send(body);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

  async function world(code: string, funds = 1000000): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name) values ($1,$1) returning id`, [code])).rows[0].id);
    await db.query(`insert into safes (branch_id) values ($1)`, [id]);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id); await seedUser(db, `cash_${code}`, 'cashier', id);
    if (funds > 0) await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',$2,'opening_balance','تجربة',$3)`, [id, funds, mgrId]);
    return { id, code, mgr: await tokenFor(app, `mgr_${code}`), mgrId, cash: await tokenFor(app, `cash_${code}`) };
  }
  const safeBalance = async (w: World) => Number((await one(`select balance from safes where branch_id = $1`, [w.id])).balance);
  const upload = (t: string, buf: Buffer, kind: string | null = 'expense_proof', filename = 'proof.png', extra: Record<string, string> = {}) => {
    let r = http().post('/attachments').set(auth(t));
    if (kind !== null) r = r.field('kind', kind);
    for (const [k, v] of Object.entries(extra)) r = r.field(k, v);
    return r.attach('file', buf, { filename });
  };
  const proof = async (w: World, kind = 'expense_proof') => { const r = await upload(w.mgr, png(), kind); expect(r.status).toBe(201); return r.body.id as number; };
  const category = async (w: World, name = `نوع ${Math.random().toString(36).slice(2, 8)}`, kind?: string) => {
    const r = await post(w.mgr, '/expense-categories', { name, ...(kind ? { kind } : {}) }); expect(r.status).toBe(201); return r.body.id as number;
  };
  async function spend(w: World, cat: number, amount: number, over: Record<string, unknown> = {}, token = w.mgr) {
    const body = { category_id: cat, amount, expense_date: today, pay_source: 'safe', proof_attachment_id: await proof(w), ...over };
    return post(token, '/expenses', body);
  }

  beforeAll(async () => {
    app = await makeApp(); db = pool();
    today = (await db.query(`select clinic_today()::text as d`)).rows[0].d;
    [owner, nurse, doc1] = await Promise.all(['owner', 'nurse1', 'doc1'].map((u) => tokenFor(app, u)));
  });
  afterAll(async () => { await app.close(); await db.end(); });

  // ------------------------------------------------------------------------------------------------
  describe('رفع صور الإثبات وعرضها', () => {
    let w: World; let w2: World;
    beforeAll(async () => { w = await world('EXA'); w2 = await world('EXA2'); });
    it('المدير يرفع صورة: تتخزن بالقرص ببصمتها ونوعها الحقيقي، وتتسجل بالقاعدة وسجل الحركات', async () => {
      const buf = png();
      const r = await upload(w.mgr, buf);
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ branch_id: w.id, kind: 'expense_proof', mime: 'image/png', size_bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
      const row = await one(`select storage_key, uploaded_by::int as by from attachments where id = $1`, [r.body.id]);
      expect(row.storage_key).toMatch(/^\d{4}-\d{2}\/[0-9a-f-]{36}\.png$/);
      const path = join(process.env.UPLOAD_DIR!, row.storage_key);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path).equals(buf)).toBe(true);
      expect(row.by).toBe(w.mgrId);
      expect((await db.query(`select 1 from audit_log where action = 'attachment.upload' and entity_id = $1`, [r.body.id])).rowCount).toBe(1);
    });
    it('كل الأنواع المسموحة تنقبل (JPG, PNG, WEBP, PDF) ويتحدد النوع من المحتوى مو من الاسم', async () => {
      for (const [buf, mime, name] of [[jpg(), 'image/jpeg', 'a.jpg'], [webp(), 'image/webp', 'a.webp'], [pdf(), 'application/pdf', 'a.pdf'], [jpg(), 'image/jpeg', 'اسم-غريب.png']] as const) {
        const r = await upload(w.mgr, buf, 'expense_proof', name);
        expect(r.status).toBe(201); expect(r.body.mime).toBe(mime);
      }
    });
    it('ملف ما هو صورة/PDF → 400 حتى لو انسمى .jpg، وفارغ، وبدون ملف', async () => {
      expect((await upload(w.mgr, Buffer.from('hello world, I am a script'), 'expense_proof', 'x.jpg')).body.code).toBe('INVALID_FILE_TYPE');
      expect((await upload(w.mgr, Buffer.from('MZ\x90\x00 fake exe'), 'expense_proof', 'x.png')).body.code).toBe('INVALID_FILE_TYPE');
      expect((await upload(w.mgr, Buffer.from('<svg onload=alert(1)>'), 'expense_proof', 'x.svg')).body.code).toBe('INVALID_FILE_TYPE');
      expect((await upload(w.mgr, Buffer.alloc(0))).body.code).toBe('FILE_REQUIRED');
      expect((await http().post('/attachments').set(auth(w.mgr)).field('kind', 'expense_proof')).body.code).toBe('FILE_REQUIRED');
      expect((await db.query(`select 1 from attachments where branch_id = $1 and size_bytes < 2`, [w.id])).rowCount).toBe(0);
    });
    it('أكبر من الحد → 413 وما يتخزن شي، ونوع مرفق غلط أو ناقص 400', async () => {
      const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(8 * 1024 * 1024 + 10)]);
      const before = Number((await one(`select count(*)::int as n from attachments`)).n);
      expect((await upload(w.mgr, big)).status).toBe(413);
      expect(Number((await one(`select count(*)::int as n from attachments`)).n)).toBe(before);
      expect((await upload(w.mgr, png(), null)).body.code).toBe('INVALID_KIND');
      for (const k of ['before_after', 'receipt_pdf', 'nonsense']) expect((await upload(w.mgr, png(), k)).body.code).toBe('INVALID_KIND');
    });
    it('الصلاحيات: الكاشير والطبيب والممرض 403، بدون توكن 401، والمالك يحدد الفرع، والمدير ما يرفع لفرع ثاني', async () => {
      for (const t of [w.cash, doc1, nurse]) expect((await upload(t, png())).status).toBe(403);
      expect((await http().post('/attachments').field('kind', 'expense_proof').attach('file', png(), { filename: 'a.png' })).status).toBe(401);
      expect((await upload(owner, png())).status).toBe(400);                                              // أكثر من فرع: لازم يحدد
      expect((await upload(owner, png(), 'expense_proof', 'a.png', { branch_id: String(w.id) })).status).toBe(201);
      expect((await upload(w.mgr, png(), 'expense_proof', 'a.png', { branch_id: String(w2.id) })).status).toBe(403);
    });
    it('العرض: المدير بفرعه والمالك بس، بنوع الملف الحقيقي، وفرع ثاني 404، والمحذوف 404', async () => {
      const buf = jpg(); const up = await upload(w.mgr, buf, 'expense_proof', 'p.jpg');
      const g = await get(w.mgr, `/attachments/${up.body.id}`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
      expect(g.status).toBe(200); expect(g.headers['content-type']).toBe('image/jpeg'); expect(g.headers['cache-control']).toContain('no-store');
      expect((g.body as Buffer).equals(buf)).toBe(true);
      expect((await get(owner, `/attachments/${up.body.id}`)).status).toBe(200);
      expect((await get(w2.mgr, `/attachments/${up.body.id}`)).status).toBe(404);
      for (const t of [w.cash, doc1, nurse]) expect((await get(t, `/attachments/${up.body.id}`)).status).toBe(403);
      await db.query(`update attachments set deleted_at = now() where id = $1`, [up.body.id]);
      expect((await get(w.mgr, `/attachments/${up.body.id}`)).status).toBe(404);
      expect((await get(w.mgr, '/attachments/99999999')).status).toBe(404);
    });
    it('مرفقات أنواع ثانية (صور قبل وبعد) ما تنعرض من هذا المسار', async () => {
      const c = (await one(`insert into customers (branch_id, public_code, phone, full_name, source) values ($1,'EXAC1','+9647750000001','ز','cashier') returning id`, [w.id])).id;
      const a = (await one(`insert into attachments (branch_id, kind, storage_key, mime, size_bytes, sha256, customer_id) values ($1,'before_after','x/y.png','image/png',10,'abc',$2) returning id`, [w.id, c])).id;
      expect((await get(w.mgr, `/attachments/${a}`)).status).toBe(404);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('أنواع المصاريف', () => {
    let w: World; let w2: World;
    beforeAll(async () => { w = await world('EXC'); w2 = await world('EXC2'); });
    it('المدير والمالك ينشئون ويعدلون، والكاشير والطبيب 403', async () => {
      const r = await post(w.mgr, '/expense-categories', { name: '  كهرباء   ومولدة ' });
      expect(r.status).toBe(201); expect(r.body).toMatchObject({ name: 'كهرباء ومولدة', kind: 'operating', is_active: true });
      for (const t of [w.cash, doc1, nurse]) { expect((await post(t, '/expense-categories', { name: 'ممنوع' })).status).toBe(403); expect((await get(t, '/expense-categories')).status).toBe(403); }
      expect((await post(owner, '/expense-categories', { name: 'نوع المالك' })).status).toBe(400);       // أكثر من فرع
      expect((await post(owner, '/expense-categories', { name: 'نوع المالك', branch_id: w.id, kind: 'equipment' })).body.kind).toBe('equipment');
    });
    it('الأنواع الثلاثة، التكرار (بدون حساسية للحالة أو المسافات)، النوع الغلط، والاسم القصير', async () => {
      for (const k of ['operating', 'payment_fee', 'equipment']) expect((await post(w.mgr, '/expense-categories', { name: `ن-${k}`, kind: k })).body.kind).toBe(k);
      expect((await post(w.mgr, '/expense-categories', { name: 'ن-operating' })).body.code).toBe('CATEGORY_EXISTS');
      await post(w.mgr, '/expense-categories', { name: 'Internet' });
      expect((await post(w.mgr, '/expense-categories', { name: ' internet ' })).body.code).toBe('CATEGORY_EXISTS');
      expect((await post(w.mgr, '/expense-categories', { name: 'نوع', kind: 'weird' })).status).toBe(400);
      expect((await post(w.mgr, '/expense-categories', { name: 'ا' })).status).toBe(400);
      expect((await post(w2.mgr, '/expense-categories', { name: 'Internet' })).status).toBe(201);        // فرع ثاني: مستقل
    });
    it('تعديل الاسم والتفعيل بس (النوع ما يتغير)، والمكرر، وبدون تغيير، وفرع ثاني 404', async () => {
      const id = await category(w, 'تعديل الاسم');
      expect((await patch(w.mgr, `/expense-categories/${id}`, { name: 'اسم جديد', is_active: false })).body).toMatchObject({ name: 'اسم جديد', is_active: false });
      expect((await patch(w.mgr, `/expense-categories/${id}`, { kind: 'equipment' })).status).toBe(400);
      expect((await patch(w.mgr, `/expense-categories/${id}`, {})).body.code).toBe('NO_CHANGE');
      await category(w, 'اسم ثاني');
      expect((await patch(w.mgr, `/expense-categories/${id}`, { name: 'اسم ثاني' })).body.code).toBe('CATEGORY_EXISTS');
      expect((await patch(w2.mgr, `/expense-categories/${id}`, { name: 'x1' })).status).toBe(404);
      expect((await patch(w.mgr, '/expense-categories/99999999', { name: 'x1' })).status).toBe(404);
    });
    it('القائمة تخفي المعطل إلا مع all=1، وبفرعها بس', async () => {
      const id = await category(w, 'للتعطيل'); await patch(w.mgr, `/expense-categories/${id}`, { is_active: false });
      expect((await get(w.mgr, '/expense-categories')).body.categories.map((c: any) => c.id)).not.toContain(id);
      expect((await get(w.mgr, '/expense-categories?all=1')).body.categories.map((c: any) => c.id)).toContain(id);
      expect((await get(w2.mgr, '/expense-categories?all=1')).body.categories.map((c: any) => c.id)).not.toContain(id);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('تسجيل المصروف', () => {
    let w: World; let w2: World; let cat: number;
    beforeAll(async () => { w = await world('EXE', 1000000); w2 = await world('EXE2', 0); cat = await category(w, 'نظافة'); });
    it('من الخزنة: ينقص رصيدها بحركة expense مربوطة بالمصروف، ويرجع كل التفاصيل', async () => {
      const r = await spend(w, cat, 120000, { description: '  مواد تنظيف ' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ amount: 120000, original_amount: 120000, expense_date: today, description: 'مواد تنظيف', pay_source: 'safe', bank_name: null, status: 'active', version: 1, category: { id: cat, name: 'نظافة', kind: 'operating' }, edits: [] });
      expect(await safeBalance(w)).toBe(880000);
      expect(await one(`select direction, amount::int as amount, kind from safe_movements where expense_id = $1`, [r.body.id])).toEqual({ direction: 'out', amount: 120000, kind: 'expense' });
      expect((await db.query(`select 1 from audit_log where action = 'expense.create' and entity_id = $1`, [r.body.id])).rowCount).toBe(1);
    });
    it('إلكتروني: اسم المصرف إلزامي وما يلمس الخزنة، والخزنة ما تقبل اسم مصرف', async () => {
      const before = await safeBalance(w);
      expect((await spend(w, cat, 50000, { pay_source: 'electronic' })).body.code).toBe('BANK_REQUIRED');
      expect((await spend(w, cat, 50000, { pay_source: 'electronic', bank_name: '   ' })).body.code).toBe('BANK_REQUIRED');
      expect((await spend(w, cat, 50000, { pay_source: 'safe', bank_name: 'مصرف' })).body.code).toBe('BANK_NOT_ALLOWED');
      const r = await spend(w, cat, 50000, { pay_source: 'electronic', bank_name: ' مصرف الرافدين ' });
      expect(r.status).toBe(201); expect(r.body).toMatchObject({ pay_source: 'electronic', bank_name: 'مصرف الرافدين' });
      expect(await safeBalance(w)).toBe(before);
      expect((await db.query(`select 1 from safe_movements where expense_id = $1`, [r.body.id])).rowCount).toBe(0);
    });
    it('فوق رصيد الخزنة → 409 والمصروف ما ينسجل والصورة تبقى حرة للاستخدام', async () => {
      const w3 = await world('EXE3', 10000); const c3 = await category(w3, 'نوع'); const p = await proof(w3);
      const r = await post(w3.mgr, '/expenses', { category_id: c3, amount: 10001, expense_date: today, pay_source: 'safe', proof_attachment_id: p });
      expect(r.status).toBe(409); expect(r.body).toMatchObject({ code: 'SAFE_INSUFFICIENT', safe_balance: 10000, requested: 10001 });
      expect(Number((await one(`select count(*)::int as n from expenses where branch_id = $1`, [w3.id])).n)).toBe(0);
      expect(await safeBalance(w3)).toBe(10000);
      expect((await post(w3.mgr, '/expenses', { category_id: c3, amount: 10000, expense_date: today, pay_source: 'safe', proof_attachment_id: p })).status).toBe(201);
      expect(await safeBalance(w3)).toBe(0);
    });
    it('صورة الإثبات: إلزامية، وبنوعها، وبفرعها، ومرة وحدة (حتى 6 طلبات متزامنة بنفس الصورة)', async () => {
      const base = { category_id: cat, amount: 1000, expense_date: today, pay_source: 'safe' };
      expect((await post(w.mgr, '/expenses', base)).status).toBe(400);
      expect((await post(w.mgr, '/expenses', { ...base, proof_attachment_id: 99999999 })).body.code).toBe('PROOF_INVALID');
      expect((await post(w.mgr, '/expenses', { ...base, proof_attachment_id: await proof(w, 'purchase_receipt') })).body.code).toBe('PROOF_INVALID');
      const foreign = await proof(w2);
      expect((await post(w.mgr, '/expenses', { ...base, proof_attachment_id: foreign })).body.code).toBe('PROOF_INVALID');
      const gone = await proof(w); await db.query(`update attachments set deleted_at = now() where id = $1`, [gone]);
      expect((await post(w.mgr, '/expenses', { ...base, proof_attachment_id: gone })).body.code).toBe('PROOF_INVALID');
      const p = await proof(w); const before = await safeBalance(w);
      expect((await post(w.mgr, '/expenses', { ...base, proof_attachment_id: p })).status).toBe(201);
      expect((await post(w.mgr, '/expenses', { ...base, proof_attachment_id: p })).body.code).toBe('PROOF_ALREADY_USED');
      expect(await safeBalance(w)).toBe(before - 1000);
      const q = await proof(w);
      const rs = await Promise.all(Array.from({ length: 6 }, () => post(w.mgr, '/expenses', { ...base, proof_attachment_id: q })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'PROOF_ALREADY_USED')).toHaveLength(5);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(await safeBalance(w)).toBe(before - 2000);
    });
    it('التحقق: مبلغ صفر/سالب/كسر، تاريخ مستقبل/غلط، نوع من فرع ثاني أو معطل، والصلاحيات', async () => {
      for (const amount of [0, -1, 1.5, '100']) expect((await spend(w, cat, amount as number)).status).toBe(400);
      expect((await spend(w, cat, 1000, { expense_date: addDays(today, 1) })).body.code).toBe('FUTURE_DATE');
      expect((await spend(w, cat, 1000, { expense_date: '2026-02-30' })).body.code).toBe('INVALID_DATE');
      expect((await spend(w, cat, 1000, { expense_date: addDays(today, -40) })).status).toBe(201);          // تاريخ ماضي مسموح
      const other = await category(w2, 'نوع فرع ثاني');
      expect((await spend(w, other, 1000)).body.code).toBe('CATEGORY_INVALID');
      expect((await spend(w, 99999999, 1000)).body.code).toBe('CATEGORY_INVALID');
      const off = await category(w, 'نوع معطل'); await patch(w.mgr, `/expense-categories/${off}`, { is_active: false });
      expect((await spend(w, off, 1000)).body.code).toBe('CATEGORY_INACTIVE');
      expect((await spend(w, cat, 1000, {}, w.cash)).status).toBe(403);
      expect((await spend(w, cat, 1000, { net: 1 })).status).toBe(400);
      expect((await spend(w, cat, 1000, { status: 'cancelled' })).status).toBe(400);
    });
    it('6 مصاريف متزامنة بمبلغ 30,000 والرصيد 100,000: ثلاثة تنجح وثلاثة SAFE_INSUFFICIENT والرصيد 10,000', async () => {
      const x = await world('EXS', 100000); const c = await category(x, 'نوع');
      const ps = await Promise.all(Array.from({ length: 6 }, () => proof(x)));
      const rs = await Promise.all(ps.map((p) => post(x.mgr, '/expenses', { category_id: c, amount: 30000, expense_date: today, pay_source: 'safe', proof_attachment_id: p })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(3);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'SAFE_INSUFFICIENT')).toHaveLength(3);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(await safeBalance(x)).toBe(10000);
      expect(Number((await one(`select count(*)::int as n from expenses where branch_id = $1`, [x.id])).n)).toBe(3);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('قائمة المصاريف والإجماليات', () => {
    let w: World; let w2: World; let cA: number; let cB: number;
    const firstOfMonth = () => `${today.slice(0, 7)}-01`;
    beforeAll(async () => {
      w = await world('EXL'); w2 = await world('EXL2'); cA = await category(w, 'إيجار'); cB = await category(w, 'قرطاسية');
    });
    it('الافتراضي الشهر الحالي: إجمالي حسب النوع، والملغى يظهر وما ينحسب، والفلاتر', async () => {
      const a1 = await spend(w, cA, 700000); const a2 = await spend(w, cA, 100000, { pay_source: 'electronic', bank_name: 'م' }); const b1 = await spend(w, cB, 50000);
      const old = await spend(w, cB, 9000, { expense_date: addDays(firstOfMonth(), -1) });                     // الشهر الماضي
      await post(owner, `/expenses/${a2.body.id}/cancel`, { reason: 'مكرر' });
      const r = (await get(w.mgr, '/expenses')).body;
      expect(r.from).toBe(firstOfMonth());
      const ids = r.expenses.map((e: any) => e.id);
      expect(ids).toEqual(expect.arrayContaining([a1.body.id, a2.body.id, b1.body.id])); expect(ids).not.toContain(old.body.id);
      expect(r.expenses.find((e: any) => e.id === a2.body.id).status).toBe('cancelled');
      expect(r.total_active).toBe(750000);
      expect(r.by_category).toEqual([{ category_id: cA, name: 'إيجار', kind: 'operating', total: 700000 }, { category_id: cB, name: 'قرطاسية', kind: 'operating', total: 50000 }]);
      expect((await get(w.mgr, `/expenses?month=${addDays(firstOfMonth(), -1).slice(0, 7)}`)).body.expenses.map((e: any) => e.id)).toEqual([old.body.id]);
      expect((await get(w.mgr, `/expenses?category_id=${cB}`)).body.expenses.map((e: any) => e.id)).toEqual([b1.body.id]);
      expect((await get(w.mgr, '/expenses?status=cancelled')).body.expenses.map((e: any) => e.id)).toEqual([a2.body.id]);
      expect((await get(w.mgr, `/expenses?from=${today}&to=${today}`)).body.expenses.length).toBeGreaterThanOrEqual(3);
    });
    it('الصيغ الغلط 400، والكاشير 403، وفرع ثاني ما يشوف، والمالك يحدد الفرع', async () => {
      expect((await get(w.mgr, '/expenses?month=2026-13')).body.code).toBe('INVALID_MONTH');
      expect((await get(w.mgr, '/expenses?from=2026-01-01')).body.code).toBe('INVALID_RANGE');
      expect((await get(w.mgr, `/expenses?from=${today}&to=${addDays(today, -1)}`)).body.code).toBe('INVALID_RANGE');
      expect((await get(w.mgr, '/expenses?status=x')).status).toBe(400);
      expect((await get(w.cash, '/expenses')).status).toBe(403);
      expect((await get(w2.mgr, '/expenses')).body).toMatchObject({ expenses: [], total_active: 0, by_category: [] });
      expect((await get(owner, '/expenses')).status).toBe(400);
      expect((await get(owner, `/expenses?branch_id=${w.id}`)).body.expenses.length).toBeGreaterThan(0);
    });
    it('تفاصيل مصروف: فرع ثاني 404، والكاشير 403', async () => {
      const e = await spend(w, cA, 1000);
      expect((await get(w.mgr, `/expenses/${e.body.id}`)).body.id).toBe(e.body.id);
      expect((await get(w2.mgr, `/expenses/${e.body.id}`)).status).toBe(404);
      expect((await get(w.cash, `/expenses/${e.body.id}`)).status).toBe(403);
      expect((await get(w.mgr, '/expenses/99999999')).status).toBe(404);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('تعديل المصروف وإلغاؤه (المالك بس)', () => {
    let w: World; let cat: number; let cat2: number;
    beforeAll(async () => { w = await world('EXM', 1000000); cat = await category(w, 'نوع أ'); cat2 = await category(w, 'نوع ب'); });
    const edit = (t: string, id: number, body: object) => put(t, `/expenses/${id}`, body);
    it('الصلاحية للمالك فقط: المدير والكاشير 403، والمالك ينجح', async () => {
      const e = await spend(w, cat, 100000);
      for (const t of [w.mgr, w.cash, doc1, nurse]) { expect((await edit(t, e.body.id, { expected_version: 1, reason: 'سبب', amount: 90000 })).status).toBe(403); expect((await post(t, `/expenses/${e.body.id}/cancel`, { reason: 'سبب' })).status).toBe(403); }
      expect((await edit(owner, e.body.id, { expected_version: 1, reason: 'سبب', amount: 90000 })).status).toBe(200);
    });
    it('زيادة المبلغ تنقص الخزنة بالفرق، والنقصان يرجعه، بحركات expense_adjustment، والسجل يحفظ القديم والجديد والسبب', async () => {
      const e = await spend(w, cat, 100000); const base = await safeBalance(w);
      const up = await edit(owner, e.body.id, { expected_version: 1, reason: 'الفاتورة 150', amount: 150000, description: 'تصحيح' });
      expect(up.status).toBe(200);
      expect(up.body).toMatchObject({ amount: 150000, original_amount: 100000, version: 2, description: 'تصحيح' });
      expect(up.body.edits).toHaveLength(1); expect(up.body.edits[0]).toMatchObject({ reason: 'الفاتورة 150', old: { amount: 100000, category_id: cat }, new: { amount: 150000, description: 'تصحيح' } });
      expect(await safeBalance(w)).toBe(base - 50000);
      const down = await edit(owner, e.body.id, { expected_version: 2, reason: 'غلط ثاني', amount: 120000 });
      expect(down.body).toMatchObject({ amount: 120000, original_amount: 100000, version: 3 });             // «كان X» بالأصلي حتى بعد تعديل ثاني
      expect(await safeBalance(w)).toBe(base - 20000);
      expect((await db.query(`select direction, amount::int as amount, kind from safe_movements where expense_id = $1 order by id`, [e.body.id])).rows)
        .toEqual([{ direction: 'out', amount: 100000, kind: 'expense' }, { direction: 'out', amount: 50000, kind: 'expense_adjustment' }, { direction: 'in', amount: 30000, kind: 'expense_adjustment' }]);
      expect((await db.query(`select 1 from audit_log where action = 'expense.edit' and entity_id = $1 and reason = 'الفاتورة 150'`, [e.body.id])).rowCount).toBe(1);
      expect(Number((await one(`select count(*)::int as n from expense_edits where expense_id = $1`, [e.body.id])).n)).toBe(2);
    });
    it('الإلكتروني ما يلمس الخزنة بالتعديل، وتعديل النوع والتاريخ والملاحظة بدون مبلغ ما يحرك الخزنة', async () => {
      const el = await spend(w, cat, 80000, { pay_source: 'electronic', bank_name: 'م' }); const base = await safeBalance(w);
      expect((await edit(owner, el.body.id, { expected_version: 1, reason: 'سبب', amount: 99000 })).body.amount).toBe(99000);
      expect(await safeBalance(w)).toBe(base);
      const s = await spend(w, cat, 5000); const b2 = await safeBalance(w);
      const r = await edit(owner, s.body.id, { expected_version: 1, reason: 'نوع غلط', category_id: cat2, expense_date: addDays(today, -3) });
      expect(r.body).toMatchObject({ category: { id: cat2 }, expense_date: addDays(today, -3), amount: 5000 });
      expect(await safeBalance(w)).toBe(b2);
    });
    it('زيادة تتجاوز رصيد الخزنة → 409 وما يتغير شي (النسخة، السجل، الخزنة)', async () => {
      const x = await world('EXM2', 100000); const c = await category(x, 'نوع');
      const e = await spend(x, c, 100000);
      expect(await safeBalance(x)).toBe(0);
      const r = await edit(owner, e.body.id, { expected_version: 1, reason: 'سبب', amount: 100001 });
      expect(r.status).toBe(409); expect(r.body).toMatchObject({ code: 'SAFE_INSUFFICIENT', safe_balance: 0 });
      expect(await one(`select amount::int as amount, version::int as version from expenses where id = $1`, [e.body.id])).toEqual({ amount: 100000, version: 1 });
      expect(Number((await one(`select count(*)::int as n from expense_edits where expense_id = $1`, [e.body.id])).n)).toBe(0);
      expect((await edit(owner, e.body.id, { expected_version: 1, reason: 'سبب', amount: 90000 })).status).toBe(200);              // النقصان دائماً ينفع
    });
    it('بدون تغيير 400، السبب إلزامي، طريقة الدفع والصورة ما تتغير (400)، تاريخ مستقبل، ونوع معطل أو غلط', async () => {
      const e = await spend(w, cat, 10000);
      expect((await edit(owner, e.body.id, { expected_version: 1, reason: 'سبب' })).body.code).toBe('NO_CHANGE');
      expect((await edit(owner, e.body.id, { expected_version: 1, reason: 'سبب', amount: 10000, category_id: cat })).body.code).toBe('NO_CHANGE');
      expect((await edit(owner, e.body.id, { expected_version: 1, amount: 9000 })).status).toBe(400);
      expect((await edit(owner, e.body.id, { expected_version: 1, reason: '   ', amount: 9000 })).status).toBe(400);
      expect((await edit(owner, e.body.id, { expected_version: 1, reason: 'سبب', pay_source: 'electronic' })).status).toBe(400);
      expect((await edit(owner, e.body.id, { expected_version: 1, reason: 'سبب', proof_attachment_id: await proof(w) })).status).toBe(400);
      expect((await edit(owner, e.body.id, { expected_version: 1, reason: 'سبب', amount: 0 })).status).toBe(400);
      expect((await edit(owner, e.body.id, { expected_version: 1, reason: 'سبب', expense_date: addDays(today, 2) })).body.code).toBe('FUTURE_DATE');
      const off = await category(w, 'معطل للتعديل'); await patch(w.mgr, `/expense-categories/${off}`, { is_active: false });
      expect((await edit(owner, e.body.id, { expected_version: 1, reason: 'سبب', category_id: off })).body.code).toBe('CATEGORY_INACTIVE');
      expect((await edit(owner, e.body.id, { expected_version: 1, reason: 'سبب', category_id: 99999999 })).body.code).toBe('CATEGORY_INVALID');
      expect((await edit(owner, 99999999, { expected_version: 1, reason: 'سبب', amount: 5 })).status).toBe(404);
      expect(Number((await one(`select version::int as v from expenses where id = $1`, [e.body.id])).v)).toBe(1);
    });
    it('تعديلان متزامنان بنفس النسخة: واحد ينجح والثاني VERSION_CONFLICT، والخزنة بفرق واحد', async () => {
      const e = await spend(w, cat, 100000); const base = await safeBalance(w);
      const rs = await Promise.all([edit(owner, e.body.id, { expected_version: 1, reason: 'سبب أول', amount: 110000 }), edit(owner, e.body.id, { expected_version: 1, reason: 'سبب ثاني', amount: 120000 })]);
      expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
      expect(rs.find((r) => r.status === 409)!.body).toMatchObject({ code: 'VERSION_CONFLICT', current_version: 2 });
      const final = Number((await one(`select amount::int as a from expenses where id = $1`, [e.body.id])).a);
      expect(await safeBalance(w)).toBe(base - (final - 100000));
    });
    it('الإلغاء: يبقى ظاهر «ملغى»، مبلغه الحالي يرجع للخزنة (بعد التعديل مو الأصلي)، والإلكتروني ما يلمس الخزنة، ومرتين 409', async () => {
      const e = await spend(w, cat, 60000);
      await edit(owner, e.body.id, { expected_version: 1, reason: 'تعديل', amount: 70000 });
      const base = await safeBalance(w);
      expect((await post(owner, `/expenses/${e.body.id}/cancel`, {})).status).toBe(400);
      expect((await post(owner, `/expenses/${e.body.id}/cancel`, { reason: '  ' })).status).toBe(400);
      const c = await post(owner, `/expenses/${e.body.id}/cancel`, { reason: 'ما تم الدفع فعلاً' });
      expect(c.status).toBe(201); expect(c.body).toMatchObject({ status: 'cancelled', cancel_reason: 'ما تم الدفع فعلاً', amount: 70000 });
      expect(await safeBalance(w)).toBe(base + 70000);
      expect(await one(`select direction, amount::int as amount, kind from safe_movements where expense_id = $1 order by id desc limit 1`, [e.body.id])).toEqual({ direction: 'in', amount: 70000, kind: 'expense_adjustment' });
      expect((await post(owner, `/expenses/${e.body.id}/cancel`, { reason: 'مرة ثانية' })).body.code).toBe('EXPENSE_CANCELLED');
      expect((await edit(owner, e.body.id, { expected_version: c.body.version, reason: 'بعد الإلغاء', amount: 5 })).body.code).toBe('EXPENSE_CANCELLED');
      expect(await safeBalance(w)).toBe(base + 70000);
      const el = await spend(w, cat, 30000, { pay_source: 'electronic', bank_name: 'م' }); const b2 = await safeBalance(w);
      expect((await post(owner, `/expenses/${el.body.id}/cancel`, { reason: 'تجربة' })).status).toBe(201);
      expect(await safeBalance(w)).toBe(b2);
      expect((await post(owner, '/expenses/99999999/cancel', { reason: 'تجربة' })).status).toBe(404);
      expect((await get(w.mgr, `/expenses/${e.body.id}`)).body.status).toBe('cancelled');                           // ما ينحذف
    });
    it('إلغاء متزامن 6 مرات: واحد ينجح والمبلغ يرجع مرة وحدة', async () => {
      const e = await spend(w, cat, 40000); const base = await safeBalance(w);
      const rs = await Promise.all(Array.from({ length: 6 }, () => post(owner, `/expenses/${e.body.id}/cancel`, { reason: 'سباق' })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status >= 500)).toHaveLength(0);
      expect(await safeBalance(w)).toBe(base + 40000);
    });
    it('التعديل مع الإلغاء بنفس اللحظة: الخزنة تبقى متسقة مع المصروف', async () => {
      for (let i = 0; i < 3; i++) {
        const e = await spend(w, cat, 50000);
        const [a, b] = await Promise.all([edit(owner, e.body.id, { expected_version: 1, reason: 'سباق', amount: 70000 }), post(owner, `/expenses/${e.body.id}/cancel`, { reason: 'سباق' })]);
        expect([a.status, b.status].filter((s) => s >= 500)).toHaveLength(0);
        const net = await one(`select coalesce(sum(case direction when 'out' then amount else -amount end),0)::int as n from safe_movements where expense_id = $1`, [e.body.id]);
        const row = await one(`select status, amount::int as amount from expenses where id = $1`, [e.body.id]);
        expect(net.n).toBe(row.status === 'cancelled' ? 0 : row.amount);
      }
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('سحب المالك', () => {
    let w: World; let w2: World;
    const wd = (over: object = {}) => ({ amount: 200000, withdrawn_by_name: 'المالك', withdrawal_date: today, note: 'مصروف شخصي', ...over });
    beforeAll(async () => { w = await world('EXW', 1000000); w2 = await world('EXW2', 1000000); });
    it('المدير يسجل (المالك والكاشير لا): بانتظار الموافقة وما ينقص الخزنة ولا ينحسب مصروف', async () => {
      const r = await post(w.mgr, '/safe/withdrawals', wd());
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ amount: 200000, withdrawn_by_name: 'المالك', withdrawal_date: today, note: 'مصروف شخصي', status: 'pending', recorded_by: { id: w.mgrId }, decided_by: null });
      expect(await safeBalance(w)).toBe(1000000);
      for (const t of [owner, w.cash, doc1, nurse]) expect((await post(t, '/safe/withdrawals', wd())).status).toBe(403);
      expect((await get(w.mgr, `/expenses`)).body.total_active).toBe(0);
      expect((await db.query(`select 1 from audit_log where action = 'withdrawal.record' and entity_id = $1`, [r.body.id])).rowCount).toBe(1);
    });
    it('التحقق: مبلغ، اسم، تاريخ مستقبل أو غلط', async () => {
      for (const amount of [0, -5, 1.5, '1']) expect((await post(w.mgr, '/safe/withdrawals', wd({ amount }))).status).toBe(400);
      expect((await post(w.mgr, '/safe/withdrawals', wd({ withdrawn_by_name: ' ' }))).status).toBe(400);
      expect((await post(w.mgr, '/safe/withdrawals', wd({ withdrawal_date: addDays(today, 1) }))).body.code).toBe('FUTURE_DATE');
      expect((await post(w.mgr, '/safe/withdrawals', wd({ withdrawal_date: '2026-02-30' }))).body.code).toBe('INVALID_DATE');
      expect((await post(w.mgr, '/safe/withdrawals', wd({ status: 'approved' }))).status).toBe(400);
    });
    it('القائمة: المدير والمالك، فلتر الحالة، وفرع ثاني ما يشوف، والكاشير 403', async () => {
      const a = await post(w.mgr, '/safe/withdrawals', wd({ amount: 1000 }));
      const list = (await get(w.mgr, '/safe/withdrawals?status=pending')).body;
      expect(list.map((x: any) => x.id)).toContain(a.body.id); expect(list.every((x: any) => x.status === 'pending' && x.branch_id === w.id)).toBe(true);
      expect((await get(owner, `/safe/withdrawals?branch_id=${w.id}`)).body.length).toBeGreaterThan(0);
      expect((await get(w2.mgr, '/safe/withdrawals')).body.map((x: any) => x.id)).not.toContain(a.body.id);
      expect((await get(w.cash, '/safe/withdrawals')).status).toBe(403);
      expect((await get(w.mgr, '/safe/withdrawals?status=x')).status).toBe(400);
    });
    it('موافقة المالك: تنسجل حركة الخزنة وقتها بس، والمدير ما يوافق، ومرتين 409', async () => {
      const r = await post(w.mgr, '/safe/withdrawals', wd({ amount: 300000 })); const base = await safeBalance(w);
      for (const t of [w.mgr, w.cash, doc1]) expect((await post(t, `/safe/withdrawals/${r.body.id}/approve`, {})).status).toBe(403);
      expect(await safeBalance(w)).toBe(base);
      const a = await post(owner, `/safe/withdrawals/${r.body.id}/approve`, { note: 'تمام' });
      expect(a.status).toBe(201); expect(a.body).toMatchObject({ status: 'approved', decision_note: 'تمام', decided_by: { full_name: expect.any(String) } });
      expect(await safeBalance(w)).toBe(base - 300000);
      expect(await one(`select direction, amount::int as amount, kind from safe_movements where owner_withdrawal_id = $1`, [r.body.id])).toEqual({ direction: 'out', amount: 300000, kind: 'owner_withdrawal' });
      expect((await post(owner, `/safe/withdrawals/${r.body.id}/approve`, {})).body.code).toBe('ALREADY_DECIDED');
      expect((await post(owner, `/safe/withdrawals/${r.body.id}/reject`, {})).body.code).toBe('ALREADY_DECIDED');
      expect(await safeBalance(w)).toBe(base - 300000);
      expect((await post(owner, '/safe/withdrawals/99999999/approve', {})).status).toBe(404);
    });
    it('الرفض ما يلمس الخزنة، وبعده ما تصير موافقة، والمدير ما يرفض', async () => {
      const r = await post(w.mgr, '/safe/withdrawals', wd({ amount: 100000 })); const base = await safeBalance(w);
      expect((await post(w.mgr, `/safe/withdrawals/${r.body.id}/reject`, {})).status).toBe(403);
      const x = await post(owner, `/safe/withdrawals/${r.body.id}/reject`, { note: 'ما أوافق' });
      expect(x.body).toMatchObject({ status: 'rejected', decision_note: 'ما أوافق' });
      expect((await post(owner, `/safe/withdrawals/${r.body.id}/approve`, {})).body.code).toBe('ALREADY_DECIDED');
      expect(await safeBalance(w)).toBe(base);
    });
    it('سحب أكبر من الرصيد: الموافقة تفشل 409 ويبقى معلق، وبعد ما يرجع الرصيد يوافق عليه', async () => {
      const x = await world('EXW3', 50000);
      const r = await post(x.mgr, '/safe/withdrawals', wd({ amount: 80000 }));
      const a = await post(owner, `/safe/withdrawals/${r.body.id}/approve`, {});
      expect(a.status).toBe(409); expect(a.body).toMatchObject({ code: 'SAFE_INSUFFICIENT', safe_balance: 50000, requested: 80000 });
      expect((await one(`select status from owner_withdrawals where id = $1`, [r.body.id])).status).toBe('pending');
      expect(await safeBalance(x)).toBe(50000);
      await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',40000,'opening_balance','تعبئة',$2)`, [x.id, x.mgrId]);
      expect((await post(owner, `/safe/withdrawals/${r.body.id}/approve`, {})).status).toBe(201);
      expect(await safeBalance(x)).toBe(10000);
    });
    it('6 قرارات متزامنة (موافقة ورفض) على نفس السحب: قرار واحد والخزنة تتغير مرة وحدة بالأكثر', async () => {
      const r = await post(w.mgr, '/safe/withdrawals', wd({ amount: 10000 })); const base = await safeBalance(w);
      const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => post(owner, `/safe/withdrawals/${r.body.id}/${i % 3 === 0 ? 'reject' : 'approve'}`, {})));
      expect(rs.filter((x) => x.status === 201)).toHaveLength(1);
      expect(rs.filter((x) => x.status === 409 && x.body.code === 'ALREADY_DECIDED')).toHaveLength(5);
      expect(rs.filter((x) => x.status >= 500)).toHaveLength(0);
      const st = (await one(`select status from owner_withdrawals where id = $1`, [r.body.id])).status;
      expect(await safeBalance(w)).toBe(st === 'approved' ? base - 10000 : base);
    });
    it('موافقات متزامنة على 5 سحوبات والرصيد يكفي 3: ثلاثة تنجح واثنين SAFE_INSUFFICIENT', async () => {
      const x = await world('EXW4', 100000);
      const ids = []; for (let i = 0; i < 5; i++) ids.push((await post(x.mgr, '/safe/withdrawals', wd({ amount: 30000 }))).body.id);
      const rs = await Promise.all(ids.map((id) => post(owner, `/safe/withdrawals/${id}/approve`, {})));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(3);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'SAFE_INSUFFICIENT')).toHaveLength(2);
      expect(await safeBalance(x)).toBe(10000);
    });
  });

  it('فحص نهائي: رصيد الخزنة = مجموع حركاتها، وكل مصروف من الخزنة له حركة، والمصروف الفعال بصورة إثبات فريدة', async () => {
    const bad = await db.query(`select * from v_integrity_checks where check_name in ('safe_balance_mismatch','safe_expense_without_movement','safe_payment_without_movement')`);
    expect(bad.rows).toEqual([]);
    const dupProof = await db.query(`select proof_attachment_id from expenses group by 1 having count(*) > 1`);
    expect(dupProof.rows).toEqual([]);
    const approvedNoMove = await db.query(`select id from owner_withdrawals w where status = 'approved' and not exists (select 1 from safe_movements m where m.owner_withdrawal_id = w.id)`);
    expect(approvedNoMove.rows).toEqual([]);
    const moveNotApproved = await db.query(`select m.id from safe_movements m join owner_withdrawals w on w.id = m.owner_withdrawal_id where w.status <> 'approved'`);
    expect(moveNotApproved.rows).toEqual([]);
    const netPerExpense = await db.query(
      `select e.id from expenses e where e.pay_source = 'safe' and
         (select coalesce(sum(case direction when 'out' then amount else -amount end),0) from safe_movements m where m.expense_id = e.id) <> case e.status when 'active' then e.amount else 0 end`);
    expect(netPerExpense.rows).toEqual([]);
  });
});
