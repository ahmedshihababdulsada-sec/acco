import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/theme.dart';
import '../core/widgets.dart';
import 'customer_session.dart';
import 'privacy_page.dart';

Api _api(BuildContext c) => c.read<Api>();
num _n(dynamic v) => (v as num?) ?? 0;

const _bookingStatus = {'booked': 'محجوز', 'arrived': 'حضرت', 'missed': 'ما حضرت', 'cancelled': 'ملغى'};
const _sessionStatus = {'awaiting_booking': 'بانتظار الحجز', 'booked': 'محجوزة', 'paid': 'مدفوعة', 'completed': 'منفذة', 'cancelled': 'ملغاة'};
const _pointType = {'earn': 'كسب', 'redeem': 'استخدام', 'redeem_return': 'إرجاع نقاط', 'earn_clawback': 'استرداد نقاط', 'merge_out': 'نقل ملف', 'merge_in': 'دمج ملف'};

/// الإطار الرئيسي لتطبيق الزبون: شريط سفلي بخمس صفحات.
class CustomerHome extends StatefulWidget {
  const CustomerHome({super.key});
  @override
  State<CustomerHome> createState() => _CustomerHomeState();
}

class _CustomerHomeState extends State<CustomerHome> {
  int _i = 0; int _tick = 0;
  static const _titles = ['الرئيسية', 'مواعيدي', 'جلساتي', 'مدفوعاتي', 'حسابي'];

  @override
  Widget build(BuildContext context) {
    final pages = [HomeTab(onGo: (i) => setState(() => _i = i)), const BookingsTab(), const SessionsTab(), const PaymentsTab(), const AccountTab()];
    return Scaffold(
      appBar: AppBar(title: Text(_titles[_i]), actions: [
        IconButton(tooltip: 'الإشعارات', icon: const Icon(Icons.notifications_none), onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const NotificationsPage()))),
        IconButton(tooltip: 'تحديث', icon: const Icon(Icons.refresh), onPressed: () => setState(() => _tick++)),
      ]),
      body: KeyedSubtree(key: ValueKey('$_i-$_tick'), child: pages[_i]),
      bottomNavigationBar: NavigationBar(selectedIndex: _i, onDestinationSelected: (i) => setState(() => _i = i), destinations: const [
        NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home), label: 'الرئيسية'),
        NavigationDestination(icon: Icon(Icons.event_outlined), selectedIcon: Icon(Icons.event), label: 'مواعيدي'),
        NavigationDestination(icon: Icon(Icons.spa_outlined), selectedIcon: Icon(Icons.spa), label: 'جلساتي'),
        NavigationDestination(icon: Icon(Icons.receipt_long_outlined), selectedIcon: Icon(Icons.receipt_long), label: 'مدفوعاتي'),
        NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: 'حسابي'),
      ]),
    );
  }
}

// ====================================================================== الرئيسية
class HomeTab extends StatelessWidget {
  const HomeTab({super.key, required this.onGo});
  final void Function(int) onGo;
  @override
  Widget build(BuildContext context) {
    final api = _api(context); final s = context.watch<CustomerSession>();
    return Loader<Map<String, dynamic>>(
      load: () async => {
        'bookings': ((await api.get('/customer/bookings'))['bookings'] as List).cast<Map<String, dynamic>>(),
        'offers': ((await api.get('/customer/offers'))['offers'] as List).cast<Map<String, dynamic>>(),
        'points': Map<String, dynamic>.from(await api.get('/customer/points') as Map),
        'unread': ((await api.get('/customer/notifications', query: {'unread': 1}))['notifications'] as List).length,
      },
      builder: (context, d, reload) {
        final upcoming = (d['bookings'] as List<Map<String, dynamic>>).where((b) => (b['status'] == 'booked' || b['status'] == 'arrived') && b['finished'] != true && (b['date'] as String).compareTo(todayIso()) >= 0).toList();
        final offers = d['offers'] as List<Map<String, dynamic>>;
        return ListPage(maxWidth: 560, children: [
          Text('أهلاً ${s.profile?['full_name'] ?? ''}', style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
          if ((d['unread'] as int) > 0) InkWell(onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const NotificationsPage())), child: Notice('عندك ${d['unread']} إشعار جديد')),
          Container(
            padding: const EdgeInsets.all(18), decoration: BoxDecoration(gradient: const LinearGradient(colors: [Palette.primary, Palette.primaryDark]), borderRadius: BorderRadius.circular(16)),
            child: Row(children: [
              const Icon(Icons.stars_rounded, color: Colors.white, size: 36), const SizedBox(width: 12),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [const Text('رصيد نقاطك', style: TextStyle(color: Colors.white70)), Text('${(d['points'] as Map)['balance']} نقطة', style: const TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.w700))])),
              TextButton(onPressed: () => onGo(3), style: TextButton.styleFrom(foregroundColor: Colors.white), child: const Text('السجل')),
            ]),
          ),
          Section(title: 'موعدك القادم', child: upcoming.isEmpty
              ? Column(children: [const Text('ما عندك موعد قادم', style: TextStyle(color: Palette.muted)), const SizedBox(height: 10), FilledButton.icon(icon: const Icon(Icons.add), label: const Text('احجز موعد'), onPressed: () async { if (await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => const NewBookingPage())) == true) await reload(); })])
              : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  Text('${weekdayName(upcoming.first['date'] as String)} ${dmy(upcoming.first['date'] as String)}', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                  Text(_bookingKind(upcoming.first) + (upcoming.first['doctor_name'] == null ? '' : ' · ${upcoming.first['doctor_name']}'), style: const TextStyle(color: Palette.muted)),
                  _TurnLine(b: upcoming.first),
                  TextButton(onPressed: () => onGo(1), child: const Text('كل مواعيدي')),
                ])),
          if (offers.isNotEmpty) Section(title: 'عروض لك', child: Column(children: [for (final o in offers) ListTile(contentPadding: EdgeInsets.zero, leading: const Icon(Icons.local_offer_outlined, color: Palette.primary), title: Text('${o['title']}'), subtitle: Text('${o['service_name'] ?? 'كل الخدمات'} · لين ${dmy(o['ends_on'] as String?)}'), trailing: Pill.ok('${o['percent']}%'))])),
        ]);
      },
    );
  }
}

/// «رقمك واحنا بأي دور»: يطلع للحجز اللي باليوم بس (حاضرين قدامك = دفعوا وما انخدموا بعد)
class _TurnLine extends StatelessWidget {
  const _TurnLine({required this.b});
  final Map<String, dynamic> b;
  @override
  Widget build(BuildContext context) {
    final t = b['turn'] as Map?;
    if (t == null) return const SizedBox.shrink();
    final ahead = (t['ahead'] as num).toInt();
    return Padding(padding: const EdgeInsets.only(top: 6), child: Row(children: [
      Pill.ok('رقمك ${t['seq_no']}'), const SizedBox(width: 8),
      Text(ahead == 0 ? 'ما أكو أحد حاضر قدامك' : 'حاضرين قدامك: $ahead', key: const ValueKey('turn-ahead'), style: const TextStyle(color: Palette.muted)),
    ]));
  }
}

String _bookingKind(Map<String, dynamic> b) {
  final sessions = (b['sessions_count'] as int?) ?? 0;
  return switch (b['kind']) {
    'followup' => 'مراجعة مجانية${sessions > 0 ? ' + $sessions جلسة' : ''}',
    'sessions_only' => 'جلسات فقط${sessions > 0 ? ' ($sessions جلسة)' : ''}',
    'consultation' => 'كشفية${sessions > 0 ? ' + $sessions جلسة' : ''}',
    _ => '$sessions جلسة',
  };
}

// ====================================================================== المواعيد
class BookingsTab extends StatelessWidget {
  const BookingsTab({super.key});
  @override
  Widget build(BuildContext context) {
    final api = _api(context);
    return Loader<List<Map<String, dynamic>>>(
      load: () async => ((await api.get('/customer/bookings'))['bookings'] as List).cast<Map<String, dynamic>>(),
      builder: (context, list, reload) => ListPage(maxWidth: 560, children: [
        FilledButton.icon(icon: const Icon(Icons.add), label: const Text('حجز موعد جديد'), onPressed: () async { if (await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => const NewBookingPage())) == true) await reload(); }),
        if (list.isEmpty) const Empty('ما عندك مواعيد بعد'),
        for (final b in list) Card(child: Padding(padding: const EdgeInsets.all(14), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [Expanded(child: Text('${weekdayName(b['date'] as String)} ${dmy(b['date'] as String)}', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16))), b['finished'] == true ? const Pill('انتهت') : _statusPill(b['status'] as String)]),
          Text('${_bookingKind(b)}${b['doctor_name'] == null ? '' : ' · ${b['doctor_name']}'}', style: const TextStyle(color: Palette.muted)),
          _TurnLine(b: b),
          if (b['changeable'] == true || b['cancellable'] == true) Padding(padding: const EdgeInsets.only(top: 8), child: Wrap(spacing: 8, children: [
            if (b['changeable'] == true) OutlinedButton(onPressed: () async { if (await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => NewBookingPage(moveBookingId: b['id'] as int, doctorHint: null))) == true) await reload(); }, child: const Text('تغيير الموعد')),
            if (b['cancellable'] == true) TextButton(onPressed: () async {
              final withSessions = ((b['sessions_count'] as int?) ?? 0) > 0;
              if (!await confirm(context, withSessions ? 'إلغاء الكشفية؟' : 'إلغاء الحجز؟', body: withSessions ? 'تنلغي الكشفية بس. جلساتك بنفس اليوم تبقى بموعدها.' : null, danger: true, yes: withSessions ? 'إلغاء الكشفية' : 'إلغاء الحجز')) return;
              try { await api.post('/customer/bookings/${b['id']}/cancel'); if (context.mounted) toast(context, withSessions ? 'انلغت الكشفية وجلساتك باقية' : 'انلغى الحجز'); await reload(); } catch (e) { if (context.mounted) showError(context, e); }
            }, child: Text(((b['sessions_count'] as int?) ?? 0) > 0 ? 'إلغاء الكشفية' : 'إلغاء', style: const TextStyle(color: Palette.danger))),
          ])),
        ]))),
      ]),
    );
  }
}

Widget _statusPill(String s) => switch (s) { 'booked' => Pill(_bookingStatus[s]!), 'arrived' => Pill.ok(_bookingStatus[s]!), 'cancelled' || 'missed' => Pill.danger(_bookingStatus[s] ?? s), _ => Pill(s) };

/// حجز جديد، أو (مع moveBookingId) تغيير موعد حجز موجود.
class NewBookingPage extends StatefulWidget {
  const NewBookingPage({super.key, this.moveBookingId, this.doctorHint});
  final int? moveBookingId;
  final int? doctorHint;
  @override
  State<NewBookingPage> createState() => _NewBookingPageState();
}

class _NewBookingPageState extends State<NewBookingPage> {
  List<Map<String, dynamic>> _doctors = []; int? _doctor; List<Map<String, dynamic>> _days = []; bool _loading = true; String? _error;
  /// نوع الحجز يختاره الزبون: 'standard' كشفية (ثم جلسات) أو 'sessions_only' جلسات فقط (مثل الليزر: الطبيب ينظم الجلسات والكشفية مجانية أو بسعر العيادة)
  String _type = 'standard'; int _soFee = 0;
  /// الكشفية للزبون الجديد: الراجع افتراضيه «جلسات فقط» (يقدر يغيره). الخدمة والملاحظة اختيارية وتوصل للطبيب.
  bool _firstTime = true; List<Map<String, dynamic>> _services = []; int? _service; final _note = TextEditingController();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _init());
  }

  Future<void> _init() async {
    final api = _api(context);
    try {
      final dr = await api.get('/customer/doctors') as Map;
      _soFee = (dr['sessions_only_fee'] as num?)?.toInt() ?? 0;
      _firstTime = dr['is_first_time'] != false;
      _services = ((dr['services'] as List?) ?? const []).cast<Map<String, dynamic>>();
      if (!_firstTime && widget.moveBookingId == null) _type = 'sessions_only';
      _doctors = (dr['doctors'] as List).cast<Map<String, dynamic>>();
      _doctor = widget.doctorHint ?? (_doctors.isNotEmpty ? _doctors.first['id'] as int : null);
      await _loadDays();
    } catch (e) { _error = e is ApiException ? e.message : '$e'; }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _loadDays() async {
    final from = todayIso();
    final r = await _api(context).get('/customer/availability', query: {'from': from, 'to': addDaysIso(from, 30), if (_doctor != null) 'doctor_id': _doctor});
    _days = ((r as Map)['days'] as List).cast<Map<String, dynamic>>();
  }

  /// يوم فيه جلسات للزبون: الكشفية تنضاف لموعده (نفس الرقم)؛ غيره: عدد المواعيد المتاحة.
  String _hint(Map<String, dynamic> d) {
    final own = d['customer_visit'] as Map?;
    if (own != null) return 'عندك ${own['sessions_count']} جلسة بهذا اليوم: الكشفية تنضاف لموعدك بنفس رقمك';
    return 'متاح: ${d['remaining']} موعد';
  }

  String _why(Map<String, dynamic> d) {
    final own = d['customer_visit'] as Map?;
    if (own != null && own['has_consultation'] == true) return 'عندك كشفية محجوزة بهذا اليوم';
    if (d['holiday'] != null) return 'عطلة';
    if (d['stopped'] == true) return 'الحجز موقوف هذا اليوم';
    if (d['clinic_open'] == false) return 'العيادة مسكرة';
    if ((d['doctor'] as Map)['day_off'] != null) return 'الطبيب بإجازة';
    if ((d['doctor'] as Map)['works'] == false) return 'الطبيب ما يداوم';
    return 'ممتلئ';
  }

  Future<void> _pick(Map<String, dynamic> d) async {
    final api = _api(context); final date = d['date'] as String;
    final move = widget.moveBookingId != null;
    final joins = !move && d['customer_visit'] != null;
    if (!await confirm(context, move ? 'نقل الموعد لـ ${weekdayName(date)} ${dmy(date)}؟' : 'تأكيد الحجز ${weekdayName(date)} ${dmy(date)}؟',
        body: joins ? 'عندك جلسات بهذا اليوم: الكشفية تنضاف لنفس موعدك وبنفس رقمك، وما تاخذ دور جديد.' : null, yes: move ? 'نقل' : 'احجز')) return;
    try {
      if (move) { await api.post('/customer/bookings/${widget.moveBookingId}/move', body: {'date': date}); } else { await api.post('/customer/bookings', body: {'doctor_id': _doctor, 'date': date, 'type': _type, if (_service != null) 'service_id': _service, if (_note.text.trim().isNotEmpty) 'note': _note.text.trim()}); }
      if (mounted) { toast(context, move ? 'انتقل الموعد' : 'تم الحجز'); Navigator.pop(context, true); }
    } on ApiException catch (e) {
      final next = e.body?['next_available_date'] as String?;
      if (mounted) toast(context, next == null ? e.message : '${e.message}. أقرب يوم متاح: ${weekdayName(next)} ${dmy(next)}', error: true);
    } catch (e) { if (mounted) showError(context, e); }
  }

  Widget _typeChooser() {
    Widget opt(String v, String title, String sub, IconData icon) => Card(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: BorderSide(color: _type == v ? Palette.primary : Palette.border, width: _type == v ? 2 : 1)),
      color: _type == v ? Palette.primarySoft : null,
      child: ListTile(
        key: ValueKey('type-$v'),
        leading: Icon(icon, color: _type == v ? Palette.primary : Palette.muted),
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
        subtitle: Text(sub),
        trailing: Icon(_type == v ? Icons.radio_button_checked : Icons.radio_button_off, color: _type == v ? Palette.primary : Palette.muted),
        onTap: () => setState(() => _type = v),
      ),
    );
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const Text('شنو تريد؟', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
      opt('standard', 'كشفية (وبعدها جلسات)', 'الطبيب يكشف عليك ويحدد الجلسات المناسبة', Icons.medical_services_outlined),
      opt('sessions_only', 'جلسات فقط (مثل الليزر)', _soFee > 0 ? 'الطبيب ينظم لك الجلسات · الكشفية ${money(_soFee)}' : 'الطبيب ينظم لك الجلسات · الكشفية مجانية وتدفع الجلسات فقط', Icons.spa_outlined),
      if (!_firstTime) const Padding(padding: EdgeInsets.symmetric(vertical: 4), child: Text('عندك كشفية سابقة: الكشفية للزبون الجديد بس، فاخترنا لك «جلسات فقط». تقدر تغيرها.', key: ValueKey('returning-hint'), style: TextStyle(color: Palette.muted, fontSize: 13))),
      const SizedBox(height: 4),
      if (_services.isNotEmpty) DropdownButtonFormField<int?>(
        key: const ValueKey('interest-service'), initialValue: _service, decoration: deco('الخدمة اللي تريدها (اختياري)'),
        items: [const DropdownMenuItem<int?>(value: null, child: Text('ما أدري / أريد استشارة')), for (final s in _services) DropdownMenuItem<int?>(value: s['id'] as int, child: Text('${s['name']}'))],
        onChanged: (v) => setState(() => _service = v),
      ),
      const SizedBox(height: 10),
      TextField(key: const ValueKey('booking-note'), controller: _note, maxLength: 500, maxLines: 2, decoration: deco('ملاحظة للطبيب (اختياري)', hint: 'مثلاً: عندي حساسية، أو ليش اخترت هذي الخدمة')),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.moveBookingId != null ? 'تغيير الموعد' : 'حجز موعد')),
      body: _loading ? const Center(child: CircularProgressIndicator()) : _error != null ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!))) : ListPage(maxWidth: 560, children: [
        if (_doctors.length > 1) DropdownButtonFormField<int>(initialValue: _doctor, decoration: deco('الطبيب'), items: [for (final d in _doctors) DropdownMenuItem(value: d['id'] as int, child: Text('${d['full_name']}${d['title'] == null ? '' : ' · ${d['title']}'}'))], onChanged: (v) async { setState(() { _doctor = v; _loading = true; }); try { await _loadDays(); } catch (e) { if (mounted) showError(context, e); } if (mounted) setState(() => _loading = false); }),
        if (widget.moveBookingId == null) _typeChooser(),
        const Text('اختر اليوم المناسب', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
        for (final d in _days) Card(child: ListTile(
          enabled: d['bookable'] == true,
          title: Text('${weekdayName(d['date'] as String)} ${dmy(d['date'] as String)}'),
          subtitle: Text(d['bookable'] == true ? _hint(d) : _why(d)),
          trailing: d['bookable'] == true ? const Icon(Icons.chevron_left) : const Icon(Icons.block, size: 18),
          onTap: d['bookable'] == true ? () => _pick(d) : null,
        )),
      ]),
    );
  }
}

// ====================================================================== الجلسات
class SessionsTab extends StatelessWidget {
  const SessionsTab({super.key});
  @override
  Widget build(BuildContext context) {
    final api = _api(context);
    return Loader<List<Map<String, dynamic>>>(
      load: () async => ((await api.get('/customer/sessions'))['sessions'] as List).cast<Map<String, dynamic>>(),
      builder: (context, list, reload) => ListPage(maxWidth: 560, children: [
        if (list.isEmpty) const Empty('ما عندك جلسات علاجية بعد'),
        for (final s in list) Card(child: Padding(padding: const EdgeInsets.all(14), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [Expanded(child: Text('${s['service_name']} · جلسة ${s['seq_no']} من ${s['of']}', style: const TextStyle(fontWeight: FontWeight.w700))), s['status'] == 'completed' ? Pill.ok(_sessionStatus['completed']!) : s['status'] == 'cancelled' ? Pill.danger(_sessionStatus['cancelled']!) : Pill(_sessionStatus[s['status']] ?? '${s['status']}')]),
          if (s['scheduled_date'] != null) Text('الموعد: ${weekdayName(s['scheduled_date'] as String)} ${dmy(s['scheduled_date'] as String)}', style: const TextStyle(color: Palette.muted)),
          if (s['paid_amount'] != null) Text('المدفوع: ${money(_n(s['paid_amount']))}', style: const TextStyle(color: Palette.muted))
          else if (s['estimate_price'] != null) Text(s['offer_percent'] != null ? 'السعر: ${money(_n(s['estimate_after_offer']))} بدل ${money(_n(s['estimate_price']))} (عرض ${s['offer_percent']}%)' : 'السعر التقديري: ${money(_n(s['estimate_price']))}', style: const TextStyle(color: Palette.muted)),
          Wrap(spacing: 8, children: [
            if (s['movable'] == true) OutlinedButton(onPressed: () async { if (await _move(context, s)) await reload(); }, child: const Text('تأجيل الجلسة')),
            if (s['status'] == 'completed') OutlinedButton.icon(icon: const Icon(Icons.star_outline, size: 18), onPressed: () => _rate(context, s), label: const Text('قيّم الجلسة')),
          ]),
        ]))),
      ]),
    );
  }

  Future<bool> _move(BuildContext context, Map<String, dynamic> s) async {
    final api = _api(context);
    String date = addDaysIso(todayIso(), 1);
    final chosen = await showDialog<String>(context: context, builder: (d) => StatefulBuilder(builder: (d, setS) => AlertDialog(
      title: const Text('تأجيل الجلسة'),
      content: SizedBox(width: 340, child: Column(mainAxisSize: MainAxisSize.min, children: [
        DateField(label: 'التاريخ الجديد', value: date, first: DateTime.now(), last: DateTime.now().add(const Duration(days: 120)), onChanged: (v) => setS(() => date = v)),
        const SizedBox(height: 8), const Text('راح نريك كل المواعيد اللي تتغير قبل ما تأكد.', style: TextStyle(color: Palette.muted, fontSize: 12)),
      ])),
      actions: [TextButton(onPressed: () => Navigator.pop(d), child: const Text('رجوع')), FilledButton(onPressed: () => Navigator.pop(d, date), child: const Text('معاينة'))],
    )));
    if (chosen == null || !context.mounted) return false;
    try {
      final p = Map<String, dynamic>.from(await api.post('/customer/sessions/${s['id']}/move-preview', body: {'date': chosen}) as Map);
      final changes = (p['changes'] as List).cast<Map<String, dynamic>>();
      if (!context.mounted) return false;
      final ok = await showDialog<bool>(context: context, builder: (d) => AlertDialog(
        title: const Text('هذي المواعيد راح تتغير'),
        content: SizedBox(width: 360, child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          for (final c in changes) ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text('الجلسة ${c['seq_no']}'), subtitle: Text('${c['from'] == null ? '' : dmy(c['from'] as String)}  ←  ${dmy(c['to'] as String)}')),
          if (changes.length > 1) const Padding(padding: EdgeInsets.only(top: 8), child: Notice('تأجيل جلسة يأجّل اللي بعدها للحفاظ على الفاصل بين الجلسات.')),
        ])),
        actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('تأكيد التأجيل'))],
      ));
      if (ok != true) return false;
      await api.post('/customer/sessions/${s['id']}/move', body: {'date': chosen});
      if (context.mounted) toast(context, 'انأجلت الجلسة');
      return true;
    } catch (e) { if (context.mounted) showError(context, e); return false; }
  }

  Future<void> _rate(BuildContext context, Map<String, dynamic> s) async {
    final api = _api(context); int stars = 5; final comment = TextEditingController();
    final ok = await showDialog<bool>(context: context, builder: (d) => StatefulBuilder(builder: (d, setS) => AlertDialog(
      title: const Text('كيف كانت الجلسة؟'),
      content: SizedBox(width: 340, child: Column(mainAxisSize: MainAxisSize.min, children: [
        Row(mainAxisAlignment: MainAxisAlignment.center, children: [for (var i = 1; i <= 5; i++) IconButton(onPressed: () => setS(() => stars = i), icon: Icon(i <= stars ? Icons.star : Icons.star_border, color: Palette.warn, size: 34))]),
        TextField(controller: comment, maxLines: 3, decoration: deco('ملاحظة (اختياري)')),
      ])),
      actions: [TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('رجوع')), FilledButton(onPressed: () async {
        try { await api.post('/customer/sessions/${s['id']}/rating', body: {'stars': stars, if (comment.text.trim().isNotEmpty) 'comment': comment.text.trim()}); if (d.mounted) Navigator.pop(d, true); } catch (e) { if (d.mounted) showError(d, e); }
      }, child: const Text('إرسال'))],
    )));
    if (ok == true && context.mounted) toast(context, 'شكراً لتقييمك');
  }
}

// ====================================================================== المدفوعات والنقاط
class PaymentsTab extends StatelessWidget {
  const PaymentsTab({super.key});
  @override
  Widget build(BuildContext context) => DefaultTabController(length: 2, child: Column(children: const [
        Material(color: Palette.surface, child: TabBar(tabs: [Tab(text: 'الوصلات'), Tab(text: 'النقاط')])),
        Expanded(child: TabBarView(children: [_ReceiptsList(), _PointsList()])),
      ]));
}

class _ReceiptsList extends StatelessWidget {
  const _ReceiptsList();
  @override
  Widget build(BuildContext context) {
    final api = _api(context);
    return Loader<List<Map<String, dynamic>>>(
      load: () async => ((await api.get('/customer/payments'))['payments'] as List).cast<Map<String, dynamic>>(),
      builder: (context, list, reload) => ListPage(maxWidth: 560, children: [
        if (list.isEmpty) const Empty('ما عندك مدفوعات بعد'),
        for (final p in list) Card(child: ListTile(
          title: Text('وصل ${p['receipt_no']} · ${money(_n(p['net_amount']))}'), subtitle: Text('${dmy(p['date'] as String)}${p['status'] == 'refunded' ? ' · مسترجع' : ''}'), trailing: const Icon(Icons.chevron_left),
          onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ChangeNotifierProvider.value(value: api, child: _ReceiptPage(id: p['id'] as int)))),
        )),
      ]),
    );
  }
}

class _ReceiptPage extends StatelessWidget {
  const _ReceiptPage({required this.id});
  final int id;
  @override
  Widget build(BuildContext context) {
    final api = _api(context);
    return Scaffold(
      appBar: AppBar(title: const Text('تفاصيل الوصل')),
      body: Loader<Map<String, dynamic>>(
        load: () async => Map<String, dynamic>.from(await api.get('/customer/payments/$id') as Map),
        builder: (context, p, reload) => ListPage(maxWidth: 520, children: [
          Section(title: 'وصل ${p['receipt_no']}', child: Column(children: [
            KV('التاريخ', dmy(p['date'] as String)),
            for (final i in (p['items'] as List).cast<Map<String, dynamic>>()) KV('${i['service_name']}${_n(i['quantity']) > 1 ? ' × ${i['quantity']}' : ''}', money(_n(i['net_amount']))),
            const Divider(),
            KV('المجموع', money(_n(p['gross_amount']))),
            if (_n(p['offer_discount']) > 0) KV('خصم العرض', '- ${money(_n(p['offer_discount']))}'),
            if (_n(p['manual_discount']) > 0) KV('خصم', '- ${money(_n(p['manual_discount']))}'),
            if (_n(p['points_discount']) > 0) KV('خصم النقاط', '- ${money(_n(p['points_discount']))}'),
            KV('الصافي', money(_n(p['net_amount'])), bold: true),
            if (_n(p['points_earned']) > 0) KV('نقاط كسبتها', '+${p['points_earned']}', valueColor: Palette.ok),
            if (_n(p['points_used']) > 0) KV('نقاط استخدمتها', '${p['points_used']}'),
          ])),
        ]),
      ),
    );
  }
}

class _PointsList extends StatelessWidget {
  const _PointsList();
  @override
  Widget build(BuildContext context) {
    final api = _api(context);
    return Loader<Map<String, dynamic>>(
      load: () async => Map<String, dynamic>.from(await api.get('/customer/points') as Map),
      builder: (context, d, reload) {
        final entries = (d['entries'] as List).cast<Map<String, dynamic>>();
        return ListPage(maxWidth: 560, children: [
          Section(child: KV('رصيدك الحالي', '${d['balance']} نقطة', bold: true)),
          if (entries.isEmpty) const Empty('ما أكو حركات نقاط'),
          for (final e in entries) Card(child: ListTile(
            leading: Icon(_n(e['points']) >= 0 ? Icons.add_circle_outline : Icons.remove_circle_outline, color: _n(e['points']) >= 0 ? Palette.ok : Palette.danger),
            title: Text(_pointType[e['type']] ?? '${e['type']}'), subtitle: Text('${e['receipt_no'] == null ? '' : 'وصل ${e['receipt_no']} · '}${dmy((e['at'] as String).substring(0, 10))}'),
            trailing: Text('${_n(e['points']) > 0 ? '+' : ''}${e['points']}', style: TextStyle(fontWeight: FontWeight.w700, color: _n(e['points']) >= 0 ? Palette.ok : Palette.danger)),
          )),
        ]);
      },
    );
  }
}

// ====================================================================== الحساب
class AccountTab extends StatelessWidget {
  const AccountTab({super.key});
  @override
  Widget build(BuildContext context) {
    final s = context.watch<CustomerSession>(); final p = s.profile!;
    return ListPage(maxWidth: 560, children: [
      Section(title: 'معلوماتي', trailing: TextButton(onPressed: () => _edit(context), child: const Text('تعديل')), child: Column(children: [
        KV('الاسم', '${p['full_name']}'), KV('التلفون', ltr('${p['phone']}')), KV('رمزي', ltr('${p['public_code']}')), KV('الفرع', '${(p['branch'] as Map)['name']}'),
        if (p['gender'] != null) KV('الجنس', p['gender'] == 'female' ? 'أنثى' : 'ذكر'), if (p['birth_date'] != null) KV('تاريخ الميلاد', dmy(p['birth_date'] as String)),
      ])),
      Card(child: SwitchListTile(title: const Text('استلام إشعارات العروض'), subtitle: const Text('إشعارات عن العروض والخصومات'), value: p['notify_offers'] == true, onChanged: (v) async { try { await s.updateProfile({'notify_offers': v}); } catch (e) { if (context.mounted) showError(context, e); } })),
      OutlinedButton.icon(icon: const Icon(Icons.privacy_tip_outlined), label: const Text('سياسة الخصوصية'), onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const PrivacyPage()))),
      OutlinedButton.icon(icon: const Icon(Icons.logout), label: const Text('تسجيل الخروج'), onPressed: () async { if (await confirm(context, 'تسجيل الخروج؟')) await s.logout(); }),
      TextButton(onPressed: () async {
        if (!await confirm(context, 'حذف الحساب؟', body: 'راح ينحذف حسابك بالتطبيق ويطلع من كل أجهزتك. سجلاتك الطبية والمالية تبقى بالعيادة حسب القانون.', danger: true, yes: 'حذف الحساب')) return;
        try { await s.deleteAccount(); } catch (e) { if (context.mounted) showError(context, e); }
      }, child: const Text('حذف حسابي', style: TextStyle(color: Palette.danger))),
    ]);
  }

  Future<void> _edit(BuildContext context) async {
    final s = context.read<CustomerSession>(); final p = s.profile!;
    final name = TextEditingController(text: '${p['full_name']}'); String? gender = p['gender'] as String?; String? birth = p['birth_date'] as String?;
    await showDialog<void>(context: context, builder: (d) => StatefulBuilder(builder: (d, setS) => AlertDialog(
      title: const Text('تعديل معلوماتي'),
      content: SizedBox(width: 360, child: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: name, decoration: deco('الاسم')), const SizedBox(height: 10),
        DropdownButtonFormField<String>(initialValue: gender, decoration: deco('الجنس'), items: const [DropdownMenuItem(value: 'female', child: Text('أنثى')), DropdownMenuItem(value: 'male', child: Text('ذكر'))], onChanged: (v) => setS(() => gender = v)), const SizedBox(height: 10),
        DateField(label: 'تاريخ الميلاد', value: birth, first: DateTime(1930), last: DateTime.now(), onChanged: (v) => setS(() => birth = v)),
      ])),
      actions: [TextButton(onPressed: () => Navigator.pop(d), child: const Text('رجوع')), FilledButton(onPressed: () async {
        try { await s.updateProfile({'full_name': name.text.trim(), if (gender != null) 'gender': gender, if (birth != null) 'birth_date': birth}); if (d.mounted) Navigator.pop(d); } catch (e) { if (d.mounted) showError(d, e); }
      }, child: const Text('حفظ'))],
    )));
  }
}

// ====================================================================== الإشعارات
class NotificationsPage extends StatelessWidget {
  const NotificationsPage({super.key});
  @override
  Widget build(BuildContext context) {
    final api = _api(context);
    return Scaffold(
      appBar: AppBar(title: const Text('الإشعارات')),
      body: Loader<List<Map<String, dynamic>>>(
        load: () async => ((await api.get('/customer/notifications'))['notifications'] as List).cast<Map<String, dynamic>>(),
        builder: (context, list, reload) => ListPage(maxWidth: 560, children: [
          if (list.any((n) => n['read'] != true)) Align(alignment: Alignment.centerRight, child: TextButton.icon(icon: const Icon(Icons.done_all), label: const Text('تعليم الكل كمقروء'), onPressed: () async { try { await api.post('/customer/notifications/read', body: {}); await reload(); } catch (e) { if (context.mounted) showError(context, e); } })),
          if (list.isEmpty) const Empty('ما أكو إشعارات'),
          for (final n in list) Card(color: n['read'] == true ? null : Palette.primarySoft, child: ListTile(
            title: Text('${n['title']}', style: TextStyle(fontWeight: n['read'] == true ? FontWeight.w500 : FontWeight.w700)), subtitle: Text('${n['body']}'),
            onTap: n['read'] == true ? null : () async { try { await api.post('/customer/notifications/read', body: {'id': n['id']}); await reload(); } catch (_) {} },
          )),
        ]),
      ),
    );
  }
}
