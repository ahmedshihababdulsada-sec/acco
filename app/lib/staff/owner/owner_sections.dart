import 'package:file_picker/file_picker.dart';
import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/theme.dart';
import '../../core/widgets.dart';
import '../manager/admin_shell.dart';
import '../photos.dart';

Api _api(BuildContext c) => c.read<Api>();
BranchScope _scope(BuildContext c) => c.read<BranchScope>();
num _n(dynamic v) => (v as num?) ?? 0;
String _iso(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

// ====================================================================== التقارير
const _reports = [('dashboard', 'الملخص'), ('sales', 'المبيعات'), ('services', 'أرباح الخدمات'), ('cashiers', 'الكاشيرية'), ('stock', 'المخزون'), ('doctors', 'الأطباء'), ('payroll', 'الرواتب')];

class ReportsSection extends StatefulWidget {
  const ReportsSection({super.key});
  @override
  State<ReportsSection> createState() => _ReportsSectionState();
}

class _ReportsSectionState extends State<ReportsSection> {
  String _from = _iso(DateTime(DateTime.now().year, DateTime.now().month, 1));
  String _to = _iso(DateTime.now());
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context); final name = _reports[_tab].$1;
    return Column(children: [
      Material(color: Palette.surface, child: Padding(padding: const EdgeInsets.fromLTRB(12, 16, 12, 8), child: Wrap(spacing: 10, runSpacing: 14, crossAxisAlignment: WrapCrossAlignment.center, children: [
        SizedBox(width: 160, child: DateField(label: 'من', value: _from, last: DateTime.now(), onChanged: (v) => setState(() => _from = v))),
        SizedBox(width: 160, child: DateField(label: 'إلى', value: _to, last: DateTime.now(), onChanged: (v) => setState(() => _to = v))),
        Wrap(spacing: 6, children: [
          for (final f in const [('xlsx', 'Excel'), ('csv', 'CSV')]) OutlinedButton.icon(icon: const Icon(Icons.download, size: 18), label: Text(f.$2), onPressed: () async {
            try {
              final bytes = await api.download('/reports/$name/export', query: {...sc.q, 'from': _from, 'to': _to, 'format': f.$1});
              final saved = await FilePicker.saveFile(fileName: 'report-$name-$_from-$_to.${f.$1}', bytes: bytes, mimeType: f.$1 == 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv');
              if (saved != null && context.mounted) toast(context, 'انحفظ الملف');
            } catch (e) { if (context.mounted) showError(context, e); }
          }),
        ]),
      ]))),
      SizedBox(height: 48, child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 8), children: [
        for (final (i, r) in _reports.indexed) Padding(padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8), child: ChoiceChip(label: Text(r.$2), selected: _tab == i, onSelected: (_) => setState(() => _tab = i))),
      ])),
      Expanded(child: Loader<Map<String, dynamic>>(
        key: ValueKey('$name|$_from|$_to|${sc.selected}'),
        load: () async => Map<String, dynamic>.from(await api.get('/reports/$name', query: {...sc.q, 'from': _from, 'to': _to}) as Map),
        builder: (context, d, reload) => ListPage(maxWidth: 900, children: [_body(name, d), _Basis(d['basis'] as Map<String, dynamic>)]),
      )),
    ]);
  }

  Widget _body(String name, Map<String, dynamic> d) {
    switch (name) {
      case 'dashboard': return _dashboard(d);
      case 'sales': return _sales(d);
      case 'services': return _simpleTable(['الخدمة', 'المنفذ', 'الإيراد', 'كلفة المواد', 'الهامش'], [for (final s in (d['services'] as List).cast<Map<String, dynamic>>()) ['${s['name']}', '${s['executed']}', money(_n(s['revenue'])), money(_n(s['materials_cost'])), money(_n(s['margin']))]], totals: ['الإجمالي', '', money(_n(d['total']['revenue'])), money(_n(d['total']['materials_cost'])), money(_n(d['total']['margin']))]);
      case 'cashiers': return _simpleTable(['الكاشير', 'وصلات', 'الصافي', 'خصم يدوي', 'استرجاع', 'شفتات', 'فرق الصندوق'], [for (final c in (d['cashiers'] as List).cast<Map<String, dynamic>>()) ['${c['name']}', '${c['payments']}', money(_n(c['net'])), money(_n(c['manual_discounts'])), money(_n(c['refunded'])), '${c['shifts']}', money(_n(c['cash_difference']))]]);
      case 'stock': return _stock(d);
      case 'doctors': return _simpleTable(['الطبيب', 'كشفيات', 'صافي الكشفيات', 'نسبته'], [for (final c in (d['doctors'] as List).cast<Map<String, dynamic>>()) ['${c['name']}', '${c['consultations']}', money(_n(c['consultation_net'])), money(_n(c['percent_amount']))]]);
      default: return _payroll(d);
    }
  }

  Widget _dashboard(Map<String, dynamic> d) {
    final col = d['collections'] as Map; final cost = d['costs'] as Map; final cnt = d['counts'] as Map; final al = d['alerts'] as Map;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Wrap(spacing: 10, runSpacing: 10, children: [
        _Stat('صافي المقبوضات', money(_n(col['net'])), Palette.primary), _Stat('الإيراد المنفذ', money(_n((d['executed_revenue'] as Map)['total'])), Palette.primaryDark),
        _Stat('إجمالي التكاليف', money(_n(cost['total'])), Palette.warn), _Stat('ربح الإدارة', money(_n(d['management_profit'])), _n(d['management_profit']) >= 0 ? Palette.ok : Palette.danger),
      ]),
      const SizedBox(height: 12),
      Section(title: 'المقبوضات حسب الطريقة', child: Column(children: [for (final m in (col['by_method'] as List).cast<Map<String, dynamic>>()) KV('${m['method_name']}', money(_n(m['collected']) - _n(m['refunded']))), if ((col['by_method'] as List).isEmpty) const Text('ما أكو', style: TextStyle(color: Palette.muted)), KV('الإجمالي قبل الاسترجاع', money(_n(col['gross']))), KV('الاسترجاعات', money(_n(col['refunds'])))])),
      Section(title: 'التكاليف', child: Column(children: [KV('مواد مستهلكة', money(_n(cost['materials']))), KV('رواتب (استحقاق)', money(_n(cost['salaries']))), KV('تالف', money(_n(cost['waste']))), KV('مصاريف', money(_n(cost['expenses']))), KV('تعويضات', money(_n(cost['compensations']))), KV('المعدات (خارج الربح)', money(_n((d['outside_profit'] as Map)['equipment'])))])),
      Section(title: 'أرقام', child: Column(children: [KV('زبائن جدد', '${cnt['new_customers']}'), KV('إجمالي الزبائن', '${cnt['customers_total']}'), KV('جلسات مكتملة', '${cnt['completed_sessions']}'), KV('كشفيات منتهية', '${cnt['finished_consultations']}'), KV('وصلات', '${cnt['payments']}'), KV('استرجاعات', '${cnt['refunds']}')])),
      Section(title: 'تنبيهات', child: Column(children: [KV('رصيد الخزنة', money(_n(al['safe_balance'])), bold: true), KV('سحوبات معلقة', '${al['pending_withdrawals']}'), KV('مواد بالسالب', '${al['negative_stock']}'), KV('رواتب ما انحددت', '${al['payroll_unset_items']}'),
        if ((al['doctors_without_salary'] as List).isNotEmpty) Notice('أطباء بدون راتب محدد: ${(al['doctors_without_salary'] as List).map((x) => x['full_name']).join('، ')}')])),
    ]);
  }

  Widget _sales(Map<String, dynamic> d) {
    final days = (d['days'] as List).cast<Map<String, dynamic>>(); final t = d['total'] as Map;
    final maxV = days.fold<num>(1, (m, x) => _n(x['net']) > m ? _n(x['net']) : m);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Wrap(spacing: 10, runSpacing: 10, children: [_Stat('الصافي', money(_n(t['net'])), Palette.primary), _Stat('المقبوض', money(_n(t['collected'])), Palette.primaryDark), _Stat('المسترجع', money(_n(t['refunded'])), Palette.danger), _Stat('عدد الوصلات', '${t['payments']}', Palette.muted)]),
      const SizedBox(height: 12),
      Section(title: 'صافي المبيعات اليومي', child: SizedBox(height: 140, child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        for (final x in days) Expanded(child: Tooltip(message: '${dmy(x['day'] as String)}: ${money(_n(x['net']))}', child: Container(margin: const EdgeInsets.symmetric(horizontal: 1), height: 4 + 130 * (_n(x['net']) / maxV).toDouble(), decoration: BoxDecoration(color: _n(x['net']) > 0 ? Palette.primary : Palette.border, borderRadius: BorderRadius.circular(2))))),
      ]))),
      _simpleTable(['اليوم', 'وصلات', 'المقبوض', 'الاسترجاع', 'الصافي'], [for (final x in days.where((x) => _n(x['payments']) > 0 || _n(x['refunds']) > 0)) [dmy(x['day'] as String), '${x['payments']}', money(_n(x['collected'])), money(_n(x['refunded'])), money(_n(x['net']))]]),
    ]);
  }

  Widget _stock(Map<String, dynamic> d) {
    final w = d['waste'] as Map; final adj = d['count_adjustments'] as Map;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Wrap(spacing: 10, runSpacing: 10, children: [_Stat('قيمة المخزون', money(_n((d['valuation'] as Map)['total'])), Palette.primary), _Stat('تالف الفترة', money(_n(w['total_cost'])), Palette.danger)]),
      const SizedBox(height: 12),
      _simpleTable(['المادة', 'الموجود', 'المتاح', 'منتهي', 'القيمة'], [for (final m in (d['materials'] as List).cast<Map<String, dynamic>>()) ['${m['name']}', '${m['on_hand']} ${m['unit']}', '${m['available']}', '${m['expired']}', money(_n(m['value']))]]),
      Section(title: 'تعديلات الجرد', child: Column(children: [KV('عدد الحركات', '${adj['movements']}'), KV('زيادات', money(_n(adj['gains']))), KV('نواقص', money(_n(adj['losses'])))])),
    ]);
  }

  Widget _payroll(Map<String, dynamic> d) {
    final t = d['totals'] as Map;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Wrap(spacing: 10, runSpacing: 10, children: [_Stat('المستحق', money(_n(t['accrued'])), Palette.primary), _Stat('المسدد', money(_n(t['paid'])), Palette.ok), _Stat('ما انحدد', '${t['unset']}', Palette.warn)]),
      const SizedBox(height: 12),
      _simpleTable(['الشهر', 'الاسم', 'الدور', 'الحالة', 'المستحق'], [for (final i in (d['items'] as List).cast<Map<String, dynamic>>()) ['${i['month']}', '${i['full_name']}', '${i['role']}', i['status'] == 'paid' ? 'مسدد' : i['status'] == 'pending' ? 'معلّق' : 'ما انحدد', money(_n(i['total_due']))]]),
    ]);
  }
}

class _Stat extends StatelessWidget {
  const _Stat(this.label, this.value, this.color);
  final String label, value; final Color color;
  @override
  Widget build(BuildContext context) => Container(
        width: 210, padding: const EdgeInsets.all(14), decoration: BoxDecoration(color: Palette.surface, borderRadius: BorderRadius.circular(12), border: Border.all(color: Palette.border)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(label, style: const TextStyle(color: Palette.muted, fontSize: 13)), const SizedBox(height: 6), Text(value, style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: color))]),
      );
}

class _Basis extends StatelessWidget {
  const _Basis(this.b);
  final Map<String, dynamic> b;
  @override
  Widget build(BuildContext context) {
    final lines = b.entries.where((e) => !const {'branch_id', 'from', 'to', 'timezone', 'generated_at'}.contains(e.key)).map((e) => '${e.value}').toList();
    return Padding(padding: const EdgeInsets.only(top: 12), child: ExpansionTile(title: const Text('على أي أساس انحسب هذا التقرير؟', style: TextStyle(fontSize: 13, color: Palette.muted)), children: [for (final l in lines) ListTile(dense: true, title: Text(l, style: const TextStyle(fontSize: 13)))]));
  }
}

Widget _simpleTable(List<String> cols, List<List<String>> rows, {List<String>? totals}) {
  if (rows.isEmpty) return const Empty('ما أكو بيانات بهذي الفترة');
  return Card(child: SingleChildScrollView(scrollDirection: Axis.horizontal, child: DataTable(
    columns: [for (final c in cols) DataColumn(label: Text(c))],
    rows: [for (final r in rows) DataRow(cells: [for (final c in r) DataCell(Text(c))]), if (totals != null) DataRow(cells: [for (final c in totals) DataCell(Text(c, style: const TextStyle(fontWeight: FontWeight.w700)))])],
  )));
}

// ====================================================================== التقييمات
class RatingsSection extends StatefulWidget {
  const RatingsSection({super.key});
  @override
  State<RatingsSection> createState() => _RatingsSectionState();
}

class _RatingsSectionState extends State<RatingsSection> {
  String _from = _iso(DateTime.now().subtract(const Duration(days: 30)));
  String _to = _iso(DateTime.now());

  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context);
    return Loader<Map<String, dynamic>>(
      key: ValueKey('$_from|$_to|${sc.selected}'),
      load: () async => Map<String, dynamic>.from(await api.get('/ratings', query: {...sc.q, 'from': _from, 'to': _to}) as Map),
      builder: (context, d, reload) {
        final svc = (d['by_service'] as List).cast<Map<String, dynamic>>(); final nurses = (d['by_nurse'] as List).cast<Map<String, dynamic>>(); final list = (d['ratings'] as List).cast<Map<String, dynamic>>();
        Widget stars(num v) => Row(mainAxisSize: MainAxisSize.min, children: [const Icon(Icons.star, size: 16, color: Palette.warn), const SizedBox(width: 2), Text(v.toStringAsFixed(1), style: const TextStyle(fontWeight: FontWeight.w700))]);
        return ListPage(maxWidth: 820, children: [
          Row(children: [Expanded(child: DateField(label: 'من', value: _from, last: DateTime.now(), onChanged: (v) => setState(() => _from = v))), const SizedBox(width: 8), Expanded(child: DateField(label: 'إلى', value: _to, last: DateTime.now(), onChanged: (v) => setState(() => _to = v)))]),
          if (list.isEmpty) const Empty('ما أكو تقييمات بهذي الفترة'),
          if (svc.isNotEmpty) Section(title: 'حسب الخدمة', child: Column(children: [for (final s in svc) ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text('${s['service_name']}'), subtitle: Text('${s['count']} تقييم'), trailing: stars(_n(s['average'])))])),
          if (nurses.isNotEmpty) Section(title: 'حسب الممرض', child: Column(children: [for (final s in nurses) ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text('${s['nurse_name']}'), subtitle: Text('${s['count']} تقييم'), trailing: stars(_n(s['average'])))])),
          for (final r in list) Card(child: ListTile(
            leading: stars(_n(r['stars'])), title: Text('${(r['customer'] as Map)['full_name']} · ${(r['service'] as Map)['name']}'), subtitle: Text('ممرض: ${(r['nurse'] as Map)['name']}${r['comment'] == null ? '' : '\n${r['comment']}'}'), isThreeLine: r['comment'] != null,
          )),
        ]);
      },
    );
  }
}

// ====================================================================== التعويضات
class CompensationsSection extends StatelessWidget {
  const CompensationsSection({super.key});
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context);
    return Loader<Map<String, dynamic>>(
      load: () async => Map<String, dynamic>.from(await api.get('/compensations', query: sc.q) as Map),
      builder: (context, d, reload) {
        final list = (d['compensations'] as List).cast<Map<String, dynamic>>();
        return ListPage(maxWidth: 760, children: [
          Section(child: KV('إجمالي التعويضات', money(_n(d['total'])), bold: true)),
          FilledButton.icon(icon: const Icon(Icons.volunteer_activism_outlined), label: const Text('تعويض زبون عن جلسة منفذة'), onPressed: () async { if (await _create(context)) await reload(); }),
          if (list.isEmpty) const Empty('ما أكو تعويضات'),
          for (final c in list) Card(child: ListTile(title: Text('${money(_n(c['amount']))} · ${c['pay_source'] == 'safe' ? 'من الخزنة' : 'إلكتروني ${c['bank_name'] ?? ''}'}'), subtitle: Text('${c['reason']}'))),
        ]);
      },
    );
  }

  Future<bool> _create(BuildContext context) async {
    final api = _api(context);
    final cust = await showDialog<Map<String, dynamic>>(context: context, builder: (_) => ChangeNotifierProvider.value(value: _scope(context), child: const _CustomerPickDialog()));
    if (cust == null || !context.mounted) return false;
    List<Map<String, dynamic>> sessions;
    try { sessions = ((await api.get('/customers/${cust['id']}/sessions'))['sessions'] as List).cast<Map<String, dynamic>>().where((s) => s['status'] == 'completed').toList(); } catch (e) { if (context.mounted) showError(context, e); return false; }
    if (!context.mounted) return false;
    if (sessions.isEmpty) { toast(context, 'ما أكو جلسات منفذة لهذا الزبون', error: true); return false; }
    int sid = sessions.first['id'] as int; final amount = TextEditingController(); final reason = TextEditingController(); final bank = TextEditingController(); String source = 'safe';
    final ok = await showDialog<bool>(context: context, builder: (d) => StatefulBuilder(builder: (d, setS) => AlertDialog(
      title: Text('تعويض ${cust['full_name']}'),
      content: SizedBox(width: 400, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
        DropdownButtonFormField<int>(initialValue: sid, decoration: deco('الجلسة'), items: [for (final s in sessions) DropdownMenuItem(value: s['id'] as int, child: Text('${s['service_name']} #${s['seq_no']}'))], onChanged: (v) => setS(() => sid = v!)), const SizedBox(height: 10),
        TextField(controller: amount, keyboardType: TextInputType.number, textDirection: TextDirection.ltr, decoration: deco('المبلغ', suffix: 'د.ع')), const SizedBox(height: 10),
        TextField(controller: reason, decoration: deco('السبب')), const SizedBox(height: 10),
        DropdownButtonFormField<String>(initialValue: source, decoration: deco('من وين'), items: const [DropdownMenuItem(value: 'safe', child: Text('من الخزنة')), DropdownMenuItem(value: 'electronic', child: Text('إلكتروني'))], onChanged: (v) => setS(() => source = v!)),
        if (source == 'electronic') ...[const SizedBox(height: 10), TextField(controller: bank, decoration: deco('اسم المصرف'))],
      ]))),
      actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
        final a = int.tryParse(amount.text.replaceAll(',', '').trim()); if (a == null || a < 1) { toast(d, 'اكتب المبلغ', error: true); return; }
        try { await api.post('/compensations', body: {'session_id': sid, 'amount': a, 'reason': reason.text.trim(), 'pay_source': source, if (source == 'electronic') 'bank_name': bank.text.trim()}); if (d.mounted) Navigator.pop(d, true); } catch (e) { if (d.mounted) showError(d, e); }
      }, child: const Text('تسجيل'))],
    )));
    return ok ?? false;
  }
}

class _CustomerPickDialog extends StatefulWidget {
  const _CustomerPickDialog();
  @override
  State<_CustomerPickDialog> createState() => _CustomerPickDialogState();
}

class _CustomerPickDialogState extends State<_CustomerPickDialog> {
  final _c = TextEditingController(); List<Map<String, dynamic>> _res = []; String? _err;
  Future<void> _search() async {
    try { final r = ((await context.read<Api>().get('/customers', query: {'q': _c.text.trim()})) as List).cast<Map<String, dynamic>>(); setState(() { _res = r; _err = null; }); } on ApiException catch (e) { setState(() => _err = e.message); }
  }
  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('اختر الزبون'),
        content: SizedBox(width: 400, child: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: _c, autofocus: true, textInputAction: TextInputAction.search, onSubmitted: (_) => _search(), decoration: deco('اسم أو رقم تلفون').copyWith(suffixIcon: IconButton(onPressed: _search, icon: const Icon(Icons.search)))),
          if (_err != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_err!, style: const TextStyle(color: Palette.danger))),
          Flexible(child: ListView(shrinkWrap: true, children: [for (final r in _res) ListTile(title: Text('${r['full_name']}'), subtitle: Text('${r['phone'] ?? ''}', textDirection: TextDirection.ltr), onTap: () => Navigator.pop(context, r))])),
        ])),
        actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('رجوع'))],
      );
}

// ====================================================================== دمج ملفات الزبائن
class CustomerMergeSection extends StatefulWidget {
  const CustomerMergeSection({super.key});
  @override
  State<CustomerMergeSection> createState() => _CustomerMergeSectionState();
}

class _CustomerMergeSectionState extends State<CustomerMergeSection> {
  Map<String, dynamic>? _dup, _keep; final _reason = TextEditingController();

  Future<void> _pick(bool dup) async {
    final c = await showDialog<Map<String, dynamic>>(context: context, builder: (_) => ChangeNotifierProvider.value(value: _scope(context), child: const _CustomerPickDialog()));
    if (c != null) setState(() => dup ? _dup = c : _keep = c);
  }

  @override
  Widget build(BuildContext context) {
    final api = _api(context);
    Widget card(String title, Map<String, dynamic>? c, bool dup) => Section(title: title, child: Row(children: [Expanded(child: Text(c == null ? 'ما اتحدد' : '${c['full_name']} · ${ltr('${c['phone'] ?? ''}')}')), OutlinedButton(onPressed: () => _pick(dup), child: Text(c == null ? 'اختيار' : 'تغيير'))]));
    return ListPage(maxWidth: 640, children: [
      const Notice('الدمج يحول كل بيانات الملف المكرر (حجوزات، مواعيد، نقاط، إشعارات) للملف الباقي ثم يقفل المكرر. ما ينرجع. يتمنع إذا للمكرر مدفوعات أو علاجات أو زيارات بنفس اليوم.'),
      card('الملف المكرر (يتقفل)', _dup, true), card('الملف الباقي', _keep, false),
      TextField(controller: _reason, decoration: deco('سبب الدمج')),
      AsyncButton(icon: Icons.merge_type, danger: true, onPressed: () async {
        if (_dup == null || _keep == null) { toast(context, 'اختر الملفين', error: true); return; }
        if (_dup!['id'] == _keep!['id']) { toast(context, 'اختر ملفين مختلفين', error: true); return; }
        if (!await confirm(context, 'دمج ${_dup!['full_name']} داخل ${_keep!['full_name']}؟', body: 'ما يمكن التراجع.', danger: true, yes: 'دمج')) return;
        await api.post('/customers/${_dup!['id']}/merge', body: {'into_id': _keep!['id'], 'reason': _reason.text.trim()});
        if (mounted) { toast(context, 'تم الدمج'); setState(() { _dup = null; _keep = null; _reason.clear(); }); }
      }, child: const Text('دمج')),
    ]);
  }
}

// ====================================================================== صور قبل وبعد (المالك: عرض وحذف)
class PhotosSection extends StatefulWidget {
  const PhotosSection({super.key});
  @override
  State<PhotosSection> createState() => _PhotosSectionState();
}

class _PhotosSectionState extends State<PhotosSection> {
  Map<String, dynamic>? _customer;

  @override
  Widget build(BuildContext context) {
    return ListPage(maxWidth: 820, children: [
      Section(child: Row(children: [
        Expanded(child: Text(_customer == null ? 'اختر زبون لعرض صوره' : '${_customer!['full_name']} · ${ltr('${_customer!['phone'] ?? ''}')}', style: const TextStyle(fontWeight: FontWeight.w600))),
        OutlinedButton(onPressed: () async {
          final c = await showDialog<Map<String, dynamic>>(context: context, builder: (_) => ChangeNotifierProvider.value(value: _scope(context), child: const _CustomerPickDialog()));
          if (c != null) setState(() => _customer = c);
        }, child: Text(_customer == null ? 'اختيار' : 'تغيير')),
      ])),
      if (_customer != null) Section(title: 'الصور', child: PhotoGallery(key: ValueKey(_customer!['id']), customerId: _customer!['id'] as int, canDelete: true)),
      const Notice('الحذف ناعم: الصورة تختفي من القوائم وينسجل مين حذفها وليش، والملف يبقى محفوظ بالخادم.'),
    ]);
  }
}
