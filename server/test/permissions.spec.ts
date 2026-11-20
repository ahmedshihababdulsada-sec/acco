import { PERMISSIONS, Permission, can, permissionToManage } from '../src/auth/permissions';

// نتأكد إن المصفوفة تطابق جدول PROJECT_PLAN.md القسم 3 حرفياً لأهم الصفوف
const expected: Record<string, string[]> = {
  'reports.all': ['owner'],
  'staff.manage_managers': ['owner'],
  'staff.manage_staff': ['owner', 'manager'],
  'stock.manage': ['owner', 'manager'],
  'expenses.record': ['owner', 'manager'],
  'expenses.edit': ['owner'],
  'salary.manager_pay': ['owner'],
  'safe.pay': ['owner', 'manager'],
  'discount.approve': ['owner', 'manager'],
  'withdrawal.record': ['manager'],
  'withdrawal.approve': ['owner'],
  'discount.request': ['cashier'],
  'points.rules': ['owner'],
  'doctor.percent_set': ['owner'],
  'salary.doctor_manager_set': ['owner'],
  'salary.staff_set': ['owner', 'manager'],
  'customer.merge_or_recode': ['owner'],
  'customer.register_and_book': ['owner', 'manager', 'cashier'],
  'payments.take': ['owner', 'cashier'],
  'payments.refund': ['owner', 'cashier'],
  'consultation.write': ['doctor'],
  'health.record': ['doctor'],
  'health.view_alert': ['owner', 'doctor', 'nurse'],
  'photos.upload': ['doctor', 'nurse'],
  'photos.delete': ['owner'],
  'session.confirm': ['nurse'],
  'session.revert_confirmation': ['owner', 'manager'],
  'rating.submit': ['customer'],
  'ratings.view': ['owner'],
};

describe('مصفوفة الصلاحيات', () => {
  for (const [perm, roles] of Object.entries(expected)) {
    it(`${perm} → ${roles.join(', ')}`, () => {
      expect([...(PERMISSIONS[perm as Permission] as readonly string[])].sort()).toEqual([...roles].sort());
    });
  }

  it('الكاشير ما يأكد جلسة، والممرض ما يستلم دفع', () => {
    expect(can('cashier', 'session.confirm')).toBe(false);
    expect(can('nurse', 'payments.take')).toBe(false);
  });

  it('المدير ما يشوف الأرباح ولا يعدل مصروف محفوظ', () => {
    expect(can('manager', 'reports.all')).toBe(false);
    expect(can('manager', 'expenses.edit')).toBe(false);
  });

  it('المالك ما يسجل سحب بنفسه (المدير يسجل، المالك يوافق)', () => {
    expect(can('owner', 'withdrawal.record')).toBe(false);
    expect(can('owner', 'withdrawal.approve')).toBe(true);
  });

  it('إدارة الحسابات: المدراء للمالك، والباقي للمالك والمدير، والمالك ما ينُدار', () => {
    expect(permissionToManage('manager')).toBe('staff.manage_managers');
    for (const r of ['cashier', 'nurse', 'doctor'] as const) expect(permissionToManage(r)).toBe('staff.manage_staff');
    expect(permissionToManage('owner')).toBeNull();
  });

  it('كل الصلاحيات معرفة لدور واحد على الأقل وبأدوار صحيحة', () => {
    for (const [perm, roles] of Object.entries(PERMISSIONS)) {
      expect(roles.length).toBeGreaterThan(0);
      for (const r of roles) expect(['owner', 'manager', 'cashier', 'doctor', 'nurse', 'customer']).toContain(r);
      expect(perm).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
    }
  });
});
