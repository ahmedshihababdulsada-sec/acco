import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/theme.dart';
import '../../core/widgets.dart';
import 'cashier_state.dart';

/// فتح الشفت بالفكة. يرجع true إذا انفتح.
Future<bool> openShiftDialog(BuildContext context, CashierState st) async {
  final ctrl = TextEditingController(text: '0');
  final r = await showDialog<bool>(
    context: context,
    builder: (c) => AlertDialog(
      title: const Text('فتح الشفت'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        const Text('الفكة اللي استلمتها من المدير (دينار):'),
        const SizedBox(height: 12),
        TextField(controller: ctrl, autofocus: true, keyboardType: TextInputType.number, textDirection: TextDirection.ltr, decoration: deco('الفكة', suffix: 'د.ع')),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('رجوع')),
        FilledButton(onPressed: () async {
          final v = int.tryParse(ctrl.text.replaceAll(',', '').trim());
          if (v == null || v < 0) { toast(c, 'اكتب مبلغ صحيح', error: true); return; }
          try { await st.api.post('/shifts/open', body: {'opening_float': v}); if (c.mounted) Navigator.pop(c, true); } catch (e) { if (c.mounted) showError(c, e); }
        }, child: const Text('فتح')),
      ],
    ),
  );
  return r ?? false;
}

/// زبون جديد (الاسم والتلفون). إذا الرقم مسجل يرجع الزبون الموجود. يرجع id الزبون.
Future<int?> newCustomerDialog(BuildContext context) async {
  final name = TextEditingController();
  final phone = TextEditingController();
  final api = context.read<Api>();
  return showDialog<int>(
    context: context,
    builder: (c) => AlertDialog(
      title: const Text('زبون جديد'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: name, autofocus: true, decoration: deco('الاسم الكامل')),
        const SizedBox(height: 12),
        TextField(controller: phone, keyboardType: TextInputType.phone, textDirection: TextDirection.ltr, decoration: deco('رقم الموبايل', hint: '07701234567')),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c), child: const Text('رجوع')),
        FilledButton(onPressed: () async {
          try {
            final r = Map<String, dynamic>.from(await api.post('/customers', body: {'full_name': name.text.trim(), 'phone': phone.text.trim()}) as Map);
            if (c.mounted) Navigator.pop(c, r['id'] as int);
          } on ApiException catch (e) {
            if (e.code == 'PHONE_EXISTS' && c.mounted) {
              final ex = e.body?['customer'] as Map?;
              final use = await confirm(c, 'الرقم مسجل', body: ex == null ? e.message : 'هذا الرقم للزبون ${ex['full_name']} (${ex['public_code']}). تفتح ملفه؟', yes: 'فتح ملفه');
              if (use && c.mounted && ex != null) Navigator.pop(c, ex['id'] as int);
            } else if (c.mounted) { showError(c, e); }
          }
        }, child: const Text('حفظ')),
      ],
    ),
  );
}

/// حجز كشفية: النوع والطبيب واليوم والخدمة والملاحظة. [returning] = الزبون عنده كشفية/جلسات سابقة (الافتراضي «جلسات فقط»: الكشفية للجديد بس). يرجع true إذا انحجز.
Future<bool> bookingDialog(BuildContext context, int customerId, {bool returning = false}) async {
  final api = context.read<Api>();
  List<Map<String, dynamic>> docs;
  try { docs = ((await api.get('/schedule/doctors'))['doctors'] as List).cast<Map<String, dynamic>>(); } catch (e) { showError(context, e); return false; }
  if (docs.isEmpty) { toast(context, 'ما أكو أطباء فعالين', error: true); return false; }
  int doctor = docs.first['id'] as int;
  String date = todayIso();
  String? hint;
  String type = returning ? 'sessions_only' : 'standard';   // 'sessions_only' = جلسات فقط (الكشفية مجانية أو بسعر العيادة)
  List<Map<String, dynamic>> services = [];
  try { services = ((await api.get('/services')) as List).cast<Map<String, dynamic>>().where((s) => s['kind'] == 'treatment' && s['is_active'] != false).toList(); } catch (_) {}
  int? service; final note = TextEditingController();
  if (!context.mounted) return false;
  final r = await showDialog<bool>(
    context: context,
    builder: (c) => StatefulBuilder(builder: (c, setS) => AlertDialog(
      title: const Text('حجز كشفية'),
      content: SizedBox(width: 380, child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SegmentedButton<String>(
          segments: const [ButtonSegment(value: 'standard', label: Text('كشفية + جلسات')), ButtonSegment(value: 'sessions_only', label: Text('جلسات فقط'))],
          selected: {type}, onSelectionChanged: (v) => setS(() { type = v.first; hint = null; }),
        ),
        if (returning) const Padding(padding: EdgeInsets.only(top: 6), child: Text('الزبون عنده كشفية سابقة: اخترنا «جلسات فقط». غيّرها إذا يريد كشفية جديدة.', key: ValueKey('returning-hint'), style: TextStyle(color: Palette.muted, fontSize: 13))),
        const SizedBox(height: 12),
        DropdownButtonFormField<int>(initialValue: doctor, decoration: deco('الطبيب'), items: [for (final d in docs) DropdownMenuItem(value: d['id'] as int, child: Text('${d['full_name']}'))], onChanged: (v) => setS(() { doctor = v!; hint = null; })),
        const SizedBox(height: 12),
        DateField(label: 'اليوم', value: date, first: DateTime.now(), last: DateTime.now().add(const Duration(days: 60)), onChanged: (v) => setS(() { date = v; hint = null; })),
        if (services.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 12), child: DropdownButtonFormField<int?>(
          key: const ValueKey('interest-service'), initialValue: service, decoration: deco('الخدمة المطلوبة (اختياري)'),
          items: [const DropdownMenuItem<int?>(value: null, child: Text('غير محددة')), for (final s in services) DropdownMenuItem<int?>(value: s['id'] as int, child: Text('${s['name_ar']}'))],
          onChanged: (v) => setS(() => service = v))),
        Padding(padding: const EdgeInsets.only(top: 12), child: TextField(key: const ValueKey('booking-note'), controller: note, maxLength: 500, maxLines: 2, decoration: deco('ملاحظة للطبيب (اختياري)', hint: 'ليش اختار هذي الخدمة، حساسية...'))),
        if (hint != null) Padding(padding: const EdgeInsets.only(top: 12), child: Notice(hint!, kind: NoticeKind.warn)),
      ])),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('رجوع')),
        FilledButton(onPressed: () async {
          try { await api.post('/bookings', body: {'customer_id': customerId, 'doctor_id': doctor, 'date': date, 'type': type, if (service != null) 'service_id': service, if (note.text.trim().isNotEmpty) 'note': note.text.trim()}); if (c.mounted) Navigator.pop(c, true); }
          on ApiException catch (e) {
            final next = e.body?['next_available_date'];
            setS(() => hint = next == null ? e.message : '${e.message}. أقرب يوم متاح: ${dmy(next as String)}');
            if (next != null) date = next;
          }
        }, child: const Text('حجز')),
      ],
    )),
  );
  return r ?? false;
}

/// يختار تاريخ (نقل جلسة أو حجز جلسة) ويرجع بنتيجة النداء، مع اقتراح يوم بديل من رد الخادم.
Future<bool> pickDateAndCall(BuildContext context, {required String title, required String initial, required Future<void> Function(String date) call, String yes = 'تأكيد', DateTime? first}) async {
  String date = initial;
  String? hint;
  final r = await showDialog<bool>(
    context: context,
    builder: (c) => StatefulBuilder(builder: (c, setS) => AlertDialog(
      title: Text(title),
      content: SizedBox(width: 360, child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        DateField(label: 'التاريخ', value: date, first: first ?? DateTime.now(), last: DateTime.now().add(const Duration(days: 365)), onChanged: (v) => setS(() { date = v; hint = null; })),
        if (hint != null) Padding(padding: const EdgeInsets.only(top: 12), child: Notice(hint!, kind: NoticeKind.warn)),
      ])),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('رجوع')),
        FilledButton(onPressed: () async {
          try { await call(date); if (c.mounted) Navigator.pop(c, true); }
          on ApiException catch (e) {
            final next = e.body?['next_available_date'] ?? e.body?['earliest_date'];
            setS(() => hint = next == null ? e.message : '${e.message} (${dmy(next as String)})');
            if (next != null) date = next as String;
          }
        }, child: Text(yes)),
      ],
    )),
  );
  return r ?? false;
}
