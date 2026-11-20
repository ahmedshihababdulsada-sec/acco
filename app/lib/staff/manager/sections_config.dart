import 'dart:typed_data';

import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/theme.dart';
import '../../core/widgets.dart';
import 'admin_shell.dart';
import 'sections_stock.dart' show pickAndUpload;

Api _api(BuildContext c) => c.read<Api>();
BranchScope _scope(BuildContext c) => c.read<BranchScope>();
num _n(dynamic v) => (v as num?) ?? 0;
const _weekdays = {1: 'الاثنين', 2: 'الثلاثاء', 3: 'الأربعاء', 4: 'الخميس', 5: 'الجمعة', 6: 'السبت', 7: 'الأحد'};

// ====================================================================== الدوام
class ScheduleSection extends StatelessWidget {
  const ScheduleSection({super.key});
  @override
  Widget build(BuildContext context) => DefaultTabController(length: 3, child: Column(children: const [
        Material(color: Palette.surface, child: TabBar(tabs: [Tab(text: 'أيام العيادة'), Tab(text: 'العطل'), Tab(text: 'دوام الأطباء')])),
        Expanded(child: TabBarView(children: [_ClinicDaysTab(), _HolidaysTab(), _DoctorsTab()])),
      ]));
}

class _ClinicDaysTab extends StatefulWidget {
  const _ClinicDaysTab();
  @override
  State<_ClinicDaysTab> createState() => _ClinicDaysTabState();
}

class _ClinicDaysTabState extends State<_ClinicDaysTab> {
  Map<int, bool>? _open;

  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context);
    return Loader<Map<String, dynamic>>(
      load: () async => Map<String, dynamic>.from(await api.get('/schedule/clinic-days', query: sc.q) as Map),
      builder: (context, d, reload) {
        _open ??= {for (final x in (d['days'] as List).cast<Map<String, dynamic>>()) x['weekday'] as int: x['is_open'] as bool};
        return ListPage(maxWidth: 560, children: [
          Section(title: 'أيام الأسبوع اللي تفتح بها العيادة', child: Column(children: [
            for (final w in [7, 1, 2, 3, 4, 5, 6]) SwitchListTile(contentPadding: EdgeInsets.zero, title: Text(_weekdays[w]!), value: _open![w] ?? true, onChanged: (v) => setState(() => _open![w] = v)),
          ])),
          AsyncButton(icon: Icons.save_outlined, onPressed: () async {
            await api.put('/schedule/clinic-days', body: sc.body({'days': [for (final e in _open!.entries) {'weekday': e.key, 'is_open': e.value}]}));
            if (context.mounted) toast(context, 'انحفظت أيام العيادة');
          }, child: const Text('حفظ')),
        ]);
      },
    );
  }
}

class _HolidaysTab extends StatelessWidget {
  const _HolidaysTab();
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context);
    return Loader<List<Map<String, dynamic>>>(
      load: () async => ((await api.get('/schedule/holidays', query: sc.q)) as List).cast<Map<String, dynamic>>(),
      builder: (context, list, reload) => ListPage(maxWidth: 640, children: [
        FilledButton.icon(icon: const Icon(Icons.event_busy), label: const Text('إضافة عطلة'), onPressed: () async {
          final name = TextEditingController(); String date = todayIso(); String kind = 'official';
          final ok = await showDialog<bool>(context: context, builder: (d) => StatefulBuilder(builder: (d, setS) => AlertDialog(
            title: const Text('عطلة جديدة'),
            content: SizedBox(width: 380, child: Column(mainAxisSize: MainAxisSize.min, children: [
              DateField(label: 'التاريخ', value: date, onChanged: (v) => setS(() => date = v)), const SizedBox(height: 10),
              TextField(controller: name, decoration: deco('الاسم', hint: 'مثلاً: عيد الفطر')), const SizedBox(height: 10),
              DropdownButtonFormField<String>(initialValue: kind, decoration: deco('النوع'), items: const [DropdownMenuItem(value: 'official', child: Text('رسمية')), DropdownMenuItem(value: 'sudden', child: Text('طارئة'))], onChanged: (v) => setS(() => kind = v!)),
              const SizedBox(height: 8), const Text('الحجوزات الموجودة بهذا اليوم تنتقل حسب سياسة النقل وينرسل إشعار للزبائن.', style: TextStyle(color: Palette.muted, fontSize: 12)),
            ])),
            actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
              try { await api.post('/schedule/holidays', body: sc.body({'date': date, 'name': name.text.trim(), 'kind': kind})); if (d.mounted) Navigator.pop(d, true); } catch (e) { if (d.mounted) showError(d, e); }
            }, child: const Text('حفظ'))],
          )));
          if (ok == true) await reload();
        }),
        if (list.isEmpty) const Empty('ما أكو عطل قادمة'),
        for (final h in list) Card(child: ListTile(
          title: Text('${h['name']}'), subtitle: Text('${dmy(h['date'] as String)} · ${h['kind'] == 'sudden' ? 'طارئة' : 'رسمية'}'),
          trailing: TextButton(onPressed: () async { if (!await confirm(context, 'إلغاء العطلة؟', danger: true)) return; try { await api.post('/schedule/holidays/${h['id']}/cancel', body: {}); await reload(); } catch (e) { if (context.mounted) showError(context, e); } }, child: const Text('إلغاء')),
        )),
      ]),
    );
  }
}

class _DoctorsTab extends StatelessWidget {
  const _DoctorsTab();
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context);
    return Loader<List<Map<String, dynamic>>>(
      load: () async => ((await api.get('/schedule/doctors', query: sc.q))['doctors'] as List).cast<Map<String, dynamic>>(),
      builder: (context, list, reload) => ListPage(maxWidth: 640, children: [
        if (list.isEmpty) const Empty('ما أكو أطباء'),
        for (final x in list) Card(child: ListTile(
          title: Text('${x['full_name']}'), subtitle: Text('${x['title'] ?? ''} ${x['room'] ?? ''}'), trailing: const Icon(Icons.chevron_left),
          onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ChangeNotifierProvider.value(value: sc, child: _DoctorPage(doctor: x)))),
        )),
      ]),
    );
  }
}

class _DoctorPage extends StatefulWidget {
  const _DoctorPage({required this.doctor});
  final Map<String, dynamic> doctor;
  @override
  State<_DoctorPage> createState() => _DoctorPageState();
}

class _DoctorPageState extends State<_DoctorPage> {
  Map<int, (String, String)>? _w; String _from = todayIso(); int _tick = 0;

  @override
  Widget build(BuildContext context) {
    final api = _api(context); final id = widget.doctor['id'];
    return Scaffold(
      appBar: AppBar(title: Text('دوام ${widget.doctor['full_name']}')),
      body: Loader<Map<String, dynamic>>(
        key: ValueKey(_tick),
        load: () async => Map<String, dynamic>.from(await api.get('/schedule/doctors/$id') as Map),
        builder: (context, d, reload) {
          _w ??= {for (final x in (d['weekly'] as List).cast<Map<String, dynamic>>()) x['weekday'] as int: (x['start_time'] as String, x['end_time'] as String)};
          final off = (d['days_off'] as List).cast<Map<String, dynamic>>();
          final upcoming = (d['upcoming_changes'] as List);
          return ListPage(maxWidth: 640, children: [
            Section(title: 'الدوام الأسبوعي', child: Column(children: [
              for (final w in [7, 1, 2, 3, 4, 5, 6]) Row(children: [
                Expanded(child: CheckboxListTile(contentPadding: EdgeInsets.zero, title: Text(_weekdays[w]!), value: _w!.containsKey(w), onChanged: (v) => setState(() { if (v == true) { _w![w] = ('09:00', '17:00'); } else { _w!.remove(w); } }))),
                if (_w!.containsKey(w)) ...[
                  TextButton(onPressed: () async { final t = await showTimePicker(context: context, initialTime: _parse(_w![w]!.$1)); if (t != null) setState(() => _w![w] = (_fmt(t), _w![w]!.$2)); }, child: Text(_w![w]!.$1, textDirection: TextDirection.ltr)),
                  const Text('→'),
                  TextButton(onPressed: () async { final t = await showTimePicker(context: context, initialTime: _parse(_w![w]!.$2)); if (t != null) setState(() => _w![w] = (_w![w]!.$1, _fmt(t))); }, child: Text(_w![w]!.$2, textDirection: TextDirection.ltr)),
                ],
              ]),
              const SizedBox(height: 8), DateField(label: 'يبدأ العمل بهذا الدوام من', value: _from, onChanged: (v) => setState(() => _from = v)),
              if (upcoming.isNotEmpty) const Padding(padding: EdgeInsets.only(top: 8), child: Notice('أكو تغيير دوام مجدول قادم: حفظ جديد يستبدله.')),
              const SizedBox(height: 10),
              AsyncButton(icon: Icons.save_outlined, onPressed: () async {
                await api.put('/schedule/doctors/$id/weekly', body: {'effective_from': _from, 'days': [for (final e in _w!.entries) {'weekday': e.key, 'start_time': e.value.$1, 'end_time': e.value.$2}]});
                if (context.mounted) { toast(context, 'انحفظ الدوام'); _w = null; setState(() => _tick++); }
              }, child: const Text('حفظ الدوام')),
            ])),
            Section(title: 'إجازات الطبيب القادمة', trailing: TextButton.icon(icon: const Icon(Icons.add), label: const Text('إضافة'), onPressed: () async {
              final reason = TextEditingController(); String date = todayIso();
              final ok = await showDialog<bool>(context: context, builder: (c) => StatefulBuilder(builder: (c, setS) => AlertDialog(
                title: const Text('إجازة طبيب'),
                content: SizedBox(width: 360, child: Column(mainAxisSize: MainAxisSize.min, children: [DateField(label: 'التاريخ', value: date, onChanged: (v) => setS(() => date = v)), const SizedBox(height: 10), TextField(controller: reason, decoration: deco('السبب (اختياري)'))])),
                actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
                  try { await api.post('/schedule/doctors/$id/days-off', body: {'date': date, if (reason.text.trim().isNotEmpty) 'reason': reason.text.trim()}); if (c.mounted) Navigator.pop(c, true); } catch (e) { if (c.mounted) showError(c, e); }
                }, child: const Text('حفظ'))],
              )));
              if (ok == true) { _w = null; setState(() => _tick++); }
            }), child: Column(children: [
              if (off.isEmpty) const Text('ما أكو', style: TextStyle(color: Palette.muted)),
              for (final o in off) ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text(dmy(o['date'] as String)), subtitle: o['reason'] == null ? null : Text('${o['reason']}'),
                trailing: TextButton(onPressed: () async { try { await api.post('/schedule/days-off/${o['id']}/cancel', body: {}); _w = null; setState(() => _tick++); } catch (e) { if (context.mounted) showError(context, e); } }, child: const Text('إلغاء'))),
            ])),
          ]);
        },
      ),
    );
  }

  TimeOfDay _parse(String s) => TimeOfDay(hour: int.parse(s.substring(0, 2)), minute: int.parse(s.substring(3, 5)));
  String _fmt(TimeOfDay t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
}

// ====================================================================== الخدمات والأسعار
class ServicesSection extends StatelessWidget {
  const ServicesSection({super.key});
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context);
    return Loader<List<Map<String, dynamic>>>(
      load: () async => ((await api.get('/services', query: {...sc.q, 'all': 1})) as List).cast<Map<String, dynamic>>(),
      builder: (context, list, reload) => ListPage(maxWidth: 820, children: [
        FilledButton.icon(icon: const Icon(Icons.add), label: const Text('خدمة جديدة'), onPressed: () async { if (await _create(context)) await reload(); }),
        for (final s in list) Section(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            Expanded(child: Text('${s['name_ar']}', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16))),
            if (s['kind'] == 'consultation') Padding(padding: const EdgeInsets.only(left: 6), child: Pill('كشفية')),
            s['is_active'] == true ? Pill.ok('فعالة') : Pill.danger('معطلة'),
          ]),
          const SizedBox(height: 4),
          Text(switch (s['pricing_model']) { 'fixed' => 'سعر ثابت: ${money(_n(s['price']))}', 'per_unit' => 'بالوحدة: ${money(_n(s['price']))} لكل ${((s['fields'] as List).cast<Map<String, dynamic>>().where((f) => f['pricing_role'] == 'quantity').map((f) => f['unit_label']).firstOrNull) ?? 'وحدة'}', _ => 'سعر حسب الخيارات' }, style: const TextStyle(color: Palette.muted)),
          for (final f in (s['fields'] as List).cast<Map<String, dynamic>>()) Padding(padding: const EdgeInsets.only(top: 6), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Icon(Icons.subdirectory_arrow_left, size: 16, color: Palette.muted), const SizedBox(width: 6),
            Expanded(child: Text('${f['label_ar']} (${f['field_type']}${f['is_required'] == true ? ' · إلزامي' : ''})${(f['options'] as List).isEmpty ? '' : '\n${(f['options'] as List).cast<Map<String, dynamic>>().map((o) => '${o['label_ar']}${o['price'] == null ? '' : ' ${money(_n(o['price']))}'}').join(' · ')}'}', style: const TextStyle(fontSize: 13))),
          ])),
          if ((s['materials'] as List).isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text('يستهلك ${(s['materials'] as List).length} مادة من المخزون', style: const TextStyle(color: Palette.muted, fontSize: 13))),
          const SizedBox(height: 8),
          Wrap(spacing: 8, runSpacing: 8, children: [
            if (s['pricing_model'] != 'per_option') OutlinedButton(onPressed: () async { if (await _price(context, s)) await reload(); }, child: const Text('تغيير السعر')),
            if (s['kind'] != 'consultation') OutlinedButton(onPressed: () async { if (await _addField(context, s)) await reload(); }, child: const Text('إضافة حقل')),
            if (s['kind'] != 'consultation') OutlinedButton(onPressed: () async { if (await _materials(context, s)) await reload(); }, child: const Text('المواد المستهلكة')),
            TextButton(onPressed: () async { try { await api.post('/services/${s['id']}/${s['is_active'] == true ? 'deactivate' : 'activate'}', body: {}); await reload(); } catch (e) { if (context.mounted) showError(context, e); } }, child: Text(s['is_active'] == true ? 'تعطيل' : 'تفعيل')),
          ]),
        ])),
      ]),
    );
  }

  Future<bool> _create(BuildContext context) async {
    final api = _api(context); final sc = _scope(context); final name = TextEditingController(); final price = TextEditingController(); String model = 'fixed';
    final ok = await showDialog<bool>(context: context, builder: (d) => StatefulBuilder(builder: (d, setS) => AlertDialog(
      title: const Text('خدمة جديدة'),
      content: SizedBox(width: 400, child: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: name, decoration: deco('اسم الخدمة')), const SizedBox(height: 10),
        DropdownButtonFormField<String>(initialValue: model, decoration: deco('طريقة التسعير'), items: const [DropdownMenuItem(value: 'fixed', child: Text('سعر ثابت للجلسة')), DropdownMenuItem(value: 'per_unit', child: Text('بالوحدة (cc / ml...)')), DropdownMenuItem(value: 'per_option', child: Text('حسب الخيارات'))], onChanged: (v) => setS(() => model = v!)),
        if (model != 'per_option') ...[const SizedBox(height: 10), TextField(controller: price, keyboardType: TextInputType.number, textDirection: TextDirection.ltr, decoration: deco(model == 'fixed' ? 'السعر' : 'سعر الوحدة', suffix: 'د.ع'))],
        const SizedBox(height: 8), Text(model == 'per_unit' ? 'بعد الإنشاء أضف حقل «كمية» (مثلاً cc) ليتحسب السعر منه.' : model == 'per_option' ? 'بعد الإنشاء أضف حقل خيارات وسعر كل خيار.' : '', style: const TextStyle(color: Palette.muted, fontSize: 12)),
      ])),
      actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
        final p = model == 'per_option' ? null : int.tryParse(price.text.replaceAll(',', '').trim());
        if (model != 'per_option' && p == null) { toast(d, 'اكتب السعر', error: true); return; }
        try { await api.post('/services', body: sc.body({'name_ar': name.text.trim(), 'pricing_model': model, if (p != null) 'price': p})); if (d.mounted) Navigator.pop(d, true); } catch (e) { if (d.mounted) showError(d, e); }
      }, child: const Text('إنشاء'))],
    )));
    return ok ?? false;
  }

  Future<bool> _price(BuildContext context, Map<String, dynamic> s) async {
    final api = _api(context); final c = TextEditingController(text: '${s['price'] ?? ''}');
    final ok = await showDialog<bool>(context: context, builder: (d) => AlertDialog(
      title: Text('سعر ${s['name_ar']}'),
      content: SizedBox(width: 340, child: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: c, keyboardType: TextInputType.number, textDirection: TextDirection.ltr, decoration: deco('السعر الجديد', suffix: 'د.ع')),
        const SizedBox(height: 8), const Text('السعر الجديد ينطبق على الوصلات الجديدة فقط؛ الخطط القديمة تحتفظ بسعرها.', style: TextStyle(color: Palette.muted, fontSize: 12)),
      ])),
      actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
        final p = int.tryParse(c.text.replaceAll(',', '').trim()); if (p == null || p < 0) { toast(d, 'سعر غير صحيح', error: true); return; }
        try { await api.put('/services/${s['id']}/price', body: {'price': p}); if (d.mounted) Navigator.pop(d, true); } catch (e) { if (d.mounted) showError(d, e); }
      }, child: const Text('حفظ'))],
    ));
    return ok ?? false;
  }

  Future<bool> _addField(BuildContext context, Map<String, dynamic> s) async {
    final api = _api(context); final key = TextEditingController(); final label = TextEditingController(); final unit = TextEditingController(); final opts = TextEditingController();
    String type = (s['pricing_model'] == 'per_option') ? 'select' : 'number'; bool req = true; String role = s['pricing_model'] == 'per_unit' ? 'quantity' : (s['pricing_model'] == 'per_option' ? 'option' : 'none');
    final ok = await showDialog<bool>(context: context, builder: (d) => StatefulBuilder(builder: (d, setS) => AlertDialog(
      title: Text('حقل جديد لـ ${s['name_ar']}'),
      content: SizedBox(width: 420, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: label, decoration: deco('اسم الحقل (يطلع للطبيب)', hint: 'كم cc / المنطقة')), const SizedBox(height: 10),
        TextField(controller: key, textDirection: TextDirection.ltr, decoration: deco('المفتاح', hint: 'cc أو area (إنجليزي صغير)')), const SizedBox(height: 10),
        DropdownButtonFormField<String>(initialValue: type, decoration: deco('النوع'), items: const [DropdownMenuItem(value: 'number', child: Text('رقم')), DropdownMenuItem(value: 'select', child: Text('اختيار واحد')), DropdownMenuItem(value: 'multi_select', child: Text('اختيار متعدد')), DropdownMenuItem(value: 'text', child: Text('نص')), DropdownMenuItem(value: 'bool', child: Text('نعم/لا'))], onChanged: (v) => setS(() => type = v!)), const SizedBox(height: 10),
        DropdownButtonFormField<String>(initialValue: role, decoration: deco('دوره بالتسعير'), items: const [DropdownMenuItem(value: 'none', child: Text('ما يؤثر بالسعر')), DropdownMenuItem(value: 'quantity', child: Text('كمية (السعر × الرقم)')), DropdownMenuItem(value: 'option', child: Text('سعر الخيار'))], onChanged: (v) => setS(() => role = v!)),
        if (type == 'number') ...[const SizedBox(height: 10), TextField(controller: unit, decoration: deco('الوحدة', hint: 'cc / ml'))],
        if (type == 'select' || type == 'multi_select') ...[const SizedBox(height: 10), TextField(controller: opts, maxLines: 5, decoration: deco('الخيارات (كل خيار بسطر)', hint: 'خدود:150000\nشفاه:200000'))],
        SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('إلزامي'), value: req, onChanged: (v) => setS(() => req = v)),
      ]))),
      actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
        final options = <Map<String, dynamic>>[];
        if (type == 'select' || type == 'multi_select') {
          for (final line in opts.text.split('\n')) { final t = line.trim(); if (t.isEmpty) continue; final i = t.lastIndexOf(':'); final p = i > 0 ? int.tryParse(t.substring(i + 1).replaceAll(',', '').trim()) : null; options.add({'label_ar': i > 0 && p != null ? t.substring(0, i).trim() : t, if (p != null) 'price': p}); }
        }
        try { await api.post('/services/${s['id']}/fields', body: {'field_key': key.text.trim(), 'label_ar': label.text.trim(), 'field_type': type, if (type == 'number' && unit.text.trim().isNotEmpty) 'unit_label': unit.text.trim(), 'is_required': req, 'pricing_role': role, if (options.isNotEmpty) 'options': options}); if (d.mounted) Navigator.pop(d, true); } catch (e) { if (d.mounted) showError(d, e); }
      }, child: const Text('إضافة'))],
    )));
    return ok ?? false;
  }

  Future<bool> _materials(BuildContext context, Map<String, dynamic> s) async {
    final api = _api(context); final sc = _scope(context);
    final mats = ((await api.get('/materials', query: sc.q))['materials'] as List).cast<Map<String, dynamic>>();
    if (!context.mounted) return false;
    final fields = (s['fields'] as List).cast<Map<String, dynamic>>().where((f) => f['field_type'] == 'number').toList();
    final links = [for (final l in (s['materials'] as List).cast<Map<String, dynamic>>()) {'material_id': l['material_id'], 'formula': l['formula'], 'field_id': l['field_id'], 'factor': TextEditingController(text: '${l['factor']}'.replaceFirst(RegExp(r'\.?0+$'), ''))}];
    final ok = await showDialog<bool>(context: context, builder: (d) => StatefulBuilder(builder: (d, setS) => AlertDialog(
      title: Text('مواد ${s['name_ar']}'),
      content: SizedBox(width: 480, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const Text('كل مادة تنخصم تلقائياً من المخزون بعد تأكيد الممرض: إما بحسب قيمة حقل رقمي × معامل، أو كمية ثابتة لكل جلسة.', style: TextStyle(color: Palette.muted, fontSize: 12)), const SizedBox(height: 10),
        for (final (i, l) in links.indexed) Card(child: Padding(padding: const EdgeInsets.all(10), child: Column(children: [
          Row(children: [Expanded(child: DropdownButtonFormField<int>(initialValue: l['material_id'] as int, decoration: deco('المادة'), items: [for (final m in mats) DropdownMenuItem(value: m['id'] as int, child: Text('${m['name']} (${(m['units'] as Map)['base_unit']})'))], onChanged: (v) => setS(() => l['material_id'] = v))), IconButton(onPressed: () => setS(() => links.removeAt(i)), icon: const Icon(Icons.delete_outline, color: Palette.danger))]),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(initialValue: l['formula'] as String, decoration: deco('الحساب'), items: [if (fields.isNotEmpty) const DropdownMenuItem(value: 'per_field_value', child: Text('حسب قيمة حقل × معامل')), const DropdownMenuItem(value: 'fixed_per_session', child: Text('كمية ثابتة لكل جلسة'))], onChanged: (v) => setS(() { l['formula'] = v; if (v == 'fixed_per_session') l['field_id'] = null; })),
          if (l['formula'] == 'per_field_value') ...[const SizedBox(height: 8), DropdownButtonFormField<int>(initialValue: l['field_id'] as int?, decoration: deco('الحقل'), items: [for (final f in fields) DropdownMenuItem(value: f['id'] as int, child: Text('${f['label_ar']}'))], onChanged: (v) => setS(() => l['field_id'] = v))],
          const SizedBox(height: 8), TextField(controller: l['factor'] as TextEditingController, keyboardType: const TextInputType.numberWithOptions(decimal: true), textDirection: TextDirection.ltr, decoration: deco('المعامل', hint: '1 = وحدة لكل وحدة')),
        ]))),
        OutlinedButton.icon(onPressed: mats.isEmpty ? null : () => setS(() => links.add({'material_id': mats.first['id'], 'formula': fields.isNotEmpty ? 'per_field_value' : 'fixed_per_session', 'field_id': fields.isNotEmpty ? fields.first['id'] : null, 'factor': TextEditingController(text: '1')})), icon: const Icon(Icons.add), label: const Text('إضافة مادة')),
      ]))),
      actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
        try {
          await api.put('/services/${s['id']}/materials', body: {'items': [for (final l in links) {'material_id': l['material_id'], 'formula': l['formula'], if (l['field_id'] != null) 'field_id': l['field_id'], 'factor': (l['factor'] as TextEditingController).text.trim()}]});
          if (d.mounted) Navigator.pop(d, true);
        } catch (e) { if (d.mounted) showError(d, e); }
      }, child: const Text('حفظ'))],
    )));
    return ok ?? false;
  }
}

// ====================================================================== الإعدادات
class SettingsSection extends StatelessWidget {
  const SettingsSection({super.key});
  @override
  Widget build(BuildContext context) => DefaultTabController(length: 2, child: Column(children: const [
        Material(color: Palette.surface, child: TabBar(tabs: [Tab(text: 'إعدادات العيادة'), Tab(text: 'طرق الدفع')])),
        Expanded(child: TabBarView(children: [_RulesTab(), _MethodsTab()])),
      ]));
}

class _RulesTab extends StatelessWidget {
  const _RulesTab();
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context);
    return Loader<List<Map<String, dynamic>>>(
      load: () async => ((await api.get('/settings', query: sc.q))['settings'] as List).cast<Map<String, dynamic>>().toList(),
      builder: (context, list, reload) => ListPage(maxWidth: 720, children: [
        for (final s in list) if (s['key'] == 'receipt.logo_attachment_id') _LogoTile(setting: s, onChanged: reload) else Card(child: ListTile(
          title: Text('${s['label']}'), subtitle: Text('${s['value'] == null || '${s['value']}'.isEmpty ? '—' : s['value']}${s['is_default'] == true ? '  (افتراضي)' : ''}'),
          trailing: s['can_edit'] == true ? TextButton(onPressed: () async { if (await _edit(context, s)) await reload(); }, child: const Text('تعديل')) : const Icon(Icons.lock_outline, size: 18, color: Palette.muted),
        )),
      ]),
    );
  }

  Future<bool> _edit(BuildContext context, Map<String, dynamic> s) async {
    final api = _api(context); final sc = _scope(context); final isInt = s['type'] != 'string';
    final c = TextEditingController(text: s['value'] == null ? '' : '${s['value']}'); final reason = TextEditingController();
    final ok = await showDialog<bool>(context: context, builder: (d) => AlertDialog(
      title: Text('${s['label']}'),
      content: SizedBox(width: 380, child: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: c, keyboardType: isInt ? TextInputType.number : TextInputType.text, textDirection: isInt ? TextDirection.ltr : null, decoration: deco('القيمة')), const SizedBox(height: 10),
        TextField(controller: reason, decoration: deco('سبب التغيير (اختياري)')),
      ])),
      actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
        dynamic v = c.text.trim();
        if (isInt) { v = int.tryParse(c.text.replaceAll(',', '').trim()); if (v == null) { toast(d, 'لازم رقم صحيح', error: true); return; } }
        try { await api.put('/settings/${s['key']}', body: sc.body({'value': v, 'expected_version': s['version'], if (reason.text.trim().isNotEmpty) 'reason': reason.text.trim()})); if (d.mounted) Navigator.pop(d, true); } catch (e) { if (d.mounted) showError(d, e); }
      }, child: const Text('حفظ'))],
    ));
    return ok ?? false;
  }
}

/// شعار الوصل: يرفعه المدير/المالك (صورة)، يطلع بأعلى الوصل المطبوع، والكاشير ينزله وقت الطباعة.
class _LogoTile extends StatefulWidget {
  const _LogoTile({required this.setting, required this.onChanged});
  final Map<String, dynamic> setting;
  final Future<void> Function() onChanged;
  @override
  State<_LogoTile> createState() => _LogoTileState();
}

class _LogoTileState extends State<_LogoTile> {
  Uint8List? _bytes; bool _loading = false;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    if (widget.setting['value'] == null) return;
    setState(() => _loading = true);
    try { _bytes = await _api(context).download('/attachments/logo/current', query: _scope(context).q); } catch (_) { _bytes = null; }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _set(Object? value) async {
    final api = _api(context); final sc = _scope(context);
    await api.put('/settings/receipt.logo_attachment_id', body: sc.body({'value': value, 'expected_version': widget.setting['version']}));
    await widget.onChanged();
  }

  @override
  Widget build(BuildContext context) {
    final has = widget.setting['value'] != null;
    return Card(child: Padding(padding: const EdgeInsets.all(14), child: Row(children: [
      Container(width: 72, height: 72, alignment: Alignment.center, decoration: BoxDecoration(border: Border.all(color: Palette.border), borderRadius: BorderRadius.circular(8)),
          child: _loading ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)) : _bytes != null ? Image.memory(_bytes!, fit: BoxFit.contain) : const Icon(Icons.image_outlined, color: Palette.muted)),
      const SizedBox(width: 14),
      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('شعار الوصل', style: TextStyle(fontWeight: FontWeight.w700)),
        Text(has ? 'مضبوط: يطلع بأعلى الوصل المطبوع' : 'ما مضبوط: الوصل يطلع بدون شعار', style: const TextStyle(color: Palette.muted, fontSize: 13)),
        const SizedBox(height: 8),
        Wrap(spacing: 8, children: [
          AsyncButton(outlined: true, icon: Icons.upload_file, onPressed: () async {
            final id = await pickAndUpload(context, 'logo', imagesOnly: true);
            if (id == null) return;
            await _set(id);
            if (context.mounted) toast(context, 'انحفظ الشعار');
          }, child: Text(has ? 'تغيير' : 'رفع شعار')),
          if (has) AsyncButton(outlined: true, danger: true, onPressed: () async { if (await confirm(context, 'إزالة الشعار؟', yes: 'إزالة', danger: true)) await _set(null); }, child: const Text('إزالة')),
        ]),
      ])),
    ])));
  }
}

class _MethodsTab extends StatelessWidget {
  const _MethodsTab();
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context);
    return Loader<List<Map<String, dynamic>>>(
      load: () async => ((await api.get('/payment-methods', query: {...sc.q, 'all': 1})) as List).cast<Map<String, dynamic>>(),
      builder: (context, list, reload) => ListPage(maxWidth: 640, children: [
        FilledButton.icon(icon: const Icon(Icons.add_card), label: const Text('طريقة دفع إلكترونية جديدة'), onPressed: () async {
          final name = TextEditingController(); final dev = TextEditingController();
          final ok = await showDialog<bool>(context: context, builder: (d) => AlertDialog(
            title: const Text('طريقة دفع جديدة'),
            content: SizedBox(width: 380, child: Column(mainAxisSize: MainAxisSize.min, children: [
              TextField(controller: name, decoration: deco('الاسم', hint: 'ماستر / زين كاش')), const SizedBox(height: 10),
              TextField(controller: dev, decoration: deco('اسم الجهاز أو المصرف', hint: 'كل جهاز يتطابق كشفه لحاله بتسليم الشفت')),
            ])),
            actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
              try { await api.post('/payment-methods', body: sc.body({'name_ar': name.text.trim(), 'device_label': dev.text.trim()})); if (d.mounted) Navigator.pop(d, true); } catch (e) { if (d.mounted) showError(d, e); }
            }, child: const Text('حفظ'))],
          ));
          if (ok == true) await reload();
        }),
        for (final m in list) Card(child: ListTile(
          title: Text('${m['name_ar']}${m['is_active'] == false ? ' (معطلة)' : ''}'), subtitle: Text(m['kind'] == 'cash' ? 'نقدي' : '${m['device_label'] ?? ''}'),
          trailing: m['kind'] == 'cash' ? null : Row(mainAxisSize: MainAxisSize.min, children: [
            IconButton(icon: const Icon(Icons.arrow_upward, size: 18), onPressed: () async { try { await api.post('/payment-methods/${m['id']}/move', body: {'direction': 'up'}); await reload(); } catch (e) { if (context.mounted) showError(context, e); } }),
            IconButton(icon: const Icon(Icons.arrow_downward, size: 18), onPressed: () async { try { await api.post('/payment-methods/${m['id']}/move', body: {'direction': 'down'}); await reload(); } catch (e) { if (context.mounted) showError(context, e); } }),
            TextButton(onPressed: () async { try { await api.post('/payment-methods/${m['id']}/${m['is_active'] == false ? 'enable' : 'disable'}', body: {}); await reload(); } catch (e) { if (context.mounted) showError(context, e); } }, child: Text(m['is_active'] == false ? 'تفعيل' : 'تعطيل')),
          ]),
        )),
      ]),
    );
  }
}
