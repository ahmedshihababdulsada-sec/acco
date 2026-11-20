import { HttpException } from '@nestjs/common';
import { FieldDef, MaterialLink, OptionDef, ServiceDef, completenessProblems, divRoundHalfUp, formatScaled, quote, toScaled } from '../src/catalog/pricing';

const code = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return ((e as HttpException).getResponse() as any).code; }
  return undefined;
};

const opt = (id: number, label: string, price: number | null, extra: Partial<OptionDef> = {}): OptionDef =>
  ({ id, label_ar: label, is_exclusive: false, is_active: true, price, ...extra });
const field = (id: number, key: string, type: FieldDef['field_type'], extra: Partial<FieldDef> = {}): FieldDef =>
  ({ id, field_key: key, label_ar: key, field_type: type, unit_label: null, is_required: false, pricing_role: 'none', is_active: true, options: [], ...extra });
const svc = (extra: Partial<ServiceDef>): ServiceDef =>
  ({ id: 1, name_ar: 'خدمة', kind: 'treatment', pricing_model: 'fixed', price: 50000, fields: [], materials: [], ...extra });

describe('أعداد عشرية بدقة ثابتة', () => {
  it('toScaled: يقبل أرقام ونصوص صحيحة بحد الخانات', () => {
    expect(toScaled('2.5', 3)).toBe(2500n);
    expect(toScaled(2.5, 3)).toBe(2500n);
    expect(toScaled('2', 3)).toBe(2000n);
    expect(toScaled('0.001', 3)).toBe(1n);
    expect(toScaled(' 7 ', 0)).toBe(7n);
    expect(toScaled('0.0001', 4)).toBe(1n);
  });
  it('toScaled: يرفض سالب وأُس وخانات زيادة ونص ومالانهاية', () => {
    for (const bad of ['-1', '1e-7', '2.5555', 'abc', '', '1,5', NaN, Infinity, 1e21, 1e-7, null, undefined, {}, true]) {
      expect(() => toScaled(bad, 3)).toThrow();
    }
  });
  it('القسمة بتقريب نصف للأعلى', () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);   // 2.5 → 3
    expect(divRoundHalfUp(4n, 2n)).toBe(2n);
    expect(divRoundHalfUp(7n, 2n)).toBe(4n);   // 3.5 → 4
    expect(divRoundHalfUp(499n, 1000n)).toBe(0n);
    expect(divRoundHalfUp(500n, 1000n)).toBe(1n);
    expect(divRoundHalfUp(0n, 1000n)).toBe(0n);
  });
  it('formatScaled', () => {
    expect(formatScaled(2500n, 3)).toBe('2.500');
    expect(formatScaled(1n, 3)).toBe('0.001');
    expect(formatScaled(0n, 3)).toBe('0.000');
    expect(formatScaled(123456n, 3)).toBe('123.456');
  });
});

describe('التسعير: سعر ثابت', () => {
  it('السعر نفسه، وبدون سعر → NO_PRICE', () => {
    const q = quote(svc({ price: 25000 }), {});
    expect(q.list_price).toBe(25000);
    expect(q.unit_price).toBeNull();
    expect(code(() => quote(svc({ price: null }), {}))).toBe('NO_PRICE');
  });
});

describe('التسعير: سعر لكل وحدة (بوتكس بالـ cc)', () => {
  const botox = (price: number | null = 50000, req = true) => svc({
    pricing_model: 'per_unit', price,
    fields: [field(10, 'cc', 'number', { pricing_role: 'quantity', is_required: req, unit_label: 'cc' })],
  });

  it.each([
    [50000, '2.5', 125000],
    [50000, 2, 100000],
    [50000, '0.5', 25000],
    [333, '0.5', 167],      // 166.5 → 167 (نصف للأعلى)
    [1, '0.5', 1],          // 0.5 → 1
    [3, '0.5', 2],          // 1.5 → 2
    [2, '0.25', 1],         // 0.5 → 1
    [2, '0.249', 0],        // 0.498 → 0
    [333, '0.001', 0],      // 0.333 → 0
    [100000, '12.345', 1234500],
    [7, '3', 21],
  ])('سعر %i × كمية %s = %i', (price, qty, expected) => {
    const q = quote(botox(price), { cc: qty });
    expect(q.list_price).toBe(expected);
    expect(q.unit_price).toBe(price);
    expect(q.quantity).toBe(formatScaled(toScaled(qty, 3), 3));
  });

  it('الكمية: صفر وسالب وأكثر من 3 خانات وأُس ونص وكبيرة جداً كلها مرفوضة', () => {
    for (const bad of [0, '0', '0.000', -1, '2.5555', '1e-3', 'abc', 100001, true, [1]]) {
      expect(code(() => quote(botox(), { cc: bad as any }))).toBe('INVALID_FIELD_VALUE');
    }
    expect(quote(botox(), { cc: 100000 }).list_price).toBe(5_000_000_000);
  });

  it('الكمية مطلوبة، وبدون سعر NO_PRICE، وحقل مجهول مرفوض', () => {
    expect(code(() => quote(botox(), {}))).toBe('FIELD_REQUIRED');
    expect(code(() => quote(botox(), { cc: null as any }))).toBe('FIELD_REQUIRED');
    expect(code(() => quote(botox(null), { cc: 2 }))).toBe('NO_PRICE');
    expect(code(() => quote(botox(), { cc: 2, hack: 1 }))).toBe('UNKNOWN_FIELD');
  });

  it('حقل الكمية غير معرف = إعداد خاطئ', () => {
    expect(code(() => quote(svc({ pricing_model: 'per_unit', price: 100, fields: [] }), {}))).toBe('SERVICE_MISCONFIGURED');
  });
});

describe('التسعير: حسب الخيارات (مناطق الليزر)', () => {
  const laser = () => svc({
    pricing_model: 'per_option', price: null,
    fields: [field(20, 'zones', 'multi_select', {
      pricing_role: 'option', is_required: true,
      options: [opt(1, 'ابط', 30000), opt(2, 'وجه', 50000), opt(3, 'فول بدي', 200000, { is_exclusive: true }), opt(4, 'قديم', 1, { is_active: false }), opt(5, 'بدون سعر', null)],
    })],
  });

  it('مجموع أسعار المناطق المختارة', () => {
    const q = quote(laser(), { zones: [1, 2] });
    expect(q.list_price).toBe(80000);
    expect(q.options).toEqual([{ option_id: 1, label_ar: 'ابط', price: 30000 }, { option_id: 2, label_ar: 'وجه', price: 50000 }]);
    expect(quote(laser(), { zones: [2] }).list_price).toBe(50000);
  });
  it('فول بدي لحاله مقبول، ومع غيره مرفوض', () => {
    expect(quote(laser(), { zones: [3] }).list_price).toBe(200000);
    expect(code(() => quote(laser(), { zones: [3, 1] }))).toBe('EXCLUSIVE_OPTION_CONFLICT');
  });
  it('خيار غير موجود أو معطل أو مكرر أو بدون سعر أو فاضي', () => {
    expect(code(() => quote(laser(), { zones: [99] }))).toBe('INVALID_OPTION');
    expect(code(() => quote(laser(), { zones: [4] }))).toBe('INVALID_OPTION');
    expect(code(() => quote(laser(), { zones: [1, 1] }))).toBe('DUPLICATE_OPTION');
    expect(code(() => quote(laser(), { zones: [5] }))).toBe('NO_PRICE');
    expect(code(() => quote(laser(), { zones: [] }))).toBe('FIELD_REQUIRED');
    expect(code(() => quote(laser(), {}))).toBe('FIELD_REQUIRED');
    expect(code(() => quote(laser(), { zones: 'ابط' as any }))).toBe('INVALID_FIELD_VALUE');
    expect(code(() => quote(laser(), { zones: ['1'] as any }))).toBe('INVALID_FIELD_VALUE');
  });
  it('حقل select مفرد يشتغل مثل الاختيار الواحد', () => {
    const s = svc({ pricing_model: 'per_option', price: null, fields: [field(21, 'level', 'select', { pricing_role: 'option', is_required: true, options: [opt(1, 'خفيف', 10000), opt(2, 'قوي', 20000)] })] });
    expect(quote(s, { level: 2 }).list_price).toBe(20000);
    expect(code(() => quote(s, { level: [2] as any }))).toBe('INVALID_FIELD_VALUE');
  });
});

describe('الحقول العادية', () => {
  const s = svc({
    fields: [
      field(1, 'notes', 'text'), field(2, 'req_text', 'text', { is_required: true }),
      field(3, 'flag', 'bool'), field(4, 'depth', 'number', { unit_label: 'مم' }),
      field(5, 'old', 'text', { is_active: false }),
    ],
  });
  it('الاختياري يتخطى، المطلوب لازم، والنص يتقص، والفاضي ما يكفي للمطلوب', () => {
    expect(code(() => quote(s, {}))).toBe('FIELD_REQUIRED');
    expect(code(() => quote(s, { req_text: '   ' }))).toBe('FIELD_REQUIRED');
    const q = quote(s, { req_text: '  مرحبا  ', flag: true, depth: '1.25' });
    expect((q.snapshot as any).values).toEqual({ req_text: '  مرحبا  ', flag: true, depth: '1.25' });
  });
  it('أنواع غلط وطول زيادة وحقل معطل', () => {
    expect(code(() => quote(s, { req_text: 5 as any }))).toBe('INVALID_FIELD_VALUE');
    expect(code(() => quote(s, { req_text: 'x', flag: 'yes' as any }))).toBe('INVALID_FIELD_VALUE');
    expect(code(() => quote(s, { req_text: 'x'.repeat(501) }))).toBe('INVALID_FIELD_VALUE');
    expect(code(() => quote(s, { req_text: 'x', depth: -2 }))).toBe('INVALID_FIELD_VALUE');
    expect(code(() => quote(s, { req_text: 'x', old: 'z' }))).toBe('UNKNOWN_FIELD');
    expect(quote(s, { req_text: 'x', depth: 0 }).list_price).toBe(50000);   // الصفر مسموح لحقل غير كمية
  });
});

describe('استهلاك المواد', () => {
  const link = (m: Partial<MaterialLink> & { material_id: number }): MaterialLink => ({ field_id: null, formula: 'fixed_per_session', factor: '1', ...m });
  const base = (materials: MaterialLink[], req = true) => svc({
    pricing_model: 'per_unit', price: 1000,
    fields: [field(10, 'cc', 'number', { pricing_role: 'quantity', is_required: req })], materials,
  });

  it('قيمة الحقل × المعامل', () => {
    expect(quote(base([link({ material_id: 7, formula: 'per_field_value', field_id: 10, factor: '1' })]), { cc: '2.5' }).consumption).toEqual([{ material_id: 7, qty_base: '2.500' }]);
    expect(quote(base([link({ material_id: 7, formula: 'per_field_value', field_id: 10, factor: '0.4' })]), { cc: '2.5' }).consumption).toEqual([{ material_id: 7, qty_base: '1.000' }]);
    expect(quote(base([link({ material_id: 7, formula: 'per_field_value', field_id: 10, factor: '3' })]), { cc: '0.333' }).consumption).toEqual([{ material_id: 7, qty_base: '0.999' }]);
  });
  it('كمية ثابتة للجلسة مع تقريب نصف للأعلى لـ3 خانات', () => {
    expect(quote(base([link({ material_id: 8, factor: '1' })]), { cc: 1 }).consumption).toEqual([{ material_id: 8, qty_base: '1.000' }]);
    expect(quote(base([link({ material_id: 8, factor: '3.0005' })]), { cc: 1 }).consumption).toEqual([{ material_id: 8, qty_base: '3.001' }]);
    expect(quote(base([link({ material_id: 8, factor: '3.0004' })]), { cc: 1 }).consumption).toEqual([{ material_id: 8, qty_base: '3.000' }]);
  });
  it('أصغر كمية 0.001 بدل صفر', () => {
    expect(quote(base([link({ material_id: 7, formula: 'per_field_value', field_id: 10, factor: '0.0001' })]), { cc: '0.001' }).consumption).toEqual([{ material_id: 7, qty_base: '0.001' }]);
  });
  it('نفس المادة من ربطين تتجمع، ومواد مختلفة تنفصل', () => {
    const q = quote(base([
      link({ material_id: 7, formula: 'per_field_value', field_id: 10, factor: '1' }),
      link({ material_id: 7, factor: '0.5' }),
      link({ material_id: 9, factor: '2' }),
    ]), { cc: 2 });
    expect(q.consumption).toEqual([{ material_id: 7, qty_base: '2.500' }, { material_id: 9, qty_base: '2.000' }]);
  });
  it('حقل غير مطلوب وما انكتب: ما أكو استهلاك منه', () => {
    const s = svc({ fields: [field(11, 'extra', 'number')], materials: [link({ material_id: 7, formula: 'per_field_value', field_id: 11, factor: '2' })] });
    expect(quote(s, {}).consumption).toEqual([]);
    expect(quote(s, { extra: 3 }).consumption).toEqual([{ material_id: 7, qty_base: '6.000' }]);
  });
});

describe('اكتمال التعريف قبل التفعيل', () => {
  it('خدمة بسعر ثابت: جاهزة بسعر، وبدونه ناقصة، ومع حقل كمية ناقصة', () => {
    expect(completenessProblems(svc({}))).toEqual([]);
    expect(completenessProblems(svc({ price: null }))).toContain('حدد السعر');
    expect(completenessProblems(svc({ fields: [field(1, 'q', 'number', { pricing_role: 'quantity', is_required: true })] }))[0]).toContain('سعر ثابت');
  });
  it('الكشفية لازم بسعر ثابت', () => {
    expect(completenessProblems(svc({ kind: 'consultation', pricing_model: 'per_unit', price: 1 }))).toContain('الكشفية لازم بسعر ثابت');
  });
  it('بسعر الوحدة: حقل كمية واحد ومطلوب وسعر', () => {
    const ok = svc({ pricing_model: 'per_unit', price: 100, fields: [field(1, 'q', 'number', { pricing_role: 'quantity', is_required: true })] });
    expect(completenessProblems(ok)).toEqual([]);
    expect(completenessProblems({ ...ok, price: null })).toContain('حدد سعر الوحدة');
    expect(completenessProblems({ ...ok, fields: [] })).toContain('لازم حقل كمية واحد بالضبط');
    expect(completenessProblems({ ...ok, fields: [{ ...ok.fields[0], is_required: false }] })).toContain('حقل الكمية لازم يكون مطلوباً');
    expect(completenessProblems({ ...ok, fields: [ok.fields[0], { ...ok.fields[0], id: 2, field_key: 'q2' }] })).toContain('لازم حقل كمية واحد بالضبط');
  });
  it('بسعر الخيارات: حقل واحد، خيارات فعالة، كلها بأسعار', () => {
    const ok = svc({ pricing_model: 'per_option', price: null, fields: [field(1, 'z', 'multi_select', { pricing_role: 'option', is_required: true, options: [opt(1, 'أ', 10), opt(2, 'ب', 20)] })] });
    expect(completenessProblems(ok)).toEqual([]);
    expect(completenessProblems({ ...ok, fields: [] })).toContain('لازم حقل خيارات تسعير واحد بالضبط');
    expect(completenessProblems({ ...ok, fields: [{ ...ok.fields[0], options: [] }] })).toContain('أضف خياراً واحداً على الأقل');
    expect(completenessProblems({ ...ok, fields: [{ ...ok.fields[0], options: [opt(1, 'أ', null)] }] })).toContain('حدد سعر الخيار «أ»');
    expect(completenessProblems({ ...ok, fields: [{ ...ok.fields[0], options: [opt(1, 'أ', 5), opt(2, 'ب', null, { is_active: false })] }] })).toEqual([]);
  });
  it('ربط مادة بحقل: لازم رقم ومطلوب وفعال', () => {
    const f = field(1, 'cc', 'number', { pricing_role: 'quantity', is_required: true });
    const s = (extra: Partial<ServiceDef>) => svc({ pricing_model: 'per_unit', price: 1, fields: [f], ...extra });
    const m = (field_id: number): MaterialLink => ({ material_id: 5, field_id, formula: 'per_field_value', factor: '1' });
    expect(completenessProblems(s({ materials: [m(1)] }))).toEqual([]);
    expect(completenessProblems(s({ materials: [m(99)] }))).toContain('ربط مادة بحقل معطل أو محذوف');
    expect(completenessProblems(s({ fields: [{ ...f, is_active: false }, field(2, 'q', 'number', { pricing_role: 'quantity', is_required: true })], materials: [m(1)] }))).toContain('ربط مادة بحقل معطل أو محذوف');
    expect(completenessProblems(s({ fields: [f, field(3, 'n', 'text')], materials: [m(3)] }))[0]).toContain('رقماً ومطلوباً');
  });
});
