/**
 * مصفوفة الصلاحيات حسب PROJECT_PLAN.md القسم 3. السيرفر هو اللي يفحصها بكل طلب.
 * ملاحظات النطاق (مثل «زبائنه بس» للطبيب) تنفحص بالخدمة نفسها، مو هنا.
 */
export const ROLES = ['owner', 'manager', 'cashier', 'doctor', 'nurse', 'customer'] as const;
export type Role = (typeof ROLES)[number];
export type StaffRole = Exclude<Role, 'customer'>;

export const PERMISSIONS = {
  // المالك
  'reports.all': ['owner'],                                   // الأرباح والتقارير الكاملة
  'staff.manage_managers': ['owner'],                         // إضافة/تعطيل المدراء وإعادة تعيين رمزهم
  'salary.manager_pay': ['owner'],                            // تسديد راتب المدير
  'salary.doctor_manager_set': ['owner'],                     // رواتب الأطباء والمدير
  'doctor.percent_set': ['owner'],                            // نسبة الطبيب على كشفياته
  'points.rules': ['owner'],                                  // قواعد النقاط
  'purchases.void': ['owner'],                                // إلغاء فاتورة شراء غلط (بسبب مكتوب)
  'expenses.edit': ['owner'],                                 // تعديل مصروف محفوظ
  'withdrawal.approve': ['owner'],                            // الموافقة على سحب المالك
  'ratings.view': ['owner'],
  'compensation.decide': ['owner'],                           // تعويض زبون عن جلسة منفذة (مبلغ مستقل وبسبب)
  'jobs.run': ['owner'],                                      // تشغيل المهام المجدولة يدوياً
  'settings.clinic_rules': ['owner'],                         // مدة المراجعة المجانية وخطوة التقريب
  'customer.merge_or_recode': ['owner'],
  'photos.delete': ['owner'],
  // المالك والمدير
  'staff.manage_staff': ['owner', 'manager'],                 // الكاشير والممرضين والأطباء
  'salary.staff_set': ['owner', 'manager'],                   // رواتب الكاشير والممرضين
  'stock.manage': ['owner', 'manager'],                         // المواد والموردين وفواتير الشراء والمرتجعات والتسديد                       // المواد والشراء والتالف والمرتجع والجرد
  'services.prices': ['owner', 'manager'],
  'services.define': ['owner', 'manager'],
  'expenses.record': ['owner', 'manager'],
  'safe.pay': ['owner', 'manager'],                           // تأكيد استلام الشفت والدفع من الخزنة
  'discount.approve': ['owner', 'manager'],
  'settings.receipt_and_methods': ['owner', 'manager'],
  'schedule.manage': ['owner', 'manager'],                    // دوام الأطباء والعطل والحد اليومي
  'offers.manage': ['owner', 'manager'],
  'session.revert_confirmation': ['owner', 'manager'],
  'settings.read': ['owner', 'manager'],                      // قراءة الإعدادات وتاريخها
  'payroll.read': ['owner', 'manager'],                       // قائمة الرواتب والتوليد (المدير ما يشوف راتب مدير)
  'bookings.close_day': ['owner', 'manager'],                  // إقفال الأيام الماضية (الحجز الغير مدفوع يصير «فات»)
  'bookings.read': ['owner', 'manager', 'cashier', 'doctor'],  // قائمة الحجوزات (الطبيب حجوزاته بس)
  'schedule.read': ['owner', 'manager', 'cashier', 'doctor'],  // قراءة أيام الدوام والعطل والتوفر (الكاشير يحجز، الطبيب يشوف دوامه)
  'services.read': ['owner', 'manager', 'doctor', 'cashier'], // قراءة الخدمات وأسعارها وحقولها (الطبيب يكتب الخطة، الكاشير يعرض السعر)
  // المدير
  'withdrawal.record': ['manager'],
  // المالك والمدير والكاشير
  'customer.register_and_book': ['owner', 'manager', 'cashier'],
  // المالك والكاشير
  'payments.take': ['owner', 'cashier'],                      // الدفع وطباعة الوصل
  'payments.read': ['owner', 'manager', 'cashier'],           // عرض الوصولات والبحث عنها (الكاشير يبحث إذا ضاع رد الدفع)
  'shifts.open': ['owner', 'cashier'],                        // فتح الشفت وتسكيره وعرض شفته
  'shifts.force_close': ['owner', 'manager'],                 // تسكير شفت منسي نيابة عن الكاشير (بسبب مكتوب)
  'shifts.read': ['owner', 'manager'],                        // قائمة الشفتات وتفاصيلها (المتوقع والمعدود والفرق)
  'safe.read': ['owner', 'manager'],                          // رصيد الخزنة وحركاتها
  'safe.opening': ['owner'],                                  // الرصيد الافتتاحي للخزنة (مرة وحدة)
  'payments.refund': ['owner', 'cashier'],
  // الكاشير
  'discount.request': ['cashier'],
  // الطبيب
  'consultation.write': ['doctor'],
  'health.record': ['doctor'],
  // الطبيب والممرض (والمالك للقراءة)
  'health.view_alert': ['owner', 'doctor', 'nurse'],
  'customer.file.view': ['owner', 'doctor'],                  // الطبيب لزبائنه بس
  'photos.upload': ['doctor', 'nurse'],
  'photos.view': ['owner', 'doctor'],                         // الطبيب لزبائنه بس
  // الممرض
  'session.confirm': ['nurse'],
  // الزبون
  'rating.submit': ['customer'],
  'customer.self': ['customer'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

/** من يقدر يضيف/يعطل/يعيد رمز أي دور (الجدول: المدراء للمالك، والباقي للمالك والمدير) */
export function permissionToManage(targetRole: StaffRole): Permission | null {
  if (targetRole === 'owner') return null;               // حساب المالك ما ينُدار من الـ API
  if (targetRole === 'manager') return 'staff.manage_managers';
  return 'staff.manage_staff';
}
