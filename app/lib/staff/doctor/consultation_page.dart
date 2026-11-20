import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/theme.dart';
import '../../core/widgets.dart';
import '../photos.dart';
import 'plan_builder.dart';

/// ملف الزبون عند الطبيب: المعلومات الصحية، الخطة العلاجية، السجل، وإنهاء الكشفية.
class ConsultationPage extends StatefulWidget {
  const ConsultationPage({super.key, required this.consultationId, required this.customerId});
  final int consultationId;
  final int customerId;
  @override
  State<ConsultationPage> createState() => _ConsultationPageState();
}

class _Bundle {
  _Bundle(this.file, this.plan, this.status, this.booking);
  final Map<String, dynamic> booking;     // طلب الزبون وقت الحجز (ملاحظة + خدمة) لهذي الكشفية
  final Map<String, dynamic> file;
  final Map<String, dynamic>? plan;
  final String status;
}

class _ConsultationPageState extends State<ConsultationPage> {
  final _ctl = LoaderController();
  final _photosCtl = LoaderController();

  Future<_Bundle> _load(Api api) async {
    final file = Map<String, dynamic>.from(await api.get('/customers/${widget.customerId}/file') as Map);
    final cons = (file['consultations'] as List).cast<Map<String, dynamic>>().firstWhere((c) => c['id'] == widget.consultationId);
    Map<String, dynamic>? plan;
    try { plan = Map<String, dynamic>.from(await api.get('/consultations/${widget.consultationId}/plan') as Map); } on ApiException catch (e) { if (e.status != 404) rethrow; }
    return _Bundle(file, plan, cons['status'] as String, cons);
  }

  @override
  Widget build(BuildContext context) {
    final api = context.read<Api>();
    return Scaffold(
      appBar: AppBar(title: const Text('ملف الزبون')),
      body: Loader<_Bundle>(
        controller: _ctl, load: () => _load(api),
        builder: (context, b, reload) {
          final cu = b.file['customer'] as Map;
          return ListPage(maxWidth: 880, children: [
            Section(child: Row(children: [
              const CircleAvatar(radius: 26, backgroundColor: Palette.primarySoft, child: Icon(Icons.person, color: Palette.primary, size: 30)),
              const SizedBox(width: 14),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(cu['full_name'] as String, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                Text('${ltr(cu['public_code'] as String)} · ${cu['gender'] == 'female' ? 'أنثى' : cu['gender'] == 'male' ? 'ذكر' : ''}${cu['birth_date'] == null ? '' : ' · ${dmy(cu['birth_date'] as String)}'}', style: const TextStyle(color: Palette.muted)),
              ])),
              switch (b.status) { 'paid' => Pill.warn('بانتظارك'), 'with_doctor' => Pill.ok('مفتوح'), 'finished' => const Pill('انتهت'), _ => Pill(b.status) },
            ])),
            if ((b.booking['booking_note'] as String?) != null || b.booking['interest_name'] != null) Section(title: 'طلب الزبون وقت الحجز', child: Column(crossAxisAlignment: CrossAxisAlignment.start, key: const ValueKey('booking-wish'), children: [
              if (b.booking['interest_name'] != null) KV('الخدمة اللي يريدها', b.booking['interest_name'] as String),
              if ((b.booking['booking_note'] as String?) != null) KV('ملاحظة الزبون', b.booking['booking_note'] as String),
            ])),
            if (b.status == 'paid') Section(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              const Notice('بعد فتح الملف ما يصير استرجاع للكشفية. افتحه لما الزبون يدخل عندك.', kind: NoticeKind.warn),
              const SizedBox(height: 12),
              AsyncButton(icon: Icons.folder_open, onPressed: () async { await api.post('/consultations/${widget.consultationId}/enter'); await reload(); }, child: const Text('فتح ملف الزبون')),
            ])) else ...[
              _HealthSection(file: b.file, consultationId: widget.consultationId, editable: b.status == 'with_doctor', onSaved: reload),
              _PlanSection(bundle: b, consultationId: widget.consultationId, customerId: widget.customerId, onChanged: reload),
              Section(title: 'صور قبل وبعد', child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                if (b.status == 'with_doctor') Padding(padding: const EdgeInsets.only(bottom: 12), child: PhotoButtons(consultationId: widget.consultationId, onUploaded: _photosCtl.reload)),
                PhotoGallery(controller: _photosCtl, customerId: widget.customerId),
              ])),
              if (b.status == 'with_doctor') Section(child: AsyncButton(icon: Icons.task_alt, onPressed: () async {
                if (b.plan == null && !await confirm(context, 'تنهي الكشفية بدون خطة علاجية؟', yes: 'إنهاء')) return;
                final r = Map<String, dynamic>.from(await api.post('/consultations/${widget.consultationId}/finish') as Map);
                if (context.mounted) { final e = r['doctor_earning'] as Map?; toast(context, e == null ? 'انتهت الكشفية' : 'انتهت الكشفية. نسبتك: ${money(e['amount'] as num)}'); }
                await reload();
              }, child: const Text('إنهاء الكشفية'))),
            ],
            _HistorySection(file: b.file, currentConsultation: widget.consultationId),
          ]);
        },
      ),
    );
  }
}

/// المعلومات الصحية (آخر سجل هو الحالي، وكل حفظ يضيف سجل جديد بدون ما يتعدل القديم)
class _HealthSection extends StatefulWidget {
  const _HealthSection({required this.file, required this.consultationId, required this.editable, required this.onSaved});
  final Map<String, dynamic> file;
  final int consultationId;
  final bool editable;
  final Future<void> Function() onSaved;
  @override
  State<_HealthSection> createState() => _HealthSectionState();
}

class _HealthSectionState extends State<_HealthSection> {
  late final Map<String, TextEditingController> _c;
  late String _pregnancy;
  bool _edit = false;

  @override
  void initState() {
    super.initState();
    final h = (widget.file['health'] as Map)['current'] as Map?;
    _c = {for (final k in ['allergies', 'chronic_conditions', 'medications', 'notes']) k: TextEditingController(text: (h?[k] as String?) ?? '')};
    _pregnancy = (h?['pregnancy'] as String?) ?? 'unknown';
    _edit = widget.editable && h == null;
  }

  @override
  Widget build(BuildContext context) {
    final h = (widget.file['health'] as Map)['current'] as Map?;
    final alert = h != null && (h['pregnancy'] == 'yes' || [h['allergies'], h['chronic_conditions'], h['medications']].any((x) => (x as String?)?.trim().isNotEmpty == true));
    return Section(
      title: 'المعلومات الصحية',
      trailing: widget.editable && !_edit ? TextButton(onPressed: () => setState(() => _edit = true), child: const Text('تحديث')) : null,
      child: _edit
          ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              TextField(controller: _c['allergies'], decoration: deco('الحساسية')),
              const SizedBox(height: 10),
              DropdownButtonFormField<String>(initialValue: _pregnancy, decoration: deco('الحمل'), items: const [DropdownMenuItem(value: 'unknown', child: Text('غير معروف')), DropdownMenuItem(value: 'no', child: Text('لا')), DropdownMenuItem(value: 'yes', child: Text('نعم'))], onChanged: (v) => setState(() => _pregnancy = v!)),
              const SizedBox(height: 10),
              TextField(controller: _c['chronic_conditions'], decoration: deco('الأمراض المزمنة')),
              const SizedBox(height: 10),
              TextField(controller: _c['medications'], decoration: deco('الأدوية')),
              const SizedBox(height: 10),
              TextField(controller: _c['notes'], decoration: deco('ملاحظات'), maxLines: 2),
              const SizedBox(height: 12),
              AsyncButton(onPressed: () async {
                await context.read<Api>().post('/consultations/${widget.consultationId}/health', body: {
                  for (final e in _c.entries) if (e.value.text.trim().isNotEmpty) e.key: e.value.text.trim(), 'pregnancy': _pregnancy,
                });
                if (context.mounted) toast(context, 'انحفظت المعلومات الصحية');
                setState(() => _edit = false);
                await widget.onSaved();
              }, child: const Text('حفظ')),
            ])
          : h == null
              ? const Text('ما أكو معلومات صحية مسجلة', style: TextStyle(color: Palette.muted))
              : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  if (alert) const Padding(padding: EdgeInsets.only(bottom: 8), child: Notice('تنبيه: راجع المعلومات قبل الخطة', kind: NoticeKind.danger)),
                  KV('الحساسية', (h['allergies'] as String?) ?? '—'),
                  KV('الحمل', switch (h['pregnancy']) { 'yes' => 'نعم', 'no' => 'لا', _ => 'غير معروف' }),
                  KV('الأمراض المزمنة', (h['chronic_conditions'] as String?) ?? '—'),
                  KV('الأدوية', (h['medications'] as String?) ?? '—'),
                  if (h['notes'] != null) KV('ملاحظات', h['notes'] as String),
                ]),
    );
  }
}

/// الخطة العلاجية: إنشاء (إذا ما أكو)، أو عرض الموجودة مع إضافة بند/إيقاف بند/إيقاف الخطة.
class _PlanSection extends StatelessWidget {
  const _PlanSection({required this.bundle, required this.consultationId, required this.customerId, required this.onChanged});
  final _Bundle bundle;
  final int consultationId;
  final int customerId;
  final Future<void> Function() onChanged;
  @override
  Widget build(BuildContext context) {
    final api = context.read<Api>();
    final plan = bundle.plan;
    final editable = bundle.status == 'with_doctor';
    if (plan == null || plan['status'] == 'draft') {
      if (!editable) return const Section(title: 'الخطة العلاجية', child: Text('ما كُتبت خطة لهذي الكشفية', style: TextStyle(color: Palette.muted)));
      return PlanBuilder(consultationId: consultationId, draftReason: plan?['draft_failure_reason'] as String?, onSaved: onChanged);
    }
    final items = (plan['items'] as List).cast<Map<String, dynamic>>();
    final active = plan['status'] == 'active';
    return Section(
      title: 'الخطة العلاجية',
      trailing: Pill(switch (plan['status']) { 'active' => 'فعالة', 'stopped' => 'موقوفة', _ => '${plan['status']}' }),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (plan['treatments_text'] != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(plan['treatments_text'] as String)),
        for (final i in items) Container(
          margin: const EdgeInsets.only(bottom: 10), padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(border: Border.all(color: Palette.border), borderRadius: BorderRadius.circular(8)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(children: [
              Expanded(child: Text('${(i['service'] as Map)['name']} · ${i['sessions_count']} جلسات كل ${i['interval_days']} يوم', style: const TextStyle(fontWeight: FontWeight.w700))),
              if (i['estimate']['per_session'] != null) Text('${money(i['estimate']['per_session'] as num)} للجلسة', style: const TextStyle(color: Palette.muted)),
              if (active && editable) IconButton(tooltip: 'إيقاف البند', icon: const Icon(Icons.block, size: 20, color: Palette.danger), onPressed: () async {
                final why = await askText(context, 'إيقاف هذا البند؟', label: 'السبب'); if (why == null) return;
                try { await api.post('/plans/items/${i['id']}/stop', body: {'reason': why}); await onChanged(); } catch (e) { if (context.mounted) showError(context, e); }
              }),
            ]),
            Wrap(spacing: 6, runSpacing: 6, children: [for (final s in (i['sessions'] as List).cast<Map<String, dynamic>>()) Pill('${s['seq_no']}: ${s['scheduled_date'] == null ? 'تنتظر حجز' : dmy(s['scheduled_date'] as String)}${s['status'] == 'completed' ? ' ✓' : s['status'] == 'cancelled' ? ' ✗' : ''}', color: s['status'] == 'cancelled' ? Palette.danger : Palette.primaryDark, bg: s['status'] == 'cancelled' ? Palette.dangerSoft : s['status'] == 'completed' ? Palette.okSoft : Palette.primarySoft)]),
          ]),
        ),
        if (plan['estimated_total'] != null) KV('التقدير الكلي (بسعر اليوم)', money(plan['estimated_total'] as num), bold: true),
        if (active && editable) Padding(padding: const EdgeInsets.only(top: 8), child: Wrap(spacing: 8, runSpacing: 8, children: [
          OutlinedButton.icon(onPressed: () async { if (await addPlanItemDialog(context, planId: plan['id'] as int)) await onChanged(); }, icon: const Icon(Icons.add), label: const Text('إضافة بند')),
          OutlinedButton.icon(style: OutlinedButton.styleFrom(foregroundColor: Palette.danger), onPressed: () async {
            final why = await askText(context, 'إيقاف الخطة كلها؟', label: 'السبب'); if (why == null) return;
            try { await api.post('/plans/${plan['id']}/stop', body: {'reason': why}); await onChanged(); } catch (e) { if (context.mounted) showError(context, e); }
          }, icon: const Icon(Icons.stop_circle_outlined), label: const Text('إيقاف الخطة')),
        ])),
      ]),
    );
  }
}

class _HistorySection extends StatelessWidget {
  const _HistorySection({required this.file, required this.currentConsultation});
  final Map<String, dynamic> file;
  final int currentConsultation;
  @override
  Widget build(BuildContext context) {
    final cons = (file['consultations'] as List).cast<Map<String, dynamic>>().where((c) => c['id'] != currentConsultation).toList();
    final plans = (file['plans'] as List).cast<Map<String, dynamic>>().where((p) => p['consultation_id'] != currentConsultation).toList();
    if (cons.isEmpty && plans.isEmpty) return const SizedBox.shrink();
    return Section(title: 'السجل السابق', child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      for (final c in cons) ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text('كشفية ${dmy(c['date'] as String)} · ${(c['doctor'] as Map)['full_name']}'), trailing: Text(c['kind'] == 'free_followup' ? 'مراجعة' : c['kind'] == 'sessions_only' ? 'جلسات فقط' : '')),
      for (final p in plans) ExpansionTile(tilePadding: EdgeInsets.zero, title: Text('خطة #${p['id']} · ${p['status']}'), children: [for (final s in (p['sessions'] as List).cast<Map<String, dynamic>>()) ListTile(dense: true, title: Text('${s['service_name']} · جلسة ${s['seq_no']}'), trailing: Text('${s['status']}${s['scheduled_date'] == null ? '' : ' · ${dmy(s['scheduled_date'] as String)}'}'))]),
    ]));
  }
}
