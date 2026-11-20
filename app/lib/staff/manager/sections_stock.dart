import 'package:file_picker/file_picker.dart';
import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/theme.dart';
import '../../core/widgets.dart';
import 'admin_shell.dart';

Api _api(BuildContext c) => c.read<Api>();
BranchScope _scope(BuildContext c) => c.read<BranchScope>();
num _n(dynamic v) => (v as num?) ?? 0;
String _q(num v) => v % 1 == 0 ? '${v.toInt()}' : v.toStringAsFixed(3).replaceFirst(RegExp(r'0+$'), '');

/// يرفع صورة/PDF إثبات ويرجع id المرفق (أو null إذا الغى).
Future<int?> pickAndUpload(BuildContext context, String kind, {bool imagesOnly = false}) async {
  final f = await FilePicker.pickFile(type: FileType.custom, allowedExtensions: ['jpg', 'jpeg', 'png', 'webp', if (!imagesOnly) 'pdf']);
  if (f == null) return null;
  final bytes = await f.readAsBytes();
  if (!context.mounted) return null;
  final j = await _api(context).upload('/attachments', kind: kind, bytes: bytes, filename: f.name);
  if (j['duplicate_of'] != null && context.mounted) toast(context, 'تنبيه: نفس هذي الصورة انرفعت سابقاً (مرفق رقم ${j['duplicate_of']}). تأكد إنها مو مكررة.');
  return j['id'] as int;
}

// ====================================================================== المخزون
class StockSection extends StatelessWidget {
  const StockSection({super.key});
  @override
  Widget build(BuildContext context) => DefaultTabController(length: 4, child: Column(children: [
        const Material(color: Palette.surface, child: TabBar(isScrollable: true, tabs: [Tab(text: 'المواد'), Tab(text: 'التنبيهات'), Tab(text: 'التالف والجرد'), Tab(text: 'فواتير الشراء')])),
        const Expanded(child: TabBarView(children: [_MaterialsTab(), _AlertsTab(), _WasteCountTab(), _PurchasesTab()])),
      ]));
}

class _MaterialsTab extends StatelessWidget {
  const _MaterialsTab();
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context);
    return Loader<List<Map<String, dynamic>>>(
      load: () async => ((await api.get('/materials', query: sc.q))['materials'] as List).cast<Map<String, dynamic>>(),
      builder: (context, list, reload) => ListPage(maxWidth: 820, children: [
        FilledButton.icon(icon: const Icon(Icons.add), label: const Text('مادة جديدة'), onPressed: () async { if (await _materialDialog(context)) await reload(); }),
        if (list.isEmpty) const Empty('ما أكو مواد'),
        for (final m in list) Section(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            Expanded(child: Text('${m['name']}', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16))),
            if ((m['flags'] as Map)['negative'] == true) Pill.danger('سالب'), if ((m['flags'] as Map)['low'] == true) Padding(padding: const EdgeInsets.only(right: 6), child: Pill.warn('قليل')),
            if ((m['flags'] as Map)['has_expired'] == true) Padding(padding: const EdgeInsets.only(right: 6), child: Pill.danger('فيه منتهي')),
          ]),
          const SizedBox(height: 6),
          Wrap(spacing: 16, runSpacing: 4, children: [
            Text('الموجود: ${_q(_n((m['stock'] as Map)['on_hand']))} ${(m['units'] as Map)['base_unit']}'), Text('المحجوز: ${_q(_n((m['stock'] as Map)['reserved']))}'), Text('المتاح: ${_q(_n((m['stock'] as Map)['available']))}', style: const TextStyle(fontWeight: FontWeight.w700)),
            if (m['last_unit_cost'] != null) Text('آخر سعر: ${money(_n(m['last_unit_cost']))}', style: const TextStyle(color: Palette.muted)),
          ]),
          Text('الشراء بـ${(m['units'] as Map)['pack_unit']} · حد التنبيه ${_q(_n(m['low_threshold']))}', style: const TextStyle(color: Palette.muted, fontSize: 13)),
        ])),
      ]),
    );
  }

  Future<bool> _materialDialog(BuildContext context) async {
    final api = _api(context); final sc = _scope(context);
    final name = TextEditingController(); final base = TextEditingController(text: 'cc'); final pack = TextEditingController(text: 'علبة'); final thr = TextEditingController(text: '0');
    final ok = await showDialog<bool>(context: context, builder: (d) => AlertDialog(
      title: const Text('مادة جديدة'),
      content: SizedBox(width: 400, child: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: name, decoration: deco('اسم المادة')), const SizedBox(height: 10),
        TextField(controller: base, decoration: deco('وحدة الاستهلاك', hint: 'cc أو قطعة')), const SizedBox(height: 10),
        TextField(controller: pack, decoration: deco('وحدة الشراء', hint: 'كرتون / علبة')), const SizedBox(height: 10),
        TextField(controller: thr, keyboardType: TextInputType.number, decoration: deco('حد التنبيه (على المتاح)')),
        const SizedBox(height: 8), const Text('الوحدات تنقفل لما تصير بالمادة حركات. التحويل (علبة ← cc) من «تعديل المادة».', style: TextStyle(color: Palette.muted, fontSize: 12)),
      ])),
      actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
        try { await api.post('/materials', body: sc.body({'name': name.text.trim(), 'base_unit': base.text.trim(), 'pack_unit': pack.text.trim(), 'low_threshold': num.tryParse(thr.text.trim()) ?? 0})); if (d.mounted) Navigator.pop(d, true); } catch (e) { if (d.mounted) showError(d, e); }
      }, child: const Text('حفظ'))],
    ));
    return ok ?? false;
  }
}

class _AlertsTab extends StatelessWidget {
  const _AlertsTab();
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context);
    return Loader<Map<String, dynamic>>(
      load: () async => Map<String, dynamic>.from(await api.get('/stock/alerts', query: sc.q) as Map),
      builder: (context, a, reload) {
        List<Map<String, dynamic>> l(String k) => (a[k] as List).cast<Map<String, dynamic>>();
        Widget block(String title, List<Map<String, dynamic>> items, String Function(Map<String, dynamic>) line, Widget pill) => items.isEmpty ? const SizedBox.shrink() : Section(title: title, trailing: pill, child: Column(children: [for (final i in items) ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text(line(i)))]));
        return ListPage(maxWidth: 760, children: [
          if ((a['counts'] as Map)['total'] == 0) const Empty('ما أكو تنبيهات: المخزون سليم'),
          block('مواد سالبة (انصرفت أكثر من المخزون: صححها بالجرد أو فاتورة شراء)', l('negative'), (i) => '${(i['material'] as Map)['name']}: ${_q(_n(i['on_hand']))} ${(i['material'] as Map)['unit']}', Pill.danger('${l('negative').length}')),
          block('دفعات منتهية (سجلها تالف)', l('expired'), (i) => '${(i['material'] as Map)['name']} · ${_q(_n(i['qty_on_hand']))} ${(i['material'] as Map)['unit']} · انتهت ${dmy(i['expiry_date'] as String)} · ${money(_n(i['value']))}', Pill.danger('${l('expired').length}')),
          block('قليلة (على المتاح)', l('low'), (i) => '${(i['material'] as Map)['name']}: المتاح ${_q(_n(i['available']))} من حد ${_q(_n(i['threshold']))}', Pill.warn('${l('low').length}')),
          block('تنتهي قريب', l('near_expiry'), (i) => '${(i['material'] as Map)['name']} · ${_q(_n(i['qty_on_hand']))} ${(i['material'] as Map)['unit']} · تنتهي ${dmy(i['expiry_date'] as String)}', Pill.warn('${l('near_expiry').length}')),
        ]);
      },
    );
  }
}

class _WasteCountTab extends StatelessWidget {
  const _WasteCountTab();
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context);
    return Loader<Map<String, dynamic>>(
      load: () async => Map<String, dynamic>.from(await api.get('/stock/counts/sheet', query: sc.q) as Map),
      builder: (context, sheet, reload) {
        final batches = (sheet['batches'] as List).cast<Map<String, dynamic>>();
        return ListPage(maxWidth: 820, children: [
          Row(children: [Expanded(child: Text('دفعات المخزون (${batches.length})', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16))), OutlinedButton.icon(icon: const Icon(Icons.fact_check_outlined), label: const Text('جرد'), onPressed: () async { if (await _countDialog(context, batches)) await reload(); })]),
          if (batches.isEmpty) const Empty('ما أكو دفعات'),
          for (final b in batches) Card(child: ListTile(
            title: Text('${(b['material'] as Map)['name']} · ${_q(_n(b['system_qty']))} ${(b['material'] as Map)['unit']}'),
            subtitle: Text('تنتهي ${dmy(b['expiry_date'] as String)} · كلفة ${money(_n(b['unit_cost']))} للوحدة'),
            trailing: TextButton(onPressed: () async { if (await _wasteDialog(context, b)) await reload(); }, child: const Text('تالف')),
          )),
        ]);
      },
    );
  }

  Future<bool> _wasteDialog(BuildContext context, Map<String, dynamic> b) async {
    final api = _api(context); final qty = TextEditingController(); final note = TextEditingController(); String reason = 'damaged';
    final ok = await showDialog<bool>(context: context, builder: (d) => StatefulBuilder(builder: (d, setS) => AlertDialog(
      title: Text('تالف: ${(b['material'] as Map)['name']}'),
      content: SizedBox(width: 380, child: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: qty, keyboardType: const TextInputType.numberWithOptions(decimal: true), textDirection: TextDirection.ltr, decoration: deco('الكمية', suffix: (b['material'] as Map)['unit'] as String, hint: 'المتبقي ${_q(_n(b['system_qty']))}')), const SizedBox(height: 10),
        DropdownButtonFormField<String>(initialValue: reason, decoration: deco('السبب'), items: const [DropdownMenuItem(value: 'expired', child: Text('منتهي الصلاحية')), DropdownMenuItem(value: 'damaged', child: Text('تالف')), DropdownMenuItem(value: 'opened_unused', child: Text('مفتوح وما انستخدم')), DropdownMenuItem(value: 'prep_error', child: Text('خطأ تحضير')), DropdownMenuItem(value: 'other', child: Text('أخرى (ملاحظة إلزامية)'))], onChanged: (v) => setS(() => reason = v!)), const SizedBox(height: 10),
        TextField(controller: note, decoration: deco('ملاحظة')),
      ])),
      actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
        final q = num.tryParse(qty.text.trim());
        if (q == null || q <= 0) { toast(d, 'اكتب الكمية', error: true); return; }
        try { await api.post('/stock/waste', body: {'batch_id': b['batch_id'], 'qty': q, 'reason': reason, if (note.text.trim().isNotEmpty) 'note': note.text.trim()}); if (d.mounted) Navigator.pop(d, true); } catch (e) { if (d.mounted) showError(d, e); }
      }, child: const Text('تسجيل'))],
    )));
    return ok ?? false;
  }

  Future<bool> _countDialog(BuildContext context, List<Map<String, dynamic>> batches) async {
    final api = _api(context); final c = {for (final b in batches) b['batch_id'] as int: TextEditingController()}; final notes = {for (final b in batches) b['batch_id'] as int: TextEditingController()};
    final ok = await showDialog<bool>(context: context, builder: (d) => AlertDialog(
      title: const Text('جرد المخزون'),
      content: SizedBox(width: 480, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const Text('اكتب الكمية الموجودة فعلياً للدفعات اللي عددتها (اترك غير المعدودة فاضية). أي فرق يحتاج ملاحظة.', style: TextStyle(color: Palette.muted)), const SizedBox(height: 10),
        for (final b in batches) Padding(padding: const EdgeInsets.only(bottom: 10), child: Row(children: [
          Expanded(flex: 3, child: Text('${(b['material'] as Map)['name']}\nالنظام: ${_q(_n(b['system_qty']))}', style: const TextStyle(fontSize: 13))),
          const SizedBox(width: 8), Expanded(flex: 2, child: TextField(controller: c[b['batch_id']], keyboardType: const TextInputType.numberWithOptions(decimal: true), textDirection: TextDirection.ltr, decoration: deco('الفعلي'))),
          const SizedBox(width: 8), Expanded(flex: 3, child: TextField(controller: notes[b['batch_id']], decoration: deco('ملاحظة'))),
        ])),
      ]))),
      actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
        final lines = <Map<String, dynamic>>[];
        for (final b in batches) { final t = c[b['batch_id']]!.text.trim(); if (t.isEmpty) continue; final v = num.tryParse(t); if (v == null || v < 0) { toast(d, 'كمية غير صحيحة', error: true); return; } final n = notes[b['batch_id']]!.text.trim(); lines.add({'kind': 'batch', 'batch_id': b['batch_id'], 'actual_qty': v, 'expected_system_qty': b['system_qty'], if (n.isNotEmpty) 'note': n}); }
        if (lines.isEmpty) { toast(d, 'ما عددت أي دفعة', error: true); return; }
        try { await api.post('/stock/counts', body: {'lines': lines}); if (d.mounted) Navigator.pop(d, true); } catch (e) { if (d.mounted) showError(d, e); }
      }, child: const Text('حفظ الجرد'))],
    ));
    if (ok == true && context.mounted) toast(context, 'انحفظ الجرد');
    return ok ?? false;
  }
}

class _PurchasesTab extends StatelessWidget {
  const _PurchasesTab();
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context);
    return Loader<List<Map<String, dynamic>>>(
      load: () async => ((await api.get('/purchases', query: sc.q))['purchases'] as List).cast<Map<String, dynamic>>(),
      builder: (context, list, reload) => ListPage(maxWidth: 820, children: [
        FilledButton.icon(icon: const Icon(Icons.add_shopping_cart), label: const Text('فاتورة شراء جديدة'), onPressed: () async { if (await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => ChangeNotifierProvider.value(value: sc, child: const NewPurchasePage()))) == true) await reload(); }),
        if (list.isEmpty) const Empty('ما أكو فواتير شراء'),
        for (final p in list) Card(child: ListTile(
          title: Text('${p['supplier_name'] ?? ''} · ${money(_n(p['total_amount']))}'), subtitle: Text('${dmy(p['purchase_date'] as String)}${p['invoice_no'] == null ? '' : ' · فاتورة ${p['invoice_no']}'} · المدفوع ${money(_n(p['paid_amount']))}'),
          trailing: p['status'] == 'voided' ? Pill.danger('ملغاة') : null,
        )),
      ]),
    );
  }
}

class NewPurchasePage extends StatefulWidget {
  const NewPurchasePage({super.key});
  @override
  State<NewPurchasePage> createState() => _NewPurchasePageState();
}

class _Line { _Line(this.material); Map<String, dynamic> material; final qty = TextEditingController(); final total = TextEditingController(); String expiry = addDaysIso(todayIso(), 365); }

class _NewPurchasePageState extends State<NewPurchasePage> {
  List<Map<String, dynamic>> _suppliers = [], _materials = [];
  int? _supplier; String _date = todayIso(); final _inv = TextEditingController(); int? _receipt; String? _receiptName;
  final List<_Line> _lines = []; String _mode = 'full'; String _source = 'safe'; final _bank = TextEditingController(); final _partial = TextEditingController();
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final api = _api(context); final sc = _scope(context);
      try {
        _suppliers = ((await api.get('/suppliers', query: sc.q))['suppliers'] as List).cast<Map<String, dynamic>>().where((s) => s['is_active'] != false).toList();
        _materials = ((await api.get('/materials', query: sc.q))['materials'] as List).cast<Map<String, dynamic>>().where((m) => m['is_active'] != false).toList();
      } catch (e) { if (mounted) showError(context, e); }
      if (mounted) setState(() => _ready = true);
    });
  }

  @override
  Widget build(BuildContext context) {
    final api = _api(context);
    final total = _lines.fold<int>(0, (s, l) => s + (int.tryParse(l.total.text.replaceAll(',', '').trim()) ?? 0));
    return Scaffold(
      appBar: AppBar(title: const Text('فاتورة شراء')),
      body: !_ready ? const Center(child: CircularProgressIndicator()) : ListPage(maxWidth: 760, children: [
        Section(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          DropdownButtonFormField<int>(initialValue: _supplier, decoration: deco('المورد'), items: [for (final s in _suppliers) DropdownMenuItem(value: s['id'] as int, child: Text(s['name'] as String))], onChanged: (v) => setState(() => _supplier = v)),
          const SizedBox(height: 10), Row(children: [Expanded(child: DateField(label: 'تاريخ الفاتورة', value: _date, last: DateTime.now(), onChanged: (v) => setState(() => _date = v))), const SizedBox(width: 8), Expanded(child: TextField(controller: _inv, decoration: deco('رقم الفاتورة (اختياري)')))]),
          const SizedBox(height: 10), OutlinedButton.icon(onPressed: () async { try { final id = await pickAndUpload(context, 'purchase_receipt'); if (id != null) setState(() { _receipt = id; _receiptName = 'تم رفع الوصل'; }); } catch (e) { if (context.mounted) showError(context, e); } }, icon: Icon(_receipt == null ? Icons.upload_file : Icons.check_circle, color: _receipt == null ? null : Palette.ok), label: Text(_receiptName ?? 'رفع صورة وصل الشراء (إلزامي)')),
        ])),
        Section(title: 'المواد', child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          for (final (i, l) in _lines.indexed) Padding(padding: const EdgeInsets.only(bottom: 12), child: Column(children: [
            Row(children: [Expanded(child: DropdownButtonFormField<int>(initialValue: l.material['id'] as int, decoration: deco('المادة'), items: [for (final m in _materials) DropdownMenuItem(value: m['id'] as int, child: Text(m['name'] as String))], onChanged: (v) => setState(() => l.material = _materials.firstWhere((m) => m['id'] == v)))), IconButton(onPressed: () => setState(() => _lines.removeAt(i)), icon: const Icon(Icons.delete_outline, color: Palette.danger))]),
            const SizedBox(height: 8),
            Row(children: [
              Expanded(child: TextField(controller: l.qty, keyboardType: const TextInputType.numberWithOptions(decimal: true), onChanged: (_) => setState(() {}), textDirection: TextDirection.ltr, decoration: deco('الكمية (${(l.material['units'] as Map)['pack_unit']})'))), const SizedBox(width: 8),
              Expanded(child: TextField(controller: l.total, keyboardType: TextInputType.number, onChanged: (_) => setState(() {}), textDirection: TextDirection.ltr, decoration: deco('إجمالي السطر', suffix: 'د.ع'))), const SizedBox(width: 8),
              Expanded(child: DateField(label: 'الصلاحية', value: l.expiry, first: DateTime.now(), onChanged: (v) => setState(() => l.expiry = v))),
            ]),
          ])),
          OutlinedButton.icon(onPressed: _materials.isEmpty ? null : () => setState(() => _lines.add(_Line(_materials.first))), icon: const Icon(Icons.add), label: const Text('إضافة مادة')),
          const SizedBox(height: 8), KV('إجمالي الفاتورة', money(total), bold: true),
        ])),
        Section(title: 'الدفع', child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          SegmentedButton<String>(segments: const [ButtonSegment(value: 'full', label: Text('كاملة')), ButtonSegment(value: 'partial', label: Text('جزء')), ButtonSegment(value: 'credit', label: Text('آجلة'))], selected: {_mode}, onSelectionChanged: (v) => setState(() => _mode = v.first)),
          if (_mode != 'credit') ...[
            const SizedBox(height: 10), DropdownButtonFormField<String>(initialValue: _source, decoration: deco('من وين تنسدد'), items: const [DropdownMenuItem(value: 'safe', child: Text('من الخزنة')), DropdownMenuItem(value: 'electronic', child: Text('إلكتروني'))], onChanged: (v) => setState(() => _source = v!)),
            if (_source == 'electronic') ...[const SizedBox(height: 10), TextField(controller: _bank, decoration: deco('اسم المصرف'))],
            if (_mode == 'partial') ...[const SizedBox(height: 10), TextField(controller: _partial, keyboardType: TextInputType.number, textDirection: TextDirection.ltr, decoration: deco('المبلغ المدفوع الآن', suffix: 'د.ع'))],
          ],
        ])),
        AsyncButton(icon: Icons.save_outlined, onPressed: () async {
          if (_supplier == null) { toast(context, 'اختر المورد', error: true); return; }
          if (_receipt == null) { toast(context, 'ارفع صورة الوصل', error: true); return; }
          if (_lines.isEmpty) { toast(context, 'أضف مادة', error: true); return; }
          final items = <Map<String, dynamic>>[];
          for (final l in _lines) { final q = num.tryParse(l.qty.text.trim()); final t = int.tryParse(l.total.text.replaceAll(',', '').trim()); if (q == null || q <= 0 || t == null || t < 0) { toast(context, 'اكتب كمية وإجمالي لكل مادة', error: true); return; } items.add({'material_id': l.material['id'], 'qty_pack': q, 'line_total': t, 'expiry_date': l.expiry}); }
          final payment = {'mode': _mode, if (_mode != 'credit') 'pay_source': _source, if (_mode != 'credit' && _source == 'electronic') 'bank_name': _bank.text.trim(), if (_mode == 'partial') 'amount': int.tryParse(_partial.text.replaceAll(',', '').trim())};
          await api.post('/purchases', body: {'supplier_id': _supplier, if (_inv.text.trim().isNotEmpty) 'invoice_no': _inv.text.trim(), 'purchase_date': _date, 'receipt_attachment_id': _receipt, 'items': items, 'payment': payment});
          if (context.mounted) { toast(context, 'انحفظت الفاتورة ودخلت المواد للمخزون'); Navigator.pop(context, true); }
        }, child: const Text('حفظ الفاتورة')),
      ]),
    );
  }
}

// ====================================================================== الموردين
class SuppliersSection extends StatelessWidget {
  const SuppliersSection({super.key});
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context);
    return Loader<Map<String, dynamic>>(
      load: () async => Map<String, dynamic>.from(await api.get('/suppliers', query: sc.q) as Map),
      builder: (context, d, reload) {
        final list = (d['suppliers'] as List).cast<Map<String, dynamic>>();
        return ListPage(maxWidth: 760, children: [
          Section(child: Row(children: [const Expanded(child: Text('باقي علينا لكل الموردين', style: TextStyle(fontWeight: FontWeight.w700))), Text(money(_n(d['total_owed'])), style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: Palette.danger))])),
          FilledButton.icon(icon: const Icon(Icons.add), label: const Text('مورد جديد'), onPressed: () async {
            final name = TextEditingController(); final phone = TextEditingController(); final open = TextEditingController(text: '0');
            final ok = await showDialog<bool>(context: context, builder: (c) => AlertDialog(title: const Text('مورد جديد'), content: SizedBox(width: 380, child: Column(mainAxisSize: MainAxisSize.min, children: [
              TextField(controller: name, decoration: deco('اسم المورد')), const SizedBox(height: 10), TextField(controller: phone, keyboardType: TextInputType.phone, textDirection: TextDirection.ltr, decoration: deco('التلفون (اختياري)')), const SizedBox(height: 10),
              TextField(controller: open, keyboardType: TextInputType.number, textDirection: TextDirection.ltr, decoration: deco('اللي علينا قبل النظام', suffix: 'د.ع')),
            ])), actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
              try { await api.post('/suppliers', body: sc.body({'name': name.text.trim(), if (phone.text.trim().isNotEmpty) 'phone': phone.text.trim(), 'opening_balance': int.tryParse(open.text.replaceAll(',', '').trim()) ?? 0})); if (c.mounted) Navigator.pop(c, true); } catch (e) { if (c.mounted) showError(c, e); }
            }, child: const Text('حفظ'))]));
            if (ok == true) await reload();
          }),
          if (list.isEmpty) const Empty('ما أكو موردين'),
          for (final s in list) Card(child: ListTile(
            title: Text('${s['name']}${s['is_active'] == false ? ' (معطل)' : ''}'), subtitle: Text('${s['phone'] ?? ''} · باقي علينا ${money(_n(s['balance_owed']))}'),
            trailing: TextButton(onPressed: () async { if (await _pay(context, s)) await reload(); }, child: const Text('تسديد')),
            onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => _StatementPage(supplier: s))),
          )),
        ]);
      },
    );
  }

  Future<bool> _pay(BuildContext context, Map<String, dynamic> s) async {
    final api = _api(context); final amount = TextEditingController(); final bank = TextEditingController(); String source = 'safe'; String date = todayIso();
    final ok = await showDialog<bool>(context: context, builder: (d) => StatefulBuilder(builder: (d, setS) => AlertDialog(
      title: Text('تسديد: ${s['name']}'),
      content: SizedBox(width: 380, child: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: amount, keyboardType: TextInputType.number, textDirection: TextDirection.ltr, decoration: deco('المبلغ', suffix: 'د.ع', hint: 'باقي علينا ${money(_n(s['balance_owed']))}')), const SizedBox(height: 10),
        DropdownButtonFormField<String>(initialValue: source, decoration: deco('من وين'), items: const [DropdownMenuItem(value: 'safe', child: Text('من الخزنة')), DropdownMenuItem(value: 'electronic', child: Text('إلكتروني'))], onChanged: (v) => setS(() => source = v!)),
        if (source == 'electronic') ...[const SizedBox(height: 10), TextField(controller: bank, decoration: deco('اسم المصرف'))],
        const SizedBox(height: 10), DateField(label: 'تاريخ التسديد', value: date, last: DateTime.now(), onChanged: (v) => setS(() => date = v)),
      ])),
      actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
        final a = int.tryParse(amount.text.replaceAll(',', '').trim()); if (a == null || a < 1) { toast(d, 'اكتب المبلغ', error: true); return; }
        try { await api.post('/suppliers/${s['id']}/payments', body: {'amount': a, 'pay_source': source, if (source == 'electronic') 'bank_name': bank.text.trim(), 'paid_on': date}); if (d.mounted) Navigator.pop(d, true); } catch (e) { if (d.mounted) showError(d, e); }
      }, child: const Text('تسديد'))],
    )));
    return ok ?? false;
  }
}

class _StatementPage extends StatelessWidget {
  const _StatementPage({required this.supplier});
  final Map<String, dynamic> supplier;
  @override
  Widget build(BuildContext context) {
    final api = _api(context);
    return Scaffold(
      appBar: AppBar(title: Text('كشف حساب ${supplier['name']}')),
      body: Loader<Map<String, dynamic>>(
        load: () async => Map<String, dynamic>.from(await api.get('/suppliers/${supplier['id']}/statement') as Map),
        builder: (context, d, reload) {
          final rows = ((d['entries'] ?? d['lines'] ?? const []) as List).cast<Map<String, dynamic>>();
          return ListPage(maxWidth: 720, children: [
            Section(child: KV('باقي علينا', money(_n(d['balance_owed'] ?? d['balance'])), bold: true)),
            for (final r in rows) Card(child: ListTile(dense: true, title: Text('${r['label'] ?? r['kind'] ?? ''}'), subtitle: Text('${r['date'] ?? ''}'), trailing: Text(money(_n(r['amount'] ?? 0))))),
            if (rows.isEmpty) const Empty('ما أكو حركات'),
          ]);
        },
      ),
    );
  }
}
