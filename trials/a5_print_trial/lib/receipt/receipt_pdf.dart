import 'dart:typed_data';

import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;

import 'mixed_text.dart';
import 'models.dart';

const _ink = PdfColors.black;
const _grey = PdfColor.fromInt(0xFF3D4652);
const _line = PdfColor.fromInt(0xFFB8BEC8);

// المقاس: A5 = 148×210 مم. الهوامش 30pt (= 40px بالنموذج، لأن 1px = 0.75pt).
const _margin = 30.0;
const _amountCol = 96.0; // = 128px
const _dateCol = 72.0; // = 96px
// عرض عمود الخدمة = عرض المحتوى (419.5 − 60) − التاريخ − السعر − فراغات الصف
const _titleCol = 419.5 - 2 * _margin - _dateCol - _amountCol - 4;

/// يولد وصل A5 بالعربي (RTL). نقية Dart (بدون Flutter) حتى تشتغل من سطر الأوامر ومن التطبيق.
Future<Uint8List> buildReceiptPdf(
  ReceiptData r, {
  required ByteData regular,
  required ByteData bold,
}) async {
  final base = pw.Font.ttf(regular);
  final strong = pw.Font.ttf(bold);
  final measurer = TextMeasurer(regular, bold);
  final doc = pw.Document(
    title: 'وصل ${r.number}',
    theme: pw.ThemeData.withFont(base: base, bold: strong),
  );

  pw.Widget ltr(String t, {double size = 10.5, bool b = false, pw.TextAlign? align}) =>
      pw.Text(t,
          textDirection: pw.TextDirection.ltr,
          textAlign: align,
          style: pw.TextStyle(fontSize: size, fontWeight: b ? pw.FontWeight.bold : null));

  // ملاحظة مهمة (اكتشفناها بالتجربة): مع هذا الخط ومكتبة pdf المسافة بين الكلمات العربية تطلع صفر
  // إذا ما انضبط wordSpacing، فالكلمات تلتصق. نحط 16% من حجم الخط.
  pw.Widget rtl(String t,
      {double size = 10.5,
      bool b = false,
      PdfColor color = _ink,
      pw.TextAlign? align,
      double maxWidth = _titleCol}) {
    pw.TextStyle style(double s, bool bb) => pw.TextStyle(
        fontSize: s,
        color: color,
        fontWeight: bb ? pw.FontWeight.bold : null,
        wordSpacing: s * 0.16);
    // النص اللي بيه حروف لاتينية أو % يتقسم لمقاطع (عربي/LTR) حتى يثبت ترتيبه ومسافاته
    if (RegExp(r'[A-Za-z%]').hasMatch(t)) {
      return mixedText(t,
          size: size, bold: b, style: style, measurer: measurer, maxWidth: maxWidth);
    }
    return pw.Text(t, textDirection: pw.TextDirection.rtl, textAlign: align, style: style(size, b));
  }

  pw.Widget header() => pw.Container(
        padding: const pw.EdgeInsets.only(bottom: 9),
        decoration: const pw.BoxDecoration(
            border: pw.Border(bottom: pw.BorderSide(width: 1.5, color: _ink))),
        child: pw.Row(
          crossAxisAlignment: pw.CrossAxisAlignment.center,
          children: [
            pw.Container(
              width: 42,
              height: 42,
              alignment: pw.Alignment.center,
              decoration: pw.BoxDecoration(
                  border: pw.Border.all(color: _grey, width: 0.7, style: pw.BorderStyle.dashed)),
              child: rtl('[الشعار]', size: 9, color: _grey),
            ),
            pw.SizedBox(width: 10),
            pw.Expanded(
              child: pw.Column(
                crossAxisAlignment: pw.CrossAxisAlignment.start, // بالـ RTL = اليمين
                children: [
                  rtl(r.clinicName, size: 16.5, b: true),
                  pw.Row(children: [
                    pw.Flexible(child: rtl('${r.address} · ', size: 9.5, color: _grey)),
                    ltr(r.phone, size: 9.5),
                  ]),
                ],
              ),
            ),
            pw.Column(
              crossAxisAlignment: pw.CrossAxisAlignment.start,
              children: [
                rtl('وصل دفع', size: 9.5, b: true),
                ltr(r.number, size: 16.5, b: true), // 2026-00131 يبقى بنفس الترتيب
              ],
            ),
          ],
        ),
      );

  pw.Widget footer(pw.Context ctx) => pw.Container(
        padding: const pw.EdgeInsets.only(top: 6),
        decoration: const pw.BoxDecoration(
            border: pw.Border(top: pw.BorderSide(width: 0.7, color: _ink))),
        child: pw.Row(
          mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
          children: [
            rtl('شكراً لزيارتكم', b: true),
            pw.Row(children: [
              rtl('صفحة ', size: 9, color: _grey),
              ltr('${ctx.pageNumber} / ${ctx.pagesCount}', size: 9),
            ]),
          ],
        ),
      );

  pw.Widget metaCell(String label, pw.Widget value, {int flex = 1}) => pw.Expanded(
        flex: flex,
        child: pw.Row(crossAxisAlignment: pw.CrossAxisAlignment.start, children: [
          rtl('$label: ', color: _grey),
          pw.Expanded(child: pw.Align(alignment: pw.Alignment.centerRight, child: value)),
        ]),
      );

  pw.Widget meta() => pw.Column(children: [
        pw.Row(children: [
          metaCell('التاريخ والوقت', ltr(r.when)),
          metaCell('الكاشير', rtl(r.cashier)),
        ]),
        pw.SizedBox(height: 3),
        pw.Row(children: [
          metaCell('الزبون', rtl(r.customer, b: true, maxWidth: 150), flex: 3),
          metaCell('الرمز المميز', ltr(r.code, b: true), flex: 2),
        ]),
      ]);

  pw.Widget tableHead() => pw.Container(
        padding: const pw.EdgeInsets.symmetric(vertical: 4),
        decoration: const pw.BoxDecoration(
            border: pw.Border(
                top: pw.BorderSide(width: 0.7, color: _ink),
                bottom: pw.BorderSide(width: 1.5, color: _ink))),
        child: pw.Row(children: [
          pw.Expanded(child: rtl('الخدمة', size: 9.75, b: true)),
          pw.SizedBox(width: _dateCol, child: rtl('موعد الجلسة', size: 9.75, b: true)),
          pw.SizedBox(
              width: _amountCol,
              child: rtl('السعر (د.ع)', size: 9.75, b: true, align: pw.TextAlign.right)),
        ]),
      );

  // الصف وحدة ما تنشطر بين صفحتين
  pw.Widget itemRow(ReceiptItem it) => pw.Container(
        padding: const pw.EdgeInsets.symmetric(vertical: 6),
        decoration: const pw.BoxDecoration(
            border: pw.Border(bottom: pw.BorderSide(width: 0.5, color: _line))),
        child: pw.Row(
          crossAxisAlignment: pw.CrossAxisAlignment.start,
          children: [
            pw.Expanded(
              child: pw.Column(crossAxisAlignment: pw.CrossAxisAlignment.start, children: [
                rtl(it.title, size: 11.25, b: true),
                rtl(it.sub, size: 9.75, color: _grey),
              ]),
            ),
            pw.SizedBox(width: _dateCol, child: ltr(it.date, align: pw.TextAlign.right)),
            pw.SizedBox(
                width: _amountCol,
                child: ltr(groupDigits(it.price), size: 11.25, b: true, align: pw.TextAlign.right)),
          ],
        ),
      );

  pw.Widget amountLine(String label, int amount, {bool minus = false}) => pw.Padding(
        padding: const pw.EdgeInsets.only(top: 2),
        child: pw.Row(children: [
          pw.Expanded(
              child: pw.Align(alignment: pw.Alignment.centerRight, child: rtl(label, maxWidth: 250))),
          pw.SizedBox(
              width: _amountCol,
              child: ltr('${minus ? '− ' : ''}${groupDigits(amount)}', align: pw.TextAlign.right)),
        ]),
      );

  pw.Widget totals() => pw.Column(children: [
        pw.SizedBox(height: 6),
        amountLine('المجموع', r.gross),
        if (r.offerDiscount > 0) amountLine('خصم العرض', r.offerDiscount, minus: true),
        if (r.manualDiscount > 0) amountLine('خصم المدير', r.manualDiscount, minus: true),
        if (r.pointsUsed > 0)
          amountLine('النقاط المستخدمة (${groupDigits(r.pointsUsed)} نقطة)', r.pointsUsed, minus: true),
        if (r.rounding > 0) amountLine('تقريب لأقرب 250', r.rounding, minus: true),
        pw.Container(
          margin: const pw.EdgeInsets.only(top: 5),
          padding: const pw.EdgeInsets.only(top: 6),
          decoration: const pw.BoxDecoration(
              border: pw.Border(top: pw.BorderSide(width: 1.5, color: _ink))),
          child: pw.Row(
            crossAxisAlignment: pw.CrossAxisAlignment.end,
            children: [
              pw.Expanded(child: rtl('الصافي (د.ع)', size: 13.5, b: true)),
              pw.SizedBox(
                width: _amountCol,
                child: pw.Row(
                  mainAxisAlignment: pw.MainAxisAlignment.start,
                  crossAxisAlignment: pw.CrossAxisAlignment.end,
                  children: [
                    ltr(groupDigits(r.net), size: 18, b: true),
                  ],
                ),
              ),
            ],
          ),
        ),
        pw.Container(
          margin: const pw.EdgeInsets.only(top: 8),
          padding: const pw.EdgeInsets.only(top: 6),
          decoration: const pw.BoxDecoration(
              border: pw.Border(top: pw.BorderSide(width: 0.7, color: _ink))),
          child: pw.Column(crossAxisAlignment: pw.CrossAxisAlignment.start, children: [
            rtl('طريقة الدفع', size: 9.75, b: true),
            for (final t in r.resolvedTenders) amountLine(t.label, t.amount),
          ]),
        ),
      ]);

  // آخر بندين + المجاميع + الدفع بقطعة وحدة ما تنشطر: المجاميع ما تنفرد بصفحة لحالها
  final items = r.items;
  final tailCount = items.length >= 2 ? 2 : items.length;
  final head = items.sublist(0, items.length - tailCount);
  final tail = items.sublist(items.length - tailCount);

  doc.addPage(
    pw.MultiPage(
      pageFormat: PdfPageFormat.a5.copyWith(
          marginLeft: _margin, marginRight: _margin, marginTop: _margin, marginBottom: _margin),
      textDirection: pw.TextDirection.rtl,
      maxPages: 20,
      header: (ctx) => pw.Column(children: [header(), pw.SizedBox(height: 8)]),
      footer: (ctx) => pw.Column(children: [pw.SizedBox(height: 6), footer(ctx)]),
      build: (ctx) => [
        meta(),
        pw.SizedBox(height: 8),
        tableHead(),
        for (final it in head) itemRow(it),
        // Inseparable: القطعة كلها (آخر بندين + المجاميع + الدفع) تنتقل مع بعض
        // (Container و Column و SizedBox كلها تنشطر بين الصفحات بمكتبة pdf، وجربناها).
        pw.Inseparable(
          child: pw.Column(mainAxisSize: pw.MainAxisSize.min, children: [
            for (final it in tail) itemRow(it),
            totals(),
          ]),
        ),
      ],
    ),
  );

  return doc.save();
}
