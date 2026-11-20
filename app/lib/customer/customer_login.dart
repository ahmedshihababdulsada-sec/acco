import 'dart:async';

import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../core/api.dart';
import '../core/theme.dart';
import '../core/widgets.dart';
import 'customer_session.dart';
import 'privacy_page.dart';

/// دخول الزبون: رقم التلفون ← رمز من 6 أرقام. أول مرة يطلب الاسم (والفرع إذا أكثر من فرع).
class CustomerLoginPage extends StatefulWidget {
  const CustomerLoginPage({super.key});
  @override
  State<CustomerLoginPage> createState() => _CustomerLoginPageState();
}

class _CustomerLoginPageState extends State<CustomerLoginPage> {
  final _phone = TextEditingController(); final _code = TextEditingController(); final _name = TextEditingController();
  bool _codeStep = false; bool _needName = false; bool _needBranch = false;
  List<Map<String, dynamic>> _branches = []; int? _branch; int _cooldown = 0; Timer? _timer;

  @override
  void dispose() { _timer?.cancel(); super.dispose(); }

  void _startCooldown(int s) {
    _timer?.cancel(); setState(() => _cooldown = s);
    _timer = Timer.periodic(const Duration(seconds: 1), (t) { if (_cooldown <= 1) { t.cancel(); if (mounted) setState(() => _cooldown = 0); } else { if (mounted) setState(() => _cooldown--); } });
  }

  Future<void> _send() async {
    final s = context.read<CustomerSession>();
    if (_phone.text.trim().length < 10) { toast(context, 'اكتب رقم التلفون كامل', error: true); return; }
    final wait = await s.requestOtp(_phone.text);
    if (!mounted) return;
    setState(() => _codeStep = true);
    _startCooldown(wait);
    toast(context, 'انرسل الرمز لتلفونك');
  }

  Future<void> _verify() async {
    final s = context.read<CustomerSession>();
    if (_code.text.trim().length != 6) { toast(context, 'الرمز 6 أرقام', error: true); return; }
    try {
      await s.verify(_phone.text, _code.text, fullName: _name.text, branchId: _branch);
    } on ApiException catch (e) {
      if (e.code == 'NAME_REQUIRED') { setState(() => _needName = true); if (mounted) toast(context, e.message, error: true); return; }
      if (e.code == 'BRANCH_REQUIRED') {
        _branches = await s.branches();
        if (mounted) { setState(() => _needBranch = true); toast(context, e.message, error: true); }
        return;
      }
      rethrow;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(child: Center(child: SingleChildScrollView(padding: const EdgeInsets.all(24), child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Center(child: Container(width: 76, height: 76, decoration: BoxDecoration(color: Palette.primary, borderRadius: BorderRadius.circular(20)), child: const Icon(Icons.spa_outlined, color: Colors.white, size: 40))),
          const SizedBox(height: 16),
          const Text('أهلاً بيك', textAlign: TextAlign.center, style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          const Text('سجّل دخولك برقم تلفونك لتحجز وتتابع جلساتك ونقاطك', textAlign: TextAlign.center, style: TextStyle(color: Palette.muted)),
          const SizedBox(height: 24),
          Section(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            TextField(controller: _phone, enabled: !_codeStep, onSubmitted: (_) async { if (_codeStep) return; try { await _send(); } catch (e) { if (mounted) showError(context, e); } }, keyboardType: TextInputType.phone, textDirection: TextDirection.ltr, decoration: deco('رقم التلفون', hint: '07xx xxx xxxx')),
            if (!_codeStep) ...[const SizedBox(height: 14), AsyncButton(icon: Icons.sms_outlined, onPressed: _send, child: const Text('إرسال الرمز'))]
            else ...[
              const SizedBox(height: 12),
              TextField(controller: _code, autofocus: true, onSubmitted: (_) async { try { await _verify(); } catch (e) { if (mounted) showError(context, e); } }, keyboardType: TextInputType.number, maxLength: 6, textDirection: TextDirection.ltr, textAlign: TextAlign.center, style: const TextStyle(fontSize: 22, letterSpacing: 6), decoration: deco('رمز التأكيد').copyWith(counterText: '')),
              if (_needName) ...[const SizedBox(height: 12), TextField(controller: _name, decoration: deco('اسمك (للتسجيل أول مرة)'))],
              if (_needBranch) ...[const SizedBox(height: 12), DropdownButtonFormField<int>(initialValue: _branch, decoration: deco('الفرع'), items: [for (final b in _branches) DropdownMenuItem(value: b['id'] as int, child: Text(b['name'] as String))], onChanged: (v) => setState(() => _branch = v))],
              const SizedBox(height: 14),
              AsyncButton(icon: Icons.login, onPressed: _verify, child: const Text('دخول')),
              const SizedBox(height: 8),
              Wrap(alignment: WrapAlignment.spaceBetween, crossAxisAlignment: WrapCrossAlignment.center, children: [
                TextButton(onPressed: () => setState(() { _codeStep = false; _code.clear(); _needName = false; _needBranch = false; }), child: const Text('تغيير الرقم')),
                TextButton(onPressed: _cooldown > 0 ? null : () async { try { await _send(); } catch (e) { if (mounted) showError(context, e); } }, child: Text(_cooldown > 0 ? 'إعادة الإرسال بعد $_cooldown ث' : 'إعادة الإرسال')),
              ]),
            ],
          ])),
          TextButton(onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const PrivacyPage())), child: const Text('سياسة الخصوصية')),
        ]),
      )))),
    );
  }
}
