import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/theme.dart';
import '../../core/widgets.dart';
import '../photos.dart';
import '../home_shell.dart';

/// واجهة الممرض (screens/Nurse.dc.html): جلسات اليوم المدفوعة مع التنبيه الصحي، و«اكتملت الجلسة» (تخصم المواد تلقائياً).
class NurseHome extends StatefulWidget {
  const NurseHome({super.key});
  @override
  State<NurseHome> createState() => _NurseHomeState();
}

class _NurseHomeState extends State<NurseHome> {
  final _ctl = LoaderController();

  @override
  Widget build(BuildContext context) {
    final api = context.read<Api>();
    return Scaffold(
      appBar: staffBar(context, 'الممرض', actions: [IconButton(tooltip: 'تحديث', icon: const Icon(Icons.refresh), onPressed: _ctl.reload)]),
      body: Loader<Map<String, dynamic>>(
        controller: _ctl,
        load: () async => Map<String, dynamic>.from(await api.get('/nurse/queue') as Map),
        builder: (context, data, reload) {
          final list = (data['sessions'] as List).cast<Map<String, dynamic>>();
          return RefreshIndicator(
            onRefresh: reload,
            child: ListPage(maxWidth: 760, children: [
              Row(children: [const Icon(Icons.today, size: 20, color: Palette.muted), const SizedBox(width: 6), Text('جلسات اليوم ${dmy(data['date'] as String)}', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)), const Spacer(), Pill('${list.length} بالانتظار')]),
              if (list.isEmpty) const Empty('ما أكو جلسات مدفوعة بالانتظار'),
              for (final s in list) _SessionCard(s: s, api: api, onDone: reload),
            ]),
          );
        },
      ),
    );
  }
}

class _SessionCard extends StatelessWidget {
  const _SessionCard({required this.s, required this.api, required this.onDone});
  final Map<String, dynamic> s;
  final Api api;
  final Future<void> Function() onDone;

  @override
  Widget build(BuildContext context) {
    final c = s['customer'] as Map;
    final alert = s['has_health_alert'] == true;
    final h = s['health'] as Map?;
    final mats = (s['planned_materials'] as List).cast<Map<String, dynamic>>();
    return Card(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: BorderSide(color: alert ? Palette.danger : Palette.border, width: alert ? 1.6 : 1)),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            Container(width: 44, height: 44, alignment: Alignment.center, decoration: BoxDecoration(color: Palette.text, borderRadius: BorderRadius.circular(8)), child: Text('${s['visit_seq_no']}', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 18))),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(c['full_name'] as String, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 17)),
              Text('${s['service_name']} · جلسة ${s['seq_no']} من ${s['of']}', style: const TextStyle(color: Palette.muted)),
            ])),
            Text(ltr(c['public_code'] as String), style: const TextStyle(color: Palette.muted)),
          ]),
          if (alert && h != null) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: Palette.dangerSoft, borderRadius: BorderRadius.circular(8)),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Row(children: [Icon(Icons.health_and_safety, color: Palette.danger), SizedBox(width: 8), Text('تنبيه صحي: راجع قبل التنفيذ', style: TextStyle(color: Palette.danger, fontWeight: FontWeight.w700))]),
                const SizedBox(height: 6),
                if (h['pregnancy'] == 'yes') const Text('• حامل', style: TextStyle(fontWeight: FontWeight.w600)),
                if ((h['allergies'] as String?)?.trim().isNotEmpty == true) Text('• حساسية: ${h['allergies']}'),
                if ((h['chronic_conditions'] as String?)?.trim().isNotEmpty == true) Text('• أمراض مزمنة: ${h['chronic_conditions']}'),
                if ((h['medications'] as String?)?.trim().isNotEmpty == true) Text('• أدوية: ${h['medications']}'),
                if ((h['notes'] as String?)?.trim().isNotEmpty == true) Text('• ملاحظات: ${h['notes']}'),
              ]),
            ),
          ] else if (h == null) const Padding(padding: EdgeInsets.only(top: 8), child: Text('ما أكو معلومات صحية مسجلة', style: TextStyle(color: Palette.muted, fontSize: 13))),
          if (mats.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 10), child: Text('المواد المخططة: ${mats.map((m) => '${m['name']} ${m['qty']} ${m['unit']}').join('، ')}', style: const TextStyle(color: Palette.muted, fontSize: 13))),
          const SizedBox(height: 10),
          PhotoButtons(sessionId: s['session_id'] as int),
          const SizedBox(height: 12),
          AsyncButton(
            icon: Icons.check_circle_outline,
            onPressed: () async {
              if (!await confirm(context, 'تأكيد اكتمال الجلسة؟', body: alert ? 'الزبون عنده تنبيه صحي. تأكد إنك راجعته. تنخصم المواد من المخزون تلقائياً.' : 'تنخصم المواد من المخزون تلقائياً.', yes: 'اكتملت')) return;
              final r = Map<String, dynamic>.from(await api.post('/sessions/${s['session_id']}/complete') as Map);
              if (context.mounted) {
                final short = (r['shortages'] as List).isNotEmpty;
                toast(context, short ? 'اكتملت الجلسة. ملاحظة: المخزون ما كفى (المدير يصلحه)' : 'اكتملت الجلسة');
              }
              await onDone();
            },
            child: const Text('اكتملت الجلسة'),
          ),
        ]),
      ),
    );
  }
}
