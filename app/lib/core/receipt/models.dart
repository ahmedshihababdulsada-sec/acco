import 'dart:typed_data';

import '../api.dart';

/// بيانات الوصل (مطابقة لحقول payments / payment_items / payment_tenders بقاعدة البيانات).
/// الصافي والتقريب والخصومات تجي من الخادم (`ReceiptData.fromServer`) وما تنحسب بالتطبيق.
class ReceiptItem {
  const ReceiptItem({
    required this.title,
    required this.sub,
    required this.date,
    required this.price,
    this.offerPercent = 0,
  });
  final String title; // اسم الخدمة (عربي، ممكن بيه كلمات لاتينية)
  final String sub; // مثل: جلسة 2 من 6
  final String date; // dd/MM/yyyy
  final int price; // دينار صحيح
  final int offerPercent;
}

class ReceiptTender {
  const ReceiptTender(this.label, this.amount);
  final String label;
  final int amount;
}

class ReceiptData {
  const ReceiptData({
    required this.number,
    required this.when,
    required this.cashier,
    required this.customer,
    required this.code,
    required this.items,
    required this.tenders,
    this.manualDiscount = 0,
    this.pointsUsed = 0,
    this.clinicName = '[اسم العيادة]',
    this.address = '[العنوان]',
    this.phone = '[رقم الهاتف]',
    this.grossFixed,
    this.offerFixed,
    this.netFixed,
    this.roundingFixed,
    this.logo,
  });

  final String number;
  final String when;
  final String cashier;
  final String customer;
  final String code;
  final List<ReceiptItem> items;
  final List<ReceiptTender> tenders;
  final int manualDiscount;
  final int pointsUsed;
  final String clinicName;
  final String address;
  final String phone;

  /// أرقام الخادم (المرجع): إذا انعطت تنعرض كما هي بدون إعادة حساب (الوصل ما يتغير بتغيير الأسعار).
  final int? grossFixed;
  final int? offerFixed;
  final int? netFixed;
  final int? roundingFixed;

  /// صورة شعار العيادة (PNG/JPG) إذا مضبوط؛ بدونه ما ينرسم مربع الشعار.
  final Uint8List? logo;

  int get gross => grossFixed ?? items.fold(0, (s, i) => s + i.price);
  int get offerDiscount =>
      offerFixed ?? items.fold(0, (s, i) => s + (i.price * i.offerPercent / 100).round());

  /// الصافي يتقرب لأقرب 250 دينار لصالح الزبون (القسم 12 هـ بالخطة).
  int get net {
    if (netFixed != null) return netFixed!;
    final raw = gross - offerDiscount - manualDiscount - pointsUsed;
    return (raw ~/ 250) * 250;
  }

  /// الطريقة اللي مبلغها 0 تاخذ الباقي من الصافي (للعينات بس؛ بالنظام الحقيقي كل طريقة بمبلغها).
  List<ReceiptTender> get resolvedTenders {
    final fixed = tenders.fold<int>(0, (s, t) => s + t.amount);
    return [
      for (final t in tenders)
        if (t.amount == 0) ReceiptTender(t.label, net - fixed) else t,
    ].where((t) => t.amount > 0).toList();
  }

  int get rounding => roundingFixed ?? (gross - offerDiscount - manualDiscount - pointsUsed - net);
}

String groupDigits(int n) {
  final s = n.abs().toString();
  final b = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
    b.write(s[i]);
  }
  return (n < 0 ? '-' : '') + b.toString();
}


/// يحول رد الخادم (GET /payments/:id أو رد الدفع) لبيانات الطباعة.
ReceiptData receiptFromServer(Map<String, dynamic> j, {Uint8List? logo}) {
  String two(int n) => n.toString().padLeft(2, '0');
  String dmy(String iso) => iso.length >= 10 ? '${iso.substring(8, 10)}/${iso.substring(5, 7)}/${iso.substring(0, 4)}' : iso;
  final paid = DateTime.tryParse(j['paid_at'] as String? ?? '')?.toLocal();
  final when = paid == null ? dmy(j['business_date'] as String? ?? '') : '${two(paid.day)}/${two(paid.month)}/${paid.year} · ${two(paid.hour)}:${two(paid.minute)}';
  final clinic = (j['clinic'] as Map?)?.cast<String, dynamic>() ?? const {};
  final date = dmy(j['business_date'] as String? ?? '');
  final items = <ReceiptItem>[];
  for (final i in (j['items'] as List).cast<Map<String, dynamic>>()) {
    final pct = (i['offer_percent'] as num?)?.toDouble();
    final qty = (i['quantity'] as num?)?.toDouble() ?? 1;
    final kind = i['item_type'] == 'consultation' ? 'كشفية' : 'جلسة';
    final parts = <String>[kind, if (qty != 1) '${qty % 1 == 0 ? qty.toInt() : qty}', if (pct != null && pct > 0) 'عرض ${pct % 1 == 0 ? pct.toInt() : pct}%'];
    items.add(ReceiptItem(title: i['service_name'] as String, sub: parts.join(' · '), date: date, price: (i['list_price'] as num).toInt(), offerPercent: 0));
  }
  return ReceiptData(
    number: j['receipt_no'] as String,
    when: when,
    cashier: (j['cashier'] as Map)['full_name'] as String,
    customer: (j['customer'] as Map)['full_name'] as String,
    code: (j['customer'] as Map)['public_code'] as String,
    items: items,
    tenders: [for (final t in (j['tenders'] as List).cast<Map<String, dynamic>>()) ReceiptTender(t['device_label'] == null ? t['method_name'] as String : '${t['method_name']} · ${t['device_label']}', (t['amount'] as num).toInt())],
    manualDiscount: (j['manual_discount'] as num).toInt(),
    pointsUsed: (j['points_discount'] as num).toInt(),
    clinicName: (clinic['name'] as String?) ?? '[اسم العيادة]',
    address: (clinic['address'] as String?) ?? '',
    phone: (clinic['phone'] as String?) ?? '',
    grossFixed: (j['gross_amount'] as num).toInt(),
    offerFixed: (j['offer_discount'] as num).toInt(),
    netFixed: (j['net_amount'] as num).toInt(),
    roundingFixed: (j['rounding_amount'] as num).toInt(),
    logo: logo,
  );
}

/// ينزل شعار العيادة للطباعة إذا الوصل مسجل له شعار (لقطة العيادة وقت الدفع). أي فشل = بدون شعار (الطباعة ما تتوقف).
Future<Uint8List?> fetchReceiptLogo(Api api, Map<String, dynamic> receipt) async {
  if ((receipt['clinic'] as Map?)?['logo_attachment_id'] == null) return null;
  try { return await api.download('/attachments/logo/current'); } catch (_) { return null; }
}
