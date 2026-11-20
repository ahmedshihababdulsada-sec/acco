import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import 'admin_shell.dart';
import 'sections_config.dart';
import 'sections_ops.dart';
import 'sections_people.dart';
import 'sections_stock.dart';

/// الأقسام المشتركة بين المدير والمالك (الخادم يقرر الصلاحيات الدقيقة لكل عملية).
List<AdminSection> commonAdminSections() => [
      AdminSection('الرئيسية', Icons.dashboard_outlined, (c) => OverviewSection(onGo: c.read<AdminNav>().go)),
      AdminSection('الحجوزات', Icons.event_note_outlined, (_) => const BookingsSection()),
      AdminSection('الشفتات والخزنة', Icons.account_balance_wallet_outlined, (_) => const CashSection()),
      AdminSection('طلبات الخصم', Icons.discount_outlined, (_) => const DiscountsSection()),
      AdminSection('العروض', Icons.local_offer_outlined, (_) => const OffersSection()),
      AdminSection('المخزون', Icons.inventory_2_outlined, (_) => const StockSection()),
      AdminSection('الموردين', Icons.local_shipping_outlined, (_) => const SuppliersSection()),
      AdminSection('المصاريف', Icons.receipt_long_outlined, (_) => const ExpensesSection()),
      AdminSection('الموظفين', Icons.badge_outlined, (_) => const StaffSection()),
      AdminSection('الرواتب', Icons.payments_outlined, (_) => const PayrollSection()),
      AdminSection('الدوام والعطل', Icons.calendar_month_outlined, (_) => const ScheduleSection()),
      AdminSection('الخدمات والأسعار', Icons.spa_outlined, (_) => const ServicesSection()),
      AdminSection('الإعدادات', Icons.settings_outlined, (_) => const SettingsSection()),
    ];

class ManagerHome extends StatelessWidget {
  const ManagerHome({super.key});
  @override
  Widget build(BuildContext context) => AdminShell(title: 'المدير', sections: commonAdminSections());
}
