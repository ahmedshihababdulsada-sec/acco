import 'package:material_ui/material_ui.dart';

import '../../core/format.dart';
import '../../core/theme.dart';
import '../../core/widgets.dart';
import 'cashier_state.dart';

/// تسليم الشفت: الكاشير يكتب اللي عدّه (الكاش) ومبلغ كشف كل جهاز. المتوقع ما يظهر له (المدير يطابق).
class CloseShiftPage extends StatefulWidget {
  const CloseShiftPage({super.key, required this.state});
  final CashierState state;
  @override
  State<CloseShiftPage> createState() => _CloseShiftPageState();
}

class _CloseShiftPageState extends State<CloseShiftPage> {
  final Map<int, TextEditingController> _c = {};
  Map<String, dynamic>? _done;

  @override
  Widget build(BuildContext context) {
    final shift = widget.state.shift!;
    final methods = (shift['methods_to_count'] as List).cast<Map<String, dynamic>>();
    for (final m in methods) { _c.putIfAbsent(m['method_id'] as int, () => TextEditingController()); }
    return Scaffold(
      appBar: AppBar(title: const Text('تسليم الشفت')),
      body: ListPage(maxWidth: 640, children: [
        if (_done != null) ...[
          const Notice('انغلق الشفت. سلّم الفلوس للمدير حتى يعدها ويأكد المبلغ.'),
          Section(title: 'ملخص ما عددته', child: Column(children: [for (final r in (_done!['counts'] as List).cast<Map<String, dynamic>>()) KV('${r['method_name']}${r['device_label'] == null ? '' : ' · ${r['device_label']}'}', money(r['counted'] as num), bold: true)])),
          FilledButton(onPressed: () => Navigator.pop(context), child: const Text('رجوع')),
        ] else ...[
          const Notice('اكتب الكاش اللي عديته (مع الفكة)، ومبلغ كشف كل جهاز إلكتروني. بعد التسليم ما تقدر تدفع بهذا الشفت.', kind: NoticeKind.warn),
          Section(
            title: 'العدّ',
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              KV('الفكة اللي استلمتها', money(shift['opening_float'] as num)),
              const SizedBox(height: 8),
              for (final m in methods) Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: TextField(
                  controller: _c[m['method_id']], keyboardType: TextInputType.number, textDirection: TextDirection.ltr,
                  decoration: deco('${m['method_name']}${m['device_label'] == null ? '' : ' · ${m['device_label']}'}', suffix: 'د.ع', hint: m['method_kind'] == 'cash' ? 'الكاش المعدود' : 'مبلغ كشف الجهاز'),
                ),
              ),
            ]),
          ),
          AsyncButton(
            onPressed: () async {
              final counts = <Map<String, int>>[];
              for (final m in methods) {
                final t = _c[m['method_id']]!.text.replaceAll(',', '').trim();
                final v = int.tryParse(t);
                if (v == null || v < 0) { toast(context, 'اكتب مبلغ لكل طريقة (صفر إذا ما أكو)', error: true); return; }
                counts.add({'method_id': m['method_id'] as int, 'counted': v});
              }
              if (!await confirm(context, 'تسكير الشفت وتسليمه؟', body: 'ما تقدر ترجعه بعد التسكير.', yes: 'تسكير')) return;
              final r = Map<String, dynamic>.from(await widget.state.api.post('/shifts/current/close', body: {'counts': counts}) as Map);
              if (mounted) setState(() => _done = r);
            },
            icon: Icons.lock,
            child: const Text('تسكير الشفت وتسليمه'),
          ),
          const Text('', style: TextStyle(color: Palette.muted)),
        ],
      ]),
    );
  }
}
