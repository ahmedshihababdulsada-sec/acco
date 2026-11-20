import { Permission } from '../auth/permissions';
import { Errors } from '../common/errors';

/**
 * سجل الإعدادات المسموحة: كل مفتاح له نوع وحدود وقيمة افتراضية ومن يقدر يغيره.
 * أي قيمة تخص عيادة (مو قرار برمجي) تنكتب هنا. القيم الافتراضية = قرارات صاحب المشروع، وكل عيادة تغيرها.
 */
export type SettingType = 'int' | 'string' | 'int_or_null';

export interface SettingDef {
  key: string;
  type: SettingType;
  min?: number;
  max?: number;
  maxLen?: number;
  default: number | string | null;
  permission: Permission;
  label: string;
}

const def = (d: SettingDef) => d;

export const SETTINGS: readonly SettingDef[] = [
  // الحجز والدوام (المدير والمالك)
  def({ key: 'booking.daily_limit', type: 'int', min: 1, max: 1000, default: 30, permission: 'schedule.manage', label: 'الحد الأقصى للحجوزات باليوم' }),
  // قرارات المالك
  def({ key: 'booking.free_followup_days', type: 'int', min: 0, max: 90, default: 7, permission: 'settings.clinic_rules', label: 'مدة المراجعة المجانية (أيام)' }),
  def({ key: 'consultation.sessions_only_fee', type: 'int', min: 0, max: 100_000_000, default: 0, permission: 'services.prices', label: 'سعر كشفية «جلسات فقط» (دينار، 0 = مجانية)' }),
  def({ key: 'money.rounding_step', type: 'int', min: 1, max: 10000, default: 250, permission: 'settings.clinic_rules', label: 'خطوة تقريب صافي الوصل (دينار)' }),
  // النقاط (المالك)
  def({ key: 'points.earn_per_amount', type: 'int', min: 1, max: 100_000_000, default: 10000, permission: 'points.rules', label: 'كل كم دينار مدفوع تكسب نقاط' }),
  def({ key: 'points.earn_points', type: 'int', min: 0, max: 1_000_000, default: 250, permission: 'points.rules', label: 'عدد النقاط لكل عتبة' }),
  def({ key: 'points.point_value', type: 'int', min: 1, max: 100_000, default: 1, permission: 'points.rules', label: 'قيمة النقطة (دينار)' }),
  def({ key: 'points.min_redeem', type: 'int', min: 0, max: 100_000_000, default: 0, permission: 'points.rules', label: 'أقل رصيد نقاط لاستخدامها' }),
  def({ key: 'points.max_percent', type: 'int', min: 0, max: 100, default: 50, permission: 'points.rules', label: 'سقف خصم النقاط من الوصل (%)' }),
  // المخزون (المدير والمالك)
  def({ key: 'stock.near_expiry_days', type: 'int', min: 1, max: 365, default: 30, permission: 'stock.manage', label: 'ينتهي قريب = خلال (أيام)' }),
  // بيانات الوصل (المدير والمالك)
  def({ key: 'receipt.clinic_name', type: 'string', maxLen: 100, default: '', permission: 'settings.receipt_and_methods', label: 'اسم العيادة بالوصل' }),
  def({ key: 'receipt.address', type: 'string', maxLen: 200, default: '', permission: 'settings.receipt_and_methods', label: 'العنوان' }),
  def({ key: 'receipt.phone', type: 'string', maxLen: 60, default: '', permission: 'settings.receipt_and_methods', label: 'التلفون' }),
  def({ key: 'receipt.logo_attachment_id', type: 'int_or_null', min: 1, default: null, permission: 'settings.receipt_and_methods', label: 'شعار الوصل (مرفق)' }),
];

export const SETTING_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(SETTINGS.map((s) => [s.key, s]));

/** يتحقق من القيمة ويرجعها بصيغتها النهائية، أو يرمي 400. */
export function validateSetting(d: SettingDef, value: unknown): number | string | null {
  const bad = (msg: string) => Errors.badRequest('INVALID_SETTING', `${d.label}: ${msg}`);
  if (d.type === 'string') {
    if (typeof value !== 'string') throw bad('لازم نص');
    const v = value.trim();
    if (v.length > (d.maxLen ?? 200)) throw bad(`أطول من ${d.maxLen} حرف`);
    return v;
  }
  if (value === null && d.type === 'int_or_null') return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw bad('لازم رقم صحيح');
  if (d.min !== undefined && value < d.min) throw bad(`أقل من ${d.min}`);
  if (d.max !== undefined && value > d.max) throw bad(`أكبر من ${d.max}`);
  return value;
}
