import { Errors } from '../common/errors';

/**
 * محرك التسعير والاستهلاك (دوال نقية، بدون قاعدة بيانات). كل الحساب بأعداد صحيحة (BigInt) حتى ما تدخل أرقام عائمة بالفلوس.
 *  - سعر ثابت: سعر الجلسة.
 *  - سعر لكل وحدة (مثل cc): السعر × الكمية، ويتقرب لدينار صحيح (نصف دينار للأعلى) وقت إنشاء البند.
 *  - حسب الخيارات (مناطق الليزر): مجموع أسعار الخيارات المختارة، والخيار الحصري (فول بدي) ما يجتمع مع غيره.
 *  - الاستهلاك: قيمة الحقل × المعامل، أو كمية ثابتة للجلسة. الكمية بـ3 خانات عشرية (numeric(14,3)).
 */
export type FieldType = 'number' | 'select' | 'multi_select' | 'text' | 'bool';
export type PricingModel = 'fixed' | 'per_unit' | 'per_option';
export type PricingRole = 'none' | 'quantity' | 'option';

export interface OptionDef { id: number; label_ar: string; is_exclusive: boolean; is_active: boolean; price: number | null }
export interface FieldDef {
  id: number; field_key: string; label_ar: string; field_type: FieldType; unit_label: string | null;
  is_required: boolean; pricing_role: PricingRole; is_active: boolean; options: OptionDef[];
}
export interface MaterialLink { material_id: number; field_id: number | null; formula: 'per_field_value' | 'fixed_per_session'; factor: string }
export interface ServiceDef {
  id: number; name_ar: string; kind: 'consultation' | 'treatment'; pricing_model: PricingModel;
  price: number | null; fields: FieldDef[]; materials: MaterialLink[];
}

export interface Quote {
  list_price: number;
  unit_price: number | null;
  quantity: string | null;
  options: { option_id: number; label_ar: string; price: number }[];
  consumption: { material_id: number; qty_base: string }[];
  /** لقطة تنحفظ مع بند الوصل: ما تتأثر بتغيير الأسعار أو الحقول بعدين */
  snapshot: Record<string, unknown>;
}

// ---------------------------------------------------------------- أعداد عشرية بدقة ثابتة
/** يحول رقم/نص عشري لـ BigInt مضروب بـ10^scale. يرفض: غير رقم، أُس (1e-7)، أكثر من scale خانة، سالب. */
export function toScaled(raw: unknown, scale: number): bigint {
  const s = typeof raw === 'number' ? (Number.isFinite(raw) ? String(raw) : '') : typeof raw === 'string' ? raw.trim() : '';
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new RangeError('not a decimal');
  const frac = m[2] ?? '';
  if (frac.length > scale) throw new RangeError('too many decimals');
  return BigInt(m[1] + frac.padEnd(scale, '0'));
}

/** قسمة صحيحة بتقريب نصف للأعلى (للأعداد غير السالبة). */
export const divRoundHalfUp = (n: bigint, d: bigint): bigint => (n * 2n + d) / (2n * d);

export function formatScaled(v: bigint, scale: number): string {
  const s = v.toString().padStart(scale + 1, '0');
  return `${s.slice(0, -scale)}.${s.slice(-scale)}`;
}

const MAX_QTY3 = 100_000n * 1000n;   // سقف الكمية المنطقي (100,000 وحدة)

// ---------------------------------------------------------------- التحقق من القيم
interface Parsed { number?: bigint; optionIds?: number[]; text?: string; bool?: boolean }

function parseValue(f: FieldDef, raw: unknown): Parsed {
  const bad = (code: string, msg: string) => Errors.badRequest(code, `${f.label_ar}: ${msg}`);
  switch (f.field_type) {
    case 'number': {
      let v: bigint;
      try { v = toScaled(raw, 3); } catch { throw bad('INVALID_FIELD_VALUE', 'لازم رقم موجب بحد أقصى 3 خانات عشرية'); }
      if (v > MAX_QTY3) throw bad('INVALID_FIELD_VALUE', 'القيمة كبيرة جداً');
      if (f.pricing_role === 'quantity' && v === 0n) throw bad('INVALID_FIELD_VALUE', 'الكمية لازم أكبر من صفر');
      return { number: v };
    }
    case 'select': {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) throw bad('INVALID_FIELD_VALUE', 'اختر خياراً من القائمة');
      const o = f.options.find((x) => x.id === raw && x.is_active);
      if (!o) throw bad('INVALID_OPTION', 'الخيار غير موجود أو معطل');
      return { optionIds: [o.id] };
    }
    case 'multi_select': {
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'number' || !Number.isInteger(x))) throw bad('INVALID_FIELD_VALUE', 'اختر خيارات من القائمة');
      const ids = [...new Set(raw as number[])];
      if (ids.length !== raw.length) throw bad('DUPLICATE_OPTION', 'خيار مكرر');
      for (const id of ids) if (!f.options.some((x) => x.id === id && x.is_active)) throw bad('INVALID_OPTION', 'خيار غير موجود أو معطل');
      return { optionIds: ids };
    }
    case 'text': {
      if (typeof raw !== 'string') throw bad('INVALID_FIELD_VALUE', 'لازم نص');
      const t = raw.trim();
      if (t.length > 500) throw bad('INVALID_FIELD_VALUE', 'النص أطول من 500 حرف');
      return { text: t };
    }
    case 'bool': {
      if (typeof raw !== 'boolean') throw bad('INVALID_FIELD_VALUE', 'لازم صح أو خطأ');
      return { bool: raw };
    }
  }
}

const isEmpty = (f: FieldDef, p: Parsed) => (f.field_type === 'text' && !p.text) || (f.field_type === 'multi_select' && !p.optionIds?.length);

// ---------------------------------------------------------------- التسعير
export function quote(service: ServiceDef, values: Record<string, unknown>): Quote {
  const active = service.fields.filter((f) => f.is_active);
  const byKey = new Map(active.map((f) => [f.field_key, f]));
  for (const k of Object.keys(values)) if (!byKey.has(k)) throw Errors.badRequest('UNKNOWN_FIELD', `حقل غير معروف أو معطل: ${k}`);

  const parsed = new Map<number, Parsed>();
  for (const f of active) {
    const raw = values[f.field_key];
    if (raw === undefined || raw === null) {
      if (f.is_required) throw Errors.badRequest('FIELD_REQUIRED', `${f.label_ar}: مطلوب`);
      continue;
    }
    const p = parseValue(f, raw);
    if (f.is_required && isEmpty(f, p)) throw Errors.badRequest('FIELD_REQUIRED', `${f.label_ar}: مطلوب`);
    parsed.set(f.id, p);
  }

  let listPrice: bigint; let unitPrice: bigint | null = null; let quantity: bigint | null = null;
  const optionLines: Quote['options'] = [];

  if (service.pricing_model === 'fixed') {
    if (service.price === null) throw Errors.badRequest('NO_PRICE', `${service.name_ar}: ما انحدد سعر`);
    listPrice = BigInt(service.price);
  } else if (service.pricing_model === 'per_unit') {
    const f = active.find((x) => x.pricing_role === 'quantity');
    if (!f) throw Errors.badRequest('SERVICE_MISCONFIGURED', `${service.name_ar}: حقل الكمية غير معرف`);
    if (service.price === null) throw Errors.badRequest('NO_PRICE', `${service.name_ar}: ما انحدد سعر`);
    const q = parsed.get(f.id)?.number;
    if (q === undefined) throw Errors.badRequest('FIELD_REQUIRED', `${f.label_ar}: مطلوب`);
    quantity = q; unitPrice = BigInt(service.price);
    listPrice = divRoundHalfUp(unitPrice * q, 1000n);
  } else {
    const f = active.find((x) => x.pricing_role === 'option');
    if (!f) throw Errors.badRequest('SERVICE_MISCONFIGURED', `${service.name_ar}: حقل الخيارات غير معرف`);
    const ids = parsed.get(f.id)?.optionIds ?? [];
    if (!ids.length) throw Errors.badRequest('FIELD_REQUIRED', `${f.label_ar}: اختر خياراً واحداً على الأقل`);
    const chosen = ids.map((id) => f.options.find((o) => o.id === id)!);
    if (chosen.some((o) => o.is_exclusive) && chosen.length > 1) {
      throw Errors.badRequest('EXCLUSIVE_OPTION_CONFLICT', `${f.label_ar}: «${chosen.find((o) => o.is_exclusive)!.label_ar}» ما يجتمع مع خيارات ثانية`);
    }
    listPrice = 0n;
    for (const o of chosen) {
      if (o.price === null) throw Errors.badRequest('NO_PRICE', `${o.label_ar}: ما انحدد سعر`);
      listPrice += BigInt(o.price);
      optionLines.push({ option_id: o.id, label_ar: o.label_ar, price: o.price });
    }
  }

  // الاستهلاك
  const acc = new Map<number, bigint>();   // material_id → كمية مضروبة بـ1000
  for (const m of service.materials) {
    let q3: bigint;
    if (m.formula === 'fixed_per_session') {
      q3 = divRoundHalfUp(toScaled(m.factor, 4), 10n);
    } else {
      const v = parsed.get(m.field_id!)?.number;
      if (v === undefined) continue;                 // الحقل غير مطلوب وما انكتب: ما أكو استهلاك منه
      q3 = divRoundHalfUp(v * toScaled(m.factor, 4), 10_000n);
    }
    if (q3 === 0n) q3 = 1n;                          // أصغر كمية ممكنة (0.001) بدل صفر
    acc.set(m.material_id, (acc.get(m.material_id) ?? 0n) + q3);
  }
  const consumption = [...acc.entries()].map(([material_id, q3]) => ({ material_id, qty_base: formatScaled(q3, 3) }));

  const quantityStr = quantity === null ? null : formatScaled(quantity, 3);
  return {
    list_price: Number(listPrice), unit_price: unitPrice === null ? null : Number(unitPrice), quantity: quantityStr,
    options: optionLines, consumption,
    snapshot: {
      service_id: service.id, service_name: service.name_ar, pricing_model: service.pricing_model,
      unit_price: unitPrice === null ? null : Number(unitPrice), quantity: quantityStr, options: optionLines,
      values: Object.fromEntries(active.filter((f) => values[f.field_key] !== undefined && values[f.field_key] !== null).map((f) => [f.field_key, values[f.field_key]])),
    },
  };
}

// ---------------------------------------------------------------- اكتمال التعريف (قبل التفعيل)
/** قائمة المشاكل اللي تمنع تفعيل الخدمة. فاضية = جاهزة. */
export function completenessProblems(s: ServiceDef): string[] {
  const out: string[] = [];
  const active = s.fields.filter((f) => f.is_active);
  const qty = active.filter((f) => f.pricing_role === 'quantity');
  const opt = active.filter((f) => f.pricing_role === 'option');
  if (s.kind === 'consultation' && s.pricing_model !== 'fixed') out.push('الكشفية لازم بسعر ثابت');
  if (s.pricing_model === 'fixed') {
    if (s.price === null) out.push('حدد السعر');
    if (qty.length || opt.length) out.push('الخدمة بسعر ثابت ما تحتاج حقل كمية أو خيارات تسعير');
  } else if (s.pricing_model === 'per_unit') {
    if (s.price === null) out.push('حدد سعر الوحدة');
    if (qty.length !== 1) out.push('لازم حقل كمية واحد بالضبط');
    else if (!qty[0].is_required) out.push('حقل الكمية لازم يكون مطلوباً');
    if (opt.length) out.push('الخدمة بسعر الوحدة ما تحتاج خيارات تسعير');
  } else {
    if (opt.length !== 1) out.push('لازم حقل خيارات تسعير واحد بالضبط');
    else {
      const o = opt[0].options.filter((x) => x.is_active);
      if (!o.length) out.push('أضف خياراً واحداً على الأقل');
      for (const x of o) if (x.price === null) out.push(`حدد سعر الخيار «${x.label_ar}»`);
      if (!opt[0].is_required) out.push('حقل الخيارات لازم يكون مطلوباً');
    }
    if (qty.length) out.push('الخدمة بسعر الخيارات ما تحتاج حقل كمية');
  }
  for (const m of s.materials) {
    if (m.formula === 'per_field_value') {
      const f = active.find((x) => x.id === m.field_id);
      if (!f) out.push('ربط مادة بحقل معطل أو محذوف');
      else if (f.field_type !== 'number' || !f.is_required) out.push(`حقل «${f.label_ar}» المربوط بمادة لازم رقماً ومطلوباً`);
    }
  }
  return out;
}
