import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:pdf/pdf.dart';
import 'package:printing/printing.dart';

import 'receipt/models.dart';
import 'receipt/receipt_pdf.dart';

/// تجربة طباعة وصل A5 بالعربي. الغرض: نتأكد على حاسبة Windows الحقيقية من:
/// 1) الحروف العربية والأرقام تطلع صح 2) مقاس A5 بدون تصغير 3) الطباعة المباشرة على الطابعة.
void main() => runApp(const TrialApp());

class TrialApp extends StatelessWidget {
  const TrialApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'تجربة وصل A5',
        debugShowCheckedModeBanner: false,
        builder: (context, child) => Directionality(textDirection: TextDirection.rtl, child: child!),
        home: const TrialPage(),
      );
}

class TrialPage extends StatefulWidget {
  const TrialPage({super.key});
  @override
  State<TrialPage> createState() => _TrialPageState();
}

class _TrialPageState extends State<TrialPage> {
  final samples = <String, ReceiptData Function()>{
    'وصل قصير': sampleShort,
    'وصل طويل (صفحتين)': sampleLong,
    'أسوأ حالة': sampleStress,
  };
  String current = 'وصل قصير';
  Printer? printer;
  List<Printer> printers = const [];
  late final Future<(ByteData, ByteData)> fonts = _loadFonts();

  Future<(ByteData, ByteData)> _loadFonts() async => (
        await rootBundle.load('assets/fonts/IBMPlexSansArabic-Regular.ttf'),
        await rootBundle.load('assets/fonts/IBMPlexSansArabic-Bold.ttf'),
      );

  @override
  void initState() {
    super.initState();
    Printing.listPrinters().then((p) {
      if (mounted) setState(() => printers = p);
    }).catchError((_) {});
  }

  Future<Uint8List> _build() async {
    final f = await fonts;
    return buildReceiptPdf(samples[current]!(), regular: f.$1, bold: f.$2);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('تجربة وصل A5 بالعربي')),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
            for (final k in samples.keys)
              ChoiceChip(label: Text(k), selected: k == current, onSelected: (_) => setState(() => current = k)),
            DropdownButton<Printer>(
              hint: const Text('اختر الطابعة'),
              value: printer,
              items: [for (final p in printers) DropdownMenuItem(value: p, child: Text(p.name))],
              onChanged: (p) => setState(() => printer = p),
            ),
            FilledButton(
              onPressed: printer == null
                  ? null
                  : () async => Printing.directPrintPdf(
                        printer: printer!,
                        format: PdfPageFormat.a5,
                        onLayout: (_) => _build(),
                      ),
              child: const Text('طباعة مباشرة'),
            ),
            OutlinedButton(
              onPressed: () async => Printing.layoutPdf(format: PdfPageFormat.a5, onLayout: (_) => _build()),
              child: const Text('نافذة الطباعة'),
            ),
          ]),
        ),
        const Divider(height: 1),
        Expanded(
          child: PdfPreview(
            key: ValueKey(current),
            build: (_) => _build(),
            initialPageFormat: PdfPageFormat.a5,
            canChangePageFormat: false,
            canChangeOrientation: false,
            canDebug: false,
          ),
        ),
      ]),
    );
  }
}
