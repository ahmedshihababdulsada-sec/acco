import 'package:material_ui/material_ui.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/theme.dart';
import '../../core/widgets.dart';
import 'cashier_state.dart';
import 'receipts_page.dart';

/// صفحة الدفع (كشفية أو جلسات): السعر من الخادم (عرض سعر بنفس حساب الدفع)، الخصم المعتمد، النقاط، وطرق الدفع.
/// مفتاح منع التكرار يتولد مرة وحدة للصفحة: لو انقطع الإنترنت وانعاد الضغط ما ينكرر الدفع.
class PaymentPage extends StatefulWidget {
  const PaymentPage.consultation({super.key, required this.state, required this.customer, required int this.consultationId, required this.visitId}) : sessionIds = null;
  const PaymentPage.sessions({super.key, required this.state, required this.customer, required List<int> this.sessionIds}) : consultationId = null, visitId = null;
  final CashierState state;
  final Map<String, dynamic> customer;
  final int? consultationId;
  final int? visitId;
  final List<int>? sessionIds;
  @override
  State<PaymentPage> createState() => _PaymentPageState();
}

class _PaymentPageState extends State<PaymentPage> {
  final String _key = newIdempotencyKey();
  List<Map<String, dynamic>> _methods = [];
  List<Map<String, dynamic>> _approved = [];
  final Map<int, TextEditingController> _amounts = {};
  Map<String, dynamic>? _quote;
  String? _error;
  bool _redeem = false;
  int? _discountId;
  bool _loading = true;
  bool _tendersTouched = false;

  bool get _isConsultation => widget.consultationId != null;
  Map<String, dynamic> get _body => {
        if (_isConsultation) 'consultation_id': widget.consultationId else 'session_ids': widget.sessionIds,
        if (_redeem) 'redeem_points': true,
        if (_discountId != null) 'discount_request_id': _discountId,
      };

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    final api = widget.state.api;
    try {
      _methods = ((await api.get('/payment-methods') as List).cast<Map<String, dynamic>>()).where((m) => m['is_active'] != false).toList();
      for (final m in _methods) { _amounts[m['id'] as int] = TextEditingController(); }
      final reqs = ((await api.get('/discount-requests', query: {'status': 'approved'}))['requests'] as List).cast<Map<String, dynamic>>();
      _approved = reqs.where((r) => (r['customer'] as Map)['id'] == widget.customer['id']).toList();
    } catch (e) { _error = e is ApiException ? e.message : '$e'; }
    await _requote();
  }

  Future<void> _requote() async {
    setState(() => _loading = true);
    try {
      final q = Map<String, dynamic>.from(await widget.state.api.post(_isConsultation ? '/payments/quote/consultation' : '/payments/quote/sessions', body: _body) as Map);
      _quote = q;
      _error = null;
      if (!_tendersTouched) _fillCash();
    } catch (e) {
      _quote = null;
      _error = e is ApiException ? e.message : '$e';
    }
    if (mounted) setState(() => _loading = false);
  }

  void _fillCash() {
    final net = (_quote?['net_amount'] as num?)?.toInt() ?? 0;
    final cash = _methods.where((m) => m['kind'] == 'cash').toList();
    for (final c in _amounts.values) { c.text = ''; }
    if (cash.isNotEmpty && net > 0) _amounts[cash.first['id'] as int]!.text = '$net';
  }

  int get _sum => _amounts.values.fold(0, (s, c) => s + (int.tryParse(c.text.replaceAll(',', '').trim()) ?? 0));

  Future<void> _pay() async {
    final q = _quote;
    if (q == null) return;
    final net = (q['net_amount'] as num).toInt();
    final tenders = <Map<String, dynamic>>[];
    for (final m in _methods) {
      final v = int.tryParse(_amounts[m['id']]!.text.replaceAll(',', '').trim()) ?? 0;
      if (v > 0) tenders.add({'method_id': m['id'], 'amount': v});
    }
    if (_sum != net) { toast(context, 'مجموع طرق الدفع (${money(_sum)}) لازم يساوي الصافي (${money(net)})', error: true); return; }
    final receipt = Map<String, dynamic>.from(await widget.state.api.post(_isConsultation ? '/payments/consultation' : '/payments/sessions', body: {..._body, if (tenders.isNotEmpty) 'tenders': tenders}, idempotencyKey: _key) as Map);
    if (!mounted) return;
    if (_isConsultation) {
      // دفع الكشفية: ما نطبع هسه. الزبون يروح للطبيب، والوصل يُطبع مرة وحدة بعد دفع الجلسات.
      toast(context, 'انسجل دفع الكشفية (${ltr(receipt['receipt_no'] as String)}). الزبون يروح للطبيب، والوصل يُطبع مرة وحدة بعد الجلسات.');
      Navigator.of(context).pop(true);
      return;
    }
    await Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => ReceiptPage.day(state: widget.state, dayCustomerId: widget.customer['id'] as int, justPaid: true)));
  }

  @override
  Widget build(BuildContext context) {
    final q = _quote;
    final balance = (widget.customer['points_balance'] as num).toInt();
    final net = (q?['net_amount'] as num?)?.toInt() ?? 0;
    return PopScope(
      onPopInvokedWithResult: (didPop, _) {},
      child: Scaffold(
        appBar: AppBar(title: Text(_isConsultation ? 'دفع الكشفية' : 'دفع الجلسات')),
        body: ListPage(maxWidth: 720, children: [
          Section(child: Row(children: [const Icon(Icons.person_outline), const SizedBox(width: 8), Expanded(child: Text(widget.customer['full_name'] as String, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16))), Text(ltr(widget.customer['public_code'] as String), style: const TextStyle(color: Palette.muted))])),
          if (_error != null) Notice(_error!, kind: NoticeKind.danger),
          if (q != null) ...[
            Section(title: 'البنود', child: Column(children: [
              for (final i in (q['items'] as List).cast<Map<String, dynamic>>()) Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(children: [
                  Expanded(child: Text('${i['service_name']}${i['offer_percent'] == null ? '' : '  · عرض ${i['offer_percent']}%'}')),
                  if ((i['offer_discount'] as num) > 0) Padding(padding: const EdgeInsets.only(left: 8), child: Text(moneyPlain(i['list_price'] as num), style: const TextStyle(decoration: TextDecoration.lineThrough, color: Palette.muted))),
                  Text(money((i['list_price'] as num) - (i['offer_discount'] as num)), style: const TextStyle(fontWeight: FontWeight.w600)),
                ]),
              ),
            ])),
            Section(title: 'الخصم والنقاط', child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              if (_approved.isNotEmpty) DropdownButtonFormField<int?>(
                initialValue: _discountId, decoration: deco('خصم معتمد من المدير'),
                items: [const DropdownMenuItem<int?>(value: null, child: Text('بدون خصم')), for (final r in _approved) DropdownMenuItem<int?>(value: r['id'] as int, child: Text('خصم ${money(r['amount'] as num)}'))],
                onChanged: (v) { _discountId = v; _requote(); },
              ) else const Text('ما أكو خصم معتمد للزبون', style: TextStyle(color: Palette.muted)),
              const SizedBox(height: 8),
              SwitchListTile(contentPadding: EdgeInsets.zero, value: _redeem, onChanged: balance <= 0 ? null : (v) { _redeem = v; _requote(); }, title: const Text('الزبون يستخدم نقاطه'), subtitle: Text('رصيده $balance نقطة · السقف 50% من المبلغ')),
            ])),
            Section(title: 'الحساب', child: Column(children: [
              KV('المجموع', money(q['gross_amount'] as num)),
              if ((q['offer_discount'] as num) > 0) KV('خصم العرض', '- ${money(q['offer_discount'] as num)}'),
              if ((q['manual_discount'] as num) > 0) KV('خصم المدير', '- ${money(q['manual_discount'] as num)}'),
              if ((q['points_discount'] as num) > 0) KV('النقاط (${q['points_used']})', '- ${money(q['points_discount'] as num)}'),
              if ((q['rounding_amount'] as num) > 0) KV('تقريب لأقرب 250', '- ${money(q['rounding_amount'] as num)}'),
              const Divider(),
              KV('الصافي', money(net), bold: true, valueColor: Palette.primaryDark),
              KV('نقاط يكسبها', '${q['points_earned']}'),
            ])),
            if (net > 0) Section(title: 'طريقة الدفع', child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              for (final m in _methods) Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: TextField(controller: _amounts[m['id']], onChanged: (_) { _tendersTouched = true; setState(() {}); }, keyboardType: TextInputType.number, textDirection: TextDirection.ltr, decoration: deco('${m['name_ar']}${m['device_label'] == null ? '' : ' · ${m['device_label']}'}', suffix: 'د.ع')),
              ),
              Row(children: [const Text('المجموع المدخل: '), Text(money(_sum), style: TextStyle(fontWeight: FontWeight.w700, color: _sum == net ? Palette.ok : Palette.danger))]),
            ])) else const Notice('الصافي صفر: وصل صفري بدون طريقة دفع.'),
            AsyncButton(onPressed: _loading || (net > 0 && _sum != net) ? null : _pay, icon: Icons.check_circle_outline, child: Text(net > 0 ? 'تم الدفع · ${money(net)}' : 'إصدار الوصل الصفري')),
          ] else if (_loading) const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator())),
        ]),
      ),
    );
  }
}
