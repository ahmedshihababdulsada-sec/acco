import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/theme.dart';
import '../../core/widgets.dart';

/// بند علاج بالخطة قبل الحفظ: الخدمة وقيم حقولها وعدد الجلسات والفرق وتاريخ أول جلسة.
class DraftItem {
  DraftItem({required this.service, required this.values, required this.sessions, required this.interval, required this.first, this.quote});
  final Map<String, dynamic> service;
  final Map<String, dynamic> values;
  final int sessions;
  final int interval;
  final String first;
  final Map<String, dynamic>? quote;
  Map<String, dynamic> toJson() => {'service_id': service['id'], 'values': values, 'sessions_count': sessions, 'interval_days': interval, 'first_session_date': first};
}

/// بناء خطة لكشفية: يضيف الطبيب بنود، والخادم يسعرها ويحجز كل الجلسات تلقائياً بحفظ واحد.
class PlanBuilder extends StatefulWidget {
  const PlanBuilder({super.key, required this.consultationId, required this.onSaved, this.draftReason});
  final int consultationId;
  final Future<void> Function() onSaved;
  final String? draftReason;
  @override
  State<PlanBuilder> createState() => _PlanBuilderState();
}

class _PlanBuilderState extends State<PlanBuilder> {
  final List<DraftItem> _items = [];
  final _text = TextEditingController();

  @override
  Widget build(BuildContext context) {
    final api = context.read<Api>();
    final total = _items.fold<num>(0, (s, i) => s + (i.quote == null ? 0 : (i.quote!['list_price'] as num) * i.sessions));
    return Section(
      title: 'الخطة العلاجية',
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (widget.draftReason != null) Padding(padding: const EdgeInsets.only(bottom: 10), child: Notice('الخطة السابقة انحفظت مسودة لأن الحجز فشل: ${widget.draftReason}. عدّل التواريخ وأعد الحفظ.', kind: NoticeKind.warn)),
        if (_items.isEmpty) const Padding(padding: EdgeInsets.only(bottom: 8), child: Text('أضف الخدمات اللي يحتاجها الزبون', style: TextStyle(color: Palette.muted))),
        for (final (i, it) in _items.indexed) Container(
          margin: const EdgeInsets.only(bottom: 10), padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(border: Border.all(color: Palette.border), borderRadius: BorderRadius.circular(8)),
          child: Row(children: [
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(it.service['name_ar'] as String, style: const TextStyle(fontWeight: FontWeight.w700)),
              Text('${it.sessions} جلسات · كل ${it.interval} يوم · الأولى ${dmy(it.first)}', style: const TextStyle(color: Palette.muted, fontSize: 13)),
              if (it.values.isNotEmpty) Text(it.values.entries.map((e) => '${e.key}: ${e.value}').join('، '), style: const TextStyle(color: Palette.muted, fontSize: 13)),
            ])),
            if (it.quote != null) Text('${money(it.quote!['list_price'] as num)} للجلسة', style: const TextStyle(fontWeight: FontWeight.w600)),
            IconButton(icon: const Icon(Icons.delete_outline, color: Palette.danger), onPressed: () => setState(() => _items.removeAt(i))),
          ]),
        ),
        OutlinedButton.icon(onPressed: () async { final it = await draftItemDialog(context); if (it != null) setState(() => _items.add(it)); }, icon: const Icon(Icons.add), label: const Text('إضافة خدمة')),
        const SizedBox(height: 12),
        TextField(controller: _text, decoration: deco('ملاحظات العلاج (اختياري)'), maxLines: 2),
        if (_items.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 12), child: KV('التقدير الكلي (بسعر اليوم)', money(total), bold: true)),
        const SizedBox(height: 12),
        AsyncButton(
          onPressed: _items.isEmpty ? null : () async {
            try {
              final plan = Map<String, dynamic>.from(await api.post('/consultations/${widget.consultationId}/plan', body: {'items': [for (final i in _items) i.toJson()], if (_text.text.trim().isNotEmpty) 'treatments_text': _text.text.trim()}) as Map);
              final w = (plan['stock_warnings'] as List?) ?? const [];
              if (context.mounted) toast(context, w.isEmpty ? 'انحفظت الخطة وانحجزت الجلسات' : 'انحفظت الخطة. تنبيه: المخزون ما يكفي لـ${w.length} مادة (المدير يتابع)');
              await widget.onSaved();
            } on ApiException catch (e) {
              if (e.code == 'PLAN_BOOKING_FAILED') { if (context.mounted) toast(context, e.message, error: true); await widget.onSaved(); } else { rethrow; }
            }
          },
          icon: Icons.save_outlined, child: const Text('حفظ الخطة وحجز الجلسات'),
        ),
      ]),
    );
  }
}

/// إضافة بند لخطة موجودة (فعالة). يرجع true إذا انضاف.
Future<bool> addPlanItemDialog(BuildContext context, {required int planId}) async {
  final it = await draftItemDialog(context);
  if (it == null || !context.mounted) return false;
  try { await context.read<Api>().post('/plans/$planId/items', body: it.toJson()); if (context.mounted) toast(context, 'انضاف البند وانحجزت جلساته'); return true; } catch (e) { if (context.mounted) showError(context, e); return false; }
}

/// نافذة بند: اختيار الخدمة وحقولها (حسب نوع كل حقل) والجلسات والفرق وأول تاريخ، مع عرض السعر.
Future<DraftItem?> draftItemDialog(BuildContext context) async {
  final api = context.read<Api>();
  List<Map<String, dynamic>> services;
  try { services = ((await api.get('/services') as List).cast<Map<String, dynamic>>()).where((s) => s['kind'] == 'treatment' && s['is_active'] == true).toList(); } catch (e) { showError(context, e); return null; }
  if (services.isEmpty) { toast(context, 'ما أكو خدمات علاجية فعالة (المدير يضيفها)', error: true); return null; }
  Map<String, dynamic> svc = services.first;
  final values = <String, dynamic>{};
  final controllers = <String, TextEditingController>{};
  final sessions = TextEditingController(text: '1');
  final interval = TextEditingController(text: '7');
  String first = todayIso();
  Map<String, dynamic>? quote;
  String? err;
  if (!context.mounted) return null;
  return showDialog<DraftItem>(
    context: context,
    builder: (c) => StatefulBuilder(builder: (c, setS) {
      final fields = (svc['fields'] as List).cast<Map<String, dynamic>>().where((f) => f['is_active'] == true).toList();
      Future<void> requote() async {
        try { quote = Map<String, dynamic>.from(await api.post('/services/${svc['id']}/quote', body: {'values': values}) as Map); err = null; } on ApiException catch (e) { quote = null; err = e.message; }
        if (c.mounted) setS(() {});
      }
      return AlertDialog(
        title: const Text('إضافة خدمة للخطة'),
        content: SizedBox(width: 460, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          DropdownButtonFormField<int>(initialValue: svc['id'] as int, decoration: deco('الخدمة'), items: [for (final s in services) DropdownMenuItem(value: s['id'] as int, child: Text(s['name_ar'] as String))], onChanged: (v) { svc = services.firstWhere((s) => s['id'] == v); values.clear(); for (final t in controllers.values) { t.clear(); } quote = null; err = null; setS(() {}); requote(); }),
          const SizedBox(height: 10),
          for (final f in fields) Padding(padding: const EdgeInsets.only(bottom: 10), child: _fieldInput(f, values, controllers, requote, setS)),
          Row(children: [
            Expanded(child: TextField(controller: sessions, keyboardType: TextInputType.number, decoration: deco('عدد الجلسات'))),
            const SizedBox(width: 10),
            Expanded(child: TextField(controller: interval, keyboardType: TextInputType.number, decoration: deco('الفرق بالأيام', hint: '7'))),
          ]),
          const SizedBox(height: 10),
          DateField(label: 'تاريخ أول جلسة', value: first, first: DateTime.now(), last: DateTime.now().add(const Duration(days: 365)), onChanged: (v) => setS(() => first = v)),
          const SizedBox(height: 10),
          if (err != null) Notice(err!, kind: NoticeKind.warn) else if (quote != null) Notice('السعر بسعر اليوم: ${money(quote!['list_price'] as num)} للجلسة', kind: NoticeKind.info),
        ]))),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('رجوع')),
          FilledButton(onPressed: () async {
            final n = int.tryParse(sessions.text.trim()); final iv = int.tryParse(interval.text.trim());
            if (n == null || n < 1 || n > 60) { toast(c, 'عدد الجلسات من 1 إلى 60', error: true); return; }
            if (iv == null || iv < 0) { toast(c, 'الفرق بالأيام رقم صحيح', error: true); return; }
            await requote();
            if (quote == null) return;
            if (c.mounted) Navigator.pop(c, DraftItem(service: svc, values: Map.of(values), sessions: n, interval: iv, first: first, quote: quote));
          }, child: const Text('إضافة')),
        ],
      );
    }),
  );
}

Widget _fieldInput(Map<String, dynamic> f, Map<String, dynamic> values, Map<String, TextEditingController> ctrls, Future<void> Function() requote, StateSetter setS) {
  final key = f['field_key'] as String;
  final label = '${f['label_ar']}${f['unit_label'] == null ? '' : ' (${f['unit_label']})'}${f['is_required'] == true ? ' *' : ''}';
  final options = (f['options'] as List).cast<Map<String, dynamic>>().where((o) => o['is_active'] == true).toList();
  switch (f['field_type']) {
    case 'number':
      final t = ctrls.putIfAbsent(key, () => TextEditingController());
      return TextField(controller: t, keyboardType: const TextInputType.numberWithOptions(decimal: true), textDirection: TextDirection.ltr, decoration: deco(label), onChanged: (v) { final n = num.tryParse(v.trim()); if (n == null) { values.remove(key); } else { values[key] = n; } requote(); });
    case 'text':
      final t = ctrls.putIfAbsent(key, () => TextEditingController());
      return TextField(controller: t, decoration: deco(label), onChanged: (v) { if (v.trim().isEmpty) { values.remove(key); } else { values[key] = v.trim(); } requote(); });
    case 'bool':
      return SwitchListTile(contentPadding: EdgeInsets.zero, title: Text(label), value: values[key] == true, onChanged: (v) { values[key] = v; setS(() {}); requote(); });
    case 'select':
      return DropdownButtonFormField<int?>(initialValue: values[key] as int?, decoration: deco(label), items: [if (f['is_required'] != true) const DropdownMenuItem<int?>(value: null, child: Text('بدون')), for (final o in options) DropdownMenuItem<int?>(value: o['id'] as int, child: Text(o['label_ar'] as String))], onChanged: (v) { if (v == null) { values.remove(key); } else { values[key] = v; } requote(); });
    default: // multi_select
      final sel = ((values[key] as List?) ?? const []).cast<int>();
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: const TextStyle(color: Palette.muted, fontSize: 13)),
        Wrap(spacing: 6, children: [for (final o in options) FilterChip(label: Text(o['label_ar'] as String), selected: sel.contains(o['id']), onSelected: (v) { final n = [...sel]; v ? n.add(o['id'] as int) : n.remove(o['id']); values[key] = n; setS(() {}); requote(); })]),
      ]);
  }
}
