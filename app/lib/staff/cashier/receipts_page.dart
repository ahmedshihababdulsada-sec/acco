import 'package:material_ui/material_ui.dart';
import 'package:flutter/foundation.dart' show kIsWeb, visibleForTesting;
import 'package:printing/printing.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/receipt/models.dart';
import '../../core/receipt/print_service.dart';
import '../../core/theme.dart';
import '../../core/widgets.dart';
import 'cashier_state.dart';

/// بحث الوصولات (برقم الوصل أو بوصولات اليوم): إذا ضاع رد الدفع أو لازم إعادة طباعة.
class ReceiptsPage extends StatefulWidget {
  const ReceiptsPage({super.key});
  @override
  State<ReceiptsPage> createState() => _ReceiptsPageState();
}

class _ReceiptsPageState extends State<ReceiptsPage> {
  final _q = TextEditingController();
  List<Map<String, dynamic>>? _list;
  bool _busy = false;

  Future<void> _search({String? no}) async {
    setState(() => _busy = true);
    try {
      final api = context.read<Api>();
      final r = await api.get('/payments', query: no != null && no.isNotEmpty ? {'receipt_no': no.trim()} : {'date': todayIso()});
      setState(() => _list = (r as List).cast<Map<String, dynamic>>());
    } catch (e) { if (mounted) showError(context, e); }
    if (mounted) setState(() => _busy = false);
  }

  @override
  void initState() { super.initState(); WidgetsBinding.instance.addPostFrameCallback((_) => _search()); }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('الوصولات')),
      body: ListPage(maxWidth: 720, children: [
        Row(children: [
          Expanded(child: TextField(controller: _q, textDirection: TextDirection.ltr, decoration: deco('رقم الوصل', hint: '2026-00001'), onSubmitted: (v) => _search(no: v))),
          const SizedBox(width: 8),
          FilledButton(onPressed: _busy ? null : () => _search(no: _q.text), child: const Text('بحث')),
          const SizedBox(width: 8),
          OutlinedButton(onPressed: _busy ? null : () { _q.clear(); _search(); }, child: const Text('وصولات اليوم')),
        ]),
        if (_list != null && _list!.isNotEmpty) Section(child: Row(key: const ValueKey('receipts-total'), children: [
          Expanded(child: Text('مجموع وصولاتك (${_list!.length} وصل)', style: const TextStyle(fontWeight: FontWeight.w600))),
          Text(money(_list!.fold<num>(0, (s, r) => s + (r['net_amount'] as num) - (r['refunded_total'] as num? ?? 0))), style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
        ])),
        if (_list == null) const Center(child: CircularProgressIndicator()) else if (_list!.isEmpty) const Empty('ما لگينا وصولات'),
        for (final r in _list ?? const <Map<String, dynamic>>[]) Card(child: ListTile(
          title: Text('${ltr(r['receipt_no'] as String)} · ${money(r['net_amount'] as num)}'),
          subtitle: Text('${(r['customer'] as Map)['full_name']} · ${dmy(r['business_date'] as String)} · ${hm(r['paid_at'] as String?)}'),
          trailing: switch (r['status']) { 'refunded' => Pill.danger('مسترجع'), 'partially_refunded' => Pill.warn('جزئي'), _ => const Pill('مدفوع') },
          onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ReceiptPage(state: null, receiptId: r['id'] as int))),
        )),
      ]),
    );
  }
}

/// للاختبارات فقط: بديل للطباعة الحقيقية (نافذة الطباعة ما تشتغل بالاختبارات)
@visibleForTesting
Future<bool> Function(ReceiptData data)? receiptPrintOverride;

/// للاختبارات فقط: يفرض سؤال «هل انطبع فعلاً؟» حتى خارج المتصفح
@visibleForTesting
bool receiptConfirmAfterPrint = false;

/// وصل واحد: ملخصه، طباعته A5، تسجيل الطباعة، والاسترجاع.
class ReceiptPage extends StatefulWidget {
  const ReceiptPage({super.key, required this.state, required int this.receiptId, this.justPaid = false}) : dayCustomerId = null;
  /// وصل اليوم الجامع للزبون: كل وصولاته المدفوعة اليوم (كشفية + جلسات) بوصل واحد يُطبع مرة وحدة.
  const ReceiptPage.day({super.key, required this.state, required int this.dayCustomerId, this.justPaid = false}) : receiptId = null;
  final CashierState? state;
  final int? receiptId;
  final int? dayCustomerId;
  final bool justPaid;
  @override
  State<ReceiptPage> createState() => _ReceiptPageState();
}

class _ReceiptPageState extends State<ReceiptPage> {
  final _ctl = LoaderController();

  bool get _day => widget.dayCustomerId != null;

  Future<Map<String, dynamic>> _load() async => Map<String, dynamic>.from(await context.read<Api>().get(_day ? '/customers/${widget.dayCustomerId}/day-receipt' : '/payments/${widget.receiptId}') as Map);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_day ? 'وصل اليوم' : 'الوصل'), leading: BackButton(onPressed: () => Navigator.pop(context, true))),
      body: Loader<Map<String, dynamic>>(
        controller: _ctl, load: _load,
        builder: (context, r, reload) {
          final items = (r['items'] as List).cast<Map<String, dynamic>>();
          final refunded = r['status'] == 'refunded';
          return ListPage(maxWidth: 720, children: [
            if (widget.justPaid) Notice(_day ? 'تم الدفع. هذا وصل واحد يجمع كل مدفوعات اليوم: اطبعه مرة وحدة للزبون.' : 'تم الدفع وانحفظ الوصل. اطبعه للزبون.'),
            if (_day && (r['unprinted'] as num) == 0 && !widget.justPaid) const Notice('هذا الوصل انطبع قبل. الطباعة مرة ثانية تنحسب «إعادة طباعة».'),
            Section(
              title: 'وصل ${ltr(r['receipt_no'] as String)}',
              trailing: switch (r['status']) { 'refunded' => Pill.danger('مسترجع'), 'partially_refunded' => Pill.warn('استرجاع جزئي'), _ => Pill.ok('مدفوع') },
              child: Column(children: [
                KV('الزبون', '${(r['customer'] as Map)['full_name']}'),
                KV('الكاشير', '${(r['cashier'] as Map)['full_name']}'),
                KV('التاريخ', '${dmy(r['business_date'] as String)} · ${hm(r['paid_at'] as String?)}'),
                const Divider(),
                for (final i in items) Padding(padding: const EdgeInsets.symmetric(vertical: 3), child: Row(children: [
                  Expanded(child: Text('${i['service_name']}${(i['offer_percent'] as num?) == null ? '' : ' · عرض ${i['offer_percent']}%'}${i['status'] == 'refunded' ? ' (مسترجع)' : ''}', style: TextStyle(decoration: i['status'] == 'refunded' ? TextDecoration.lineThrough : null))),
                  Text(money(i['net_amount'] as num)),
                ])),
                const Divider(),
                KV('المجموع', money(r['gross_amount'] as num)),
                if ((r['offer_discount'] as num) > 0) KV('خصم العرض', '- ${money(r['offer_discount'] as num)}'),
                if ((r['manual_discount'] as num) > 0) KV('خصم المدير', '- ${money(r['manual_discount'] as num)}'),
                if ((r['points_discount'] as num) > 0) KV('النقاط', '- ${money(r['points_discount'] as num)}'),
                if ((r['rounding_amount'] as num) > 0) KV('التقريب', '- ${money(r['rounding_amount'] as num)}'),
                KV('الصافي', money(r['net_amount'] as num), bold: true, valueColor: Palette.primaryDark),
                for (final t in (r['tenders'] as List).cast<Map<String, dynamic>>()) KV('${t['method_name']}${t['device_label'] == null ? '' : ' · ${t['device_label']}'}', money(t['amount'] as num)),
                if ((r['refunded_total'] as num) > 0) KV('المسترجع', money(r['refunded_total'] as num), valueColor: Palette.danger),
                KV('مرات الطباعة', '${r['print_count']}'),
              ]),
            ),
            if (_day && (r['payments'] as List).length > 1) Section(
              title: 'الوصولات المشمولة (للاسترجاع افتح الوصل)',
              child: Column(children: [
                for (final p in (r['payments'] as List).cast<Map<String, dynamic>>()) ListTile(
                  contentPadding: EdgeInsets.zero, dense: true,
                  title: Text('${ltr(p['receipt_no'] as String)} · ${money(p['net_amount'] as num)}'),
                  subtitle: Text('${p['kind'] == 'consultation' ? 'كشفية' : 'جلسات'}${p['mine'] == false ? ' · كاشير ثاني' : ''}'),
                  trailing: p['mine'] == false ? null : const Icon(Icons.chevron_left),
                  onTap: p['mine'] == false ? null : () async { await Navigator.of(context).push(MaterialPageRoute(builder: (_) => ReceiptPage(state: widget.state, receiptId: p['id'] as int))); await reload(); },
                ),
              ]),
            ),
            Wrap(spacing: 8, runSpacing: 8, children: [
              AsyncButton(icon: Icons.print_outlined, onPressed: () async { await _print(context, r); reload(); }, child: const Text('طباعة A5')),
              if (!refunded && !_day) OutlinedButton.icon(onPressed: () async { if (await _refund(context, r)) { await reload(); } }, icon: const Icon(Icons.undo), label: const Text('استرجاع'), style: OutlinedButton.styleFrom(foregroundColor: Palette.danger)),
            ]),
          ]);
        },
      ),
    );
  }

  Future<void> _print(BuildContext context, Map<String, dynamic> r) async {
    final api = context.read<Api>();
    final data = receiptFromServer(r, logo: await fetchReceiptLogo(api, r));
    Printer? direct;
    if (receiptPrintOverride == null && !kIsWeb) {
      try { final ps = await listPrinters(); if (ps.isNotEmpty) { direct = ps.firstWhere((p) => p.isDefault, orElse: () => ps.first); } } catch (_) {}
    }
    final ok = receiptPrintOverride != null ? await receiptPrintOverride!(data) : direct != null ? await printDirect(data, direct) : await printWithDialog(data);
    if (!ok) { if (context.mounted) toast(context, 'تم إلغاء الطباعة: الوصل ما انسجل كمطبوع', error: true); return; }
    // المتصفح ما يخبرنا إذا الكاشير ضغط «إلغاء» بنافذة الطباعة (يرجع «تمت» بكل الأحوال)، فنسأل قبل ما نسجل الطباعة
    if (direct == null && (kIsWeb || receiptConfirmAfterPrint)) {
      if (!context.mounted) return;
      if (!await confirm(context, 'هل انطبع الوصل فعلاً؟', body: 'سجّل «انطبع» فقط إذا طلع الوصل من الطابعة. إذا ضغطت إلغاء ما نسجله كمطبوع.', yes: 'نعم، انطبع')) {
        if (context.mounted) toast(context, 'ما انسجلت الطباعة: الوصل بعده غير مطبوع', error: true);
        return;
      }
    }
    {
      final note = direct != null ? 'طباعة مباشرة: ${direct.name}' : 'نافذة الطباعة';
      // الوصل الجامع: تسجيل الطباعة لكل وصولاته بمعاملة وحدة (يا كلها يا ولا وحدة)
      if (_day) { await api.post('/payments/print', body: {'payment_ids': (r['payment_ids'] as List).cast<int>(), 'note': note}); } else { await api.post('/payments/${r['id']}/print', body: {'note': note}); }
      if (context.mounted) toast(context, 'انطبع الوصل');
    }
  }

  Future<bool> _refund(BuildContext context, Map<String, dynamic> r) async {
    final api = context.read<Api>();
    final methods = ((await api.get('/payment-methods') as List).cast<Map<String, dynamic>>()).where((m) => m['is_active'] != false).toList();
    if (!context.mounted) return false;
    final items = (r['items'] as List).cast<Map<String, dynamic>>().where((i) => i['status'] == 'paid').toList();
    final picked = <int>{for (final i in items) i['id'] as int};
    final reason = TextEditingController();
    int? payout = methods.firstWhere((m) => m['kind'] == 'cash', orElse: () => methods.first)['id'] as int?;
    final key = newIdempotencyKey();
    final ok = await showDialog<bool>(context: context, builder: (c) => StatefulBuilder(builder: (c, setS) {
      final total = items.where((i) => picked.contains(i['id'])).fold<num>(0, (s, i) => s + (i['net_amount'] as num));
      return AlertDialog(
        title: const Text('استرجاع'),
        content: SizedBox(width: 420, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          for (final i in items) CheckboxListTile(contentPadding: EdgeInsets.zero, value: picked.contains(i['id']), onChanged: (v) => setS(() => v == true ? picked.add(i['id'] as int) : picked.remove(i['id'])), title: Text('${i['service_name']}'), subtitle: Text(money(i['net_amount'] as num))),
          const SizedBox(height: 8),
          DropdownButtonFormField<int?>(initialValue: payout, decoration: deco('رجّعنا الفلوس من'), items: [for (final m in methods) DropdownMenuItem<int?>(value: m['id'] as int, child: Text('${m['name_ar']}${m['device_label'] == null ? '' : ' · ${m['device_label']}'}'))], onChanged: (v) => setS(() => payout = v)),
          const SizedBox(height: 12),
          TextField(controller: reason, decoration: deco('سبب الاسترجاع')),
          const SizedBox(height: 8),
          Text('المبلغ المسترجع: ${money(total)}', style: const TextStyle(fontWeight: FontWeight.w700)),
        ]))),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('رجوع')),
          FilledButton(style: FilledButton.styleFrom(backgroundColor: Palette.danger), onPressed: picked.isEmpty ? null : () async {
            if (reason.text.trim().length < 3) { toast(c, 'اكتب سبب الاسترجاع', error: true); return; }
            try {
              final full = picked.length == items.length;
              await api.post('/payments/${r['id']}/refund', body: {if (full) 'full_receipt': true else 'items': picked.toList(), 'reason': reason.text.trim(), if (payout != null) 'payout': [{'method_id': payout, 'amount': total.toInt()}]}, idempotencyKey: key);
              if (c.mounted) Navigator.pop(c, true);
            } catch (e) { if (c.mounted) showError(c, e); }
          }, child: const Text('استرجاع')),
        ],
      );
    }));
    if (ok == true && context.mounted) toast(context, 'تم الاسترجاع');
    return ok ?? false;
  }
}
