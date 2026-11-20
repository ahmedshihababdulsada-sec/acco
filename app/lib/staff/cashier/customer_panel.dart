import 'package:material_ui/material_ui.dart';

import '../../core/format.dart';
import '../../core/theme.dart';
import '../../core/widgets.dart';
import 'cashier_state.dart';
import 'dialogs.dart';
import 'payment_page.dart';
import 'receipts_page.dart';

/// ملف الزبون عند الكاشير: حجز اليوم وكشفيته، جلساته (دفع/نقل/حجز)، طلبات الخصم، ووصولاته.
class CustomerPanel extends StatefulWidget {
  const CustomerPanel({super.key, required this.customerId, required this.state});
  final int customerId;
  final CashierState state;
  @override
  State<CustomerPanel> createState() => _CustomerPanelState();
}

class _Data {
  _Data(this.customer, this.sessions, this.today, this.requests, this.receipts);
  final Map<String, dynamic> customer;
  final List<Map<String, dynamic>> sessions;
  final List<Map<String, dynamic>> today;
  final List<Map<String, dynamic>> requests;
  final List<Map<String, dynamic>> receipts;
  /// عنده كشفية مدفوعة أو جلسة مدفوعة/منفذة: الكشفية للجديد بس، فالحجز يقترح «جلسات فقط»
  bool get returning => receipts.any((r) => r['kind'] == 'consultation' && r['status'] == 'paid') || sessions.any((s) => s['status'] == 'paid' || s['status'] == 'completed');
}

class _CustomerPanelState extends State<CustomerPanel> {
  final Set<int> _selected = {};
  final _ctl = LoaderController();

  Future<_Data> _load() async {
    final api = widget.state.api;
    final id = widget.customerId;
    final customer = Map<String, dynamic>.from(await api.get('/customers/$id') as Map);
    final sessions = ((await api.get('/customers/$id/sessions'))['sessions'] as List).cast<Map<String, dynamic>>();
    final today = ((await api.get('/bookings', query: {'customer_id': id}))['bookings'] as List).cast<Map<String, dynamic>>();
    final reqs = ((await api.get('/discount-requests'))['requests'] as List).cast<Map<String, dynamic>>().where((r) => (r['customer'] as Map)['id'] == id).toList();
    final receipts = (await api.get('/payments', query: {'customer_id': id}) as List).cast<Map<String, dynamic>>();
    return _Data(customer, sessions, today, reqs, receipts);
  }

  Future<void> _after(Future<void> Function() f) async { await f(); _ctl.reload(); widget.state.refresh().catchError((_) {}); }

  @override
  Widget build(BuildContext context) {
    return Loader<_Data>(
      controller: _ctl, load: _load,
      builder: (context, d, reload) => ListPage(maxWidth: 820, children: [
        _Header(c: d.customer),
        _TodaySection(d: d, state: widget.state, onChanged: () => _after(() async {})),
        _SessionsSection(d: d, state: widget.state, selected: _selected, onChanged: () => _after(() async { _selected.clear(); })),
        if (d.requests.isNotEmpty) _RequestsSection(requests: d.requests, state: widget.state, onChanged: () => _after(() async {})),
        _ReceiptsSection(receipts: d.receipts, state: widget.state, onChanged: () => _after(() async {})),
      ]),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.c});
  final Map<String, dynamic> c;
  @override
  Widget build(BuildContext context) => Section(
        child: Row(children: [
          const CircleAvatar(radius: 26, backgroundColor: Palette.primarySoft, child: Icon(Icons.person, color: Palette.primary, size: 30)),
          const SizedBox(width: 14),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(c['full_name'] as String, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            Text('${ltr(c['public_code'] as String)} · ${ltr(c['phone'] as String)}', style: const TextStyle(color: Palette.muted)),
          ])),
          Pill('${c['points_balance']} نقطة'),
        ]),
      );
}

/// ملاحظة الزبون وقت الحجز والخدمة اللي يريدها
class _WishLine extends StatelessWidget {
  const _WishLine({required this.cons});
  final Map cons;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(10), decoration: BoxDecoration(color: Palette.primarySoft, borderRadius: BorderRadius.circular(8)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (cons['interest'] != null) Text('يريد: ${(cons['interest'] as Map)['name']}', style: const TextStyle(fontWeight: FontWeight.w600)),
          if ((cons['note'] as String?) != null) Text('ملاحظة الزبون: ${cons['note']}'),
        ]),
      );
}

/// حجز اليوم وكشفيته
class _TodaySection extends StatelessWidget {
  const _TodaySection({required this.d, required this.state, required this.onChanged});
  final _Data d;
  final CashierState state;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final api = state.api;
    final active = d.today.where((b) => (b['status'] == 'booked' || b['status'] == 'arrived') && b['done'] != true).toList();
    return Section(
      title: 'حجز اليوم',
      trailing: active.isEmpty ? FilledButton.icon(onPressed: () async { if (await bookingDialog(context, d.customer['id'] as int, returning: d.returning)) onChanged(); }, icon: const Icon(Icons.event_available), label: const Text('حجز كشفية')) : null,
      child: active.isEmpty
          ? const Text('ما عنده حجز فعال اليوم', style: TextStyle(color: Palette.muted))
          : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              for (final b in active) ...[
                Builder(builder: (context) {
                  final cons = b['consultation'] as Map?;
                  final visitBooked = b['status'] == 'booked';
                  final free = cons?['kind'] == 'free_followup';
                  final sessionsOnly = cons?['kind'] == 'sessions_only';
                  final soFee = (cons?['fee'] as num?)?.toInt() ?? 0;
                  final soFree = sessionsOnly && soFee <= 0;   // «جلسات فقط» مجانية: دخول بدون دفع ولا وصل للكشفية
                  return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    Row(children: [
                      Text('رقم ${b['seq_no']}', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                      const SizedBox(width: 10),
                      if (b['doctor'] != null) Text((b['doctor'] as Map)['full_name'] as String, style: const TextStyle(color: Palette.muted)),
                      const Spacer(),
                      if (free) Pill.ok('مراجعة مجانية'),
                      if (sessionsOnly) Pill(soFree ? 'جلسات فقط · مجانية' : 'جلسات فقط · ${money(soFee)}'),
                      const SizedBox(width: 6),
                      if (cons != null) _consPill(cons['status'] as String),
                    ]),
                    const SizedBox(height: 10),
                    Wrap(spacing: 8, runSpacing: 8, children: [
                      if (cons != null && cons['status'] == 'awaiting_payment') ...[
                        if (free || soFree) AsyncButton(onPressed: () async { await api.post('/consultations/${cons['id']}/check-in'); if (context.mounted) toast(context, 'دخل الزبون للطبيب بدون دفع'); onChanged(); }, icon: Icons.login, child: const Text('إدخال بدون دفع')),
                        if (!soFree) FilledButton.icon(
                          onPressed: () async { final ok = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => PaymentPage.consultation(state: state, customer: d.customer, consultationId: cons['id'] as int, visitId: b['id'] as int))); if (ok == true) onChanged(); },
                          icon: const Icon(Icons.payments_outlined), label: Text(free ? 'دفع الكشفية (انتهت المجانية)' : sessionsOnly ? 'دفع كشفية «جلسات فقط»' : 'دفع الكشفية'),
                        ),
                        if (!soFree) OutlinedButton.icon(onPressed: () async { final why = await askText(context, 'طلب خصم للكشفية', label: 'ملاحظة للمدير', minLen: 0, hint: 'اختياري'); if (why == null) return; try { await api.post('/discount-requests', body: {'consultation_id': cons['id'], if (why.isNotEmpty) 'note': why}); if (context.mounted) toast(context, 'انرسل طلب الخصم للمدير'); onChanged(); } catch (e) { if (context.mounted) showError(context, e); } }, icon: const Icon(Icons.local_offer_outlined), label: const Text('طلب خصم')),
                        OutlinedButton.icon(onPressed: () async { final why = await askText(context, 'إلغاء الحجز', label: 'سبب الإلغاء'); if (why == null) return; try { await api.post('/bookings/${b['id']}/cancel', body: {'reason': why}); onChanged(); } catch (e) { if (context.mounted) showError(context, e); } }, style: OutlinedButton.styleFrom(foregroundColor: Palette.danger), icon: const Icon(Icons.close), label: const Text('إلغاء الحجز')),
                      ],
                      if (cons != null && cons['status'] == 'paid' && (free || soFree)) AsyncButton(outlined: true, onPressed: () async { final why = await askText(context, 'إلغاء الدخول المجاني', label: 'السبب'); if (why == null) return; await api.post('/consultations/${cons['id']}/cancel-check-in', body: {'reason': why}); onChanged(); }, child: const Text('إلغاء الدخول المجاني')),
                      if (visitBooked && cons == null) const Text('حجز جلسات بدون كشفية', style: TextStyle(color: Palette.muted)),
                    ]),
                    if (cons != null && (cons['interest'] != null || (cons['note'] as String?) != null)) Padding(padding: const EdgeInsets.only(top: 8), child: _WishLine(cons: cons)),
                    if (cons != null && cons['status'] == 'paid') const Padding(padding: EdgeInsets.only(top: 8), child: Text('مدفوعة: بانتظار دخول الطبيب. الاسترجاع من الوصل (تحت).', style: TextStyle(color: Palette.muted, fontSize: 13))),
                  ]);
                }),
                if (b != active.last) const Divider(height: 24),
              ],
            ]),
    );
  }

  Widget _consPill(String s) => switch (s) {
        'awaiting_payment' => Pill.warn('بانتظار الدفع'),
        'paid' => Pill.ok('مدفوعة'),
        'with_doctor' => Pill.ok('عند الطبيب'),
        'finished' => Pill.ok('انتهت'),
        _ => Pill(s),
      };
}

/// جلسات الزبون: دفع المحدد، نقل، حجز، طلب خصم
class _SessionsSection extends StatelessWidget {
  const _SessionsSection({required this.d, required this.state, required this.selected, required this.onChanged});
  final _Data d;
  final CashierState state;
  final Set<int> selected;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final api = state.api;
    final list = d.sessions.where((s) => s['status'] != 'completed').toList();
    final done = d.sessions.where((s) => s['status'] == 'completed').length;
    return StatefulBuilder(builder: (context, setS) {
      final payable = list.where((s) => s['payable_today'] == true).toList();
      final chosen = payable.where((s) => selected.contains(s['id'])).toList();
      return Section(
        title: 'الجلسات',
        trailing: done > 0 ? Pill('$done مكتملة') : null,
        child: list.isEmpty
            ? const Text('ما أكو جلسات قادمة', style: TextStyle(color: Palette.muted))
            : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                for (final s in list) _SessionRow(s: s, selected: selected.contains(s['id']), onSelect: (v) => setS(() => v ? selected.add(s['id'] as int) : selected.remove(s['id'])), api: state.api, onChanged: onChanged),
                if (payable.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  Row(children: [
                    Expanded(child: FilledButton.icon(
                      onPressed: chosen.isEmpty ? null : () async { final ok = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => PaymentPage.sessions(state: state, customer: d.customer, sessionIds: [for (final s in chosen) s['id'] as int]))); if (ok == true) onChanged(); },
                      icon: const Icon(Icons.payments_outlined), label: Text(chosen.isEmpty ? 'اختر الجلسات اللي يدفعها' : 'دفع ${chosen.length} جلسة'),
                    )),
                    const SizedBox(width: 8),
                    OutlinedButton.icon(
                      onPressed: chosen.isEmpty ? null : () async { try { await api.post('/discount-requests', body: {'session_ids': [for (final s in chosen) s['id']]}); if (context.mounted) toast(context, 'انرسل طلب الخصم للمدير'); onChanged(); } catch (e) { if (context.mounted) showError(context, e); } },
                      icon: const Icon(Icons.local_offer_outlined), label: const Text('طلب خصم'),
                    ),
                  ]),
                ],
              ]),
      );
    });
  }
}

class _SessionRow extends StatelessWidget {
  const _SessionRow({required this.s, required this.selected, required this.onSelect, required this.api, required this.onChanged});
  final Map<String, dynamic> s;
  final bool selected;
  final ValueChanged<bool> onSelect;
  final dynamic api;
  final VoidCallback onChanged;
  @override
  Widget build(BuildContext context) {
    final status = s['status'] as String;
    final payable = s['payable_today'] == true;
    final price = s['estimate_after_offer'] ?? s['estimate_price'];
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(border: Border.all(color: selected ? Palette.primary : Palette.border), borderRadius: BorderRadius.circular(8), color: selected ? Palette.primarySoft : null),
      child: Row(children: [
        if (payable) Checkbox(value: selected, onChanged: (v) => onSelect(v ?? false)) else const SizedBox(width: 12),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${s['service_name']} · جلسة ${s['seq_no']} من ${s['of']}', style: const TextStyle(fontWeight: FontWeight.w600)),
          Text([
            if (s['scheduled_date'] != null) '${dmy(s['scheduled_date'] as String)} (${weekdayName(s['scheduled_date'] as String)})' else 'تنتظر حجز',
            if (price != null && (status == 'booked' || status == 'awaiting_booking')) 'تقدير ${money(price as num)}',
            if (s['offer_percent'] != null) 'عرض ${s['offer_percent']}%',
          ].join(' · '), style: const TextStyle(color: Palette.muted, fontSize: 13)),
        ])),
        _pill(status),
        if (status == 'booked' || status == 'paid') IconButton(tooltip: 'نقل الجلسة', icon: const Icon(Icons.event_repeat), onPressed: () async {
          if (await pickDateAndCall(context, title: 'نقل الجلسة', initial: s['scheduled_date'] as String, call: (d) async { await api.post('/sessions/${s['id']}/move', body: {'date': d}); }, yes: 'نقل') && context.mounted) { toast(context, 'انتقلت الجلسة'); onChanged(); }
        }),
        if (status == 'awaiting_booking') TextButton(onPressed: () async {
          if (await pickDateAndCall(context, title: 'حجز الجلسة', initial: todayIso(), call: (d) async { await api.post('/sessions/${s['id']}/book', body: {'date': d}); }, yes: 'حجز') && context.mounted) { toast(context, 'انحجزت الجلسة'); onChanged(); }
        }, child: const Text('حجز')),
      ]),
    );
  }

  Widget _pill(String s) => switch (s) {
        'booked' => payableOrNot(),
        'paid' => Pill.ok('مدفوعة'),
        'awaiting_booking' => Pill.warn('تنتظر حجز'),
        _ => Pill(s),
      };
  Widget payableOrNot() => s['payable_today'] == true ? Pill.warn('تندفع اليوم') : const Pill('محجوزة');
}

class _RequestsSection extends StatelessWidget {
  const _RequestsSection({required this.requests, required this.state, required this.onChanged});
  final List<Map<String, dynamic>> requests;
  final CashierState state;
  final VoidCallback onChanged;
  @override
  Widget build(BuildContext context) => Section(
        title: 'طلبات الخصم اليوم',
        child: Column(children: [
          for (final r in requests) ListTile(
            contentPadding: EdgeInsets.zero, dense: true,
            title: Text('${r['basket']['kind'] == 'consultation' ? 'كشفية' : 'جلسات'} · ${money(r['basket']['gross'] as num)}'),
            subtitle: Text(r['status'] == 'approved' ? 'موافق عليه: خصم ${money(r['amount'] as num)}${r['decision_note'] == null ? '' : ' · ${r['decision_note']}'}' : r['status'] == 'rejected' ? 'مرفوض: ${r['decision_note'] ?? ''}' : r['status'] == 'used' ? 'استُخدم' : r['status'] == 'pending' ? 'بانتظار المدير' : '${r['status']}'),
            trailing: switch (r['status']) { 'approved' => Pill.ok('موافق'), 'rejected' => Pill.danger('مرفوض'), 'pending' => Pill.warn('معلق'), _ => Pill('${r['status']}') },
            onLongPress: r['status'] == 'pending' || r['status'] == 'approved' ? () async { if (await confirm(context, 'إلغاء طلب الخصم؟')) { await state.api.post('/discount-requests/${r['id']}/cancel'); onChanged(); } } : null,
          ),
          const Align(alignment: AlignmentDirectional.centerStart, child: Text('اضغط مطولاً على الطلب لإلغائه', style: TextStyle(color: Palette.muted, fontSize: 12))),
        ]),
      );
}

class _ReceiptsSection extends StatefulWidget {
  const _ReceiptsSection({required this.receipts, required this.state, required this.onChanged});
  final List<Map<String, dynamic>> receipts;
  final CashierState state;
  final VoidCallback onChanged;
  @override
  State<_ReceiptsSection> createState() => _ReceiptsSectionState();
}

class _ReceiptsSectionState extends State<_ReceiptsSection> {
  bool _older = false;
  List<Map<String, dynamic>> get receipts => widget.receipts;
  CashierState get state => widget.state;
  VoidCallback get onChanged => widget.onChanged;
  @override
  Widget build(BuildContext context) {
    // وصولات اليوم المدفوعة (غير المسترجعة): تُطبع بوصل واحد جامع
    final today = todayIso();
    final paidToday = receipts.where((r) => r['status'] == 'paid' && r['business_date'] == today).toList();
    final unprinted = paidToday.where((r) => (r['print_count'] as num) == 0).length;
    return _build(context, paidToday, unprinted);
  }

  Widget _build(BuildContext context, List<Map<String, dynamic>> paidToday, int unprinted) => Section(
        title: 'وصولات الزبون',
        child: receipts.isEmpty
            ? const Text('ما أكو وصولات', style: TextStyle(color: Palette.muted))
            : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                if (paidToday.isNotEmpty) Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: FilledButton.icon(
                    style: unprinted > 0 ? null : FilledButton.styleFrom(backgroundColor: Palette.muted),
                    onPressed: () async { await Navigator.of(context).push(MaterialPageRoute(builder: (_) => ReceiptPage.day(state: state, dayCustomerId: paidToday.first['customer']['id'] as int))); onChanged(); },
                    icon: const Icon(Icons.receipt_long_outlined),
                    label: Text(unprinted > 0 ? 'طباعة وصل اليوم (وصل واحد)' : 'إعادة طباعة وصل اليوم'),
                  ),
                ),
                for (final r in (_older ? receipts : receipts.where((x) => x['business_date'] == todayIso())).take(8)) ListTile(
                  contentPadding: EdgeInsets.zero, dense: true,
                  title: Text('${ltr(r['receipt_no'] as String)} · ${money(r['net_amount'] as num)}'),
                  subtitle: Text('${dmy(r['business_date'] as String)} · ${r['kind'] == 'consultation' ? 'كشفية' : 'جلسات'}'),
                  trailing: switch (r['status']) { 'refunded' => Pill.danger('مسترجع'), 'partially_refunded' => Pill.warn('استرجاع جزئي'), _ => const Pill('مدفوع') },
                  onTap: () async { await Navigator.of(context).push(MaterialPageRoute(builder: (_) => ReceiptPage(state: state, receiptId: r['id'] as int))); onChanged(); },
                ),
                if (receipts.any((x) => x['business_date'] != todayIso())) TextButton(key: const ValueKey('older-receipts'), onPressed: () => setState(() => _older = !_older), child: Text(_older ? 'إخفاء الوصولات السابقة' : 'وصولات سابقة (${receipts.where((x) => x['business_date'] != todayIso()).length})')),
              ]),
      );
}
