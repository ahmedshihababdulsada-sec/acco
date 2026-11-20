import 'dart:convert';

import 'package:clinic_app/core/api.dart';
import 'package:clinic_app/customer/customer_home.dart';
import 'package:clinic_app/customer/customer_session.dart';
import 'package:clinic_app/staff/cashier/cashier_home.dart';
import 'package:clinic_app/staff/cashier/cashier_state.dart';
import 'package:clinic_app/staff/cashier/customer_panel.dart';
import 'package:clinic_app/staff/cashier/receipts_page.dart';
import 'cashier_receipt_test.dart' show dayReceipt;
import 'package:clinic_app/staff/cashier/dialogs.dart';
import 'package:clinic_app/staff/doctor/doctor_home.dart';
import 'package:clinic_app/staff/manager/admin_shell.dart';
import 'package:clinic_app/staff/manager/sections_ops.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';
import 'package:clinic_app/core/format.dart';
import 'package:clinic_app/core/session.dart';

http.Response j(Object b, [int s = 200]) => http.Response(jsonEncode(b), s, headers: {'content-type': 'application/json; charset=utf-8'});
Future<void> settle(WidgetTester t) async { for (var i = 0; i < 8; i++) { await t.pump(const Duration(milliseconds: 80)); } }

Map<String, dynamic> day(String date, {bool bookable = true, bool stopped = false}) => {
      'date': date, 'weekday': 1, 'clinic_open': true, 'closed_reason': null, 'holiday': null, 'doctor': {'works': true, 'start_time': '09:00', 'end_time': '13:00', 'day_off': null},
      'used_slots': 5, 'remaining': 20, 'bookable': bookable, 'stopped': stopped, 'customer_visit': null,
    };

void main() {
  Widget host(Api api, Widget child) => ChangeNotifierProvider<Api>.value(value: api, child: MaterialApp(home: child));
  /// واجهات الموظفين تحتاج Api وSession (شريط الأعلى)
  Widget staffHost(Api api, Widget child) => MultiProvider(providers: [ChangeNotifierProvider<Api>.value(value: api), ChangeNotifierProvider<Session>.value(value: Session(api)..user = StaffUser(id: 1, username: 'u', fullName: 'موظف', role: 'cashier', branchId: 1, mustChangePassword: false))], child: MaterialApp(home: child));
  Future<void> big(WidgetTester t) async { await t.binding.setSurfaceSize(const Size(1000, 1600)); addTearDown(() => t.binding.setSurfaceSize(null)); }

  group('حجز الزبون: نوع افتراضي، خدمة، ملاحظة، يوم موقوف', () {
    late List<Map<String, dynamic>> posts;
    Api build({bool first = true, bool stoppedDay = false}) {
      posts = [];
      return Api(baseUrl: 'http://x', client: MockClient((req) async {
        if (req.url.path == '/customer/doctors') return j({'sessions_only_fee': 0, 'is_first_time': first, 'services': [{'id': 31, 'name': 'ليزر'}, {'id': 32, 'name': 'بوتوكس'}], 'doctors': [{'id': 5, 'full_name': 'د. سارة', 'title': null}]});
        if (req.url.path == '/customer/availability') return j({'branch_id': 1, 'daily_limit': 25, 'days': [day('2026-11-20'), day('2026-11-21', bookable: !stoppedDay, stopped: stoppedDay)]});
        if (req.url.path == '/customer/bookings' && req.method == 'POST') { posts.add(jsonDecode(req.body) as Map<String, dynamic>); return j({'id': 1}, 201); }
        return j({}, 404);
      }));
    }
    Future<void> open(WidgetTester t, Api api) async { await big(t); await t.pumpWidget(host(api, const NewBookingPage())); await settle(t); }

    testWidgets('زبون جديد: «كشفية» افتراضي، بدون تلميح الراجع، ويرسل الخدمة والملاحظة المقصوصة', (t) async {
      final api = build(); await open(t, api);
      expect(find.byKey(const ValueKey('returning-hint')), findsNothing);
      await t.tap(find.byKey(const ValueKey('interest-service'))); await settle(t);
      await t.tap(find.text('بوتوكس').last); await settle(t);
      await t.enterText(find.byKey(const ValueKey('booking-note')), '  عندي حساسية  '); await settle(t);
      await t.tap(find.text('متاح: 20 موعد').first); await settle(t);
      await t.tap(find.text('احجز')); await settle(t); await settle(t);
      expect(posts, [{'doctor_id': 5, 'date': '2026-11-20', 'type': 'standard', 'service_id': 32, 'note': 'عندي حساسية'}]);
    });

    testWidgets('بدون خدمة وملاحظة: ما يرسلهم', (t) async {
      final api = build(); await open(t, api);
      await t.tap(find.text('متاح: 20 موعد').first); await settle(t);
      await t.tap(find.text('احجز')); await settle(t); await settle(t);
      expect(posts.single.containsKey('service_id'), false); expect(posts.single.containsKey('note'), false);
    });

    testWidgets('زبون راجع: «جلسات فقط» افتراضي مع التلميح، ويقدر يرجع للكشفية', (t) async {
      final api = build(first: false); await open(t, api);
      expect(find.byKey(const ValueKey('returning-hint')), findsOneWidget);
      await t.tap(find.text('متاح: 20 موعد').first); await settle(t);
      await t.tap(find.text('احجز')); await settle(t); await settle(t);
      expect(posts.single['type'], 'sessions_only');
      await t.pumpWidget(const SizedBox()); await open(t, api);                                   // الصفحة تسكّرت بعد الحجز: نفتحها من جديد ونغيّر النوع
      await t.tap(find.byKey(const ValueKey('type-standard'))); await settle(t);
      await t.tap(find.text('متاح: 20 موعد').first); await settle(t);
      await t.tap(find.text('احجز')); await settle(t); await settle(t);
      expect(posts.last['type'], 'standard');
    });

    testWidgets('اليوم الموقوف: يبين السبب وما ينضغط', (t) async {
      final api = build(stoppedDay: true); await open(t, api);
      expect(find.text('الحجز موقوف هذا اليوم'), findsOneWidget);
      await t.tap(find.text('الحجز موقوف هذا اليوم')); await settle(t);
      expect(find.text('احجز'), findsNothing); expect(posts, isEmpty);
    });
  });

  group('رقم الدور عند الزبون', () {
    Map<String, dynamic> b(int id, {Map<String, dynamic>? turn}) => {'id': id, 'date': todayIso(), 'seq_no': 7, 'status': 'arrived', 'kind': 'consultation', 'doctor_name': 'د. سارة', 'consultation_status': 'paid', 'sessions_count': 0, 'changeable': false, 'cancellable': false, 'turn': turn};
    Future<void> show(WidgetTester t, List<Map<String, dynamic>> list) async {
      await big(t);
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async => req.url.path == '/customer/bookings' ? j({'bookings': list}) : j({}, 404)));
      await t.pumpWidget(host(api, const Scaffold(body: BookingsTab()))); await settle(t);
    }
    testWidgets('يبين رقمه وكم حاضر قدامه', (t) async {
      await show(t, [b(1, turn: {'seq_no': 7, 'ahead': 3})]);
      expect(find.text('رقمك 7'), findsOneWidget); expect(find.text('حاضرين قدامك: 3'), findsOneWidget);
    });
    testWidgets('الحجز المنتهية: يبين «انتهت» بقائمة المواعيد، وما يطلع «موعدك القادم» بالرئيسية', (t) async {
      await show(t, [{...b(1), 'finished': true, 'turn': null}]);
      expect(find.text('انتهت'), findsOneWidget); expect(find.text('حضرت'), findsNothing);
      await t.pumpWidget(const SizedBox());
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async {
        switch (req.url.path) {
          case '/customer/bookings': return j({'bookings': [{...b(1), 'finished': true, 'turn': null}]});
          case '/customer/offers': return j({'offers': []});
          case '/customer/points': return j({'balance': 0, 'entries': []});
          case '/customer/notifications': return j({'notifications': []});
        }
        return j({}, 404);
      }));
      final session = CustomerSession(api)..profile = {'full_name': 'منى'};
      await t.pumpWidget(MultiProvider(providers: [ChangeNotifierProvider<Api>.value(value: api), ChangeNotifierProvider<CustomerSession>.value(value: session)], child: MaterialApp(home: Scaffold(body: HomeTab(onGo: (_) {}))))); await settle(t);
      expect(find.text('ما عندك موعد قادم'), findsOneWidget);
    });
    testWidgets('ما أكو أحد قدامه، وحجز مو اليوم بدون سطر', (t) async {
      await show(t, [b(1, turn: {'seq_no': 7, 'ahead': 0}), b(2)]);
      expect(find.text('ما أكو أحد حاضر قدامك'), findsOneWidget); expect(find.byKey(const ValueKey('turn-ahead')), findsOneWidget);
    });
  });

  group('الكاشير: كشفيات وجلسات', () {
    Map<String, dynamic> visit(int seq, String name, String phase, {Map<String, dynamic>? cons, List<Map<String, dynamic>> sessions = const [], String status = 'arrived'}) => {
          'id': seq, 'seq_no': seq, 'status': status, 'phase': phase, 'customer': {'id': 100 + seq, 'full_name': name, 'public_code': 'C-$seq'}, 'doctor': cons == null ? null : {'id': 5, 'full_name': 'د. سارة'},
          'consultation': cons, 'sessions': sessions,
        };
    Future<void> openCashier(WidgetTester t, List<Map<String, dynamic>> queue, {bool stopped = false}) async {
      await big(t);
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async {
        if (req.url.path == '/shifts/current') return j({'id': 1, 'receipts_count': 0});
        if (req.url.path == '/bookings') return j({'bookings': queue, 'day': {'used_slots': queue.length, 'daily_limit': 30, 'stopped': stopped}});
        return j({}, 404);
      }));
      await t.pumpWidget(staffHost(api, const CashierHome())); await settle(t);
    }

    testWidgets('كل خانة بعنوانها وعددها، الكشفية قبل الجلسات، وملاحظة الزبون والجلسات تبين', (t) async {
      await openCashier(t, [
        visit(1, 'سارة الجديدة', 'consultation', cons: {'id': 1, 'kind': 'new', 'status': 'paid', 'note': 'عندي حساسية', 'interest': {'id': 3, 'name': 'بوتوكس'}}),
        visit(2, 'نور الراجعة', 'sessions', sessions: [{'id': 9, 'service_name': 'ليزر', 'seq_no': 3, 'of': 6, 'status': 'booked'}, {'id': 10, 'service_name': 'بوتوكس', 'seq_no': 1, 'of': 2, 'status': 'paid'}]),
        visit(3, 'هدى بعد الكشفية', 'sessions', cons: {'id': 3, 'kind': 'new', 'status': 'finished', 'note': null, 'interest': null}, sessions: [{'id': 11, 'service_name': 'ليزر', 'seq_no': 1, 'of': 4, 'status': 'booked'}]),
      ]);
      expect(find.byKey(const ValueKey('queue-consultations')), findsOneWidget); expect(find.byKey(const ValueKey('queue-sessions')), findsOneWidget);
      final consY = t.getTopLeft(find.byKey(const ValueKey('queue-consultations'))).dy; final sessY = t.getTopLeft(find.byKey(const ValueKey('queue-sessions'))).dy;
      expect(consY < sessY, true);
      expect(t.getTopLeft(find.text('سارة الجديدة')).dy < sessY, true);
      expect(t.getTopLeft(find.text('نور الراجعة')).dy > sessY, true); expect(t.getTopLeft(find.text('هدى بعد الكشفية')).dy > sessY, true);   // بعد الكشفية تنتقل للجلسات
      expect(find.textContaining('يريد بوتوكس'), findsOneWidget); expect(find.textContaining('عندي حساسية'), findsOneWidget);
      expect(find.text('ليزر · جلسة 3 من 6'), findsOneWidget); expect(find.text('بوتوكس · جلسة 1 من 2 · مدفوعة'), findsOneWidget);
      expect(find.text('نور الراجعة'), findsOneWidget);                                       // زبون الجلسات كارت واحد بكل جلساته
    });

    testWidgets('خانة فاضية ما تظهر، والحجز الموقوف يبين علامة', (t) async {
      await openCashier(t, [visit(1, 'سارة', 'consultation', cons: {'id': 1, 'kind': 'new', 'status': 'awaiting_payment', 'note': null, 'interest': null}, status: 'booked')], stopped: true);
      expect(find.byKey(const ValueKey('queue-sessions')), findsNothing); expect(find.byKey(const ValueKey('queue-consultations')), findsOneWidget);
      expect(find.text('الحجز موقوف'), findsOneWidget);
    });
  });

  group('حجز الكاشير: افتراضي الراجع، خدمة وملاحظة', () {
    testWidgets('زبون راجع: «جلسات فقط» افتراضي مع تلميح، والخدمة والملاحظة تنرسل', (t) async {
      await big(t); final posts = <Map<String, dynamic>>[];
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async {
        if (req.url.path == '/schedule/doctors') return j({'doctors': [{'id': 5, 'full_name': 'د. ليزر'}]});
        if (req.url.path == '/services') return j([{'id': 31, 'name_ar': 'ليزر', 'kind': 'treatment', 'is_active': true}, {'id': 1, 'name_ar': 'كشفية', 'kind': 'consultation', 'is_active': true}]);
        if (req.url.path == '/bookings' && req.method == 'POST') { posts.add(jsonDecode(req.body) as Map<String, dynamic>); return j({'id': 1}, 201); }
        return j({}, 404);
      }));
      await t.pumpWidget(host(api, Builder(builder: (c) => Scaffold(body: FilledButton(onPressed: () => bookingDialog(c, 9, returning: true), child: const Text('حجز'))))));
      await t.tap(find.text('حجز')); await settle(t);
      expect(find.byKey(const ValueKey('returning-hint')), findsOneWidget);
      await t.tap(find.byKey(const ValueKey('interest-service'))); await settle(t);
      expect(find.text('كشفية'), findsNothing);                                                 // خدمة الكشفية مو خيار
      await t.tap(find.text('ليزر').last); await settle(t);
      await t.enterText(find.byKey(const ValueKey('booking-note')), 'جلسة متابعة'); await settle(t);
      await t.tap(find.text('حجز').last); await settle(t); await settle(t);
      expect(posts.single, {'customer_id': 9, 'doctor_id': 5, 'date': todayIso(), 'type': 'sessions_only', 'service_id': 31, 'note': 'جلسة متابعة'});
    });
  });

  group('الطبيب والمدير', () {
    testWidgets('قائمة الطبيب تبين الخدمة المطلوبة وملاحظة الزبون', (t) async {
      await big(t);
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async => req.url.path == '/doctor/queue' ? j({'date': todayIso(), 'waiting': 1, 'queue': [
        {'consultation_id': 1, 'visit_id': 1, 'seq_no': 4, 'kind': 'sessions_only', 'status': 'paid', 'booking_note': 'أريد بوتوكس للجبهة', 'interest_name': 'بوتوكس', 'customer': {'id': 5, 'full_name': 'ليلى', 'public_code': 'C-5'}, 'has_health_alert': false},
      ]}) : j({}, 404)));
      await t.pumpWidget(staffHost(api, const DoctorHome())); await settle(t);
      expect(find.textContaining('يريد بوتوكس'), findsOneWidget); expect(find.text('ملاحظة: أريد بوتوكس للجبهة'), findsOneWidget);
    });

    testWidgets('المدير يوقف الحجز بسبب ثم يستأنفه', (t) async {
      await big(t); final calls = <String>[]; var stopped = false;
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async {
        calls.add('${req.method} ${req.url.path} ${req.body}');
        if (req.url.path == '/bookings' && req.method == 'GET') return j({'bookings': [], 'day': {'used_slots': 0, 'daily_limit': 30, 'stopped': stopped, 'stop_reason': stopped ? 'زحمة' : null}});
        if (req.url.path == '/sessions/follow-up') return j({'paid_not_executed': [], 'awaiting_booking': []});
        if (req.url.path == '/bookings/follow-up') return j({'moved': [], 'stuck': [], 'unserved': [{'id': 8, 'date': '2026-11-10', 'seq_no': 2, 'customer': {'id': 5, 'full_name': 'منى المنتظرة', 'phone': '07701234567'}}]});
        if (req.url.path.endsWith('/stop')) { stopped = true; return j({'stopped': true}); }
        if (req.url.path.endsWith('/resume')) { stopped = false; return j({'stopped': false}); }
        return j({}, 404);
      }));
      final scope = BranchScope(api, false);
      await t.pumpWidget(ChangeNotifierProvider<Api>.value(value: api, child: ChangeNotifierProvider<BranchScope>.value(value: scope, child: const MaterialApp(home: Scaffold(body: BookingsSection())))));
      await settle(t);
      expect(find.text('الحجز مفتوح لهذا اليوم'), findsOneWidget);
      expect(find.textContaining('منى المنتظرة'), findsOneWidget); expect(find.textContaining('وما انخدم ولا لگينا له يوم'), findsOneWidget);   // مدفوعة وما انخدمت: الكاشير يتصل
      await t.tap(find.text('إيقاف الحجز')); await settle(t);
      await t.enterText(find.byType(TextField).last, 'زحمة'); await settle(t);
      await t.tap(find.text('حفظ').evaluate().isNotEmpty ? find.text('حفظ') : find.text('تأكيد')); await settle(t); await settle(t);
      expect(calls.any((c) => c.startsWith('POST /bookings/days/${todayIso()}/stop') && c.contains('"reason":"زحمة"')), true);
      expect(find.text('الحجز موقوف لهذا اليوم'), findsOneWidget);
      await t.tap(find.text('استئناف الحجز')); await settle(t); await settle(t);
      expect(calls.any((c) => c.startsWith('POST /bookings/days/${todayIso()}/resume')), true);
      expect(find.text('الحجز مفتوح لهذا اليوم'), findsOneWidget);
    });
  });
  group('الكاشير: المنتهية تختفي، وكل كاشير وصولاته', () {
    Map<String, dynamic> v(int seq, String name, {bool done = false, String status = 'arrived', String phase = 'sessions'}) => {
          'id': seq, 'seq_no': seq, 'status': status, 'phase': phase, 'done': done, 'customer': {'id': 100 + seq, 'full_name': name, 'public_code': 'C-$seq'}, 'doctor': null, 'consultation': null, 'sessions': [],
        };
    Api queueApi(List<List<Map<String, dynamic>>> rounds) {
      var i = 0;
      return Api(baseUrl: 'http://x', client: MockClient((req) async {
        if (req.url.path == '/shifts/current') return j({'id': 1, 'receipts_count': 0});
        if (req.url.path == '/bookings') { final q = rounds[i < rounds.length - 1 ? i++ : i]; return j({'bookings': q, 'day': {'used_slots': q.length, 'daily_limit': 30, 'stopped': false}}); }
        return j({}, 404);
      }));
    }

    testWidgets('المنتهية والملغية ما تطلع بالقائمة، وسطر مطوي بعددها يفتحها للطوارئ', (t) async {
      await big(t);
      await t.pumpWidget(staffHost(queueApi([[v(1, 'سارة الفعالة'), v(2, 'نور المنتهية', done: true), v(3, 'هدى الملغية', done: true, status: 'cancelled')]]), const CashierHome())); await settle(t);
      expect(find.text('سارة الفعالة'), findsOneWidget); expect(find.text('نور المنتهية'), findsNothing); expect(find.text('هدى الملغية'), findsNothing);
      expect(find.text('المنتهية والملغية (2)'), findsOneWidget);
      await t.tap(find.byKey(const ValueKey('done-toggle'))); await settle(t);
      expect(find.text('نور المنتهية'), findsOneWidget); expect(find.text('هدى الملغية'), findsOneWidget);
      await t.tap(find.byKey(const ValueKey('done-toggle'))); await settle(t);
      expect(find.text('نور المنتهية'), findsNothing);
    });

    testWidgets('كلهم منتهين: رسالة «ما أكو زبائن بانتظار الكاشير» والسطر المطوي', (t) async {
      await big(t);
      await t.pumpWidget(staffHost(queueApi([[v(1, 'نور المنتهية', done: true)]]), const CashierHome())); await settle(t);
      expect(find.text('ما أكو زبائن بانتظار الكاشير'), findsOneWidget); expect(find.text('المنتهية والملغية (1)'), findsOneWidget);
    });

    test('الزبون اللي خلص شغله: الاختيار يتفرغ بالتحديث. زبون مفتوح بالبحث (ما كان بالقائمة) يبقى', () async {
      final st = CashierState(queueApi([[v(1, 'سارة')], [v(1, 'سارة', done: true)]]));
      await st.refresh(); st.select(101);
      await st.refresh();
      expect(st.selectedCustomerId, isNull);
      final st2 = CashierState(queueApi([[v(1, 'سارة')], [v(1, 'سارة')]]));
      await st2.refresh(); st2.select(555);
      await st2.refresh();
      expect(st2.selectedCustomerId, 555);
      final st3 = CashierState(queueApi([[v(1, 'سارة')], [v(1, 'سارة')]]));
      await st3.refresh(); st3.select(101); await st3.refresh();
      expect(st3.selectedCustomerId, 101);                                                      // لسه عنده شغل: يبقى
    });

    testWidgets('ملف الزبون: زيارة منتهية ما تبين، والوصولات السابقة مطوية بعددها', (t) async {
      await big(t); await t.pumpWidget(const SizedBox());
      final old = {'id': 5, 'receipt_no': '2026-00005', 'net_amount': 10000, 'business_date': '2020-01-01', 'kind': 'sessions', 'status': 'paid', 'print_count': 1, 'customer': {'id': 9}};
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async {
        switch (req.url.path) {
          case '/customers/9': return j({'id': 9, 'full_name': 'زبونة تجربة', 'public_code': 'C-0009', 'phone': '07701234567', 'points_balance': 0});
          case '/customers/9/sessions': return j({'sessions': []});
          case '/bookings': return j({'bookings': [{'id': 1, 'seq_no': 4, 'status': 'arrived', 'done': true, 'doctor': null, 'consultation': {'id': 5, 'status': 'finished', 'kind': 'new'}}]});
          case '/discount-requests': return j({'requests': []});
          case '/payments': return j([old]);
        }
        return j({}, 404);
      }));
      await t.pumpWidget(host(api, Scaffold(body: CustomerPanel(customerId: 9, state: CashierState(api))))); await settle(t);
      expect(find.text('ما عنده حجز فعال اليوم'), findsOneWidget); expect(find.text('رقم 4'), findsNothing);
      expect(find.text(ltr('2026-00005') + ' · ' + money(10000)), findsNothing);
      expect(find.text('وصولات سابقة (1)'), findsOneWidget);
      await t.tap(find.byKey(const ValueKey('older-receipts'))); await settle(t);
      expect(find.textContaining(ltr('2026-00005')), findsOneWidget);
    });

    testWidgets('صفحة الوصولات: مجموع وصولات الكاشير (بعد الاسترجاع)', (t) async {
      await big(t);
      Map<String, dynamic> r(int id, int net, int refunded) => {'id': id, 'receipt_no': '2026-0000$id', 'net_amount': net, 'refunded_total': refunded, 'business_date': todayIso(), 'paid_at': '${todayIso()}T08:30:00.000Z', 'status': refunded > 0 ? 'partially_refunded' : 'paid', 'customer': {'id': 9, 'full_name': 'زبونة'}};
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async => req.url.path == '/payments' ? j([r(1, 30000, 0), r(2, 50000, 10000)]) : j({}, 404)));
      await t.pumpWidget(host(api, const ReceiptsPage())); await settle(t);
      expect(find.text('مجموع وصولاتك (2 وصل)'), findsOneWidget); expect(find.text(money(70000)), findsOneWidget);
    });

    testWidgets('الورقة الجامعة: وصل كاشير ثاني يبان «كاشير ثاني» وما ينفتح، ووصلي ينفتح', (t) async {
      await big(t); final calls = <String>[];
      final dr = dayReceipt();
      dr['payments'] = [{...(dr['payments'] as List)[0] as Map, 'mine': false}, {...(dr['payments'] as List)[1] as Map, 'mine': true}];
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async { calls.add(req.url.path); return req.url.path.endsWith('/day-receipt') ? j(dr) : j({}, 404); }));
      await t.pumpWidget(host(api, ReceiptPage.day(state: CashierState(api), dayCustomerId: 9))); await settle(t);
      expect(find.textContaining('كاشير ثاني'), findsOneWidget);
      await t.tap(find.textContaining(ltr('2026-00001')).last); await settle(t);
      expect(calls.contains('/payments/11'), false);
      await t.tap(find.textContaining(ltr('2026-00002')).last); await settle(t);
      expect(calls.contains('/payments/12'), true);
    });
  });
}
