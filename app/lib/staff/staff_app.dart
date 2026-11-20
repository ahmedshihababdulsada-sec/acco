import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../core/api.dart';
import '../core/config.dart';
import '../core/session.dart';
import '../core/theme.dart';
import 'home_shell.dart';
import 'login_page.dart';

/// تطبيق الموظفين (كاشير، طبيب، ممرض، مدير، مالك): نفس الكود، والواجهة حسب الدور.
class StaffApp extends StatefulWidget {
  const StaffApp({super.key, this.api});
  final Api? api;
  @override
  State<StaffApp> createState() => _StaffAppState();
}

class _StaffAppState extends State<StaffApp> {
  late final Api api = widget.api ?? Api(baseUrl: apiUrl, store: PrefsTokenStore('staff'));
  late final Session session = Session(api);

  @override
  void initState() {
    super.initState();
    session.restore();
  }

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [ChangeNotifierProvider.value(value: api), ChangeNotifierProvider.value(value: session)],
      child: MaterialApp(
        title: 'نظام مركز التجميل',
        debugShowCheckedModeBanner: false,
        theme: buildTheme(),
        locale: const Locale('ar'),
        supportedLocales: const [Locale('ar')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: const _Gate(),
      ),
    );
  }
}

class _Gate extends StatelessWidget {
  const _Gate();
  @override
  Widget build(BuildContext context) {
    final s = context.watch<Session>();
    if (s.restoring) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    final u = s.user;
    if (u == null) return const LoginPage();
    if (u.mustChangePassword) return const ChangePasswordPage(forced: true);
    return HomeShell(user: u);
  }
}
