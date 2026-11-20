import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/session.dart';
import '../../core/theme.dart';
import '../../core/widgets.dart';
import 'admin_shell.dart';

Api _api(BuildContext c) => c.read<Api>();
BranchScope _scope(BuildContext c) => c.read<BranchScope>();
bool _isOwner(BuildContext c) => c.read<Session>().user?.role == 'owner';

num _n(dynamic v) => (v as num?) ?? 0;

// ====================================================================== المهام (نظرة عامة)
class OverviewSection extends StatelessWidget {
  const OverviewSection({super.key, required this.onGo});
  final void Function(String title) onGo;
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context);
    return Loader<Map<String, dynamic>>(
      load: () async {
        final reqs = ((await api.get('/discount-requests', query: {...sc.q, 'status': 'pending'}))['requests'] as List);
        final shifts = (await api.get('/shifts', query: sc.q) as List).cast<Map<String, dynamic>>();
        final alerts = Map<String, dynamic>.from(await api.get('/stock/alerts', query: sc.q) as Map);
        final follow = Map<String, dynamic>.from(await api.get('/sessions/follow-up', query: sc.q) as Map);
        final wd = (await api.get('/safe/withdrawals', query: sc.q) as List).cast<Map<String, dynamic>>();
        final safe = Map<String, dynamic>.from(await api.get('/safe', query: sc.q) as Map);
        Map<String, dynamic>? backup;
        if (_isOwner(context)) { try { backup = Map<String, dynamic>.from(await api.get('/ops/backup-status') as Map); } catch (_) { backup = null; } }
        return {'reqs': reqs.length, 'shifts': shifts, 'alerts': alerts, 'follow': follow, 'withdrawals': wd.where((w) => w['status'] == 'pending').length, 'safe': safe['balance'], 'backup': backup};
      },
      builder: (context, d, reload) {
        final toConfirm = (d['shifts'] as List).where((s) => s['status'] == 'closed').length;
        final open = (d['shifts'] as List).where((s) => s['status'] == 'open').length;
        final alerts = d['alerts']['counts']['total'] as int;
        final follow = d['follow'] as Map;
        Widget tile(String title, String value, IconData icon, String go, {bool hot = false}) => Card(child: InkWell(borderRadius: BorderRadius.circular(12), onTap: () => onGo(go), child: Padding(padding: const EdgeInsets.all(16), child: Row(children: [
              Icon(icon, size: 28, color: hot ? Palette.warn : Palette.primary), const SizedBox(width: 14),
              Expanded(child: Text(title, style: const TextStyle(fontWeight: FontWeight.w600))), Text(value, style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: hot ? Palette.warn : Palette.text)),
            ]))));
        return ListPage(maxWidth: 760, children: [
          const Text('المهام اللي تنتظرك', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 18)),
          tile('طلبات خصم بانتظار قرارك', '${d['reqs']}', Icons.local_offer_outlined, 'طلبات الخصم', hot: (d['reqs'] as int) > 0),
          tile('شفتات مسكرة بانتظار تأكيدك', '$toConfirm', Icons.lock_clock, 'الشفتات والخزنة', hot: toConfirm > 0),
          tile('تنبيهات المخزون', '$alerts', Icons.inventory_2_outlined, 'المخزون', hot: alerts > 0),
          tile('جلسات مدفوعة وما تنفذت', '${(follow['paid_not_executed'] as List).length}', Icons.assignment_late_outlined, 'الحجوزات', hot: (follow['paid_not_executed'] as List).isNotEmpty),
          tile('جلسات تنتظر حجز', '${(follow['awaiting_booking'] as List).length}', Icons.event_busy, 'الحجوزات'),
          if (_isOwner(context)) tile('سحوبات بانتظار موافقتك', '${d['withdrawals']}', Icons.account_balance_wallet_outlined, 'الشفتات والخزنة', hot: (d['withdrawals'] as int) > 0),
          if (d['backup'] != null) BackupStatusCard(health: d['backup'] as Map<String, dynamic>),
          Section(child: Column(children: [KV('رصيد الخزنة', money(_n(d['safe'])), bold: true), KV('شفتات مفتوحة الآن', '$open')])),
        ]);
      },
    );
  }
}

// ====================================================================== طلبات الخصم
class DiscountsSection extends StatelessWidget {
  const DiscountsSection({super.key});
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context);
    return DefaultTabController(length: 2, child: Column(children: [
      const Material(color: Palette.surface, child: TabBar(tabs: [Tab(text: 'بانتظار القرار'), Tab(text: 'السجل')])),
      Expanded(child: TabBarView(children: [
        for (final pending in [true, false]) Loader<Map<String, dynamic>>(
          load: () async => Map<String, dynamic>.from(await api.get('/discount-requests', query: {...sc.q, if (pending) 'status': 'pending'}) as Map),
          builder: (context, d, reload) {
            final list = (d['requests'] as List).cast<Map<String, dynamic>>().where((r) => pending ? true : r['status'] != 'pending').toList();
            return ListPage(maxWidth: 760, children: [
              if (list.isEmpty) Empty(pending ? 'ما أكو طلبات خصم بالانتظار' : 'ما أكو سجل'),
              for (final r in list) _RequestCard(r: r, onDone: reload),
            ]);
          },
        ),
      ])),
    ]));
  }
}

class _RequestCard extends StatelessWidget {
  const _RequestCard({required this.r, required this.onDone});
  final Map<String, dynamic> r;
  final Future<void> Function() onDone;
  @override
  Widget build(BuildContext context) {
    final api = _api(context);
    final basket = r['basket'] as Map;
    final status = r['status'] as String;
    return Section(
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Expanded(child: Text('${(r['customer'] as Map)['full_name']} · ${basket['kind'] == 'consultation' ? 'كشفية' : 'جلسات'}', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16))),
          switch (status) { 'pending' => Pill.warn('بانتظار القرار'), 'approved' => Pill.ok('موافق ${money(_n(r['amount']))}'), 'rejected' => Pill.danger('مرفوض'), 'used' => Pill.ok('استُخدم'), 'expired' => const Pill('منتهي'), _ => Pill(status) },
        ]),
        const SizedBox(height: 6),
        for (final i in (basket['items'] as List).cast<Map<String, dynamic>>()) KV('${i['name']}', money(_n(i['price']))),
        KV('إجمالي السلة (بعد العرض)', money(_n(basket['gross'])), bold: true),
        Text('الكاشير: ${(r['requested_by'] as Map)['name']} · ${hm(r['requested_at'] as String?)}${basket['note'] == null ? '' : ' · "${basket['note']}"'}', style: const TextStyle(color: Palette.muted, fontSize: 13)),
        if (r['decision_note'] != null) Text('ملاحظة القرار: ${r['decision_note']}', style: const TextStyle(color: Palette.muted, fontSize: 13)),
        if (status == 'pending') Padding(padding: const EdgeInsets.only(top: 12), child: Row(children: [
          Expanded(child: FilledButton.icon(icon: const Icon(Icons.check), label: const Text('موافقة بمبلغ'), onPressed: () async {
            final amt = await _askAmount(context, 'مبلغ الخصم', max: _n(basket['gross']).toInt());
            if (amt == null) return;
            try { await api.post('/discount-requests/${r['id']}/approve', body: {'amount': amt}); if (context.mounted) toast(context, 'تمت الموافقة'); await onDone(); } catch (e) { if (context.mounted) showError(context, e); }
          })),
          const SizedBox(width: 8),
          OutlinedButton.icon(icon: const Icon(Icons.close), style: OutlinedButton.styleFrom(foregroundColor: Palette.danger), label: const Text('رفض'), onPressed: () async {
            final why = await askText(context, 'رفض الطلب', label: 'سبب الرفض'); if (why == null) return;
            try { await api.post('/discount-requests/${r['id']}/reject', body: {'note': why}); await onDone(); } catch (e) { if (context.mounted) showError(context, e); }
          }),
        ])),
      ]),
    );
  }
}

/// يسأل عن مبلغ صحيح (دينار) بحد أعلى اختياري.
Future<int?> _askAmount(BuildContext context, String title, {int? max, String label = 'المبلغ'}) async {
  final c = TextEditingController();
  String? err;
  return showDialog<int>(context: context, builder: (d) => StatefulBuilder(builder: (d, setS) => AlertDialog(
    title: Text(title),
    content: TextField(controller: c, autofocus: true, keyboardType: TextInputType.number, textDirection: TextDirection.ltr, decoration: deco(label, suffix: 'د.ع').copyWith(errorText: err, helperText: max == null ? null : 'الحد الأعلى ${money(max)}')),
    actions: [
      TextButton(onPressed: () => Navigator.pop(d), child: const Text('رجوع')),
      FilledButton(onPressed: () { final v = int.tryParse(c.text.replaceAll(',', '').trim()); if (v == null || v < 1) { setS(() => err = 'اكتب مبلغ صحيح'); return; } if (max != null && v > max) { setS(() => err = 'أكبر من الحد'); return; } Navigator.pop(d, v); }, child: const Text('تأكيد')),
    ],
  )));
}

// ====================================================================== الشفتات والخزنة
class CashSection extends StatelessWidget {
  const CashSection({super.key});
  @override
  Widget build(BuildContext context) {
    return DefaultTabController(length: 3, child: Column(children: [
      const Material(color: Palette.surface, child: TabBar(tabs: [Tab(text: 'الشفتات'), Tab(text: 'الخزنة'), Tab(text: 'سحب المالك')])),
      const Expanded(child: TabBarView(children: [_ShiftsTab(), _SafeTab(), _WithdrawalsTab()])),
    ]));
  }
}

class _ShiftsTab extends StatelessWidget {
  const _ShiftsTab();
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context);
    return Loader<List<Map<String, dynamic>>>(
      load: () async => (await api.get('/shifts', query: sc.q) as List).cast<Map<String, dynamic>>(),
      builder: (context, list, reload) => ListPage(maxWidth: 760, children: [
        if (list.isEmpty) const Empty('ما أكو شفتات'),
        for (final s in list) Section(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            Expanded(child: Text('${(s['cashier'] as Map)['full_name']} · ${dmy((s['opened_at'] as String).substring(0, 10))} ${hm(s['opened_at'] as String?)}', style: const TextStyle(fontWeight: FontWeight.w700))),
            switch (s['status']) { 'open' => Pill.warn('مفتوح'), 'closed' => Pill.warn('بانتظار التأكيد'), _ => Pill.ok('مؤكد') },
          ]),
          KV('الفكة', money(_n(s['opening_float']))),
          const SizedBox(height: 8),
          Wrap(spacing: 8, runSpacing: 8, children: [
            if (s['status'] == 'closed') FilledButton.icon(icon: const Icon(Icons.fact_check_outlined), label: const Text('مطابقة وتأكيد'), onPressed: () async { if (await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => _ConfirmShiftPage(shiftId: s['id'] as int))) == true) await reload(); }),
            if (s['status'] == 'confirmed') OutlinedButton(onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => _ConfirmShiftPage(shiftId: s['id'] as int))), child: const Text('تفاصيل')),
            if (s['status'] == 'open') OutlinedButton.icon(icon: const Icon(Icons.lock_open), label: const Text('تسكير إجباري'), style: OutlinedButton.styleFrom(foregroundColor: Palette.danger), onPressed: () async {
              final why = await askText(context, 'تسكير شفت منسي نيابة عن الكاشير', label: 'السبب'); if (why == null) return;
              try { await api.post('/shifts/${s['id']}/force-close', body: {'reason': why}); await reload(); } catch (e) { if (context.mounted) showError(context, e); }
            }),
          ]),
        ])),
      ]),
    );
  }
}

class _ConfirmShiftPage extends StatefulWidget {
  const _ConfirmShiftPage({required this.shiftId});
  final int shiftId;
  @override
  State<_ConfirmShiftPage> createState() => _ConfirmShiftPageState();
}

class _ConfirmShiftPageState extends State<_ConfirmShiftPage> {
  final Map<int, TextEditingController> _conf = {};
  final Map<int, TextEditingController> _note = {};

  @override
  Widget build(BuildContext context) {
    final api = _api(context);
    return Scaffold(
      appBar: AppBar(title: const Text('مطابقة الشفت')),
      body: Loader<Map<String, dynamic>>(
        load: () async => Map<String, dynamic>.from(await api.get('/shifts/${widget.shiftId}') as Map),
        builder: (context, s, reload) {
          final methods = (s['methods'] as List).cast<Map<String, dynamic>>();
          final confirmed = s['status'] == 'confirmed';
          for (final m in methods) { _conf.putIfAbsent(m['method_id'] as int, () => TextEditingController(text: m['counted'] == null ? '' : '${m['counted']}')); _note.putIfAbsent(m['method_id'] as int, () => TextEditingController()); }
          return ListPage(maxWidth: 720, children: [
            Section(child: Column(children: [KV('الكاشير', (s['cashier'] as Map)['full_name'] as String), KV('الفكة', money(_n(s['opening_float']))), KV('الحالة', confirmed ? 'مؤكد' : s['status'] == 'closed' ? 'مسكر بانتظار التأكيد' : 'مفتوح')])),
            for (final m in methods) Section(
              title: '${m['method_name']}${m['device_label'] == null ? '' : ' · ${m['device_label']}'}',
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                KV('المقبوض', money(_n(m['collected']))), KV('المرتجع', money(_n(m['refunded']))),
                KV('المتوقع', money(_n(m['expected'])), bold: true), KV('اللي عدّه الكاشير', m['counted'] == null ? '—' : money(_n(m['counted']))),
                if (confirmed) ...[KV('المؤكد', money(_n(m['confirmed']))), KV('الفرق', money(_n(m['difference'])), valueColor: _n(m['difference']) == 0 ? Palette.ok : Palette.danger), if (m['note'] != null) KV('ملاحظة', m['note'] as String)]
                else ...[
                  const SizedBox(height: 8),
                  TextField(controller: _conf[m['method_id']], keyboardType: TextInputType.number, textDirection: TextDirection.ltr, decoration: deco('المبلغ اللي عديته وأكدته', suffix: 'د.ع')),
                  const SizedBox(height: 8),
                  TextField(controller: _note[m['method_id']], decoration: deco('ملاحظة (إلزامية إذا فيه فرق)')),
                ],
              ]),
            ),
            if (!confirmed && s['status'] == 'closed') AsyncButton(icon: Icons.verified_outlined, onPressed: () async {
              final lines = <Map<String, dynamic>>[];
              for (final m in methods) {
                final v = int.tryParse(_conf[m['method_id']]!.text.replaceAll(',', '').trim());
                if (v == null || v < 0) { toast(context, 'اكتب المبلغ المؤكد لكل طريقة', error: true); return; }
                final note = _note[m['method_id']]!.text.trim();
                lines.add({'method_id': m['method_id'], 'confirmed': v, if (note.isNotEmpty) 'note': note});
              }
              await api.post('/shifts/${widget.shiftId}/confirm', body: {'lines': lines});
              if (context.mounted) { toast(context, 'تم تأكيد الشفت: الكاش دخل الخزنة'); Navigator.pop(context, true); }
            }, child: const Text('تم تأكيد المبلغ')),
          ]);
        },
      ),
    );
  }
}

class _SafeTab extends StatelessWidget {
  const _SafeTab();
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context);
    final labels = {'opening_balance': 'رصيد افتتاحي', 'shift_float': 'فكة شفت', 'shift_handover': 'استلام شفت', 'expense': 'مصروف', 'expense_adjustment': 'تعديل مصروف', 'supplier_payment': 'تسديد مورد', 'salary': 'راتب', 'owner_withdrawal': 'سحب مالك', 'compensation': 'تعويض زبون'};
    return Loader<Map<String, dynamic>>(
      load: () async => Map<String, dynamic>.from(await api.get('/safe', query: sc.q) as Map),
      builder: (context, d, reload) => ListPage(maxWidth: 760, children: [
        Section(child: Row(children: [const Icon(Icons.savings_outlined, size: 30, color: Palette.primary), const SizedBox(width: 12), const Expanded(child: Text('رصيد الخزنة', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16))), Text(money(_n(d['balance'])), style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: Palette.primaryDark))])),
        if (_isOwner(context) && (d['movements'] as List).isEmpty) AsyncButton(onPressed: () async { final a = await _askAmount(context, 'الرصيد الافتتاحي (مرة وحدة)'); if (a == null) return; await api.post('/safe/opening-balance', body: sc.body({'amount': a})); await reload(); }, child: const Text('تسجيل الرصيد الافتتاحي')),
        Section(title: 'الحركات', child: Column(children: [
          for (final m in (d['movements'] as List).cast<Map<String, dynamic>>()) ListTile(dense: true, contentPadding: EdgeInsets.zero,
            leading: Icon(m['direction'] == 'in' ? Icons.south_west : Icons.north_east, color: m['direction'] == 'in' ? Palette.ok : Palette.danger),
            title: Text('${labels[m['kind']] ?? m['kind']}${m['note'] == null ? '' : ' · ${m['note']}'}'), subtitle: Text('${dmy(m['business_date'] as String)} · ${m['by'] ?? ''}'),
            trailing: Text('${m['direction'] == 'in' ? '+' : '-'} ${moneyPlain(_n(m['amount']))}', style: TextStyle(fontWeight: FontWeight.w700, color: m['direction'] == 'in' ? Palette.ok : Palette.danger))),
        ])),
      ]),
    );
  }
}

class _WithdrawalsTab extends StatelessWidget {
  const _WithdrawalsTab();
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context); final owner = _isOwner(context);
    return Loader<List<Map<String, dynamic>>>(
      load: () async => (await api.get('/safe/withdrawals', query: sc.q) as List).cast<Map<String, dynamic>>(),
      builder: (context, list, reload) => ListPage(maxWidth: 760, children: [
        if (!owner) FilledButton.icon(icon: const Icon(Icons.add), label: const Text('تسجيل سحب للمالك'), onPressed: () async {
          final name = TextEditingController(); final amount = TextEditingController(); final note = TextEditingController(); String date = todayIso();
          final ok = await showDialog<bool>(context: context, builder: (d) => StatefulBuilder(builder: (d, setS) => AlertDialog(
            title: const Text('سحب من الخزنة'),
            content: SizedBox(width: 380, child: Column(mainAxisSize: MainAxisSize.min, children: [
              TextField(controller: amount, keyboardType: TextInputType.number, textDirection: TextDirection.ltr, decoration: deco('المبلغ', suffix: 'د.ع')), const SizedBox(height: 10),
              TextField(controller: name, decoration: deco('انسحب باسم منو')), const SizedBox(height: 10),
              DateField(label: 'التاريخ', value: date, last: DateTime.now(), onChanged: (v) => setS(() => date = v)), const SizedBox(height: 10),
              TextField(controller: note, decoration: deco('ملاحظة (اختياري)')),
            ])),
            actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
              final a = int.tryParse(amount.text.replaceAll(',', '').trim());
              if (a == null || a < 1 || name.text.trim().length < 2) { toast(d, 'اكتب المبلغ والاسم', error: true); return; }
              try { await api.post('/safe/withdrawals', body: sc.body({'amount': a, 'withdrawn_by_name': name.text.trim(), 'withdrawal_date': date, if (note.text.trim().isNotEmpty) 'note': note.text.trim()})); if (d.mounted) Navigator.pop(d, true); } catch (e) { if (d.mounted) showError(d, e); }
            }, child: const Text('تسجيل'))],
          )));
          if (ok == true) await reload();
        }),
        if (list.isEmpty) const Empty('ما أكو سحوبات'),
        for (final w in list) Section(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [Expanded(child: Text('${money(_n(w['amount']))} · ${w['withdrawn_by_name']}', style: const TextStyle(fontWeight: FontWeight.w700))), switch (w['status']) { 'pending' => Pill.warn('بانتظار موافقة المالك'), 'approved' => Pill.ok('موافق'), 'cancelled' => const Pill('ملغى', color: Palette.muted, bg: Palette.bg), _ => Pill.danger('مرفوض') }]),
          Text('${dmy(w['withdrawal_date'] as String)}${w['note'] == null ? '' : ' · ${w['note']}'}', style: const TextStyle(color: Palette.muted)),
          if (!owner && w['status'] == 'pending' && (w['recorded_by'] as Map)['id'] == context.read<Session>().user?.id) Padding(padding: const EdgeInsets.only(top: 10), child: AsyncButton(outlined: true, danger: true, icon: Icons.undo, onPressed: () async {
            final why = await askText(context, 'إلغاء طلب السحب', label: 'سبب الإلغاء (اختياري)', minLen: 0, yes: 'إلغاء الطلب'); if (why == null) return;
            await api.post('/safe/withdrawals/${w['id']}/cancel', body: {if (why.trim().isNotEmpty) 'note': why.trim()});
            if (context.mounted) toast(context, 'انلغى طلب السحب'); await reload();
          }, child: const Text('إلغاء الطلب'))),
          if (owner && w['status'] == 'pending') Padding(padding: const EdgeInsets.only(top: 10), child: Row(children: [
            Expanded(child: AsyncButton(icon: Icons.check, onPressed: () async { await api.post('/safe/withdrawals/${w['id']}/approve', body: {}); await reload(); }, child: const Text('موافقة'))),
            const SizedBox(width: 8),
            Expanded(child: AsyncButton(outlined: true, danger: true, icon: Icons.close, onPressed: () async { final why = await askText(context, 'رفض السحب', label: 'السبب'); if (why == null) return; await api.post('/safe/withdrawals/${w['id']}/reject', body: {'note': why}); await reload(); }, child: const Text('رفض'))),
          ])),
        ])),
      ]),
    );
  }
}

// ====================================================================== الحجوزات
class BookingsSection extends StatefulWidget {
  const BookingsSection({super.key});
  @override
  State<BookingsSection> createState() => _BookingsSectionState();
}

class _BookingsSectionState extends State<BookingsSection> {
  String _date = todayIso();
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context);
    return Loader<Map<String, dynamic>>(
      key: ValueKey(_date),
      load: () async {
        final b = Map<String, dynamic>.from(await api.get('/bookings', query: {...sc.q, 'date': _date}) as Map);
        final f = Map<String, dynamic>.from(await api.get('/sessions/follow-up', query: sc.q) as Map);
        final bf = Map<String, dynamic>.from(await api.get('/bookings/follow-up', query: sc.q) as Map);
        return {'b': b, 'f': f, 'bf': bf};
      },
      builder: (context, d, reload) {
        final b = d['b'] as Map; final day = b['day'] as Map?; final list = (b['bookings'] as List).cast<Map<String, dynamic>>();
        final f = d['f'] as Map; final bf = d['bf'] as Map;
        return ListPage(maxWidth: 820, children: [
          Row(children: [
            IconButton(onPressed: () => setState(() => _date = addDaysIso(_date, -1)), icon: const Icon(Icons.chevron_right)),
            Expanded(child: InkWell(onTap: () async { final x = await showDatePicker(context: context, initialDate: DateTime.parse(_date), firstDate: DateTime(2024), lastDate: DateTime.now().add(const Duration(days: 365))); if (x != null) setState(() => _date = isoDate(x)); }, child: Text('${dmy(_date)} · ${weekdayName(_date)}', textAlign: TextAlign.center, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)))),
            IconButton(onPressed: () => setState(() => _date = addDaysIso(_date, 1)), icon: const Icon(Icons.chevron_left)),
            if (day != null) Pill('${day['used_slots']} من ${day['daily_limit']}'),
          ]),
          if (day != null && _date.compareTo(todayIso()) >= 0) Card(child: ListTile(
            key: const ValueKey('stop-day'),
            leading: Icon(day['stopped'] == true ? Icons.pause_circle : Icons.event_available, color: day['stopped'] == true ? Palette.danger : Palette.ok),
            title: Text(day['stopped'] == true ? 'الحجز موقوف لهذا اليوم' : 'الحجز مفتوح لهذا اليوم'),
            subtitle: Text(day['stopped'] == true ? (day['stop_reason'] as String?) ?? 'الحجوزات الموجودة تبقى، والجديدة تروح لأقرب يوم' : 'تگدر توقف الحجز الجديد (زحمة مثلاً): الموجود يبقى والجديد يروح لليوم اللي بعده'),
            trailing: day['stopped'] == true
                ? OutlinedButton(onPressed: () async { try { await api.post('/bookings/days/$_date/resume${sc.q.isEmpty ? '' : '?branch_id=${sc.q['branch_id']}'}', body: const {}); await reload(); } catch (e) { if (context.mounted) showError(context, e); } }, child: const Text('استئناف الحجز'))
                : OutlinedButton(onPressed: () async {
                    final why = await askText(context, 'إيقاف الحجز ليوم ${dmy(_date)}', label: 'السبب (اختياري)', minLen: 0, hint: 'مثلاً: زحمة');
                    if (why == null) return;
                    try { await api.post('/bookings/days/$_date/stop', body: sc.body({if (why.isNotEmpty) 'reason': why})); await reload(); } catch (e) { if (context.mounted) showError(context, e); }
                  }, child: const Text('إيقاف الحجز')),
          )),
          if (list.isEmpty) const Empty('ما أكو حجوزات بهذا اليوم'),
          for (final x in list) Card(child: ListTile(
            leading: Container(width: 38, height: 38, alignment: Alignment.center, decoration: BoxDecoration(color: Palette.text, borderRadius: BorderRadius.circular(8)), child: Text('${x['seq_no']}', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700))),
            title: Text('${(x['customer'] as Map)['full_name']}'), subtitle: Text('${x['doctor'] == null ? 'جلسات' : (x['doctor'] as Map)['full_name']}${(x['consultation'] as Map?)?['kind'] == 'free_followup' ? ' · مراجعة مجانية' : (x['consultation'] as Map?)?['kind'] == 'sessions_only' ? ' · جلسات فقط' : ''}${((x['consultation'] as Map?)?['interest'] as Map?) == null ? '' : ' · يريد ${((x['consultation'] as Map)['interest'] as Map)['name']}'}'),
            trailing: switch (x['status']) { 'arrived' => Pill.ok('حضر'), 'booked' => const Pill('محجوز'), 'cancelled' => Pill.danger('ملغى'), 'missed' => Pill.danger('فات'), _ => Pill('${x['status']}') },
          )),
          if ((f['paid_not_executed'] as List).isNotEmpty) Section(title: 'مدفوعة وما تنفذت (للعلم، الكاشير يتصرف)', child: Column(children: [for (final s in (f['paid_not_executed'] as List).cast<Map<String, dynamic>>()) ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text('${(s['customer'] as Map)['full_name']} · ${s['service_name']} جلسة ${s['seq_no']}'), trailing: Text(dmy(s['scheduled_date'] as String?)))])),
          if ((f['awaiting_booking'] as List).isNotEmpty) Section(title: 'جلسات تنتظر حجز', child: Column(children: [for (final s in (f['awaiting_booking'] as List).cast<Map<String, dynamic>>()) ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text('${(s['customer'] as Map)['full_name']} · ${s['service_name']} جلسة ${s['seq_no']}'))])),
          if ((bf['moved'] as List).isNotEmpty || (bf['stuck'] as List).isNotEmpty || (bf['unserved'] as List).isNotEmpty) Section(title: 'متابعة العطل', child: Column(children: [
            for (final m in (bf['moved'] as List).cast<Map<String, dynamic>>()) ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text('${(m['customer'] as Map)['full_name']} (${ltr((m['customer'] as Map)['phone'] as String)})'), subtitle: Text('انتقل من ${dmy(m['from_date'] as String)} إلى ${dmy(m['to_date'] as String)} · ${m['reason'] ?? ''}')),
            for (final m in (bf['unserved'] as List).cast<Map<String, dynamic>>()) ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text('${(m['customer'] as Map)['full_name']} (${ltr((m['customer'] as Map)['phone'] as String)})'), subtitle: Text('دفع يوم ${dmy(m['date'] as String)} وما انخدم ولا لگينا له يوم: يحتاج اتصال')),
            for (final m in (bf['stuck'] as List).cast<Map<String, dynamic>>()) ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text('${(m['customer'] as Map)['full_name']}'), subtitle: const Text('ما لگينا يوم بديل: يحتاج اتصال')),
          ])),
          AsyncButton(outlined: true, icon: Icons.event_busy, onPressed: () async {
            if (!await confirm(context, 'إقفال الأيام الماضية؟', body: 'الحجوزات غير المدفوعة بالأيام السابقة تصير «فات» وتنلغي كشفياتها.', yes: 'إقفال')) return;
            final r = await api.post('/bookings/close-past-days', body: const {}, auth: true);
            if (context.mounted) toast(context, 'انقفلت الأيام الماضية (${(r as Map)['missed']} حجز فات)');
            await reload();
          }, child: const Text('إقفال الأيام الماضية')),
        ]);
      },
    );
  }
}

// ====================================================================== العروض
class OffersSection extends StatelessWidget {
  const OffersSection({super.key});
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final sc = _scope(context);
    return Loader<List<Map<String, dynamic>>>(
      load: () async => ((await api.get('/offers', query: sc.q))['offers'] as List).cast<Map<String, dynamic>>(),
      builder: (context, list, reload) => ListPage(maxWidth: 760, children: [
        FilledButton.icon(icon: const Icon(Icons.add), label: const Text('عرض جديد'), onPressed: () async { if (await _offerDialog(context)) await reload(); }),
        if (list.isEmpty) const Empty('ما أكو عروض'),
        for (final o in list) Section(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [Expanded(child: Text('${o['title']} · ${(o['service'] as Map)['name']}', style: const TextStyle(fontWeight: FontWeight.w700))), switch (o['state']) { 'active' => Pill.ok('فعال'), 'scheduled' => Pill.warn('مجدول'), 'ended' => const Pill('منتهي'), _ => Pill.danger('ملغى') }]),
          Text('خصم ${o['percent']}% · من ${dmy(o['start_date'] as String)} إلى ${dmy(o['end_date'] as String)}', style: const TextStyle(color: Palette.muted)),
          Text('الإشعار: ${switch ((o['notify'] as Map)['audience']) { 'all' => 'لكل الزبائن', 'did_service' => 'لمن سوّوا ${((o['notify'] as Map)['service'] as Map?)?['name']}', _ => 'بدون' }}${(o['notify'] as Map)['sent_at'] != null ? ' · انرسل' : ''}', style: const TextStyle(color: Palette.muted, fontSize: 13)),
          if ((o['warnings'] as List).isNotEmpty) const Padding(padding: EdgeInsets.only(top: 6), child: Notice('نص الإشعار يذكر اسم الخدمة: ممكن ينكشف على شاشة القفل', kind: NoticeKind.warn)),
          if (o['state'] == 'active' || o['state'] == 'scheduled') Align(alignment: AlignmentDirectional.centerStart, child: TextButton(onPressed: () async { final why = await askText(context, 'إلغاء العرض', label: 'السبب'); if (why == null) return; try { await api.post('/offers/${o['id']}/cancel', body: {'reason': why}); await reload(); } catch (e) { if (context.mounted) showError(context, e); } }, child: const Text('إلغاء العرض', style: TextStyle(color: Palette.danger)))),
        ])),
      ]),
    );
  }

  Future<bool> _offerDialog(BuildContext context) async {
    final api = _api(context); final sc = _scope(context);
    final services = ((await api.get('/services', query: sc.q) as List).cast<Map<String, dynamic>>()).where((s) => s['kind'] == 'treatment' && s['is_active'] == true).toList();
    if (!context.mounted) return false;
    if (services.isEmpty) { toast(context, 'ما أكو خدمات علاجية فعالة', error: true); return false; }
    int svc = services.first['id'] as int; String start = todayIso(); String end = addDaysIso(todayIso(), 14); String audience = 'all'; int? notifySvc;
    final title = TextEditingController(); final pct = TextEditingController(text: '10'); final ntitle = TextEditingController(); final nbody = TextEditingController();
    final ok = await showDialog<bool>(context: context, builder: (d) => StatefulBuilder(builder: (d, setS) => AlertDialog(
      title: const Text('عرض جديد'),
      content: SizedBox(width: 440, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        DropdownButtonFormField<int>(initialValue: svc, decoration: deco('الخدمة'), items: [for (final s in services) DropdownMenuItem(value: s['id'] as int, child: Text(s['name_ar'] as String))], onChanged: (v) => setS(() => svc = v!)), const SizedBox(height: 10),
        TextField(controller: title, decoration: deco('عنوان العرض')), const SizedBox(height: 10),
        TextField(controller: pct, keyboardType: const TextInputType.numberWithOptions(decimal: true), textDirection: TextDirection.ltr, decoration: deco('نسبة الخصم', suffix: '%')), const SizedBox(height: 10),
        Row(children: [Expanded(child: DateField(label: 'من', value: start, first: DateTime.now(), onChanged: (v) => setS(() => start = v))), const SizedBox(width: 8), Expanded(child: DateField(label: 'إلى', value: end, first: DateTime.now(), onChanged: (v) => setS(() => end = v)))]), const SizedBox(height: 10),
        DropdownButtonFormField<String>(initialValue: audience, decoration: deco('إشعار الزبائن'), items: const [DropdownMenuItem(value: 'all', child: Text('لكل الزبائن')), DropdownMenuItem(value: 'did_service', child: Text('لمن سوّوا خدمة معينة')), DropdownMenuItem(value: 'none', child: Text('بدون إشعار'))], onChanged: (v) => setS(() => audience = v!)),
        if (audience == 'did_service') ...[const SizedBox(height: 10), DropdownButtonFormField<int>(initialValue: notifySvc, decoration: deco('الخدمة اللي سوّوها'), items: [for (final s in services) DropdownMenuItem(value: s['id'] as int, child: Text(s['name_ar'] as String))], onChanged: (v) => setS(() => notifySvc = v))],
        if (audience != 'none') ...[const SizedBox(height: 10), TextField(controller: ntitle, decoration: deco('عنوان الإشعار (اختياري)', hint: 'عرض جديد')), const SizedBox(height: 10), TextField(controller: nbody, decoration: deco('نص الإشعار (بدون اسم علاج)'))],
      ]))),
      actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
        final p = double.tryParse(pct.text.trim());
        if (title.text.trim().length < 2 || p == null) { toast(d, 'اكتب العنوان والنسبة', error: true); return; }
        try {
          final r = Map<String, dynamic>.from(await api.post('/offers', body: sc.body({'service_id': svc, 'title': title.text.trim(), 'percent': p, 'start_date': start, 'end_date': end, 'notify_audience': audience, if (audience == 'did_service' && notifySvc != null) 'notify_service_id': notifySvc, if (ntitle.text.trim().isNotEmpty) 'notify_title': ntitle.text.trim(), if (nbody.text.trim().isNotEmpty) 'notify_body': nbody.text.trim()})) as Map);
          if (d.mounted) { if ((r['warnings'] as List).isNotEmpty) toast(d, 'انحفظ العرض. تنبيه: نص الإشعار يذكر اسم الخدمة'); Navigator.pop(d, true); }
        } catch (e) { if (d.mounted) showError(d, e); }
      }, child: const Text('حفظ'))],
    )));
    return ok ?? false;
  }
}


/// حالة النسخ الاحتياطي للمالك: أخضر إذا كل شي سليم، وإلا المشاكل بالعربي.
class BackupStatusCard extends StatelessWidget {
  const BackupStatusCard({super.key, required this.health});
  final Map<String, dynamic> health;
  String _ago(String? iso) {
    if (iso == null) return 'ما انعملت';
    final d = DateTime.tryParse(iso); if (d == null) return '—';
    final m = DateTime.now().difference(d).inMinutes;
    return m < 1 ? 'هسه' : m < 60 ? 'قبل $m دقيقة' : m < 48 * 60 ? 'قبل ${m ~/ 60} ساعة' : 'قبل ${m ~/ (60 * 24)} يوم';
  }
  @override
  Widget build(BuildContext context) {
    final problems = (health['problems'] as List).cast<Map<String, dynamic>>();
    final ok = health['ok'] == true;
    return Section(
      title: 'النسخ الاحتياطي',
      trailing: ok ? (problems.isEmpty ? Pill.ok('سليم') : Pill.warn('سليم مع تنبيه')) : Pill.danger('يحتاج انتباه'),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final p in problems) Padding(padding: const EdgeInsets.only(bottom: 6), child: Notice('${p['message']}', kind: p['level'] == 'error' ? NoticeKind.danger : NoticeKind.warn)),
        if (health['configured'] == true) ...[
          KV('آخر نسخة كاملة', _ago(health['base_last_ok_at'] as String?)),
          KV('الحماية المستمرة (WAL)', _ago(health['wal_last_run_at'] as String?)),
          KV('آخر نسخة للصور', _ago(health['uploads_last_ok_at'] as String?)),
          KV('آخر تجربة استرجاع ناجحة', _ago(health['verify_last_ok_at'] as String?)),
        ],
      ]),
    );
  }
}
