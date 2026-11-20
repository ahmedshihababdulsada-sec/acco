import 'dart:io';
import 'dart:typed_data';

import 'package:a5_print_trial/receipt/models.dart';
import 'package:a5_print_trial/receipt/receipt_pdf.dart';
import 'package:flutter_test/flutter_test.dart';

ByteData _font(String p) => ByteData.sublistView(Uint8List.fromList(File(p).readAsBytesSync()));

int _pages(Uint8List pdf) => RegExp(r'/Type\s*/Page\b').allMatches(String.fromCharCodes(pdf)).length;

void main() {
  final regular = _font('assets/fonts/IBMPlexSansArabic-Regular.ttf');
  final bold = _font('assets/fonts/IBMPlexSansArabic-Bold.ttf');

  test('الأرقام: الصافي يتقرب لأقرب 250 لصالح الزبون', () {
    final r = sampleShort();
    expect(r.gross, 70000);
    expect(r.offerDiscount, 8000);
    expect(r.net % 250, 0);
    expect(r.net, 50500); // 70000 − 8000 − 4800 − 6500 = 50700 → 50500
    expect(r.rounding, 200);
    expect(r.resolvedTenders.fold<int>(0, (s, t) => s + t.amount), r.net);
  });

  test('الوصل القصير صفحة وحدة بمقاس A5', () async {
    final pdf = await buildReceiptPdf(sampleShort(), regular: regular, bold: bold);
    expect(String.fromCharCodes(pdf.sublist(0, 5)), '%PDF-');
    expect(_pages(pdf), 1);
  });

  test('الوصل الطويل يكمل بصفحة ثانية', () async {
    final pdf = await buildReceiptPdf(sampleLong(), regular: regular, bold: bold);
    expect(_pages(pdf), 2);
  });
}
