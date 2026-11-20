import 'dart:convert';

import 'package:clinic_app/core/api.dart';
import 'package:clinic_app/customer/customer_app.dart';
import 'package:clinic_app/staff/manager/sections_ops.dart' show BackupStatusCard;
import 'package:material_ui/material_ui.dart' show MaterialApp, Scaffold, SingleChildScrollView;
import 'package:clinic_app/staff/staff_app.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

http.Response j(Object body, [int status = 200]) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json; charset=utf-8'});

Future<void> settle(WidgetTester t) async { for (var i = 0; i < 6; i++) { await t.pump(const Duration(milliseconds: 80)); } }

Future<void> typeInto(WidgetTester t, int fieldIndex, String text) async {
  await t.enterText(find.byType(EditableText).at(fieldIndex), text);
  await t.pump();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('staff login', () {
    testWidgets('wrong password shows the server message and stays on login', (t) async {
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async => req.url.path == '/auth/login' ? j({'code': 'INVALID_CREDENTIALS', 'message': 'اسم المستخدم أو الرمز غلط'}, 401) : j({}, 404)));
      await t.pumpWidget(StaffApp(api: api));
      await settle(t);
      expect(find.text('تسجيل دخول الموظفين'), findsOneWidget);
      await typeInto(t, 0, 'cashier'); await typeInto(t, 1, 'bad');
      await t.tap(find.text('دخول')); await settle(t);
      expect(find.text('اسم المستخدم أو الرمز غلط'), findsOneWidget);
      expect(find.text('تسجيل دخول الموظفين'), findsOneWidget);
    });

    testWidgets('empty fields are rejected locally without calling the server', (t) async {
      var calls = 0;
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async { calls++; return j({}); }));
      await t.pumpWidget(StaffApp(api: api)); await settle(t);
      await t.tap(find.text('دخول')); await settle(t);
      expect(find.text('اكتب اسم المستخدم والرمز السري'), findsOneWidget);
      expect(calls, 0);
    });

    testWidgets('owner is sent to the TOTP step', (t) async {
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async => req.url.path == '/auth/login' ? j({'status': 'totp_required', 'mode': 'verify', 'challenge_token': 'c'}) : j({}, 404)));
      await t.pumpWidget(StaffApp(api: api)); await settle(t);
      await typeInto(t, 0, 'owner'); await typeInto(t, 1, 'pw');
      await t.tap(find.text('دخول')); await settle(t);
      expect(find.text('رمز التحقق'), findsOneWidget);
      expect(find.text('اكتب الرمز من تطبيق المصادقة'), findsOneWidget);
    });

    testWidgets('manager login lands on the admin shell with all sections', (t) async {
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async {
        switch (req.url.path) {
          case '/auth/login': return j({'status': 'authenticated', 'access_token': 'a', 'refresh_token': 'r', 'user': {'id': 2, 'username': 'manager', 'full_name': 'أحمد', 'role': 'manager', 'branch_id': 1, 'must_change_password': false}});
          case '/branches': return j({'branches': [{'id': 1, 'code': 'D', 'name': 'الفرع'}]});
          case '/discount-requests': return j({'requests': []});
          case '/shifts': return j([]);
          case '/stock/alerts': return j({'counts': {'total': 0}, 'low': [], 'near_expiry': [], 'expired': [], 'negative': []});
          case '/sessions/follow-up': return j({'paid_not_executed': [], 'awaiting_booking': []});
          case '/safe/withdrawals': return j([]);
          case '/safe': return j({'balance': 1500000});
        }
        return j({}, 404);
      }));
      await t.binding.setSurfaceSize(const Size(1200, 900));
      addTearDown(() => t.binding.setSurfaceSize(null));
      await t.pumpWidget(StaffApp(api: api)); await settle(t);
      await typeInto(t, 0, 'manager'); await typeInto(t, 1, 'pw');
      await t.tap(find.text('دخول')); await settle(t); await settle(t);
      for (final s in ['المخزون', 'الموردين', 'المصاريف', 'الموظفين', 'الرواتب', 'الدوام والعطل', 'الخدمات والأسعار', 'الإعدادات']) {
        expect(find.text(s), findsOneWidget, reason: s);
      }
      expect(find.text('التقارير'), findsNothing); // المدير ما يشوف التقارير
      expect(find.text('1,500,000 د.ع'), findsOneWidget);
    });
  });

  group('بطاقة النسخ الاحتياطي', () {
    Widget host(Map<String, dynamic> h) => MaterialApp(home: Scaffold(body: SingleChildScrollView(child: BackupStatusCard(health: h))));
    Map<String, dynamic> health({bool ok = true, List<Map<String, dynamic>> problems = const [], bool configured = true, String? base}) => {'configured': configured, 'ok': ok, 'problems': problems, 'base_last_ok_at': base, 'wal_last_run_at': DateTime.now().toIso8601String(), 'uploads_last_ok_at': null, 'verify_last_ok_at': null, 'wal_spool_files': 0};
    testWidgets('سليم: شارة خضراء وأوقات آخر نسخة', (t) async {
      await t.pumpWidget(host(health(base: DateTime.now().subtract(const Duration(hours: 5)).toIso8601String())));
      expect(find.text('سليم'), findsOneWidget); expect(find.text('قبل 5 ساعة'), findsOneWidget); expect(find.text('هسه'), findsOneWidget); expect(find.text('ما انعملت'), findsNWidgets(2));
    });
    testWidgets('مشكلة: تظهر برسالتها العربية وشارة «يحتاج انتباه»', (t) async {
      await t.pumpWidget(host(health(ok: false, problems: [{'level': 'error', 'code': 'BASE_STALE', 'message': 'آخر نسخة كاملة ناجحة قبل 30 ساعة'}])));
      expect(find.text('يحتاج انتباه'), findsOneWidget); expect(find.text('آخر نسخة كاملة ناجحة قبل 30 ساعة'), findsOneWidget);
    });
    testWidgets('تحذير فقط: سليم مع تنبيه', (t) async {
      await t.pumpWidget(host(health(problems: [{'level': 'warn', 'code': 'VERIFY_STALE', 'message': 'آخر تجربة استرجاع ناجحة قبل 40 يوم'}])));
      expect(find.text('سليم مع تنبيه'), findsOneWidget);
    });
    testWidgets('غير مضبوط: رسالة المشكلة بدون أوقات', (t) async {
      await t.pumpWidget(host(health(ok: false, configured: false, problems: [{'level': 'error', 'code': 'NOT_CONFIGURED', 'message': 'النسخ الاحتياطي غير مضبوط على هذا السيرفر'}])));
      expect(find.text('النسخ الاحتياطي غير مضبوط على هذا السيرفر'), findsOneWidget); expect(find.text('آخر نسخة كاملة'), findsNothing);
    });
  });

  group('withdrawals', () {
    Api mgrApi(List<String> posted, {int recordedBy = 2}) => Api(baseUrl: 'http://x', client: MockClient((req) async {
          switch (req.url.path) {
            case '/auth/login': return j({'status': 'authenticated', 'access_token': 'a', 'refresh_token': 'r', 'user': {'id': 2, 'username': 'manager', 'full_name': 'أحمد', 'role': 'manager', 'branch_id': 1, 'must_change_password': false}});
            case '/branches': return j({'branches': [{'id': 1, 'code': 'D', 'name': 'الفرع'}]});
            case '/discount-requests': return j({'requests': []});
            case '/shifts': return j([]);
            case '/stock/alerts': return j({'counts': {'total': 0}, 'low': [], 'near_expiry': [], 'expired': [], 'negative': []});
            case '/sessions/follow-up': return j({'paid_not_executed': [], 'awaiting_booking': []});
            case '/safe': return j({'balance': 1500000});
            case '/safe/withdrawals':
              return j([{'id': 9, 'amount': 200000, 'withdrawn_by_name': 'المالك', 'withdrawal_date': '2026-11-14', 'note': null, 'status': 'pending', 'recorded_by': {'id': recordedBy, 'full_name': 'م'}}]);
          }
          if (req.method == 'POST') { posted.add(req.url.path); return j({'id': 9, 'status': 'cancelled'}); }
          return j({}, 404);
        }));

    Future<void> openWithdrawals(WidgetTester t, Api api) async {
      await t.binding.setSurfaceSize(const Size(1200, 900));
      addTearDown(() => t.binding.setSurfaceSize(null));
      await t.pumpWidget(StaffApp(api: api)); await settle(t);
      await typeInto(t, 0, 'manager'); await typeInto(t, 1, 'pw');
      await t.tap(find.text('دخول')); await settle(t); await settle(t);
      await t.tap(find.text('الشفتات والخزنة')); await settle(t);
      await t.tap(find.text('سحب المالك')); await settle(t); await settle(t);
    }

    testWidgets('manager can cancel only his own pending request', (t) async {
      final posted = <String>[];
      await openWithdrawals(t, mgrApi(posted));
      expect(find.text('إلغاء الطلب'), findsOneWidget);
      await t.tap(find.text('إلغاء الطلب')); await settle(t);
      await t.tap(find.text('إلغاء الطلب').last); await settle(t); await settle(t);
      expect(posted, ['/safe/withdrawals/9/cancel']);
    });

    testWidgets('a request recorded by another manager shows no cancel button', (t) async {
      await openWithdrawals(t, mgrApi(<String>[], recordedBy: 77));
      expect(find.text('بانتظار موافقة المالك'), findsOneWidget);
      expect(find.text('إلغاء الطلب'), findsNothing);
    });
  });

  group('nurse', () {
    testWidgets('completing a session posts the server session_id and shows the result', (t) async {
      final posted = <String>[];
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async {
        switch (req.url.path) {
          case '/auth/login': return j({'status': 'authenticated', 'access_token': 'a', 'refresh_token': 'r', 'user': {'id': 4, 'username': 'nurse', 'full_name': 'ريم', 'role': 'nurse', 'branch_id': 1, 'must_change_password': false}});
          case '/nurse/queue': return j({'date': '2026-11-14', 'sessions': [{'session_id': 41, 'seq_no': 1, 'of': 6, 'service_name': 'ليزر', 'visit_seq_no': 5, 'customer': {'id': 8, 'full_name': 'احمد', 'public_code': 'FB7NW2GV'}, 'has_health_alert': false, 'health': null, 'planned_materials': []}]});
        }
        if (req.method == 'POST') { posted.add(req.url.path); return j({'shortages': []}); }
        return j({}, 404);
      }));
      await t.pumpWidget(StaffApp(api: api)); await settle(t);
      await typeInto(t, 0, 'nurse'); await typeInto(t, 1, 'pw');
      await t.tap(find.text('دخول')); await settle(t); await settle(t);
      expect(find.text('صورة قبل'), findsOneWidget);
      expect(find.text('صورة بعد'), findsOneWidget);
      await t.tap(find.text('اكتملت الجلسة')); await settle(t);
      await t.tap(find.text('اكتملت')); await settle(t); await settle(t);
      expect(posted, ['/sessions/41/complete']);
      expect(find.text('اكتملت الجلسة'), findsWidgets);
    });
  });

  group('customer login', () {
    Api build(Future<http.Response> Function(http.Request) h) => Api(baseUrl: 'http://x', refreshPath: '/customer/auth/refresh', client: MockClient(h));
    final profile = {'id': 7, 'branch': {'id': 1, 'name': 'الفرع'}, 'public_code': 'NUE6WQWB', 'phone': '+9647701234567', 'full_name': 'زبونة', 'gender': null, 'birth_date': null, 'points_balance': 0, 'notify_offers': true};

    testWidgets('OTP flow: first-time customer is asked for a name, then lands on home', (t) async {
      var verifyCalls = 0;
      final api = build((req) async {
        switch (req.url.path) {
          case '/customer/auth/request-otp': return j({'sent': true, 'expires_in': 300, 'resend_after': 60});
          case '/customer/auth/verify-otp':
            verifyCalls++;
            final body = jsonDecode(req.body) as Map;
            if (body['full_name'] == null) return j({'code': 'NAME_REQUIRED', 'message': 'اكتب اسمك للتسجيل'}, 400);
            return j({'access_token': 'a', 'refresh_token': 'r', 'customer': profile, 'is_new': true});
          case '/customer/bookings': return j({'bookings': []});
          case '/customer/offers': return j({'offers': []});
          case '/customer/points': return j({'balance': 0, 'entries': []});
          case '/customer/notifications': return j({'notifications': []});
        }
        return j({}, 404);
      });
      await t.pumpWidget(CustomerApp(api: api)); await settle(t);
      expect(find.text('إرسال الرمز'), findsOneWidget);
      await typeInto(t, 0, '07701234567');
      await t.tap(find.text('إرسال الرمز')); await settle(t);
      expect(find.text('دخول'), findsOneWidget);
      await typeInto(t, 1, '123456');
      await t.tap(find.text('دخول')); await settle(t);
      expect(find.text('اكتب اسمك للتسجيل'), findsWidgets); // toast + (field label appears too)
      expect(find.text('اسمك (للتسجيل أول مرة)'), findsOneWidget);
      await typeInto(t, 2, 'زبونة');
      await t.tap(find.text('دخول')); await settle(t); await settle(t);
      expect(verifyCalls, 2);
      expect(find.text('أهلاً زبونة'), findsOneWidget);
      expect(find.text('رصيد نقاطك'), findsOneWidget);
    });

    testWidgets('privacy policy opens from the login page', (t) async {
      final api = build((req) async => j({}, 404));
      await t.binding.setSurfaceSize(const Size(800, 2400));
      addTearDown(() => t.binding.setSurfaceSize(null));
      await t.pumpWidget(CustomerApp(api: api)); await settle(t);
      await t.tap(find.text('سياسة الخصوصية')); await settle(t);
      expect(find.text('شنو نجمع'), findsOneWidget);
      expect(find.text('حقوقك'), findsOneWidget);
    });

    testWidgets('short phone numbers are rejected locally', (t) async {
      var calls = 0;
      final api = build((req) async { calls++; return j({}); });
      await t.pumpWidget(CustomerApp(api: api)); await settle(t);
      await typeInto(t, 0, '0770');
      await t.tap(find.text('إرسال الرمز')); await settle(t);
      expect(find.text('اكتب رقم التلفون كامل'), findsOneWidget);
      expect(calls, 0);
    });

    testWidgets('wrong code shows the remaining attempts message and stays on the code step', (t) async {
      final api = build((req) async => req.url.path == '/customer/auth/request-otp' ? j({'sent': true, 'resend_after': 60}) : j({'code': 'INVALID_CODE', 'message': 'الرمز غلط: باقي 4 محاولات'}, 400));
      await t.pumpWidget(CustomerApp(api: api)); await settle(t);
      await typeInto(t, 0, '07701234567');
      await t.tap(find.text('إرسال الرمز')); await settle(t);
      await typeInto(t, 1, '000000');
      await t.tap(find.text('دخول')); await settle(t);
      expect(find.text('الرمز غلط: باقي 4 محاولات'), findsOneWidget);
      expect(find.text('دخول'), findsOneWidget);
      await t.pumpWidget(const SizedBox()); // يفرّغ المؤقت
    });
  });
}
