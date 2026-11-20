import 'dart:async';

import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/theme.dart';
import '../../core/widgets.dart';
import '../home_shell.dart';
import 'cashier_state.dart';
import 'customer_panel.dart';
import 'dialogs.dart';
import 'receipts_page.dart';
import 'shift_pages.dart';

/// شاشة الكاشير (نموذج screens/Main.dc.html): حجوزات اليوم وبحث الزبون على جنب، وملف الزبون والدفع بالوسط.
class CashierHome extends StatelessWidget {
  const CashierHome({super.key});
  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider(create: (c) => CashierState(c.read<Api>())..refresh().catchError((_) {}), child: const _CashierView());
  }
}

class _CashierView extends StatelessWidget {
  const _CashierView();
  @override
  Widget build(BuildContext context) {
    final st = context.watch<CashierState>();
    return Scaffold(
      appBar: staffBar(context, 'الكاشير', actions: [
        if (st.loaded) Padding(padding: const EdgeInsets.symmetric(horizontal: 4), child: Center(child: st.shiftOpen ? Pill.ok('الشفت مفتوح · ${st.shift!['receipts_count']} وصل') : Pill.warn('ما أكو شفت مفتوح'))),
        IconButton(tooltip: 'الوصولات', icon: const Icon(Icons.receipt_long_outlined), onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const ReceiptsPage()))),
        if (st.loaded && st.shiftOpen) TextButton.icon(onPressed: () async { await Navigator.of(context).push(MaterialPageRoute(builder: (_) => CloseShiftPage(state: st))); await st.refresh().catchError((_) {}); }, icon: const Icon(Icons.lock_outline), label: const Text('تسليم الشفت')),
        IconButton(tooltip: 'تحديث', icon: const Icon(Icons.refresh), onPressed: () => st.refresh().catchError((e) { if (context.mounted) showError(context, e); })),
      ]),
      body: !st.loaded
          ? const Center(child: CircularProgressIndicator())
          : !st.shiftOpen
              ? _NoShift(state: st)
              : LayoutBuilder(builder: (context, c) {
                  final wide = c.maxWidth >= 900;
                  final side = _Side(state: st, wide: wide);
                  if (!wide) return side;
                  return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    SizedBox(width: 380, child: side),
                    const VerticalDivider(width: 1),
                    Expanded(child: st.selectedCustomerId == null ? const Empty('اختر زبون من القائمة أو ابحث عنه') : CustomerPanel(key: ValueKey('${st.selectedCustomerId}-${st.version}'), customerId: st.selectedCustomerId!, state: st)),
                  ]);
                }),
    );
  }
}

class _NoShift extends StatelessWidget {
  const _NoShift({required this.state});
  final CashierState state;
  @override
  Widget build(BuildContext context) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 440),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const Icon(Icons.lock_clock, size: 56, color: Palette.muted),
            const SizedBox(height: 12),
            const Text('افتح شفتك لتبدي الدفع', textAlign: TextAlign.center, style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            const Text('اكتب الفكة اللي استلمتها من المدير. تطلع من الخزنة وتنحسب بتسليم الشفت.', textAlign: TextAlign.center, style: TextStyle(color: Palette.muted)),
            const SizedBox(height: 20),
            FilledButton.icon(onPressed: () async { if (await openShiftDialog(context, state)) await state.refresh(); }, icon: const Icon(Icons.play_arrow), label: const Text('فتح الشفت')),
          ]),
        ),
      ),
    );
  }
}

class _Side extends StatefulWidget {
  const _Side({required this.state, required this.wide});
  final CashierState state;
  final bool wide;
  @override
  State<_Side> createState() => _SideState();
}

class _SideState extends State<_Side> {
  final _q = TextEditingController();
  Timer? _debounce;
  List<Map<String, dynamic>>? _results;
  bool _searching = false;
  bool _showDone = false;

  void _onChanged(String v) {
    _debounce?.cancel();
    if (v.trim().length < 2) { setState(() => _results = null); return; }
    _debounce = Timer(const Duration(milliseconds: 350), () async {
      setState(() => _searching = true);
      try {
        final r = await context.read<Api>().get('/customers', query: {'q': v.trim()});
        if (mounted && _q.text.trim() == v.trim()) setState(() => _results = (r as List).cast<Map<String, dynamic>>());
      } catch (e) { if (mounted) showError(context, e); }
      if (mounted) setState(() => _searching = false);
    });
  }

  void _open(int id) {
    widget.state.select(id);
    if (!widget.wide) {
      Navigator.of(context).push(MaterialPageRoute(builder: (_) => ChangeNotifierProvider.value(value: widget.state, child: Scaffold(appBar: AppBar(title: const Text('ملف الزبون')), body: CustomerPanel(customerId: id, state: widget.state))))).then((_) => widget.state.refresh().catchError((_) {}));
    }
  }

  @override
  Widget build(BuildContext context) {
    final st = widget.state;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
        child: Row(children: [
          Expanded(child: TextField(controller: _q, onChanged: _onChanged, decoration: deco('بحث بالرمز المميز أو الاسم أو التلفون').copyWith(prefixIcon: const Icon(Icons.search), suffixIcon: _searching ? const Padding(padding: EdgeInsets.all(12), child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))) : null))),
          const SizedBox(width: 8),
          IconButton.filled(tooltip: 'زبون جديد', onPressed: () async { final id = await newCustomerDialog(context); if (id != null) _open(id); }, icon: const Icon(Icons.person_add_alt_1)),
        ]),
      ),
      Expanded(
        child: _results != null
            ? (_results!.isEmpty ? const Empty('ما لگينا زبون بهالبحث') : ListView(padding: const EdgeInsets.all(16), children: [for (final c in _results!) _CustomerTile(c: c, onTap: () => _open(c['id'] as int))]))
            : ListView(padding: const EdgeInsets.all(16), children: [
                Row(children: [const Expanded(child: Text('حجوزات اليوم', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700))), if (st.day != null && st.day!['stopped'] == true) Padding(padding: const EdgeInsets.only(left: 6), child: Pill.warn('الحجز موقوف')), if (st.day != null) Text('${st.day!['used_slots']} من ${st.day!['daily_limit']}', style: const TextStyle(color: Palette.muted))]),
                const SizedBox(height: 8),
                if (st.activeQueue.isEmpty) Empty(st.doneQueue.isEmpty ? 'ما أكو حجوزات اليوم' : 'ما أكو زبائن بانتظار الكاشير'),
                // الكشفيات بخانة، والجلسات بخانة: الزيارة تنتقل للجلسات لما تخلص كشفيتها. زبون الجلسات كارت واحد بكل جلساته.
                ..._section('كشفيات', 'queue-consultations', st.activeQueue.where((b) => b['phase'] == 'consultation').toList(), st),
                ..._section('جلسات', 'queue-sessions', st.activeQueue.where((b) => b['phase'] != 'consultation').toList(), st),
                // المنتهية والملغية والفايتة: مطوية، للطوارئ (زبون رجع يريد وصل أو استرجاع)
                if (st.doneQueue.isNotEmpty) ...[
                  InkWell(key: const ValueKey('done-toggle'), onTap: () => setState(() => _showDone = !_showDone), child: Padding(padding: const EdgeInsets.symmetric(vertical: 10), child: Row(children: [
                    Icon(_showDone ? Icons.expand_less : Icons.expand_more, color: Palette.muted), const SizedBox(width: 4),
                    Text('المنتهية والملغية (${st.doneQueue.length})', style: const TextStyle(color: Palette.muted, fontWeight: FontWeight.w600)),
                  ]))),
                  if (_showDone) for (final b in st.doneQueue) _QueueTile(b: b, selected: st.selectedCustomerId == (b['customer'] as Map)['id'], onTap: () => _open((b['customer'] as Map)['id'] as int)),
                ],
              ]),
      ),
    ]);
  }
}

extension on _SideState {
  List<Widget> _section(String title, String key, List<Map<String, dynamic>> items, CashierState st) {
    if (items.isEmpty) return const [];
    return [
      Padding(key: ValueKey(key), padding: const EdgeInsets.only(top: 6, bottom: 8), child: Row(children: [
        Text(title, style: const TextStyle(fontWeight: FontWeight.w700, color: Palette.muted)), const SizedBox(width: 6), Pill('${items.length}'),
      ])),
      for (final b in items) _QueueTile(b: b, selected: st.selectedCustomerId == (b['customer'] as Map)['id'], onTap: () => _open((b['customer'] as Map)['id'] as int)),
    ];
  }
}

class _CustomerTile extends StatelessWidget {
  const _CustomerTile({required this.c, required this.onTap});
  final Map<String, dynamic> c;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Card(
        child: ListTile(
          onTap: onTap, title: Text(c['full_name'] as String, style: const TextStyle(fontWeight: FontWeight.w600)),
          subtitle: Text('${ltr(c['public_code'] as String)} · ${ltr(c['phone'] as String)}'),
          trailing: Pill('${c['points_balance']} نقطة'),
        ),
      );
}

class _QueueTile extends StatelessWidget {
  const _QueueTile({required this.b, required this.selected, required this.onTap});
  final Map<String, dynamic> b;
  final bool selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final cust = b['customer'] as Map;
    final cons = b['consultation'] as Map?;
    final status = b['status'] as String;
    final pill = switch ((status, cons?['status'])) {
      ('arrived', 'with_doctor') => Pill.ok('عند الطبيب'),
      ('arrived', 'finished') => Pill.ok('انتهت'),
      ('arrived', _) => Pill.ok('مدفوعة'),
      ('booked', _) => Pill.warn('بانتظار الدفع'),
      ('cancelled', _) => Pill.danger('ملغى'),
      ('missed', _) => Pill.danger('فات'),
      _ => Pill(status),
    };
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: selected ? Palette.primarySoft : Palette.surface, border: Border.all(color: selected ? Palette.primary : Palette.border), borderRadius: BorderRadius.circular(8)),
          child: Row(children: [
            Container(width: 40, height: 40, alignment: Alignment.center, decoration: BoxDecoration(color: Palette.text, borderRadius: BorderRadius.circular(8)), child: Text('${b['seq_no']}', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 17))),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(cust['full_name'] as String, style: const TextStyle(fontWeight: FontWeight.w600)),
              Text('${ltr(cust['public_code'] as String)}${b['doctor'] == null ? '' : ' · ${(b['doctor'] as Map)['full_name']}'}${cons?['kind'] == 'free_followup' ? ' · مراجعة مجانية' : cons?['kind'] == 'sessions_only' ? ' · جلسات فقط' : ''}', style: const TextStyle(color: Palette.muted, fontSize: 13)),
              if (b['phase'] == 'consultation' && ((cons?['interest'] as Map?) != null || (cons?['note'] as String?) != null))
                Text([if (cons?['interest'] != null) 'يريد ${(cons!['interest'] as Map)['name']}', if ((cons?['note'] as String?) != null) '${cons!['note']}'].join(' · '), maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5)),
              for (final s in (b['sessions'] as List? ?? const []).cast<Map>())
                Text('${s['service_name']} · جلسة ${s['seq_no']} من ${s['of']}${s['status'] == 'paid' ? ' · مدفوعة' : s['status'] == 'completed' ? ' · منفذة' : ''}', style: const TextStyle(fontSize: 12.5)),
            ])),
            pill,
          ]),
        ),
      ),
    );
  }
}
