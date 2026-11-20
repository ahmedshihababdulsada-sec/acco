import 'dart:convert';

import 'package:clinic_app/core/api.dart';
import 'package:clinic_app/customer/customer_home.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

http.Response j(Object b, [int s = 200]) => http.Response(jsonEncode(b), s, headers: {'content-type': 'application/json; charset=utf-8'});
Future<void> settle(WidgetTester t) async { for (var i = 0; i < 6; i++) { await t.pump(const Duration(milliseconds: 80)); } }

Map<String, dynamic> day(String date, {int remaining = 20, bool bookable = true, Map<String, dynamic>? own}) => {
      'date': date, 'weekday': 1, 'clinic_open': true, 'closed_reason': null, 'holiday': null, 'doctor': {'works': true, 'start_time': '09:00', 'end_time': '13:00', 'day_off': null},
      'used_slots': 5, 'remaining': remaining, 'bookable': bookable, 'customer_visit': own,
    };

void main() {
  Widget host(Api api, Widget child) => ChangeNotifierProvider<Api>.value(value: api, child: MaterialApp(home: child));

  group('شاشة الحجز', () {
    late List<Map<String, dynamic>> posts; Map<String, dynamic>? failWith; int soFee = 0;
    Api build() {
      posts = []; failWith = null; soFee = 0;
      return Api(baseUrl: 'http://x', client: MockClient((req) async {
        if (req.url.path == '/customer/doctors') return j({'sessions_only_fee': soFee, 'doctors': [{'id': 5, 'full_name': 'د. سارة', 'title': 'جلدية'}]});
        if (req.url.path == '/customer/availability') {
          return j({'branch_id': 1, 'daily_limit': 25, 'days': [
            day('2026-11-20'),
            day('2026-11-21', own: {'has_consultation': false, 'sessions_count': 2}),
            day('2026-11-22', bookable: false, own: {'has_consultation': true, 'sessions_count': 1}),
          ]});
        }
        if (req.url.path == '/customer/bookings' && req.method == 'POST') {
          posts.add(jsonDecode(req.body) as Map<String, dynamic>);
          return failWith != null ? j(failWith!, 409) : j({'id': 1});
        }
        return j({}, 404);
      }));
    }
    Future<void> open(WidgetTester t, Api api) async {
      await t.binding.setSurfaceSize(const Size(800, 1400)); addTearDown(() => t.binding.setSurfaceSize(null));
      await t.pumpWidget(host(api, const NewBookingPage())); await settle(t);
    }

    testWidgets('كل يوم يبين حالته: عادي، فيه جلسات (الكشفية تنضاف لموعده)، وفيه كشفية (مقفل بسببه)', (t) async {
      await open(t, build());
      expect(find.text('متاح: 20 موعد'), findsOneWidget);
      expect(find.text('عندك 2 جلسة بهذا اليوم: الكشفية تنضاف لموعدك بنفس رقمك'), findsOneWidget);
      expect(find.text('عندك كشفية محجوزة بهذا اليوم'), findsOneWidget);
    });

    testWidgets('يوم فيه كشفية ما ينضغط (ما يرسل شي)', (t) async {
      final api = build(); await open(t, api);
      await t.tap(find.text('عندك كشفية محجوزة بهذا اليوم')); await settle(t);
      expect(find.text('تأكيد الحجز'), findsNothing); expect(posts, isEmpty);
    });

    testWidgets('يوم فيه جلسات: التأكيد يشرح الانضمام، وبعد الموافقة يرسل الحجز العادي', (t) async {
      final api = build(); await open(t, api);
      await t.tap(find.textContaining('عندك 2 جلسة بهذا اليوم')); await settle(t);
      expect(find.textContaining('الكشفية تنضاف لنفس موعدك وبنفس رقمك'), findsOneWidget);
      await t.tap(find.text('احجز')); await settle(t); await settle(t);
      expect(posts, [{'doctor_id': 5, 'date': '2026-11-21', 'type': 'standard'}]);
    });

    testWidgets('يوم عادي: تأكيد بدون شرح الانضمام', (t) async {
      final api = build(); await open(t, api);
      await t.tap(find.text('متاح: 20 موعد')); await settle(t);
      expect(find.textContaining('تنضاف لنفس موعدك'), findsNothing);
      await t.tap(find.text('احجز')); await settle(t); await settle(t);
      expect(posts.single['date'], '2026-11-20');
    });

    testWidgets('اختيار نوع الحجز: الافتراضي كشفية، و«جلسات فقط» (مجانية) ترسل النوع', (t) async {
      final api = build(); await open(t, api);
      expect(find.text('كشفية (وبعدها جلسات)'), findsOneWidget); expect(find.text('الطبيب ينظم لك الجلسات · الكشفية مجانية وتدفع الجلسات فقط'), findsOneWidget);
      await t.tap(find.byKey(const ValueKey('type-sessions_only'))); await settle(t);
      await t.tap(find.text('متاح: 20 موعد')); await settle(t); await t.tap(find.text('احجز')); await settle(t); await settle(t);
      expect(posts, [{'doctor_id': 5, 'date': '2026-11-20', 'type': 'sessions_only'}]);
    });

    testWidgets('«جلسات فقط» بسعر من العيادة: يظهر السعر بوصف الخيار', (t) async {
      final api = build(); soFee = 15000; await open(t, api);
      expect(find.textContaining('الكشفية 15,000'), findsOneWidget); expect(find.textContaining('مجانية'), findsNothing);
    });

    testWidgets('تغيير موعد: ما يطلع اختيار النوع ولا يرسل نوع', (t) async {
      final api = build();
      await t.binding.setSurfaceSize(const Size(800, 1400)); addTearDown(() => t.binding.setSurfaceSize(null));
      await t.pumpWidget(host(api, const NewBookingPage(moveBookingId: 3))); await settle(t);
      expect(find.text('كشفية (وبعدها جلسات)'), findsNothing);
    });

    testWidgets('رفض من الخادم (يوم فيه كشفية): الرسالة مع أقرب يوم متاح', (t) async {
      final api = build(); failWith = {'code': 'ALREADY_BOOKED_THAT_DAY', 'message': 'توجد كشفية فعالة بنفس هذا اليوم: اختر يوماً ثانياً', 'next_available_date': '2026-11-23'};
      await open(t, api);
      await t.tap(find.text('متاح: 20 موعد')); await settle(t); await t.tap(find.text('احجز')); await settle(t); await settle(t);
      expect(find.textContaining('أقرب يوم متاح'), findsOneWidget); expect(find.textContaining('23/11/2026'), findsOneWidget);
    });
  });

  group('قائمة المواعيد', () {
    Future<List<String>> openList(WidgetTester t, List<Map<String, dynamic>> bookings) async {
      final posted = <String>[];
      final api = Api(baseUrl: 'http://x', client: MockClient((req) async {
        if (req.url.path == '/customer/bookings' && req.method == 'GET') return j({'bookings': bookings});
        if (req.method == 'POST') { posted.add(req.url.path); return j({'id': 1}); }
        return j({}, 404);
      }));
      await t.binding.setSurfaceSize(const Size(800, 1400)); addTearDown(() => t.binding.setSurfaceSize(null));
      await t.pumpWidget(host(api, const Scaffold(body: BookingsTab()))); await settle(t);
      return posted;
    }
    Map<String, dynamic> b({String kind = 'consultation', int sessions = 0, bool changeable = false, bool cancellable = false}) => {'id': 7, 'date': '2026-11-21', 'seq_no': 3, 'status': 'booked', 'kind': kind, 'doctor_name': 'د. سارة', 'consultation_status': 'awaiting_payment', 'sessions_count': sessions, 'changeable': changeable, 'cancellable': cancellable};

    testWidgets('كشفية بسيطة: تغيير وإلغاء', (t) async {
      await openList(t, [b(changeable: true, cancellable: true)]);
      expect(find.text('تغيير الموعد'), findsOneWidget); expect(find.text('إلغاء'), findsOneWidget); expect(find.textContaining('+'), findsNothing);
    });

    testWidgets('كشفية منضمة لجلسات: تظهر «كشفية + جلسة»، لا تغيير، وإلغاء الكشفية بس مع شرح، وترسل الإلغاء', (t) async {
      final posted = await openList(t, [b(sessions: 2, cancellable: true)]);
      expect(find.textContaining('كشفية + 2 جلسة'), findsOneWidget);
      expect(find.text('تغيير الموعد'), findsNothing); expect(find.text('إلغاء الكشفية'), findsOneWidget);
      await t.tap(find.text('إلغاء الكشفية')); await settle(t);
      expect(find.text('تنلغي الكشفية بس. جلساتك بنفس اليوم تبقى بموعدها.'), findsOneWidget);
      await t.tap(find.text('إلغاء الكشفية').last); await settle(t); await settle(t);
      expect(posted, ['/customer/bookings/7/cancel']); expect(find.text('انلغت الكشفية وجلساتك باقية'), findsOneWidget);
    });

    testWidgets('زيارة جلسات فقط: بدون أزرار', (t) async {
      await openList(t, [{...b(kind: 'sessions', sessions: 2), 'doctor_name': null, 'consultation_status': null}]);
      expect(find.text('2 جلسة'), findsOneWidget); expect(find.text('إلغاء'), findsNothing); expect(find.text('إلغاء الكشفية'), findsNothing); expect(find.text('تغيير الموعد'), findsNothing);
    });

    testWidgets('«جلسات فقط»: تظهر بنوعها مع عدد الجلسات', (t) async {
      await openList(t, [b(kind: 'sessions_only', sessions: 2, cancellable: true)]);
      expect(find.textContaining('جلسات فقط (2 جلسة)'), findsOneWidget);
    });

    testWidgets('مراجعة مجانية منضمة لجلسات', (t) async {
      await openList(t, [b(kind: 'followup', sessions: 1, cancellable: true)]);
      expect(find.textContaining('مراجعة مجانية + 1 جلسة'), findsOneWidget);
    });
  });
}
