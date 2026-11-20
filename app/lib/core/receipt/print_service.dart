import 'dart:typed_data';

import 'package:flutter/services.dart' show rootBundle;
import 'package:pdf/pdf.dart';
import 'package:printing/printing.dart';

import 'models.dart';
import 'receipt_pdf.dart';

/// توليد وصل A5 وطباعته. الطباعة المباشرة (بدون نافذة) للحاسبات (Windows/Mac)، ونافذة الطباعة لغيرها.
Future<Uint8List> receiptPdfBytes(ReceiptData r) async {
  final regular = await rootBundle.load('assets/fonts/IBMPlexSansArabic-Regular.ttf');
  final bold = await rootBundle.load('assets/fonts/IBMPlexSansArabic-Bold.ttf');
  return buildReceiptPdf(r, regular: regular, bold: bold);
}

/// يفتح نافذة الطباعة/المعاينة (يشتغل على كل المنصات).
Future<bool> printWithDialog(ReceiptData r) async {
  final bytes = await receiptPdfBytes(r);
  return Printing.layoutPdf(onLayout: (_) async => bytes, name: 'وصل ${r.number}', format: PdfPageFormat.a5, usePrinterSettings: true);
}

Future<List<Printer>> listPrinters() async => Printing.listPrinters();

/// طباعة مباشرة بدون نافذة على طابعة محددة (حاسبة العيادة). يرجع true إذا انرسلت للطابعة.
Future<bool> printDirect(ReceiptData r, Printer printer) async {
  final bytes = await receiptPdfBytes(r);
  return Printing.directPrintPdf(printer: printer, onLayout: (_) async => bytes, name: 'وصل ${r.number}', format: PdfPageFormat.a5, usePrinterSettings: true);
}
