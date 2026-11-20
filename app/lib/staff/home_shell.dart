import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../core/session.dart';
import '../core/theme.dart';
import 'cashier/cashier_home.dart';
import 'doctor/doctor_home.dart';
import 'login_page.dart';
import 'manager/manager_home.dart';
import 'nurse/nurse_home.dart';
import 'owner/owner_home.dart';

/// يوجه كل موظف لواجهة دوره.
class HomeShell extends StatelessWidget {
  const HomeShell({super.key, required this.user});
  final StaffUser user;
  @override
  Widget build(BuildContext context) {
    return switch (user.role) {
      'cashier' => const CashierHome(),
      'nurse' => const NurseHome(),
      'doctor' => const DoctorHome(),
      'manager' => const ManagerHome(),
      'owner' => const OwnerHome(),
      _ => Scaffold(appBar: staffBar(context, 'غير مدعوم'), body: const Center(child: Text('هذا الدور ما عنده واجهة بهذا التطبيق'))),
    };
  }
}

/// شريط علوي موحّد: العنوان واسم الموظف وقائمة (تغيير الرمز، خروج).
AppBar staffBar(BuildContext context, String title, {List<Widget> actions = const [], PreferredSizeWidget? bottom, bool showMenu = true}) {
  final u = context.read<Session>().user;
  return AppBar(
    title: Text(title),
    bottom: bottom,
    actions: [
      ...actions,
      if (showMenu && u != null)
        PopupMenuButton<String>(
          tooltip: 'الحساب',
          onSelected: (v) async {
            if (v == 'password') { Navigator.of(context).push(MaterialPageRoute(builder: (_) => const ChangePasswordPage())); }
            if (v == 'logout') { await context.read<Session>().logout(); }
          },
          itemBuilder: (_) => [
            PopupMenuItem(enabled: false, child: Text('${u.fullName} · ${roleName(u.role)}', style: const TextStyle(color: Palette.muted))),
            const PopupMenuItem(value: 'password', child: Text('تغيير الرمز السري')),
            const PopupMenuItem(value: 'logout', child: Text('تسجيل الخروج')),
          ],
          child: Padding(padding: const EdgeInsets.symmetric(horizontal: 12), child: Row(mainAxisSize: MainAxisSize.min, children: [const Icon(Icons.account_circle_outlined), const SizedBox(width: 6), Text(u.fullName), const Icon(Icons.arrow_drop_down)])),
        ),
    ],
  );
}
