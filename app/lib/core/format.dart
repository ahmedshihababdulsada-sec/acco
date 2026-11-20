import 'package:intl/intl.dart' as intl;

/// مبلغ بالدينار العراقي: أعداد صحيحة بفواصل آلاف (الخادم يخزن دينار صحيح).
String money(num n) => '${_group(n.round())} د.ع';

String moneyPlain(num n) => _group(n.round());

String _group(int n) {
  final s = n.abs().toString();
  final b = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
    b.write(s[i]);
  }
  return (n < 0 ? '-' : '') + b.toString();
}

/// يعزل نص من اليسار لليمين (LRI/PDI) داخل سطر عربي: رقم الوصل 2026-00119 ورمز الزبون والتلفون حتى ما ينقلب ترتيبه.
String ltr(String s) => '\u2066$s\u2069';

/// تاريخ YYYY-MM-DD → 14/11/2026 (يومي/شهري/سنوي) للعرض.
String dmy(String? iso) {
  if (iso == null || iso.length < 10) return iso ?? '';
  return '${iso.substring(8, 10)}/${iso.substring(5, 7)}/${iso.substring(0, 4)}';
}

String isoDate(DateTime d) => intl.DateFormat('yyyy-MM-dd').format(d);

String todayIso() => isoDate(DateTime.now());

String addDaysIso(String iso, int n) => isoDate(DateTime.parse(iso).add(Duration(days: n)));

const weekdaysAr = ['الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد'];

/// اسم يوم الأسبوع من تاريخ ISO (1=الاثنين … 7=الأحد مثل الخادم).
String weekdayName(String iso) => weekdaysAr[DateTime.parse(iso).weekday - 1];

/// يوقت من timestamp ISO إلى HH:mm محلياً.
String hm(String? iso) {
  if (iso == null) return '';
  final d = DateTime.tryParse(iso)?.toLocal();
  return d == null ? '' : intl.DateFormat('HH:mm').format(d);
}
