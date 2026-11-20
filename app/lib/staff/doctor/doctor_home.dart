import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/theme.dart';
import '../../core/widgets.dart';
import '../home_shell.dart';
import 'consultation_page.dart';

/// واجهة الطبيب (screens/Doctor.dc.html): قائمة اليوم بالتسلسل، ودخول ملف الزبون.
class DoctorHome extends StatefulWidget {
  const DoctorHome({super.key});
  @override
  State<DoctorHome> createState() => _DoctorHomeState();
}

class _DoctorHomeState extends State<DoctorHome> {
  final _ctl = LoaderController();
  String _date = todayIso();

  @override
  Widget build(BuildContext context) {
    final api = context.read<Api>();
    return Scaffold(
      appBar: staffBar(context, 'الطبيب', actions: [IconButton(tooltip: 'تحديث', icon: const Icon(Icons.refresh), onPressed: _ctl.reload)]),
      body: Loader<Map<String, dynamic>>(
        key: ValueKey(_date), controller: _ctl,
        load: () async => Map<String, dynamic>.from(await api.get('/doctor/queue', query: {'date': _date}) as Map),
        builder: (context, data, reload) {
          final q = (data['queue'] as List).cast<Map<String, dynamic>>();
          return ListPage(maxWidth: 760, children: [
            Row(children: [
              Expanded(child: Text('قائمة ${dmy(_date)} (${weekdayName(_date)})', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16))),
              Pill('${data['waiting']} بالانتظار'),
              IconButton(onPressed: () => setState(() => _date = addDaysIso(_date, -1)), icon: const Icon(Icons.chevron_right)),
              IconButton(onPressed: () => setState(() => _date = todayIso()), icon: const Icon(Icons.today)),
              IconButton(onPressed: () => setState(() => _date = addDaysIso(_date, 1)), icon: const Icon(Icons.chevron_left)),
            ]),
            if (q.isEmpty) const Empty('ما أكو زبائن دفعوا الكشفية بهذا اليوم'),
            for (final c in q) _QueueCard(c: c, onOpen: () async { await Navigator.of(context).push(MaterialPageRoute(builder: (_) => ConsultationPage(consultationId: c['consultation_id'] as int, customerId: (c['customer'] as Map)['id'] as int))); await reload(); }),
          ]);
        },
      ),
    );
  }
}

class _QueueCard extends StatelessWidget {
  const _QueueCard({required this.c, required this.onOpen});
  final Map<String, dynamic> c;
  final VoidCallback onOpen;
  @override
  Widget build(BuildContext context) {
    final cu = c['customer'] as Map;
    final status = c['status'] as String;
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(12), onTap: onOpen,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(children: [
            Container(width: 44, height: 44, alignment: Alignment.center, decoration: BoxDecoration(color: status == 'paid' ? Palette.text : Palette.muted, borderRadius: BorderRadius.circular(8)), child: Text('${c['seq_no']}', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 18))),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(cu['full_name'] as String, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
              Text('${ltr(cu['public_code'] as String)}${c['kind'] == 'free_followup' ? ' · مراجعة مجانية' : c['kind'] == 'sessions_only' ? ' · جلسات فقط' : ''}${c['interest_name'] == null ? '' : ' · يريد ${c['interest_name']}'}', style: const TextStyle(color: Palette.muted)),
              if ((c['booking_note'] as String?) != null) Text('ملاحظة: ${c['booking_note']}', maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
            ])),
            if (c['has_health_alert'] == true) Padding(padding: const EdgeInsets.only(left: 8), child: Pill.danger('تنبيه صحي')),
            switch (status) { 'paid' => Pill.warn('بانتظارك'), 'with_doctor' => Pill.ok('مفتوح'), _ => const Pill('انتهت') },
          ]),
        ),
      ),
    );
  }
}
