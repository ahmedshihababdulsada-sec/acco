import 'dart:convert';
import 'dart:typed_data';

import 'package:clinic_app/core/api.dart';
import 'package:clinic_app/core/format.dart';
import 'package:clinic_app/core/receipt/mixed_text.dart';
import 'package:clinic_app/core/receipt/models.dart';
import 'package:clinic_app/core/receipt/receipt_pdf.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  group('format', () {
    test('money groups thousands and rounds', () {
      expect(money(0), '0 د.ع');
      expect(money(1500), '1,500 د.ع');
      expect(money(4950000), '4,950,000 د.ع');
      expect(money(250.4), '250 د.ع');
      expect(money(-12000), contains('12,000'));
    });
    test('dmy converts ISO dates for display', () {
      expect(dmy('2026-11-14'), '14/11/2026');
      expect(dmy(null), '');
      expect(dmy('x'), 'x');
    });
    test('date helpers', () {
      expect(addDaysIso('2026-11-30', 1), '2026-12-01');
      expect(addDaysIso('2026-03-01', -1), '2026-02-28');
      expect(weekdayName('2026-11-14'), 'السبت'); // 14 Nov 2026 is a Saturday
      expect(weekdayName('2026-11-16'), 'الاثنين');
    });
    test('groupDigits', () {
      expect(groupDigits(1234567), '1,234,567');
      expect(groupDigits(999), '999');
      expect(groupDigits(-1000), '-1,000');
    });
  });

  group('mixed text', () {
    test('arabic and digits split into separate direction runs', () {
      final segs = splitMixed('جلسة 2 من 6');
      expect(segs.map((s) => s.ltr).toList(), [false, true, false, true]);
      expect(segs[1].text, '2');
    });
    test('consecutive latin tokens stay one LTR run', () {
      final segs = splitMixed('كود C-0977 ok');
      expect(segs.where((s) => s.ltr).single.text, 'C-0977 ok');
    });
  });

  group('receipt', () {
    Map<String, dynamic> payload({int net = 47250}) => {
          'receipt_no': 'R-0001', 'paid_at': '2026-11-14T08:30:00.000Z', 'business_date': '2026-11-14',
          'cashier': {'full_name': 'نور'}, 'customer': {'full_name': 'زبونة', 'public_code': 'ABC123'},
          'items': [
            {'item_type': 'session', 'service_name': 'بوتكس', 'quantity': 2, 'list_price': 50000, 'offer_percent': 10},
            {'item_type': 'consultation', 'service_name': 'كشفية', 'quantity': 1, 'list_price': 30000},
          ],
          'tenders': [{'method_name': 'كاش', 'device_label': null, 'amount': net}],
          'manual_discount': 0, 'points_discount': 0, 'gross_amount': 80000, 'offer_discount': 5000, 'net_amount': net, 'rounding_amount': 750,
          'clinic': {'name': 'مركز', 'address': 'بغداد', 'phone': '0770'},
        };

    test('server numbers are authoritative and never recomputed', () {
      final r = receiptFromServer(payload(net: 74000));
      expect(r.gross, 80000);
      expect(r.offerDiscount, 5000);
      expect(r.net, 74000); // not (80000-5000)~/250*250
      expect(r.rounding, 750);
      expect(r.number, 'R-0001');
      expect(r.code, 'ABC123');
    });
    test('item subtitles describe kind, quantity and offer', () {
      final r = receiptFromServer(payload());
      expect(r.items[0].sub, 'جلسة · 2 · عرض 10%');
      expect(r.items[1].sub, 'كشفية');
      expect(r.clinicName, 'مركز');
    });
    test('tender label includes device when present', () {
      final p = payload();
      (p['tenders'] as List)[0] = {'method_name': 'كي كارد', 'device_label': 'جهاز 1', 'amount': 47250};
      expect(receiptFromServer(p).tenders.single.label, 'كي كارد · جهاز 1');
    });
    test('client-side fallback rounds down to 250 in favour of the customer', () {
      const r = ReceiptData(number: 'x', when: '', cashier: '', customer: '', code: '', items: [ReceiptItem(title: 'a', sub: '', date: '', price: 10100)], tenders: []);
      expect(r.net, 10000);
    });
  });

  group('receipt logo', () {
    test('fetched only when the receipt snapshot has a logo, and failures never block printing', () async {
      final calls = <String>[];
      Api api(int status) => Api(baseUrl: 'http://x', client: MockClient((req) async { calls.add(req.url.path); return status == 200 ? http.Response.bytes([1, 2, 3], 200) : http.Response(jsonEncode({'code': 'NOT_FOUND', 'message': 'x'}), status); }));
      expect(await fetchReceiptLogo(api(200), {'clinic': {'logo_attachment_id': null}}), isNull);
      expect(await fetchReceiptLogo(api(200), {}), isNull);
      expect(calls, isEmpty);
      expect(await fetchReceiptLogo(api(200), {'clinic': {'logo_attachment_id': 3}}), [1, 2, 3]);
      expect(calls, ['/attachments/logo/current']);
      expect(await fetchReceiptLogo(api(404), {'clinic': {'logo_attachment_id': 3}}), isNull);
    });
    test('receiptFromServer carries the logo bytes', () {
      final r = receiptFromServer({
        'receipt_no': 'R', 'business_date': '2026-11-14', 'cashier': {'full_name': 'a'}, 'customer': {'full_name': 'b', 'public_code': 'c'}, 'items': [], 'tenders': [],
        'manual_discount': 0, 'points_discount': 0, 'gross_amount': 0, 'offer_discount': 0, 'net_amount': 0, 'rounding_amount': 0,
      }, logo: Uint8List.fromList([9, 9]));
      expect(r.logo, [9, 9]);
    });
  });

  group('receipt pdf logo', () {
    TestWidgetsFlutterBinding.ensureInitialized();
    final png = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');
    ReceiptData data(Uint8List? logo) => ReceiptData(number: '2026-00007', when: '14/11/2026', cashier: 'نور', customer: 'زبونة', code: 'ABC',
        items: const [ReceiptItem(title: 'كشفية', sub: 'كشفية', date: '14/11/2026', price: 30000)], tenders: const [ReceiptTender('كاش', 30000)], netFixed: 30000, grossFixed: 30000, offerFixed: 0, roundingFixed: 0, logo: logo);
    Future<Uint8List> build(Uint8List? logo) async => buildReceiptPdf(data(logo), regular: await rootBundle.load('assets/fonts/IBMPlexSansArabic-Regular.ttf'), bold: await rootBundle.load('assets/fonts/IBMPlexSansArabic-Bold.ttf'));

    test('a valid logo is embedded (bigger PDF with an image object)', () async {
      final without = await build(null); final withLogo = await build(png);
      expect(String.fromCharCodes(withLogo.take(5)), '%PDF-');
      expect(withLogo.length, greaterThan(without.length));
      expect(latin1.decode(withLogo, allowInvalid: true).contains(RegExp(r'/Subtype\s*/Image')), isTrue);
      expect(latin1.decode(without, allowInvalid: true).contains(RegExp(r'/Subtype\s*/Image')), isFalse);
    });
    test('an unreadable logo never blocks the receipt (prints without it)', () async {
      final pdf = await build(Uint8List.fromList([1, 2, 3, 4, 5]));
      expect(String.fromCharCodes(pdf.take(5)), '%PDF-');
      expect(latin1.decode(pdf, allowInvalid: true).contains(RegExp(r'/Subtype\s*/Image')), isFalse);
    });
  });
}
