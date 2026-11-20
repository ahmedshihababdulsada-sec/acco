import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/session.dart';
import '../../core/theme.dart';
import '../../core/widgets.dart';
import 'admin_shell.dart';
import 'sections_stock.dart' show pickAndUpload;

Api _api(BuildContext c) => c.read<Api>();
BranchScope _scope(BuildContext c) => c.read<BranchScope>();
bool _isOwner(BuildContext c) => c.read<Session>().user?.role == 'owner';
num _n(dynamic v) => (v as num?) ?? 0;
String _month(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}';
DateTime _shift(String m, int by) { final p = m.split('-'); return DateTime(int.parse(p[0]), int.parse(p[1]) + by, 1); }
const _roles = {'owner': 'مالك', 'manager': 'مدير', 'cashier': 'كاشير', 'doctor': 'طبيب', 'nurse': 'ممرض'};

Future<void> _showSecret(BuildContext context, String title, String secret) => showDialog(context: context, builder: (d) => AlertDialog(
      title: Text(title),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('سلّمها للموظف الحين: ما تنعرض مرة ثانية. يغيّرها عند أول دخول.'), const SizedBox(height: 12),
        Container(padding: const EdgeInsets.all(12), decoration: BoxDecoration(color: Palette.primarySoft, borderRadius: BorderRadius.circular(8)), child: SelectableText(secret, textDirection: TextDirection.ltr, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700, letterSpacing: 1))),
      ]),
      actions: [TextButton(onPressed: () { Clipboard.setData(ClipboardData(text: secret)); toast(d, 'اننسخت'); }, child: const Text('نسخ')), FilledButton(onPressed: () => Navigator.pop(d), child: const Text('تم'))],
    ));

// ====================================================================== المصاريف
class ExpensesSection extends StatefulWidget {
  const ExpensesSection({super.key});
  @override
  State<ExpensesSection> createState() => _ExpensesSectionState();
}

class _ExpensesSectionState extends State<ExpensesSection> {
  String _m = _month(DateTime.now());
  int _tick = 0;

  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context); final owner = _isOwner(context);
    return Loader<Map<String, dynamic>>(
      key: ValueKey('$_m-$_tick'),
      load: () async {
        final e = Map<String, dynamic>.from(await api.get('/expenses', query: {...sc.q, 'month': _m}) as Map);
        final c = Map<String, dynamic>.from(await api.get('/expense-categories', query: sc.q) as Map);
        return {'e': e, 'c': (c['categories'] as List).cast<Map<String, dynamic>>()};
      },
      builder: (context, d, reload) {
        final e = d['e'] as Map<String, dynamic>; final cats = d['c'] as List<Map<String, dynamic>>;
        final list = (e['expenses'] as List).cast<Map<String, dynamic>>();
        Future<void> refresh() async { setState(() => _tick++); }
        return ListPage(maxWidth: 820, children: [
          Row(children: [
            IconButton(onPressed: () => setState(() => _m = _month(_shift(_m, -1))), icon: const Icon(Icons.chevron_right)),
            Expanded(child: Center(child: Text(_m, textDirection: TextDirection.ltr, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)))),
            IconButton(onPressed: _m == _month(DateTime.now()) ? null : () => setState(() => _m = _month(_shift(_m, 1))), icon: const Icon(Icons.chevron_left)),
          ]),
          Section(child: Column(children: [
            KV('إجمالي المصاريف الفعالة', money(_n(e['total_active'])), bold: true),
            for (final c in (e['by_category'] as List).cast<Map<String, dynamic>>()) KV('${c['name']}', money(_n(c['total']))),
          ])),
          Wrap(spacing: 8, runSpacing: 8, children: [
            FilledButton.icon(icon: const Icon(Icons.add), label: const Text('مصروف جديد'), onPressed: cats.where((c) => c['is_active'] != false).isEmpty ? null : () async { if (await _create(context, cats)) await refresh(); }),
            OutlinedButton.icon(icon: const Icon(Icons.category_outlined), label: const Text('أنواع المصاريف'), onPressed: () async { await _categories(context, cats); await refresh(); }),
          ]),
          if (cats.isEmpty) const Notice('أضف نوع مصروف أول (مثلاً: إيجار، كهرباء) قبل تسجيل المصاريف.'),
          if (list.isEmpty) const Empty('ما أكو مصاريف بهذا الشهر'),
          for (final x in list) Card(child: ListTile(
            title: Text('${(x['category'] as Map)['name']} · ${money(_n(x['amount']))}${x['status'] == 'cancelled' ? '  (ملغى)' : ''}', style: TextStyle(decoration: x['status'] == 'cancelled' ? TextDecoration.lineThrough : null)),
            subtitle: Text('${dmy(x['expense_date'] as String)} · ${x['pay_source'] == 'safe' ? 'من الخزنة' : 'إلكتروني ${x['bank_name'] ?? ''}'}${x['description'] == null ? '' : '\n${x['description']}'}${(x['edits'] as List).isNotEmpty ? '\nعُدّل · كان ${money(_n(x['original_amount']))}' : ''}${x['cancel_reason'] == null ? '' : '\nسبب الإلغاء: ${x['cancel_reason']}'}'),
            isThreeLine: true,
            trailing: owner && x['status'] == 'active' ? PopupMenuButton<String>(onSelected: (v) async { final ok = v == 'edit' ? await _edit(context, x, cats) : await _cancel(context, x); if (ok) await refresh(); }, itemBuilder: (_) => const [PopupMenuItem(value: 'edit', child: Text('تعديل')), PopupMenuItem(value: 'cancel', child: Text('إلغاء'))]) : null,
          )),
        ]);
      },
    );
  }

  Future<bool> _create(BuildContext context, List<Map<String, dynamic>> cats) async {
    final api = _api(context); final sc = _scope(context);
    final active = cats.where((c) => c['is_active'] != false).toList();
    int cat = active.first['id'] as int; final amount = TextEditingController(); final desc = TextEditingController(); final bank = TextEditingController();
    String source = 'safe'; String date = todayIso(); int? proof; String? proofName;
    final ok = await showDialog<bool>(context: context, builder: (d) => StatefulBuilder(builder: (d, setS) => AlertDialog(
      title: const Text('مصروف جديد'),
      content: SizedBox(width: 420, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
        DropdownButtonFormField<int>(initialValue: cat, decoration: deco('النوع'), items: [for (final c in active) DropdownMenuItem(value: c['id'] as int, child: Text(c['name'] as String))], onChanged: (v) => setS(() => cat = v!)), const SizedBox(height: 10),
        TextField(controller: amount, keyboardType: TextInputType.number, textDirection: TextDirection.ltr, decoration: deco('المبلغ', suffix: 'د.ع')), const SizedBox(height: 10),
        DateField(label: 'التاريخ', value: date, last: DateTime.now(), onChanged: (v) => setS(() => date = v)), const SizedBox(height: 10),
        TextField(controller: desc, decoration: deco('وصف (اختياري)')), const SizedBox(height: 10),
        DropdownButtonFormField<String>(initialValue: source, decoration: deco('من وين انصرف'), items: const [DropdownMenuItem(value: 'safe', child: Text('من الخزنة (ينقص رصيدها)')), DropdownMenuItem(value: 'electronic', child: Text('إلكتروني'))], onChanged: (v) => setS(() => source = v!)),
        if (source == 'electronic') ...[const SizedBox(height: 10), TextField(controller: bank, decoration: deco('اسم المصرف'))],
        const SizedBox(height: 10),
        OutlinedButton.icon(onPressed: () async { try { final id = await pickAndUpload(d, 'expense_proof'); if (id != null) setS(() { proof = id; proofName = 'تم رفع الإثبات'; }); } catch (e) { if (d.mounted) showError(d, e); } }, icon: Icon(proof == null ? Icons.upload_file : Icons.check_circle, color: proof == null ? null : Palette.ok), label: Text(proofName ?? 'رفع صورة الإثبات (إلزامي)')),
      ]))),
      actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
        final a = int.tryParse(amount.text.replaceAll(',', '').trim());
        if (a == null || a < 1) { toast(d, 'اكتب المبلغ', error: true); return; }
        if (proof == null) { toast(d, 'ارفع صورة الإثبات', error: true); return; }
        try { await api.post('/expenses', body: sc.body({'category_id': cat, 'amount': a, 'expense_date': date, if (desc.text.trim().isNotEmpty) 'description': desc.text.trim(), 'pay_source': source, if (source == 'electronic') 'bank_name': bank.text.trim(), 'proof_attachment_id': proof})); if (d.mounted) Navigator.pop(d, true); } catch (e) { if (d.mounted) showError(d, e); }
      }, child: const Text('حفظ'))],
    )));
    return ok ?? false;
  }

  Future<bool> _edit(BuildContext context, Map<String, dynamic> x, List<Map<String, dynamic>> cats) async {
    final api = _api(context); final amount = TextEditingController(text: '${x['amount']}'); final desc = TextEditingController(text: '${x['description'] ?? ''}'); final reason = TextEditingController();
    int cat = (x['category'] as Map)['id'] as int; String date = x['expense_date'] as String;
    final ok = await showDialog<bool>(context: context, builder: (d) => StatefulBuilder(builder: (d, setS) => AlertDialog(
      title: const Text('تعديل المصروف'),
      content: SizedBox(width: 420, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
        DropdownButtonFormField<int>(initialValue: cat, decoration: deco('النوع'), items: [for (final c in cats) DropdownMenuItem(value: c['id'] as int, child: Text(c['name'] as String))], onChanged: (v) => setS(() => cat = v!)), const SizedBox(height: 10),
        TextField(controller: amount, keyboardType: TextInputType.number, textDirection: TextDirection.ltr, decoration: deco('المبلغ', suffix: 'د.ع')), const SizedBox(height: 10),
        DateField(label: 'التاريخ', value: date, last: DateTime.now(), onChanged: (v) => setS(() => date = v)), const SizedBox(height: 10),
        TextField(controller: desc, decoration: deco('وصف')), const SizedBox(height: 10),
        TextField(controller: reason, decoration: deco('سبب التعديل (إلزامي)')),
      ]))),
      actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
        final a = int.tryParse(amount.text.replaceAll(',', '').trim()); if (a == null || a < 1) { toast(d, 'اكتب المبلغ', error: true); return; }
        if (reason.text.trim().length < 3) { toast(d, 'اكتب سبب التعديل', error: true); return; }
        try { await api.put('/expenses/${x['id']}', body: {'expected_version': x['version'], 'reason': reason.text.trim(), 'category_id': cat, 'amount': a, 'expense_date': date, 'description': desc.text.trim()}); if (d.mounted) Navigator.pop(d, true); } catch (e) { if (d.mounted) showError(d, e); }
      }, child: const Text('حفظ'))],
    )));
    return ok ?? false;
  }

  Future<bool> _cancel(BuildContext context, Map<String, dynamic> x) async {
    final api = _api(context);
    final reason = await askText(context, 'إلغاء المصروف', label: 'سبب الإلغاء', yes: 'إلغاء المصروف');
    if (reason == null) return false;
    try { await api.post('/expenses/${x['id']}/cancel', body: {'reason': reason}); return true; } catch (e) { if (context.mounted) showError(context, e); return false; }
  }

  Future<void> _categories(BuildContext context, List<Map<String, dynamic>> cats) async {
    final api = _api(context); final sc = _scope(context); final name = TextEditingController(); String kind = 'operating';
    await showDialog(context: context, builder: (d) => StatefulBuilder(builder: (d, setS) => AlertDialog(
      title: const Text('أنواع المصاريف'),
      content: SizedBox(width: 420, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final c in cats) ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text('${c['name']}${c['is_active'] == false ? ' (معطل)' : ''}'), subtitle: Text(c['kind'] == 'equipment' ? 'معدات (خارج الربح)' : c['kind'] == 'payment_fee' ? 'عمولة دفع' : 'تشغيلي'),
          trailing: TextButton(onPressed: () async { try { await api.patch('/expense-categories/${c['id']}', body: {'is_active': c['is_active'] == false}); if (d.mounted) Navigator.pop(d); } catch (e) { if (d.mounted) showError(d, e); } }, child: Text(c['is_active'] == false ? 'تفعيل' : 'تعطيل'))),
        const Divider(), TextField(controller: name, decoration: deco('نوع جديد')), const SizedBox(height: 8),
        DropdownButtonFormField<String>(initialValue: kind, decoration: deco('التصنيف'), items: const [DropdownMenuItem(value: 'operating', child: Text('تشغيلي')), DropdownMenuItem(value: 'payment_fee', child: Text('عمولة جهاز/مصرف')), DropdownMenuItem(value: 'equipment', child: Text('معدات طويلة الاستخدام (خارج الربح)'))], onChanged: (v) => setS(() => kind = v!)),
        const SizedBox(height: 8), FilledButton(onPressed: () async { if (name.text.trim().length < 2) { toast(d, 'اكتب الاسم', error: true); return; } try { await api.post('/expense-categories', body: sc.body({'name': name.text.trim(), 'kind': kind})); if (d.mounted) Navigator.pop(d); } catch (e) { if (d.mounted) showError(d, e); } }, child: const Text('إضافة')),
      ]))),
      actions: [TextButton(onPressed: () => Navigator.pop(d), child: const Text('إغلاق'))],
    )));
  }
}

// ====================================================================== الموظفين
class StaffSection extends StatelessWidget {
  const StaffSection({super.key});
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context); final owner = _isOwner(context);
    return Loader<List<Map<String, dynamic>>>(
      load: () async => ((await api.get('/staff', query: sc.q)) as List).cast<Map<String, dynamic>>(),
      builder: (context, list, reload) => ListPage(maxWidth: 820, children: [
        FilledButton.icon(icon: const Icon(Icons.person_add_alt), label: const Text('موظف جديد'), onPressed: () async { if (await _create(context, owner)) await reload(); }),
        for (final u in list) Card(child: ListTile(
          title: Text('${u['full_name']}${u['is_active'] == false ? ' (معطل)' : ''}'), subtitle: Text('${_roles[u['role']] ?? u['role']} · ${u['username']}', textDirection: TextDirection.rtl),
          trailing: PopupMenuButton<String>(onSelected: (v) async {
            try {
              if (v == 'reset') {
                if (!await confirm(context, 'إعادة تعيين كلمة السر؟', body: 'تنطي كلمة مؤقتة ويطلع من كل أجهزته.')) return;
                final r = await api.post('/staff/${u['id']}/reset-password', body: {}); if (context.mounted) await _showSecret(context, 'كلمة السر المؤقتة', (r as Map)['temp_password'] as String);
              } else {
                final reason = await askText(context, v == 'off' ? 'تعطيل الموظف' : 'إعادة تفعيل', label: 'السبب (اختياري)', minLen: 0);
                if (reason == null) return; await api.post('/staff/${u['id']}/${v == 'off' ? 'deactivate' : 'reactivate'}', body: {'reason': reason});
                await reload();
              }
            } catch (e) { if (context.mounted) showError(context, e); }
          }, itemBuilder: (_) => [const PopupMenuItem(value: 'reset', child: Text('إعادة تعيين كلمة السر')), PopupMenuItem(value: u['is_active'] == false ? 'on' : 'off', child: Text(u['is_active'] == false ? 'إعادة تفعيل' : 'تعطيل'))]),
        )),
      ]),
    );
  }

  Future<bool> _create(BuildContext context, bool owner) async {
    final api = _api(context); final sc = _scope(context);
    final user = TextEditingController(); final name = TextEditingController(); final phone = TextEditingController(); final title = TextEditingController(); final room = TextEditingController();
    String role = 'cashier';
    final ok = await showDialog<bool>(context: context, builder: (d) => StatefulBuilder(builder: (d, setS) => AlertDialog(
      title: const Text('موظف جديد'),
      content: SizedBox(width: 400, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: name, decoration: deco('الاسم الكامل')), const SizedBox(height: 10),
        TextField(controller: user, textDirection: TextDirection.ltr, decoration: deco('اسم المستخدم', hint: 'حروف إنجليزية وأرقام')), const SizedBox(height: 10),
        TextField(controller: phone, keyboardType: TextInputType.phone, textDirection: TextDirection.ltr, decoration: deco('التلفون (اختياري)')), const SizedBox(height: 10),
        DropdownButtonFormField<String>(initialValue: role, decoration: deco('الدور'), items: [if (owner) const DropdownMenuItem(value: 'manager', child: Text('مدير')), const DropdownMenuItem(value: 'cashier', child: Text('كاشير')), const DropdownMenuItem(value: 'doctor', child: Text('طبيب')), const DropdownMenuItem(value: 'nurse', child: Text('ممرض'))], onChanged: (v) => setS(() => role = v!)),
        if (role == 'doctor') ...[const SizedBox(height: 10), TextField(controller: title, decoration: deco('اللقب (اختياري)')), const SizedBox(height: 10), TextField(controller: room, decoration: deco('الغرفة (اختياري)'))],
      ]))),
      actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
        try {
          final r = await api.post('/staff', body: sc.body({'username': user.text.trim(), 'full_name': name.text.trim(), if (phone.text.trim().isNotEmpty) 'phone': phone.text.trim(), 'role': role, if (role == 'doctor' && title.text.trim().isNotEmpty) 'title': title.text.trim(), if (role == 'doctor' && room.text.trim().isNotEmpty) 'room': room.text.trim()}));
          if (d.mounted) Navigator.pop(d, true);
          if (context.mounted) await _showSecret(context, 'كلمة السر المؤقتة', (r as Map)['temp_password'] as String);
        } catch (e) { if (d.mounted) showError(d, e); }
      }, child: const Text('إنشاء'))],
    )));
    return ok ?? false;
  }
}

// ====================================================================== الرواتب
class PayrollSection extends StatelessWidget {
  const PayrollSection({super.key});
  @override
  Widget build(BuildContext context) => DefaultTabController(length: 2, child: Column(children: const [
        Material(color: Palette.surface, child: TabBar(tabs: [Tab(text: 'رواتب الشهر'), Tab(text: 'قواعد الرواتب')])),
        Expanded(child: TabBarView(children: [_MonthTab(), _RulesTab()])),
      ]));
}

class _MonthTab extends StatefulWidget {
  const _MonthTab();
  @override
  State<_MonthTab> createState() => _MonthTabState();
}

class _MonthTabState extends State<_MonthTab> {
  String _m = _month(DateTime.now());
  int _tick = 0;

  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context); final owner = _isOwner(context);
    return Loader<Map<String, dynamic>>(
      key: ValueKey('$_m-$_tick'),
      load: () async => Map<String, dynamic>.from(await api.get('/payroll', query: {...sc.q, 'month': _m}) as Map),
      builder: (context, d, reload) {
        void refresh() => setState(() => _tick++);
        final items = (d['items'] as List).cast<Map<String, dynamic>>();
        final totals = d['totals'] as Map<String, dynamic>;
        return ListPage(maxWidth: 820, children: [
          Row(children: [
            IconButton(onPressed: () => setState(() => _m = _month(_shift(_m, -1))), icon: const Icon(Icons.chevron_right)),
            Expanded(child: Center(child: Text(_m, textDirection: TextDirection.ltr, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)))),
            IconButton(onPressed: _m == _month(DateTime.now()) ? null : () => setState(() => _m = _month(_shift(_m, 1))), icon: const Icon(Icons.chevron_left)),
          ]),
          if (d['generated'] != true) Section(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const Text('كشف هذا الشهر ما انولّد بعد. التوليد يأخذ القاعدة السارية بآخر يوم بالشهر لكل موظف (الشهر كامل بدون تناسب).'),
            const SizedBox(height: 8),
            AsyncButton(icon: Icons.playlist_add_check, onPressed: () async { await api.post('/payroll/generate', body: sc.body({'month': _m})); refresh(); }, child: const Text('توليد كشف الرواتب')),
          ])) else ...[
            Section(child: Column(children: [KV('إجمالي المستحق', money(_n(totals['due'])), bold: true), KV('المسدد', money(_n(totals['paid']))), KV('المتبقي', money(_n(totals['pending'])))])),
            if (_n(d['not_payable']) > 0) Notice('${d['not_payable']} موظف راتبه ما انحدد: لازم المالك يحدده.'),
            for (final i in items) _ItemCard(item: i, owner: owner, onChanged: refresh),
          ],
        ]);
      },
    );
  }
}

class _ItemCard extends StatelessWidget {
  const _ItemCard({required this.item, required this.owner, required this.onChanged});
  final Map<String, dynamic> item; final bool owner; final VoidCallback onChanged;
  @override
  Widget build(BuildContext context) {
    final st = item['status'] as String; final u = item['user'] as Map;
    return Section(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [
        Expanded(child: Text('${u['full_name']} · ${_roles[u['role']] ?? u['role']}', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15))),
        st == 'paid' ? Pill.ok('مسدد') : st == 'pending' ? Pill.warn('معلّق') : Pill.danger('الراتب ما انحدد'),
      ]),
      const SizedBox(height: 6),
      if (item['base_salary'] != null) KV('الأساسي', money(_n(item['base_salary']))),
      if (_n(item['consult_amount']) != 0) KV('نسبة الكشفيات', money(_n(item['consult_amount']))),
      if (_n(item['adjustment_amount']) != 0) KV('تعديل (${item['adjustment_reason'] ?? ''})', money(_n(item['adjustment_amount']))),
      if (st != 'not_payable') KV('المستحق', money(_n(item['total_due'])), bold: true),
      if (st == 'paid') Text('انسدد ${dmy(item['paid_on'] as String)} · ${item['pay_source'] == 'safe' ? 'من الخزنة' : 'إلكتروني ${item['bank_name'] ?? ''}'}', style: const TextStyle(color: Palette.muted, fontSize: 13)),
      if (st == 'pending') Wrap(spacing: 8, children: [
        OutlinedButton(onPressed: () async { if (await _adjust(context)) onChanged(); }, child: const Text('تعديل')),
        FilledButton(onPressed: () async { if (await _pay(context)) onChanged(); }, child: const Text('تسديد')),
      ]),
      if (st == 'not_payable' && owner) FilledButton(onPressed: () async { if (await _setBase(context)) onChanged(); }, child: const Text('تحديد الراتب')),
    ]));
  }

  Future<bool> _adjust(BuildContext context) async {
    final api = _api(context); final amount = TextEditingController(text: '${item['adjustment_amount']}'); final reason = TextEditingController(text: '${item['adjustment_reason'] ?? ''}');
    final ok = await showDialog<bool>(context: context, builder: (d) => AlertDialog(
      title: const Text('تعديل الراتب'),
      content: SizedBox(width: 380, child: Column(mainAxisSize: MainAxisSize.min, children: [
        const Text('موجب = إضافة، سالب = خصم. يستبدل التعديل السابق. صفر = إلغاء التعديل.', style: TextStyle(color: Palette.muted, fontSize: 13)), const SizedBox(height: 10),
        TextField(controller: amount, keyboardType: const TextInputType.numberWithOptions(signed: true), textDirection: TextDirection.ltr, decoration: deco('مبلغ التعديل', suffix: 'د.ع')), const SizedBox(height: 10),
        TextField(controller: reason, decoration: deco('السبب')),
      ])),
      actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
        final a = int.tryParse(amount.text.replaceAll(',', '').trim()); if (a == null) { toast(d, 'مبلغ غير صحيح', error: true); return; }
        try { await api.post('/payroll/items/${item['id']}/adjust', body: {'amount': a, if (reason.text.trim().isNotEmpty) 'reason': reason.text.trim()}); if (d.mounted) Navigator.pop(d, true); } catch (e) { if (d.mounted) showError(d, e); }
      }, child: const Text('حفظ'))],
    ));
    return ok ?? false;
  }

  Future<bool> _pay(BuildContext context) async {
    final api = _api(context); final bank = TextEditingController(); final note = TextEditingController(); String source = 'safe'; String date = todayIso();
    final ok = await showDialog<bool>(context: context, builder: (d) => StatefulBuilder(builder: (d, setS) => AlertDialog(
      title: Text('تسديد ${money(_n(item['total_due']))}'),
      content: SizedBox(width: 380, child: Column(mainAxisSize: MainAxisSize.min, children: [
        DropdownButtonFormField<String>(initialValue: source, decoration: deco('من وين'), items: const [DropdownMenuItem(value: 'safe', child: Text('من الخزنة')), DropdownMenuItem(value: 'electronic', child: Text('إلكتروني'))], onChanged: (v) => setS(() => source = v!)),
        if (source == 'electronic') ...[const SizedBox(height: 10), TextField(controller: bank, decoration: deco('اسم المصرف'))],
        const SizedBox(height: 10), DateField(label: 'تاريخ التسديد', value: date, last: DateTime.now(), onChanged: (v) => setS(() => date = v)),
        const SizedBox(height: 10), TextField(controller: note, decoration: deco('ملاحظة (اختياري)')),
      ])),
      actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
        try { await api.post('/payroll/items/${item['id']}/pay', body: {'pay_source': source, if (source == 'electronic') 'bank_name': bank.text.trim(), 'paid_on': date, if (note.text.trim().isNotEmpty) 'note': note.text.trim()}); if (d.mounted) Navigator.pop(d, true); } catch (e) { if (d.mounted) showError(d, e); }
      }, child: const Text('تسديد'))],
    )));
    return ok ?? false;
  }

  Future<bool> _setBase(BuildContext context) async {
    final api = _api(context); final amount = TextEditingController(); final reason = TextEditingController();
    final ok = await showDialog<bool>(context: context, builder: (d) => AlertDialog(
      title: const Text('تحديد الراتب الأساسي'),
      content: SizedBox(width: 380, child: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: amount, keyboardType: TextInputType.number, textDirection: TextDirection.ltr, decoration: deco('الراتب الأساسي', suffix: 'د.ع')), const SizedBox(height: 10),
        TextField(controller: reason, decoration: deco('السبب')),
      ])),
      actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
        final a = int.tryParse(amount.text.replaceAll(',', '').trim()); if (a == null || a < 0) { toast(d, 'مبلغ غير صحيح', error: true); return; }
        try { await api.post('/payroll/items/${item['id']}/set-base', body: {'base_salary': a, 'reason': reason.text.trim()}); if (d.mounted) Navigator.pop(d, true); } catch (e) { if (d.mounted) showError(d, e); }
      }, child: const Text('حفظ'))],
    ));
    return ok ?? false;
  }
}

class _RulesTab extends StatelessWidget {
  const _RulesTab();
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context);
    return Loader<List<Map<String, dynamic>>>(
      load: () async => ((await api.get('/payroll/staff', query: sc.q))['staff'] as List).cast<Map<String, dynamic>>(),
      builder: (context, list, reload) => ListPage(maxWidth: 820, children: [
        const Notice('القاعدة السارية بآخر يوم بالشهر هي اللي تنحسب بالكشف. التغيير ينطبق من تاريخ «يسري من» وما يغيّر أشهر سابقة انولّدت.'),
        for (final s in list) Card(child: ListTile(
          title: Text('${s['full_name']} · ${_roles[s['role']] ?? s['role']}'),
          subtitle: Text(s['salary_set'] == true || s['monthly_salary'] != null ? 'راتب ${money(_n(s['monthly_salary']))}${s['consult_percent'] != null ? ' · نسبة ${s['consult_percent']}%' : ''}${s['since'] != null ? ' · من ${dmy(s['since'] as String)}' : ''}' : 'الراتب ما انحدد'),
          trailing: TextButton(onPressed: () async { if (await _edit(context, s)) await reload(); }, child: const Text('تغيير')),
        )),
      ]),
    );
  }

  Future<bool> _edit(BuildContext context, Map<String, dynamic> s) async {
    final api = _api(context); final owner = _isOwner(context);
    final salary = TextEditingController(text: s['monthly_salary'] == null ? '' : '${s['monthly_salary']}'); final pct = TextEditingController(text: s['consult_percent'] == null ? '' : '${s['consult_percent']}'); String from = todayIso();
    final doctor = s['role'] == 'doctor';
    final ok = await showDialog<bool>(context: context, builder: (d) => StatefulBuilder(builder: (d, setS) => AlertDialog(
      title: Text('راتب ${s['full_name']}'),
      content: SizedBox(width: 380, child: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: salary, keyboardType: TextInputType.number, textDirection: TextDirection.ltr, decoration: deco('الراتب الشهري', suffix: 'د.ع')), const SizedBox(height: 10),
        if (doctor && owner) ...[TextField(controller: pct, keyboardType: const TextInputType.numberWithOptions(decimal: true), textDirection: TextDirection.ltr, decoration: deco('نسبة الكشفيات %', hint: 'فاضي = بدون')), const SizedBox(height: 10)],
        DateField(label: 'يسري من', value: from, onChanged: (v) => setS(() => from = v)),
      ])),
      actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
        final sal = salary.text.trim().isEmpty ? null : int.tryParse(salary.text.replaceAll(',', '').trim()); if (salary.text.trim().isNotEmpty && sal == null) { toast(d, 'راتب غير صحيح', error: true); return; }
        final body = <String, dynamic>{'effective_from': from, 'monthly_salary': sal};
        if (doctor && owner) body['consult_percent'] = pct.text.trim().isEmpty ? null : num.tryParse(pct.text.trim());
        try { await api.put('/staff/${s['user_id']}/pay-rule', body: body); if (d.mounted) Navigator.pop(d, true); } catch (e) { if (d.mounted) showError(d, e); }
      }, child: const Text('حفظ'))],
    )));
    return ok ?? false;
  }
}
