import 'dart:typed_data';

import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;

/// نص عربي مختلط بأرقام أو حروف لاتينية بسطر RTL.
/// الطريقة: نقسم النص لمقاطع (كلمات عربية متتالية = مقطع RTL، وأرقام/لاتيني متتالية = مقطع LTR)
/// ونركبها بصف RTL مع مسافة ثابتة بيناتها. هذا يضمن ترتيب الأرقام و`%` و`C-0977` بغض النظر
/// عن معالجة المكتبة للاتجاهات.
List<({bool ltr, String text})> splitMixed(String input) {
  bool hasArabic(String s) => RegExp(r'[؀-ۿݐ-ݿ]').hasMatch(s);
  bool hasLatinOrDigit(String s) => RegExp(r'[A-Za-z0-9]').hasMatch(s);

  final words = input.split(' ').where((w) => w.isNotEmpty).toList();
  final segs = <({bool ltr, String text})>[];
  String pendingNeutral = '';
  for (final w in words) {
    final ar = hasArabic(w);
    final lt = !ar && hasLatinOrDigit(w);
    if (!ar && !lt) {
      // رمز حيادي مثل · أو + أو -: يلتصق بالمقطع العربي اللي قبله
      if (segs.isNotEmpty && !segs.last.ltr) {
        segs[segs.length - 1] = (ltr: false, text: '${segs.last.text} $w');
      } else {
        pendingNeutral = pendingNeutral.isEmpty ? w : '$pendingNeutral $w';
      }
      continue;
    }
    if (segs.isNotEmpty && segs.last.ltr == lt) {
      segs[segs.length - 1] = (ltr: lt, text: '${segs.last.text} $w');
    } else {
      final t = (pendingNeutral.isNotEmpty && !lt) ? '$pendingNeutral $w' : w;
      pendingNeutral = '';
      segs.add((ltr: lt, text: t));
    }
  }
  return segs;
}

/// يقيس عرض النص بالخط الفعلي (نفس ملفات الخط اللي تنحط بالـ PDF).
class TextMeasurer {
  TextMeasurer(ByteData regular, ByteData bold)
      : _doc = PdfDocument(),
        _regularBytes = regular,
        _boldBytes = bold {
    _regular = PdfTtfFont(_doc, _regularBytes);
    _bold = PdfTtfFont(_doc, _boldBytes);
  }
  final PdfDocument _doc;
  final ByteData _regularBytes;
  final ByteData _boldBytes;
  late final PdfTtfFont _regular;
  late final PdfTtfFont _bold;

  double width(String s, double size, {bool bold = false}) =>
      (bold ? _bold : _regular).stringMetrics(s).advanceWidth * size;
}

/// نص مختلط يلف على أكثر من سطر. كل سطر صف RTL من المقاطع.
/// (pw.Wrap يرتب العناصر LTR حتى بسياق RTL، فالتقطيع اليدوي هو الحل.)
pw.Widget mixedText(
  String input, {
  double size = 10.5,
  bool bold = false,
  required pw.TextStyle Function(double size, bool bold) style,
  required TextMeasurer measurer,
  required double maxWidth,
  double gap = 3,
}) {
  final words = input.split(' ').where((w) => w.isNotEmpty).toList();
  final space = size * 0.16 + gap;
  final lines = <List<String>>[[]];
  var used = 0.0;
  for (final w in words) {
    final ww = measurer.width(w, size, bold: bold) * 1.04; // هامش أمان للتشكيل
    final add = lines.last.isEmpty ? ww : space + ww;
    if (lines.last.isNotEmpty && used + add > maxWidth) {
      lines.add([w]);
      used = ww;
    } else {
      lines.last.add(w);
      used += add;
    }
  }
  pw.Widget row(String text) {
    final segs = splitMixed(text);
    return pw.Row(mainAxisSize: pw.MainAxisSize.min, children: [
      for (var i = 0; i < segs.length; i++) ...[
        if (i > 0) pw.SizedBox(width: gap),
        pw.Text(
          segs[i].text,
          textDirection: segs[i].ltr ? pw.TextDirection.ltr : pw.TextDirection.rtl,
          style: style(size, bold),
        ),
      ],
    ]);
  }

  return pw.Column(
    crossAxisAlignment: pw.CrossAxisAlignment.start, // بالـ RTL = اليمين
    children: [for (final l in lines) row(l.join(' '))],
  );
}
