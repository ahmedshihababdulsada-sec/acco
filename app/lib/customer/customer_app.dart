import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../core/api.dart';
import '../core/config.dart';
import '../core/theme.dart';
import 'customer_home.dart';
import 'customer_login.dart';
import 'customer_session.dart';

/// تطبيق الزبون: حجز ومواعيد وجلسات ومدفوعات ونقاط وعروض وإشعارات.
class CustomerApp extends StatefulWidget {
  const CustomerApp({super.key, this.api});
  final Api? api;
  @override
  State<CustomerApp> createState() => _CustomerAppState();
}

class _CustomerAppState extends State<CustomerApp> {
  late final Api api = widget.api ?? Api(baseUrl: apiUrl, store: PrefsTokenStore('customer'), refreshPath: '/customer/auth/refresh');
  late final CustomerSession session = CustomerSession(api);

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
        title: 'مركز التجميل',
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
    final s = context.watch<CustomerSession>();
    if (s.restoring) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    if (s.profile == null) return const CustomerLoginPage();
    return const CustomerHome();
  }
}
