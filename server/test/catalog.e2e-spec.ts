import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { auth, branchId, makeApp, pool, tokenFor } from './helpers';

describe('كتالوج الخدمات والتسعير', () => {
  let app: INestApplication; let db: Pool; let b1: number; let b2: number;
  let owner: string; let mgr1: string; let mgr2: string; let cash: string; let doc: string; let nurse: string;
  let matBotox: number; let matSyringe: number; let matOther: number; let matOff: number;
  const http = () => request(app.getHttpServer());
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const patch = (t: string, url: string, body: object) => http().patch(url).set(auth(t)).send(body);
  const get = (t: string, url: string) => http().get(url).set(auth(t));

  async function newFixed(name: string, price = 40000) {
    const s = (await post(mgr1, '/services', { name_ar: name, pricing_model: 'fixed', price })).body;
    return s.id as number;
  }
  async function newBotox(name = 'بوتكس') {
    const s = (await post(mgr1, '/services', { name_ar: name, pricing_model: 'per_unit', price: 50000 })).body;
    const f = await post(mgr1, `/services/${s.id}/fields`, { field_key: 'cc', label_ar: 'كم cc', field_type: 'number', unit_label: 'cc', pricing_role: 'quantity', is_required: true });
    return { id: s.id as number, fieldId: f.body.fields[0].id as number, version: f.body.version as number };
  }
  async function newLaser(name = 'ليزر', activate = true) {
    const s = (await post(mgr1, '/services', { name_ar: name, pricing_model: 'per_option' })).body;
    const f = await post(mgr1, `/services/${s.id}/fields`, {
      field_key: 'zones', label_ar: 'المناطق', field_type: 'multi_select', pricing_role: 'option', is_required: true,
      options: [{ label_ar: 'ابط', price: 30000 }, { label_ar: 'وجه', price: 50000 }, { label_ar: 'فول بدي', price: 200000, is_exclusive: true }],
    });
    const field = f.body.fields[0];
    if (activate) await post(mgr1, `/services/${s.id}/activate`);
    return { id: s.id as number, fieldId: field.id as number, options: field.options as { id: number; label_ar: string }[] };
  }

  beforeAll(async () => {
    app = await makeApp(); db = pool(); b1 = await branchId(db, 'B1'); b2 = await branchId(db, 'B2');
    [owner, mgr1, mgr2, cash, doc, nurse] = await Promise.all(['owner', 'mgr1', 'mgr2', 'cash1', 'doc1', 'nurse1'].map((u) => tokenFor(app, u)));
    const mat = async (b: number, name: string, active = true) =>
      Number((await db.query(`insert into materials (branch_id, name, base_unit, pack_unit, is_active) values ($1,$2,'cc','كرتون',$3) returning id`, [b, name, active])).rows[0].id);
    matBotox = await mat(b1, 'بوتكس'); matSyringe = await mat(b1, 'سرنجة'); matOther = await mat(b2, 'مادة فرع ثاني'); matOff = await mat(b1, 'مادة معطلة', false);
  });
  afterAll(async () => { await app.close(); await db.end(); });

  describe('الصلاحيات والرؤية', () => {
    it('المدير والمالك يديران الخدمات، والكاشير والطبيب والممرض لا', async () => {
      for (const t of [cash, doc, nurse]) expect((await post(t, '/services', { name_ar: 'خدمة', pricing_model: 'fixed' })).status).toBe(403);
      expect((await put(cash, '/services/1/price', { price: 1 })).status).toBe(403);
      expect((await post(doc, '/services/1/activate')).status).toBe(403);
    });
    it('القراءة: المالك والمدير والطبيب والكاشير، والممرض لا', async () => {
      expect((await get(nurse, '/services')).status).toBe(403);
      for (const t of [mgr1, doc, cash]) expect((await get(t, '/services')).status).toBe(200);
      expect((await get(owner, '/services')).body.code).toBe('BRANCH_REQUIRED');          // المالك يحدد الفرع
      expect((await get(owner, `/services?branch_id=${b1}`)).status).toBe(200);
      expect((await get(mgr1, `/services?branch_id=${b2}`)).status).toBe(403);
    });
    it('المسودة تظهر للمدير بس (مع all=1)، وتظهر للطبيب بعد التفعيل', async () => {
      const id = await newFixed('تنظيف بشرة');
      const s = (await get(mgr1, `/services/${id}`)).body;
      expect(s).toMatchObject({ is_active: false, pricing_model: 'fixed', price: 40000, kind: 'treatment', version: 1 });
      expect((await get(doc, '/services')).body.map((x: any) => x.id)).not.toContain(id);
      expect((await get(mgr1, '/services')).body.map((x: any) => x.id)).not.toContain(id);
      expect((await get(mgr1, '/services?all=1')).body.map((x: any) => x.id)).toContain(id);
      expect((await get(doc, `/services/${id}`)).status).toBe(404);
      expect((await get(doc, '/services?all=1')).body.map((x: any) => x.id)).not.toContain(id);   // الطبيب ما يشوف المسودة حتى مع all=1
      expect((await post(mgr1, `/services/${id}/activate`)).body.is_active).toBe(true);
      expect((await get(doc, '/services')).body.map((x: any) => x.id)).toContain(id);
      expect((await get(cash, `/services/${id}`)).status).toBe(200);
    });
    it('كل فرع خدماته: المدير ما يشوف ولا يعدل فرع ثاني، والمالك يشوف الكل', async () => {
      const id = await newFixed('خدمة فرع 1');
      expect((await get(mgr2, `/services/${id}`)).status).toBe(404);
      expect((await patch(mgr2, `/services/${id}`, { name_ar: 'هاك', expected_version: 1 })).status).toBe(404);
      expect((await put(mgr2, `/services/${id}/price`, { price: 1 })).status).toBe(404);
      expect((await post(mgr2, `/services/${id}/activate`)).status).toBe(404);
      expect((await get(owner, `/services/${id}`)).status).toBe(200);
      expect((await post(mgr1, '/services', { name_ar: 'غريبة', pricing_model: 'fixed', branch_id: b2 })).status).toBe(403);
      expect((await post(owner, '/services', { name_ar: 'خدمة المالك', pricing_model: 'fixed', price: 10, branch_id: b2 })).status).toBe(201);
      expect((await get(mgr2, '/services?all=1')).body.map((x: any) => x.name_ar)).toContain('خدمة المالك');
    });
  });

  describe('إنشاء وتعديل الخدمة', () => {
    it('بيانات غلط → 400، والخدمة بسعر الخيارات ما إلها سعر عام، ونوع التسعير ما ينتغير', async () => {
      expect((await post(mgr1, '/services', { name_ar: 'x', pricing_model: 'fixed' })).status).toBe(400);
      expect((await post(mgr1, '/services', { name_ar: 'خدمة', pricing_model: 'magic' })).status).toBe(400);
      expect((await post(mgr1, '/services', { name_ar: 'خدمة', pricing_model: 'fixed', price: -5 })).status).toBe(400);
      expect((await post(mgr1, '/services', { name_ar: 'خدمة', pricing_model: 'fixed', price: 1.5 })).status).toBe(400);
      expect((await post(mgr1, '/services', { name_ar: 'خدمة', pricing_model: 'fixed', kind: 'consultation' })).status).toBe(400);
      const po = await post(mgr1, '/services', { name_ar: 'خدمة', pricing_model: 'per_option', price: 100 });
      expect(po.body.code).toBe('PRICE_PER_OPTION');
      const id = await newFixed('ثابتة');
      expect((await patch(mgr1, `/services/${id}`, { pricing_model: 'per_unit', expected_version: 1 })).status).toBe(400);
    });
    it('قفل تفاؤلي للتعديل: النسخة القديمة 409، والصحيحة تزيد النسخة', async () => {
      const id = await newFixed('للتعديل');
      expect((await patch(mgr1, `/services/${id}`, { name_ar: 'اسم جديد', expected_version: 1 })).body).toMatchObject({ name_ar: 'اسم جديد', version: 2 });
      const stale = await patch(mgr1, `/services/${id}`, { name_ar: 'قديم', expected_version: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('SERVICE_CONFLICT');
      const ok = await Promise.all([2, 3, 4].map((i) => patch(mgr1, `/services/${id}`, { name_ar: `تزامن ${i}`, expected_version: 2 })));
      expect(ok.filter((r) => r.status === 200)).toHaveLength(1);
    });
    it('تاريخ السعر: كل تغيير سجل جديد، والسعر التاريخي يتحسب بالتاريخ، والخيارات تتبعه', async () => {
      const id = await newFixed('بتاريخ', 40000);
      await db.query(`update service_prices set effective_from = now() - interval '10 days' where service_id = $1`, [id]);
      const r = await put(mgr1, `/services/${id}/price`, { price: 45000 });
      expect(r.body.price).toBe(45000);
      expect((await db.query(`select count(*)::int as n from service_prices where service_id = $1`, [id])).rows[0].n).toBe(2);
      const past = new Date(Date.now() - 5 * 86400000).toISOString();
      expect((await post(mgr1, `/services/${id}/quote`, { values: {}, at: past })).body.list_price).toBe(40000);
      expect((await post(mgr1, `/services/${id}/quote`, { values: {} })).body.list_price).toBe(45000);
      const before = new Date(Date.now() - 20 * 86400000).toISOString();
      expect((await post(mgr1, `/services/${id}/quote`, { values: {}, at: before })).body.code).toBe('NO_PRICE');
      expect((await post(mgr1, `/services/${id}/quote`, { values: {}, at: 'not-a-date' })).body.code).toBe('INVALID_DATE');
      expect((await put(mgr1, `/services/${id}/price`, { price: -1 })).status).toBe(400);
    });
    it('تغيير السعر للمدير والمالك بس، وينسجل بسجل الحركات بالقديم والجديد', async () => {
      const id = await newFixed('سجل');
      await put(mgr1, `/services/${id}/price`, { price: 41000 });
      const a = (await db.query(`select before_values, after_values from audit_log where action='service.price' and entity_id=$1`, [id])).rows[0];
      expect(a.before_values).toEqual({ price: 40000 });
      expect(a.after_values).toEqual({ price: 41000 });
    });
  });

  describe('خدمة بسعر الوحدة (بوتكس)', () => {
    it('سعر × كمية يتقرب نصف للأعلى، والكمية مطلوبة وبحدود', async () => {
      const b = await newBotox();
      const q = async (v: object) => post(doc, `/services/${b.id}/quote`, { values: v });
      expect((await post(mgr1, `/services/${b.id}/activate`)).status).toBe(200);
      expect((await q({ cc: 2.5 })).body).toMatchObject({ list_price: 125000, unit_price: 50000, quantity: '2.500' });
      expect((await q({ cc: '0.5' })).body.list_price).toBe(25000);
      expect((await q({})).body.code).toBe('FIELD_REQUIRED');
      expect((await q({ cc: 0 })).body.code).toBe('INVALID_FIELD_VALUE');
      expect((await q({ cc: 2, other: 1 })).body.code).toBe('UNKNOWN_FIELD');
      expect((await q({ cc: '2.5555' })).status).toBe(400);
    });
    it('ما ينفع حقل كمية ثاني، ولا بنوع غلط، ولا بخدمة بسعر ثابت', async () => {
      const b = await newBotox('بوتكس 2');
      const dup = await post(mgr1, `/services/${b.id}/fields`, { field_key: 'cc2', label_ar: 'كمية ثانية', field_type: 'number', pricing_role: 'quantity' });
      expect(dup.body.code).toBe('DUPLICATE_PRICING_FIELD');
      expect((await post(mgr1, `/services/${b.id}/fields`, { field_key: 't', label_ar: 'نص', field_type: 'text', pricing_role: 'quantity' })).body.code).toBe('ROLE_TYPE_MISMATCH');
      const fixed = await newFixed('ثابتة 2');
      expect((await post(mgr1, `/services/${fixed}/fields`, { field_key: 'q', label_ar: 'كمية', field_type: 'number', pricing_role: 'quantity' })).body.code).toBe('ROLE_MODEL_MISMATCH');
      expect((await post(mgr1, `/services/${fixed}/fields`, { field_key: 'o', label_ar: 'خيار', field_type: 'select', pricing_role: 'option' })).body.code).toBe('ROLE_MODEL_MISMATCH');
      expect((await post(mgr1, `/services/${b.id}/fields`, { field_key: 'q3', label_ar: 'كمية', field_type: 'number', pricing_role: 'quantity', is_required: false })).status).toBe(409);
    });
    it('مفتاح الحقل: صيغة، وتكرار (حتى بسباق متزامن)', async () => {
      const id = await newFixed('مفاتيح');
      expect((await post(mgr1, `/services/${id}/fields`, { field_key: 'Bad Key', label_ar: 'x', field_type: 'text' })).status).toBe(400);
      expect((await post(mgr1, `/services/${id}/fields`, { field_key: '1abc', label_ar: 'x', field_type: 'text' })).status).toBe(400);
      const rs = await Promise.all([1, 2, 3].map(() => post(mgr1, `/services/${id}/fields`, { field_key: 'notes', label_ar: 'ملاحظات', field_type: 'text' })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'FIELD_KEY_EXISTS')).toHaveLength(2);
      expect((await db.query(`select count(*)::int as n from service_fields where service_id=$1 and field_key='notes'`, [id])).rows[0].n).toBe(1);
    });
  });

  describe('خدمة بسعر الخيارات (ليزر)', () => {
    it('ما تتفعل بدون أسعار الخيارات، وبعدها تتفعل وتتسعر', async () => {
      const s = (await post(mgr1, '/services', { name_ar: 'ليزر مسودة', pricing_model: 'per_option' })).body;
      const f = (await post(mgr1, `/services/${s.id}/fields`, {
        field_key: 'zones', label_ar: 'المناطق', field_type: 'multi_select', pricing_role: 'option', is_required: true, options: [{ label_ar: 'ابط' }, { label_ar: 'وجه', price: 5000 }],
      })).body.fields[0];
      const act = await post(mgr1, `/services/${s.id}/activate`);
      expect(act.status).toBe(409);
      expect(act.body.code).toBe('SERVICE_INCOMPLETE');
      expect(act.body.problems).toEqual(['حدد سعر الخيار «ابط»']);
      const aId = f.options.find((o: any) => o.label_ar === 'ابط').id;
      expect((await put(mgr1, `/options/${aId}/price`, { price: 3000 })).status).toBe(200);
      expect((await post(mgr1, `/services/${s.id}/activate`)).status).toBe(200);
      const zones = f.options.map((o: any) => o.id);
      expect((await post(doc, `/services/${s.id}/quote`, { values: { zones } })).body.list_price).toBe(8000);
    });
    it('مجموع المناطق، وفول بدي لحاله، ومع غيره مرفوض', async () => {
      const l = await newLaser('ليزر 2');
      const id = (name: string) => l.options.find((o) => o.label_ar === name)!.id;
      const q = (zones: unknown) => post(doc, `/services/${l.id}/quote`, { values: { zones } });
      expect((await q([id('ابط'), id('وجه')])).body).toMatchObject({ list_price: 80000, options: [{ label_ar: 'ابط', price: 30000 }, { label_ar: 'وجه', price: 50000 }] });
      expect((await q([id('فول بدي')])).body.list_price).toBe(200000);
      expect((await q([id('فول بدي'), id('ابط')])).body.code).toBe('EXCLUSIVE_OPTION_CONFLICT');
      expect((await q([])).body.code).toBe('FIELD_REQUIRED');
      expect((await q([999999])).body.code).toBe('INVALID_OPTION');
    });
    it('تغيير سعر خيار ما يغير الأسعار التاريخية، وسعر الخدمة العام ممنوع', async () => {
      const l = await newLaser('ليزر 3');
      const abt = l.options.find((o) => o.label_ar === 'ابط')!.id;
      await db.query(`update option_prices set effective_from = now() - interval '10 days' where option_id = $1`, [abt]);
      await put(mgr1, `/options/${abt}/price`, { price: 35000 });
      const past = new Date(Date.now() - 5 * 86400000).toISOString();
      expect((await post(doc, `/services/${l.id}/quote`, { values: { zones: [abt] }, at: past })).body.list_price).toBe(30000);
      expect((await post(doc, `/services/${l.id}/quote`, { values: { zones: [abt] } })).body.list_price).toBe(35000);
      expect((await put(mgr1, `/services/${l.id}/price`, { price: 1 })).body.code).toBe('PRICE_PER_OPTION');
    });
    it('إضافة خيار لخدمة فعالة بدون سعر ترفض وتتراجع بالكامل، وبسعر تنجح', async () => {
      const l = await newLaser('ليزر 4');
      const noPrice = await post(mgr1, `/fields/${l.fieldId}/options`, { label_ar: 'ساق' });
      expect(noPrice.status).toBe(409);
      expect(noPrice.body.code).toBe('SERVICE_INCOMPLETE');
      expect((await db.query(`select count(*)::int as n from service_options where field_id=$1 and label_ar='ساق'`, [l.fieldId])).rows[0].n).toBe(0);
      const ok = await post(mgr1, `/fields/${l.fieldId}/options`, { label_ar: 'ساق', price: 60000 });
      expect(ok.status).toBe(201);
      expect((await post(mgr1, `/fields/${l.fieldId}/options`, { label_ar: ' ساق ', price: 1 })).body.code).toBe('OPTION_EXISTS');
    });
    it('تعطيل خيار أو حقل يخلي الخدمة الفعالة ناقصة يترفض، وتعطيل خيار عادي ينفع', async () => {
      const l = await newLaser('ليزر 5');
      const vers = (await get(mgr1, `/services/${l.id}`)).body.fields[0].version;
      const off = await patch(mgr1, `/fields/${l.fieldId}`, { is_active: false, expected_version: vers });
      expect(off.body.code).toBe('SERVICE_INCOMPLETE');
      const reqOff = await patch(mgr1, `/fields/${l.fieldId}`, { is_required: false, expected_version: vers });
      expect(reqOff.body.code).toBe('OPTION_MUST_BE_REQUIRED');
      const ok = await patch(mgr1, `/options/${l.options[0].id}`, { is_active: false });
      expect(ok.status).toBe(200);
      expect((await post(doc, `/services/${l.id}/quote`, { values: { zones: [l.options[0].id] } })).body.code).toBe('INVALID_OPTION');
    });
    it('سعر خيار لحقل ما يسعّر بالخيارات مرفوض', async () => {
      const id = await newFixed('ثابتة 3');
      const f = (await post(mgr1, `/services/${id}/fields`, { field_key: 'kind', label_ar: 'النوع', field_type: 'select', options: [{ label_ar: 'أ' }] })).body.fields[0];
      expect((await put(mgr1, `/options/${f.options[0].id}/price`, { price: 5 })).body.code).toBe('NOT_PRICED_OPTION');
      expect((await post(mgr1, `/services/${id}/fields`, { field_key: 'txt', label_ar: 'نص', field_type: 'text', options: [{ label_ar: 'x' }] })).body.code).toBe('OPTIONS_NOT_ALLOWED');
    });
  });

  describe('نسخ الحقول والقفل التفاؤلي', () => {
    it('كل تعديل ينسخ تعريف الحقل بنسخة جديدة (بند الخطة يشير لنسخته)', async () => {
      const l = await newLaser('ليزر نسخ');
      const versions = async () => (await db.query(`select version_no, definition from service_field_versions where field_id=$1 order by version_no`, [l.fieldId])).rows;
      expect((await versions()).map((v) => v.version_no)).toEqual([1]);
      await patch(mgr1, `/fields/${l.fieldId}`, { label_ar: 'المناطق الجديدة', expected_version: 1 });
      await post(mgr1, `/fields/${l.fieldId}/options`, { label_ar: 'ساق', price: 1000 });
      await patch(mgr1, `/options/${l.options[1].id}`, { label_ar: 'الوجه' });
      const v = await versions();
      expect(v.map((x) => x.version_no)).toEqual([1, 2, 3, 4]);
      expect(v[0].definition.label_ar).toBe('المناطق');                     // القديمة ما تتغير
      expect(v[1].definition.label_ar).toBe('المناطق الجديدة');
      expect(v[2].definition.options.map((o: any) => o.label_ar)).toContain('ساق');
      expect(v[3].definition.options.map((o: any) => o.label_ar)).toContain('الوجه');
    });
    it('تعديل حقل بنسخة قديمة → 409، وتزامن يمرر واحد بس', async () => {
      const l = await newLaser('ليزر قفل');
      const stale = await patch(mgr1, `/fields/${l.fieldId}`, { label_ar: 'x1', expected_version: 5 });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('FIELD_CONFLICT');
      const rs = await Promise.all([1, 2, 3].map((i) => patch(mgr1, `/fields/${l.fieldId}`, { label_ar: `تزامن ${i}`, expected_version: 1 })));
      expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    });
    it('حقل أو خيار غير موجود → 404، وفرع ثاني → 404', async () => {
      const l = await newLaser('ليزر فرع');
      expect((await patch(mgr1, '/fields/999999', { label_ar: 'x', expected_version: 1 })).status).toBe(404);
      expect((await patch(mgr1, '/options/999999', { label_ar: 'x' })).status).toBe(404);
      expect((await patch(mgr2, `/fields/${l.fieldId}`, { label_ar: 'x', expected_version: 1 })).status).toBe(404);
      expect((await patch(mgr2, `/options/${l.options[0].id}`, { label_ar: 'x' })).status).toBe(404);
      expect((await put(mgr2, `/options/${l.options[0].id}/price`, { price: 1 })).status).toBe(404);
      expect((await post(mgr2, `/fields/${l.fieldId}/options`, { label_ar: 'x', price: 1 })).status).toBe(404);
    });
  });

  describe('ربط المواد والاستهلاك', () => {
    it('قيمة الحقل × المعامل + كمية ثابتة للجلسة تظهر بمعاينة الطبيب', async () => {
      const b = await newBotox('بوتكس مواد');
      const r = await put(mgr1, `/services/${b.id}/materials`, { items: [
        { material_id: matBotox, formula: 'per_field_value', field_id: b.fieldId, factor: '1' },
        { material_id: matSyringe, formula: 'fixed_per_session', factor: '1' },
      ] });
      expect(r.status).toBe(200);
      expect(r.body.materials).toHaveLength(2);
      await post(mgr1, `/services/${b.id}/activate`);
      const q = await post(doc, `/services/${b.id}/quote`, { values: { cc: '2.5' } });
      expect(q.body.consumption).toEqual([{ material_id: matBotox, qty_base: '2.500' }, { material_id: matSyringe, qty_base: '1.000' }]);
      // الاستبدال يمسح القديم
      const r2 = await put(mgr1, `/services/${b.id}/materials`, { items: [] });
      expect(r2.body.materials).toEqual([]);
      expect((await post(doc, `/services/${b.id}/quote`, { values: { cc: 2 } })).body.consumption).toEqual([]);
    });
    it('تحققات الربط: مادة فرع ثاني أو معطلة أو غير موجودة، حقل غلط، تكرار، معامل غلط', async () => {
      const b = await newBotox('بوتكس مواد 2');
      const link = (extra: object) => put(mgr1, `/services/${b.id}/materials`, { items: [{ material_id: matBotox, formula: 'per_field_value', field_id: b.fieldId, factor: '1', ...extra }] });
      expect((await link({ material_id: matOther })).body.code).toBe('MATERIAL_NOT_FOUND');
      expect((await link({ material_id: 999999 })).body.code).toBe('MATERIAL_NOT_FOUND');
      expect((await link({ material_id: matOff })).body.code).toBe('MATERIAL_INACTIVE');
      expect((await link({ field_id: 999999 })).body.code).toBe('FIELD_NOT_FOUND');
      expect((await link({ formula: 'fixed_per_session' })).body.code).toBe('FIELD_NOT_ALLOWED');
      expect((await link({ factor: '0' })).status).toBe(400);
      expect((await link({ factor: '1.23456' })).status).toBe(400);
      expect((await link({ factor: '-1' })).status).toBe(400);
      expect((await link({ factor: 'abc' })).status).toBe(400);
      const dup = await put(mgr1, `/services/${b.id}/materials`, { items: [
        { material_id: matBotox, formula: 'fixed_per_session', factor: '1' }, { material_id: matBotox, formula: 'fixed_per_session', factor: '2' }] });
      expect(dup.body.code).toBe('DUPLICATE_LINK');
      const txt = (await post(mgr1, `/services/${b.id}/fields`, { field_key: 'note', label_ar: 'ملاحظة', field_type: 'text' })).body.fields.find((f: any) => f.field_key === 'note');
      expect((await link({ field_id: txt.id })).body.code).toBe('FIELD_NOT_QUANTITY');
      expect((await db.query(`select count(*)::int as n from service_materials where service_id=$1`, [b.id])).rows[0].n).toBe(0);   // كله تراجع
    });
    it('ما ينفع تعطيل حقل مربوط بمادة بخدمة فعالة، والمدير فقط يربط', async () => {
      const b = await newBotox('بوتكس مواد 3');
      await put(mgr1, `/services/${b.id}/materials`, { items: [{ material_id: matBotox, formula: 'per_field_value', field_id: b.fieldId, factor: '1' }] });
      await post(mgr1, `/services/${b.id}/activate`);
      const v = (await get(mgr1, `/services/${b.id}`)).body.fields[0].version;
      expect((await patch(mgr1, `/fields/${b.fieldId}`, { is_active: false, expected_version: v })).body.code).toBe('SERVICE_INCOMPLETE');
      expect((await put(doc, `/services/${b.id}/materials`, { items: [] })).status).toBe(403);
      expect((await put(mgr2, `/services/${b.id}/materials`, { items: [] })).status).toBe(404);
    });
  });

  describe('التفعيل والتعطيل', () => {
    it('تعطيل الخدمة يخفيها عن الطبيب ويبقيها للمدير، والتكرار بدون أثر', async () => {
      const id = await newFixed('تفعيل');
      await post(mgr1, `/services/${id}/activate`);
      await post(mgr1, `/services/${id}/activate`);
      const off = await post(mgr1, `/services/${id}/deactivate`);
      expect(off.body.is_active).toBe(false);
      expect((await post(mgr1, `/services/${id}/deactivate`)).status).toBe(200);
      expect((await get(doc, '/services')).body.map((x: any) => x.id)).not.toContain(id);
      expect((await post(doc, `/services/${id}/quote`, { values: {} })).status).toBe(404);
      expect((await post(mgr1, `/services/${id}/quote`, { values: {} })).body.list_price).toBe(40000);   // المدير يعاين المعطلة
    });
    it('ما تتفعل بدون سعر، وكشفية فعالة وحدة بالفرع', async () => {
      const id = await newFixed('بدون سعر');
      await db.query(`delete from service_prices where service_id=$1`, [id]);
      const r = await post(mgr1, `/services/${id}/activate`);
      expect(r.body.code).toBe('SERVICE_INCOMPLETE');
      expect(r.body.problems).toEqual(['حدد السعر']);
      const mk = async (n: string) => Number((await db.query(`insert into services (branch_id, name_ar, kind, pricing_model, is_active) values ($1,$2,'consultation','fixed',false) returning id`, [b2, n])).rows[0].id);
      const c1 = await mk('كشفية 1'); const c2 = await mk('كشفية 2');
      await db.query(`insert into service_prices (service_id, price, set_by) select id, 25000, (select id from users where username='owner') from services where id in ($1,$2)`, [c1, c2]);
      expect((await post(owner, `/services/${c1}/activate`)).status).toBe(200);
      const second = await post(owner, `/services/${c2}/activate`);
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('CONSULTATION_EXISTS');
    });
  });

  it('كل عمليات الكتالوج تنسجل بسجل الحركات', async () => {
    const actions = (await db.query(`select distinct action from audit_log where action like 'service.%'`)).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['service.create', 'service.update', 'service.price', 'service.activate', 'service.deactivate',
      'service.field_add', 'service.field_update', 'service.option_add', 'service.option_update', 'service.option_price', 'service.materials']));
  });
});
