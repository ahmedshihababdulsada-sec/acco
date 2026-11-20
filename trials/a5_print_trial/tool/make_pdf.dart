// تشغيل: dart run tool/make_pdf.dart out
import 'dart:io';
import 'dart:typed_data';

import 'package:a5_print_trial/receipt/models.dart';
import 'package:a5_print_trial/receipt/receipt_pdf.dart';

ByteData _font(String path) {
  final b = File(path).readAsBytesSync();
  return ByteData.sublistView(Uint8List.fromList(b));
}

Future<void> main(List<String> args) async {
  final out = args.isNotEmpty ? args[0] : 'out';
  Directory(out).createSync(recursive: true);
  final regular = _font('assets/fonts/IBMPlexSansArabic-Regular.ttf');
  final bold = _font('assets/fonts/IBMPlexSansArabic-Bold.ttf');
  for (final e in {'short': sampleShort(), 'long': sampleLong(), 'stress': sampleStress()}.entries) {
    final bytes = await buildReceiptPdf(e.value, regular: regular, bold: bold);
    File('$out/receipt_${e.key}.pdf').writeAsBytesSync(bytes);
    stdout.writeln('wrote $out/receipt_${e.key}.pdf (${bytes.length} bytes)');
  }
}
