import 'dart:convert';

import 'package:clinic_app/core/api.dart';
import 'package:clinic_app/staff/photos.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

// صورة PNG 1×1 صالحة
final _png = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');
http.Response j(Object b, [int s = 200]) => http.Response(jsonEncode(b), s, headers: {'content-type': 'application/json; charset=utf-8'});
Future<void> settle(WidgetTester t) async { for (var i = 0; i < 6; i++) { await t.pump(const Duration(milliseconds: 80)); } }

void main() {
  Future<List<String>> pump(WidgetTester t, {required bool canDelete, List<Map<String, dynamic>>? photos}) async {
    final posted = <String>[]; final bodies = <Object?>[];
    final api = Api(baseUrl: 'http://x', client: MockClient((req) async {
      if (req.method == 'GET' && req.url.path == '/customers/8/photos') {
        return j({'customer_id': 8, 'photos': photos ?? [
          {'id': 5, 'phase': 'before', 'body_area': 'الوجه', 'mime': 'image/png', 'created_at': '2026-11-14T08:00:00.000Z', 'session_id': 1, 'consultation_id': null, 'service_name': 'ليزر', 'session_seq_no': 1, 'uploaded_by': {'id': 4, 'full_name': 'ريم'}},
          {'id': 6, 'phase': 'after', 'body_area': null, 'mime': 'image/png', 'created_at': '2026-11-14T09:00:00.000Z', 'session_id': 1, 'consultation_id': null, 'service_name': 'ليزر', 'session_seq_no': 1, 'uploaded_by': {'id': 4, 'full_name': 'ريم'}},
        ]});
      }
      if (req.method == 'GET' && req.url.path.startsWith('/photos/')) return http.Response.bytes(_png, 200, headers: {'content-type': 'image/png'});
      if (req.method == 'POST') { posted.add(req.url.path); bodies.add(jsonDecode(req.body)); return j({'id': 5, 'deleted': true}); }
      return j({}, 404);
    }));
    await t.pumpWidget(ChangeNotifierProvider<Api>.value(value: api, child: MaterialApp(home: Scaffold(body: SingleChildScrollView(child: PhotoGallery(customerId: 8, canDelete: canDelete))))));
    await settle(t);
    return [...posted]..addAll(const []);
  }

  testWidgets('gallery shows before/after thumbnails with area and date', (t) async {
    await pump(t, canDelete: false);
    expect(find.text('قبل'), findsOneWidget);
    expect(find.text('بعد'), findsOneWidget);
    expect(find.text('الوجه'), findsOneWidget);
    expect(find.text('14/11/2026'), findsNWidgets(2));
    expect(find.byType(Image), findsNWidgets(2));
    // «قبل» تخص الصورة اللي منطقتها الوجه (id 5 phase=before) مو الثانية
    final thumb = find.ancestor(of: find.text('الوجه'), matching: find.byType(Column)).first;
    expect(find.descendant(of: thumb, matching: find.text('قبل')), findsOneWidget);
    expect(find.descendant(of: thumb, matching: find.text('بعد')), findsNothing);
  });

  testWidgets('empty gallery says there are no photos', (t) async {
    await pump(t, canDelete: false, photos: []);
    expect(find.text('ما أكو صور بعد'), findsOneWidget);
  });

  testWidgets('viewer hides delete for non-owners', (t) async {
    await pump(t, canDelete: false);
    await t.tap(find.text('الوجه')); await settle(t);
    expect(find.textContaining('رفعها ريم'), findsOneWidget);
    expect(find.text('حذف'), findsNothing);
  });

  testWidgets('owner deletes with a mandatory reason and the list reloads', (t) async {
    final posted = <String>[]; final bodies = <Map<String, dynamic>>[]; var gets = 0;
    final api = Api(baseUrl: 'http://x', client: MockClient((req) async {
      if (req.url.path == '/customers/8/photos') { gets++; return j({'customer_id': 8, 'photos': gets > 1 ? [] : [{'id': 5, 'phase': 'before', 'body_area': 'الوجه', 'mime': 'image/png', 'created_at': '2026-11-14T08:00:00.000Z', 'session_id': 1, 'consultation_id': null, 'service_name': 'ليزر', 'session_seq_no': 1, 'uploaded_by': {'id': 4, 'full_name': 'ريم'}}]}); }
      if (req.url.path.startsWith('/photos/') && req.method == 'GET') return http.Response.bytes(_png, 200);
      if (req.method == 'POST') { posted.add(req.url.path); bodies.add(jsonDecode(req.body) as Map<String, dynamic>); return j({'id': 5, 'deleted': true}); }
      return j({}, 404);
    }));
    await t.pumpWidget(ChangeNotifierProvider<Api>.value(value: api, child: MaterialApp(home: Scaffold(body: SingleChildScrollView(child: PhotoGallery(customerId: 8, canDelete: true))))));
    await settle(t);
    await t.tap(find.text('الوجه')); await settle(t);
    await t.tap(find.text('حذف')); await settle(t);
    await t.enterText(find.byType(EditableText).last, 'صورة خطأ'); await t.pump();
    await t.tap(find.text('حذف').last); await settle(t); await settle(t);
    expect(posted, ['/photos/5/delete']);
    expect(bodies.single, {'reason': 'صورة خطأ'});
    expect(find.text('ما أكو صور بعد'), findsOneWidget);
  });
}
