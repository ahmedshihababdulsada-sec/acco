/// بيانات الوصل (مطابقة لحقول payments / payment_items / payment_tenders بقاعدة البيانات).
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

  int get gross => items.fold(0, (s, i) => s + i.price);
  int get offerDiscount =>
      items.fold(0, (s, i) => s + (i.price * i.offerPercent / 100).round());

  /// الصافي يتقرب لأقرب 250 دينار لصالح الزبون (القسم 12 هـ بالخطة).
  int get net {
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

  int get rounding => gross - offerDiscount - manualDiscount - pointsUsed - net;
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

/// عينات الاختبار.
ReceiptData sampleShort() => const ReceiptData(
      clinicName: 'مركز الأناقة للتجميل',
      address: 'بغداد · الكرادة',
      phone: '0770 123 4567',
      number: '2026-00131',
      when: '14/11/2026 · 16:42',
      cashier: 'سارة محمد',
      customer: 'نور علي',
      code: 'C-0977',
      items: [
        ReceiptItem(
            title: 'ليزر: وجه + إبط',
            sub: 'جلسة 2 من 6 · عرض 20%',
            date: '14/11/2026',
            price: 40000,
            offerPercent: 20),
        ReceiptItem(
            title: 'تنظيف بشرة', sub: 'جلسة 1 من 1', date: '14/11/2026', price: 30000),
      ],
      manualDiscount: 4800,
      pointsUsed: 6500,
      tenders: [ReceiptTender('كاش', 0), ReceiptTender('كي كارد · جهاز Q', 30000)],
    );

/// أسوأ حالة: اسم طويل، خدمة بإسم طويل بيه لاتيني، أرقام كبيرة.
ReceiptData sampleStress() => const ReceiptData(
      clinicName: 'مركز الأناقة الدولي للتجميل والليزر والعناية بالبشرة',
      address: 'بغداد · الكرادة · شارع 62 · قرب مجمع الصالحية',
      phone: '0770 123 4567',
      number: '2026-00999',
      when: '14/11/2026 · 23:59',
      cashier: 'سارة محمد عبد الرحمن',
      customer: 'زينب حسين علي محمد الموسوي الكعبي',
      code: 'C-10234',
      items: [
        ReceiptItem(
            title: 'ميزوثيرابي للوجه والرقبة مع قناع الكولاجين وحقن PRP المركز للشعر',
            sub: 'جلسة 12 من 12 · عرض 20% · ملاحظة طويلة للتجربة فقط',
            date: '14/11/2026',
            price: 99000000,
            offerPercent: 20),
        ReceiptItem(title: 'Botox 12 cc', sub: 'جلسة 1 من 3', date: '14/11/2026', price: 1250000),
        ReceiptItem(title: 'تنظيف', sub: 'جلسة 1 من 1', date: '14/11/2026', price: 30000),
      ],
      manualDiscount: 1000000,
      pointsUsed: 500000,
      tenders: [ReceiptTender('كاش', 0), ReceiptTender('ماستر كارد · جهاز Q', 20000000)],
    );

ReceiptData sampleLong() {
  const names = [
    'بوتكس: جبهة + عيون (12 cc)',
    'فلر: شفايف',
    'ليزر: فول بدي',
    'تنظيف بشرة عميق مع قناع',
    'ميزوثيرابي للوجه',
    'ليزر: يدين + رجلين',
    'بلازما PRP للشعر',
    'بوتكس: فك',
    'تقشير كيميائي',
    'ليزر: وجه',
    'فلر: خدود',
    'هيدرافيشل',
    'ليزر: إبط',
    'كشفية متابعة',
  ];
  return ReceiptData(
    clinicName: 'مركز الأناقة للتجميل',
    address: 'بغداد · الكرادة',
    phone: '0770 123 4567',
    number: '2026-00119',
    when: '14/11/2026 · 12:05',
    cashier: 'سارة محمد',
    customer: 'زينب حسين الموسوي',
    code: 'C-0412',
    items: [
      for (var i = 0; i < names.length; i++)
        ReceiptItem(
          title: names[i],
          sub: 'جلسة ${i % 4 + 1} من ${i % 4 + 3}',
          date: '14/11/2026',
          price: 25000 + i * 12500,
          offerPercent: i % 5 == 0 ? 10 : 0,
        ),
    ],
    manualDiscount: 25000,
    pointsUsed: 12500,
    tenders: const [
      ReceiptTender('كاش', 500000),
      ReceiptTender('كي كارد · جهاز Q', 0),
    ],
  );
}
