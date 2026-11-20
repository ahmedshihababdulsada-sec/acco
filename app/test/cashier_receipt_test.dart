import 'dart:convert';

import 'package:clinic_app/core/api.dart';
import 'package:clinic_app/core/format.dart';
import 'package:clinic_app/core/receipt/models.dart';
import 'package:clinic_app/staff/cashier/cashier_state.dart';
import 'package:clinic_app/staff/cashier/customer_panel.dart';
import 'package:clinic_app/staff/cashier/dialogs.dart';
import 'package:clinic_app/staff/cashier/payment_page.dart';
import 'package:clinic_app/staff/cashier/receipts_page.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

http.Response j(Object b, [int s = 200]) => http.Response(jsonEncode(b), s, headers: {'content-type': 'application/json; charset=utf-8'});
Future<void> settle(WidgetTester t) async { for (var i = 0; i < 8; i++) { await t.pump(const Duration(milliseconds: 80)); } }

final customer = {'id': 9, 'full_name': 'زبونة تجربة', 'public_code': 'C-0009', 'phone': '07701234567', 'points_balance': 0};

Map<String, dynamic> quote(int net, {String name = 'كشفية'}) => {
      'gross_amount': net, 'offer_discount': 0, 'manual_discount': 0, 'points_discount': 0, 'points_used': 0, 'rounding_amount': 0, 'net_amount': net, 'points_earned': 0,
      'items': [{'service_name': name, 'list_price': net, 'offer_discount': 0, 'offer_percent': null}],
    };

Map<String, dynamic> dayReceipt({int unprinted = 2, bool combined = true}) => {
      'id': 12, 'kind': combined ? 'combined' : 'consultation', 'status': 'paid', 'business_date': todayIso(), 'paid_at': '${todayIso()}T08:30:00.000Z',
      'receipt_no': combined ? '2026-00001 + 2026-00002' : '2026-00001', 'receipt_numbers': combined ? ['2026-00001', '2026-00002'] : ['2026-00001'],
      'customer': {'id': 9, 'full_name': 'زبونة تجربة', 'public_code': 'C-0009'}, 'cashier': {'id': 3, 'full_name': 'كاشير'}, 'clinic': {},
      'gross_amount': combined ? 80000 : 30000, 'offer_discount': 0, 'manual_discount': 0, 'points_discount': 0, 'rounding_amount': 0, 'net_amount': combined ? 80000 : 30000, 'points_used': 0, 'points_earned': 0, 'refunded_total': 0,
      'items': [
        {'id': 1, 'item_type': 'consultation', 'service_name': 'كشفية', 'net_amount': 30000, 'list_price': 30000, 'status': 'paid'},
        if (combined) {'id': 2, 'item_type': 'session', 'service_name': 'ليزر', 'net_amount': 50000, 'list_price': 50000, 'status': 'paid'},
      ],
      'tenders': [{'method_id': 1, 'method_name': 'كاش', 'device_label': null, 'amount': combined ? 80000 : 30000}],
      'payments': [
        {'id': 11, 'receipt_no': '2026-00001', 'kind': 'consultation', 'net_amount': 30000, 'print_count': unprinted == 0 ? 1 : 0},
        if (combined) {'id': 12, 'receipt_no': '2026-00002', 'kind': 'sessions', 'net_amount': 50000, 'print_count': unprinted == 0 ? 1 : 0},
      ],
      'payment_ids': combined ? [11, 12] : [11], 'unprinted': unprinted, 'print_count': unprinted == 0 ? 1 : 0,
    };

void main() {
  Widget host(Api api, Widget child) => ChangeNotifierProvider<Api>.value(value: api, child: MaterialApp(home: child));
  Future<void> big(WidgetTester t) async { await t.binding.setSurfaceSize(const Size(900, 1600)); addTearDown(() => t.binding.setSurfaceSize(null)); }

  group('الدفع: وصل واحد فقط', () {
    late List<String> calls; late Api api; late CashierState st;
    Api build({required bool consultation}) {
      calls = [];
      return Api(baseUrl: 'http://x', client: MockClient((req) async {
        calls.add('${req.method} ${req.url.path}');
        switch (req.url.path) {
          case '/payment-methods': return j([{'id': 1, 'name_ar': 'كاش', 'kind': 'cash', 'is_active': true, 'device_label': null}]);
          case '/discount-requests': return j({'requests': []});
          case '/payments/quote/consultation': return j(quote(30000));
          case '/payments/quote/sessions': return j(quote(50000, name: 'ليزر'));
          case '/payments/consultation': return j({'id': 11, 'receipt_no': '2026-00001'}, 201);
          case '/payments/sessions': return j({'id': 12, 'receipt_no': '2026-00002'}, 201);
          case '/customers/9/day-receipt': return j(dayReceipt());
        }
        return j({}, 404);
      }));
    }
    Future<bool?> openAndPay(WidgetTester t, {required bool consultation}) async {
      await big(t); api = build(consultation: consultation); st = CashierState(api);
      bool? result; var popped = false;
      await t.pumpWidget(host(api, Builder(builder: (c) => Scaffold(body: Center(child: FilledButton(
        onPressed: () async { result = await Navigator.of(c).push<bool>(MaterialPageRoute(builder: (_) => consultation
            ? PaymentPage.consultation(state: st, customer: customer, consultationId: 5, visitId: 1)
            : PaymentPage.sessions(state: st, customer: customer, sessionIds: [7]))); popped = true; },
        child: const Text('افتح')))))));
      await t.tap(find.text('افتح')); await settle(t);
      await t.tap(find.textContaining('تم الدفع ·')); await settle(t); await settle(t);
      return popped ? result : null;
    }

    testWidgets('بعد دفع الكشفية: ما يطلع وصل ولا طباعة، يرجع بنجاح مع تنبيه (الزبون يروح للطبيب)', (t) async {
      final r = await openAndPay(t, consultation: true);
      expect(r, true);
      expect(calls, contains('POST /payments/consultation'));
      expect(calls.where((c) => c.contains('day-receipt') || c.startsWith('GET /payments/')), isEmpty);   // ما انفتح وصل
      expect(find.byType(ReceiptPage), findsNothing); expect(find.textContaining('طباعة A5'), findsNothing);
      expect(find.textContaining('الوصل يُطبع مرة وحدة بعد الجلسات'), findsOneWidget);
    });

    testWidgets('بعد دفع الجلسات: يفتح وصل اليوم الجامع (مو وصل الجلسات لحاله) مع الأرقام والبنود وزر الطباعة', (t) async {
      final r = await openAndPay(t, consultation: false);
      expect(r, isNull);                                                                                   // ما زال بصفحة الوصل
      expect(calls, containsAllInOrder(['POST /payments/sessions', 'GET /customers/9/day-receipt']));
      expect(calls.where((c) => c.startsWith('GET /payments/')), isEmpty);
      expect(find.text('وصل اليوم'), findsOneWidget);                                                      // عنوان الصفحة
      expect(find.text('وصل ${ltr('2026-00001 + 2026-00002')}'), findsOneWidget);
      expect(find.textContaining('وصل واحد يجمع كل مدفوعات اليوم'), findsOneWidget);
      expect(find.text('كشفية'), findsWidgets); expect(find.text('ليزر'), findsOneWidget);
      expect(find.text('طباعة A5'), findsOneWidget); expect(find.text('استرجاع'), findsNothing);          // الاسترجاع من الوصل المنفرد
      expect(find.textContaining('الوصولات المشمولة'), findsOneWidget);
    });
  });

  group('صفحة وصل اليوم', () {
    Future<List<String>> open(WidgetTester t, Map<String, dynamic> receipt, {bool justPaid = false}) async {
      await big(t); final calls = <String>[];
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async {
        calls.add('${req.method} ${req.url.path}${req.url.query.isEmpty ? '' : '?${req.url.query}'}');
        if (req.url.path == '/customers/9/day-receipt') return j(receipt);
        if (req.url.path == '/payments/11') return j({...receipt, 'id': 11, 'receipt_no': '2026-00001', 'kind': 'consultation', 'payments': null, 'payment_ids': [11]});
        return j({}, 404);
      }));
      await t.pumpWidget(host(api, ReceiptPage.day(state: CashierState(api), dayCustomerId: 9, justPaid: justPaid))); await settle(t);
      return calls;
    }

    testWidgets('وصل انطبع قبل: تنبيه «إعادة طباعة»؛ وما يطلع تنبيه الدفع الجديد', (t) async {
      await open(t, dayReceipt(unprinted: 0));
      expect(find.textContaining('انطبع قبل'), findsOneWidget); expect(find.textContaining('اطبعه مرة وحدة'), findsNothing);
    });

    testWidgets('وصل واحد فقط (مثل كشفية بس): بدون قائمة «الوصولات المشمولة» ولا تنبيه وصل جامع', (t) async {
      await open(t, dayReceipt(combined: false), justPaid: true);
      expect(find.textContaining('الوصولات المشمولة'), findsNothing); expect(find.text('وصل ${ltr('2026-00001')}'), findsOneWidget);
    });

    testWidgets('الطباعة: وصل واحد جامع (رقمه مركب) ثم تسجيل كل الوصولات المشمولة دفعة وحدة', (t) async {
      final printed = <ReceiptData>[]; receiptPrintOverride = (d) async { printed.add(d); return true; }; addTearDown(() => receiptPrintOverride = null);
      await big(t); final posts = <String>[]; final bodies = <Map<String, dynamic>>[];
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async {
        if (req.method == 'POST') { posts.add(req.url.path); bodies.add(jsonDecode(req.body) as Map<String, dynamic>); return j({'prints': []}); }
        return j(dayReceipt());
      }));
      await t.pumpWidget(host(api, ReceiptPage.day(state: CashierState(api), dayCustomerId: 9))); await settle(t);
      await t.tap(find.text('طباعة A5')); await settle(t); await settle(t);
      expect(printed.length, 1); expect(printed.single.number, '2026-00001 + 2026-00002'); expect(printed.single.items.length, 2); expect(printed.single.netFixed, 80000);
      expect(posts, ['/payments/print']); expect(bodies.single['payment_ids'], [11, 12]);
    });

    testWidgets('الطباعة لوصل منفرد: تسجيل وصل واحد فقط بمساره القديم', (t) async {
      final printed = <ReceiptData>[]; receiptPrintOverride = (d) async { printed.add(d); return true; }; addTearDown(() => receiptPrintOverride = null);
      await big(t); final posts = <String>[];
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async {
        if (req.method == 'POST') { posts.add(req.url.path); return j({}); }
        return j({...dayReceipt(combined: false), 'id': 11, 'payments': null});
      }));
      await t.pumpWidget(host(api, ReceiptPage(state: CashierState(api), receiptId: 11))); await settle(t);
      await t.tap(find.text('طباعة A5')); await settle(t); await settle(t);
      expect(printed.length, 1); expect(posts, ['/payments/11/print']);
    });

    testWidgets('فشل الطباعة (المستخدم لغى): ما ينسجل شي', (t) async {
      receiptPrintOverride = (d) async => false; addTearDown(() => receiptPrintOverride = null);
      await big(t); final posts = <String>[];
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async { if (req.method == 'POST') { posts.add(req.url.path); return j({}); } return j(dayReceipt()); }));
      await t.pumpWidget(host(api, ReceiptPage.day(state: CashierState(api), dayCustomerId: 9))); await settle(t);
      await t.tap(find.text('طباعة A5')); await settle(t); await settle(t);
      expect(posts, isEmpty);
      expect(find.text('تم إلغاء الطباعة: الوصل ما انسجل كمطبوع'), findsOneWidget); expect(find.text('انطبع الوصل'), findsNothing);   // ما يقول «انطبع» إذا لغى
    });

    group('تأكيد الطباعة (المتصفح ما يعرف إذا انلغت)', () {
      Future<List<String>> run(WidgetTester t, {required bool yes}) async {
        receiptPrintOverride = (d) async => true; receiptConfirmAfterPrint = true; addTearDown(() { receiptPrintOverride = null; receiptConfirmAfterPrint = false; });
        await big(t); final posts = <String>[];
        final api = Api(baseUrl: 'http://x', client: MockClient((req) async { if (req.method == 'POST') { posts.add(req.url.path); return j({}); } return j(dayReceipt()); }));
        await t.pumpWidget(host(api, ReceiptPage.day(state: CashierState(api), dayCustomerId: 9))); await settle(t);
        await t.tap(find.text('طباعة A5')); await settle(t);
        expect(find.text('هل انطبع الوصل فعلاً؟'), findsOneWidget); expect(posts, isEmpty);          // ما يسجل قبل ما يجاوب
        await t.tap(find.text(yes ? 'نعم، انطبع' : 'رجوع')); await settle(t); await settle(t);
        return posts;
      }
      testWidgets('«لا» (ألغيت من نافذة الطباعة): ما ينسجل ويقول إنه غير مطبوع', (t) async {
        expect(await run(t, yes: false), isEmpty);
        expect(find.text('ما انسجلت الطباعة: الوصل بعده غير مطبوع'), findsOneWidget); expect(find.text('انطبع الوصل'), findsNothing);
      });
      testWidgets('«نعم»: يسجل الطباعة ويقول انطبع', (t) async {
        expect(await run(t, yes: true), ['/payments/print']);
        expect(find.text('انطبع الوصل'), findsOneWidget);
      });
    });

    testWidgets('فتح وصل مشمول يروح لوصله المنفرد (للاسترجاع)', (t) async {
      final calls = await open(t, dayReceipt());
      await t.tap(find.textContaining(ltr('2026-00001')).last); await settle(t);
      expect(calls, contains('GET /payments/11'));
      expect(find.text('استرجاع'), findsOneWidget);
    });
  });

  group('ملف الزبون عند الكاشير', () {
    Future<void> openPanel(WidgetTester t, {required Map<String, dynamic>? cons, String visitStatus = 'booked', List<Map<String, dynamic>> receipts = const [], List<String>? calls}) async {
      await big(t); await t.pumpWidget(const SizedBox());   // شجرة جديدة: الـ Loader ما يحتفظ ببيانات الفتحة السابقة
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async {
        calls?.add('${req.method} ${req.url.path}');
        switch (req.url.path) {
          case '/customers/9': return j(customer);
          case '/customers/9/sessions': return j({'sessions': []});
          case '/bookings': return j({'bookings': [if (cons != null) {'id': 1, 'seq_no': 4, 'status': visitStatus, 'doctor': {'full_name': 'د. ليزر'}, 'consultation': cons}]});
          case '/discount-requests': return j({'requests': []});
          case '/payments': return j(receipts);
        }
        if (req.method == 'POST') return j({'status': 'paid'}, 201);
        return j({}, 404);
      }));
      await t.pumpWidget(host(api, Scaffold(body: CustomerPanel(customerId: 9, state: CashierState(api))))); await settle(t);
    }
    Map<String, dynamic> pay({int printCount = 0, String status = 'paid', String? date}) => {'id': 11, 'receipt_no': '2026-00001', 'net_amount': 30000, 'business_date': date ?? todayIso(), 'kind': 'consultation', 'status': status, 'print_count': printCount, 'customer': {'id': 9}};

    testWidgets('«جلسات فقط» مجانية: فقط «إدخال بدون دفع» (لا دفع ولا خصم)، مع شارة وإلغاء الحجز', (t) async {
      await openPanel(t, cons: {'id': 5, 'status': 'awaiting_payment', 'kind': 'sessions_only', 'fee': 0});
      expect(find.text('جلسات فقط · مجانية'), findsOneWidget);
      expect(find.text('إدخال بدون دفع'), findsOneWidget);
      expect(find.textContaining('دفع كشفية'), findsNothing); expect(find.text('طلب خصم'), findsNothing); expect(find.text('إلغاء الحجز'), findsOneWidget);
    });

    testWidgets('«جلسات فقط» مجانية: ضغط الإدخال يرسل check-in', (t) async {
      final calls = <String>[];
      await openPanel(t, cons: {'id': 5, 'status': 'awaiting_payment', 'kind': 'sessions_only', 'fee': 0}, calls: calls);
      await t.tap(find.text('إدخال بدون دفع')); await settle(t);
      expect(calls, contains('POST /consultations/5/check-in'));
    });

    testWidgets('«جلسات فقط» بسعر: زر دفع «جلسات فقط» وطلب خصم، بدون إدخال مجاني، والسعر بالشارة', (t) async {
      await openPanel(t, cons: {'id': 5, 'status': 'awaiting_payment', 'kind': 'sessions_only', 'fee': 15000});
      expect(find.textContaining('جلسات فقط · '), findsOneWidget); expect(find.textContaining('مجانية'), findsNothing);
      expect(find.text('دفع كشفية «جلسات فقط»'), findsOneWidget); expect(find.text('طلب خصم'), findsOneWidget); expect(find.text('إدخال بدون دفع'), findsNothing);
    });

    testWidgets('كشفية عادية بزيارة وصلت (انضمت لجلسات): زر الدفع يظهر (كان يختفي لأن الحجز arrived)', (t) async {
      await openPanel(t, cons: {'id': 5, 'status': 'awaiting_payment', 'kind': 'new'}, visitStatus: 'arrived');
      expect(find.text('دفع الكشفية'), findsOneWidget); expect(find.text('إدخال بدون دفع'), findsNothing); expect(find.textContaining('جلسات فقط'), findsNothing);
    });

    testWidgets('«جلسات فقط» مجانية مدخلة: زر إلغاء الدخول المجاني', (t) async {
      await openPanel(t, cons: {'id': 5, 'status': 'paid', 'kind': 'sessions_only', 'fee': 0}, visitStatus: 'arrived');
      expect(find.text('إلغاء الدخول المجاني'), findsOneWidget);
    });

    testWidgets('وصولات اليوم غير المطبوعة: زر «طباعة وصل اليوم (وصل واحد)»', (t) async {
      await openPanel(t, cons: null, receipts: [pay(), {...pay(), 'id': 12, 'receipt_no': '2026-00002'}]);
      expect(find.text('طباعة وصل اليوم (وصل واحد)'), findsOneWidget); expect(find.text('إعادة طباعة وصل اليوم'), findsNothing);
    });

    testWidgets('كلها مطبوعة: «إعادة طباعة»؛ مسترجعة أو من يوم ثاني أو بدون وصولات: لا زر', (t) async {
      await openPanel(t, cons: null, receipts: [pay(printCount: 1)]);
      expect(find.text('إعادة طباعة وصل اليوم'), findsOneWidget); expect(find.text('طباعة وصل اليوم (وصل واحد)'), findsNothing);
      await openPanel(t, cons: null, receipts: [pay(status: 'refunded')]);
      expect(find.textContaining('وصل اليوم'), findsNothing);
      await openPanel(t, cons: null, receipts: [pay(date: '2020-01-01')]);
      expect(find.textContaining('وصل اليوم'), findsNothing);
      await openPanel(t, cons: null, receipts: []);
      expect(find.textContaining('وصل اليوم'), findsNothing);
    });

    testWidgets('زر «طباعة وصل اليوم» يفتح صفحة الوصل الجامع', (t) async {
      await openPanel(t, cons: null, receipts: [pay()]);
      await t.tap(find.text('طباعة وصل اليوم (وصل واحد)'));
      await settle(t);
      expect(find.byType(ReceiptPage), findsOneWidget);
    });
  });

  group('حجز الكاشير', () {
    testWidgets('اختيار «جلسات فقط» يرسل النوع، والافتراضي «كشفية + جلسات»', (t) async {
      await big(t); final posts = <Map<String, dynamic>>[];
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async {
        if (req.url.path == '/schedule/doctors') return j({'doctors': [{'id': 5, 'full_name': 'د. ليزر'}]});
        if (req.url.path == '/bookings' && req.method == 'POST') { posts.add(jsonDecode(req.body) as Map<String, dynamic>); return j({'id': 1}, 201); }
        return j({}, 404);
      }));
      await t.pumpWidget(host(api, Builder(builder: (c) => Scaffold(body: FilledButton(onPressed: () => bookingDialog(c, 9), child: const Text('حجز'))))));
      for (final pick in [false, true]) {
        await t.tap(find.text('حجز')); await settle(t);
        if (pick) { await t.tap(find.text('جلسات فقط')); await settle(t); }
        await t.tap(find.text('حجز').last); await settle(t); await settle(t);
      }
      expect(posts.map((p) => p['type']), ['standard', 'sessions_only']); expect(posts.every((p) => p['customer_id'] == 9 && p['doctor_id'] == 5), true);
    });
  });
}
