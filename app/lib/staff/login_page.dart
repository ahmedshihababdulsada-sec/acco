import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../core/session.dart';
import '../core/theme.dart';
import '../core/widgets.dart';

/// شاشة دخول الموظفين: اسم المستخدم والرمز السري، والمالك يكمل برمز التحقق الثنائي (تطبيق المصادقة).
class LoginPage extends StatefulWidget {
  const LoginPage({super.key});
  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _u = TextEditingController();
  final _p = TextEditingController();
  bool _hide = true;

  Future<void> _login() async {
    final s = context.read<Session>();
    if (_u.text.trim().isEmpty || _p.text.isEmpty) { toast(context, 'اكتب اسم المستخدم والرمز السري', error: true); return; }
    final step = await s.login(_u.text, _p.text);
    if (step is LoginNeedsTotp && mounted) {
      Navigator.of(context).push(MaterialPageRoute(builder: (_) => TotpPage(challenge: step.challenge, setup: step.setup)));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Container(
                width: 64, height: 64, alignment: Alignment.center, margin: const EdgeInsets.symmetric(horizontal: 150),
                decoration: BoxDecoration(color: Palette.primary, borderRadius: BorderRadius.circular(16)),
                child: const Icon(Icons.spa_outlined, color: Colors.white, size: 34),
              ),
              const SizedBox(height: 16),
              const Text('نظام مركز التجميل', textAlign: TextAlign.center, style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
              const Text('تسجيل دخول الموظفين', textAlign: TextAlign.center, style: TextStyle(color: Palette.muted)),
              const SizedBox(height: 24),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    TextField(controller: _u, autofocus: true, textInputAction: TextInputAction.next, autofillHints: const [AutofillHints.username], decoration: deco('اسم المستخدم'), textDirection: TextDirection.ltr),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _p, obscureText: _hide, textDirection: TextDirection.ltr, autofillHints: const [AutofillHints.password], onSubmitted: (_) async { try { await _login(); } catch (e) { if (mounted) showError(context, e); } },
                      decoration: deco('الرمز السري').copyWith(suffixIcon: IconButton(icon: Icon(_hide ? Icons.visibility_off : Icons.visibility), onPressed: () => setState(() => _hide = !_hide))),
                    ),
                    const SizedBox(height: 16),
                    AsyncButton(onPressed: _login, child: const Text('دخول')),
                  ]),
                ),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

/// المالك: إعداد التحقق الثنائي أول مرة (مفتاح + رمز تأكيد + رموز استرجاع تظهر مرة وحدة)، أو إدخال الرمز.
class TotpPage extends StatefulWidget {
  const TotpPage({super.key, required this.challenge, required this.setup});
  final String challenge;
  final bool setup;
  @override
  State<TotpPage> createState() => _TotpPageState();
}

class _TotpPageState extends State<TotpPage> {
  final _code = TextEditingController();
  Map<String, dynamic>? _setup;
  List<String>? _recovery;
  bool _useRecovery = false;

  @override
  void initState() {
    super.initState();
    if (widget.setup) {
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        try {
          final j = await context.read<Session>().setupTotp(widget.challenge);
          if (mounted) setState(() => _setup = j);
        } catch (e) { if (mounted) showError(context, e); }
      });
    }
  }

  Future<void> _submit() async {
    final s = context.read<Session>();
    final code = _code.text.trim();
    if (code.isEmpty) { toast(context, 'اكتب الرمز', error: true); return; }
    if (widget.setup) {
      final rec = await s.enableTotp(widget.challenge, code);
      if (mounted) setState(() => _recovery = rec);
    } else {
      await s.verifyTotp(widget.challenge, code);
      if (mounted) Navigator.of(context).popUntil((r) => r.isFirst);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_recovery != null) {
      return Scaffold(
        appBar: AppBar(title: const Text('رموز الاسترجاع')),
        body: ListPage(maxWidth: 520, children: [
          const Notice('احفظ هالرموز بمكان آمن. كل رمز يشتغل مرة وحدة إذا ضاع تلفونك. تظهر مرة وحدة بس.', kind: NoticeKind.warn),
          Section(child: Wrap(spacing: 12, runSpacing: 8, children: [for (final r in _recovery!) SelectableText(r, style: const TextStyle(fontFamily: 'monospace', fontSize: 16), textDirection: TextDirection.ltr)])),
          FilledButton(onPressed: () { context.read<Session>().finishTotpSetup(); Navigator.of(context).popUntil((r) => r.isFirst); }, child: const Text('حفظتها، كمّل')),
        ]),
      );
    }
    return Scaffold(
      appBar: AppBar(title: Text(widget.setup ? 'إعداد التحقق الثنائي' : 'رمز التحقق')),
      body: ListPage(maxWidth: 520, children: [
        if (widget.setup) ...[
          const Notice('المالك لازم يفعّل التحقق الثنائي: افتح تطبيق المصادقة (Google Authenticator أو غيره) وأضف هذا المفتاح، بعدين اكتب الرمز اللي يطلعلك.'),
          Section(
            title: 'المفتاح',
            child: _setup == null
                ? const Center(child: CircularProgressIndicator())
                : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    SelectableText(_setup!['secret'] as String, style: const TextStyle(fontFamily: 'monospace', fontSize: 18, letterSpacing: 1.5), textDirection: TextDirection.ltr),
                    const SizedBox(height: 8),
                    OutlinedButton.icon(onPressed: () { Clipboard.setData(ClipboardData(text: _setup!['secret'] as String)); toast(context, 'اننسخ المفتاح'); }, icon: const Icon(Icons.copy, size: 18), label: const Text('نسخ المفتاح')),
                    const SizedBox(height: 8),
                    SelectableText(_setup!['otpauth_uri'] as String, style: const TextStyle(fontSize: 11, color: Palette.muted), textDirection: TextDirection.ltr),
                  ]),
          ),
        ],
        Section(
          title: _useRecovery ? 'رمز استرجاع' : 'اكتب الرمز من تطبيق المصادقة',
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            TextField(controller: _code, autofocus: !widget.setup, keyboardType: TextInputType.number, textDirection: TextDirection.ltr, style: const TextStyle(fontSize: 22, letterSpacing: 4), decoration: deco(_useRecovery ? 'رمز الاسترجاع' : 'الرمز (6 أرقام)')),
            const SizedBox(height: 12),
            AsyncButton(onPressed: _submit, child: Text(widget.setup ? 'تفعيل ودخول' : 'تأكيد')),
            if (!widget.setup) TextButton(onPressed: () => setState(() => _useRecovery = !_useRecovery), child: Text(_useRecovery ? 'استخدام رمز التطبيق' : 'استخدام رمز استرجاع')),
          ]),
        ),
      ]),
    );
  }
}

/// أول دخول لحساب جديد أو معاد تعيينه: كل شي مقفول غير تغيير الرمز.
class ChangePasswordPage extends StatefulWidget {
  const ChangePasswordPage({super.key, this.forced = false});
  final bool forced;
  @override
  State<ChangePasswordPage> createState() => _ChangePasswordPageState();
}

class _ChangePasswordPageState extends State<ChangePasswordPage> {
  final _cur = TextEditingController();
  final _new = TextEditingController();
  final _again = TextEditingController();

  Future<void> _save() async {
    if (_new.text.length < 10) { toast(context, 'الرمز الجديد لازم يكون 10 أحرف على الأقل', error: true); return; }
    if (_new.text != _again.text) { toast(context, 'تأكيد الرمز ما يطابق', error: true); return; }
    await context.read<Session>().changePassword(_cur.text, _new.text);
    if (mounted) { toast(context, 'تغيّر الرمز. سجّل دخولك من جديد'); if (!widget.forced) Navigator.of(context).popUntil((r) => r.isFirst); }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('تغيير الرمز السري'), automaticallyImplyLeading: !widget.forced),
      body: ListPage(maxWidth: 480, children: [
        if (widget.forced) const Notice('هذا أول دخول لحسابك: لازم تغيّر الرمز المؤقت قبل ما تكمل.', kind: NoticeKind.warn),
        Section(
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            TextField(controller: _cur, obscureText: true, textDirection: TextDirection.ltr, decoration: deco('الرمز الحالي')),
            const SizedBox(height: 12),
            TextField(controller: _new, obscureText: true, textDirection: TextDirection.ltr, decoration: deco('الرمز الجديد (10 أحرف على الأقل)')),
            const SizedBox(height: 12),
            TextField(controller: _again, obscureText: true, textDirection: TextDirection.ltr, decoration: deco('تأكيد الرمز الجديد')),
            const SizedBox(height: 16),
            AsyncButton(onPressed: _save, child: const Text('حفظ')),
            if (widget.forced) TextButton(onPressed: () => context.read<Session>().logout(), child: const Text('خروج')),
          ]),
        ),
      ]),
    );
  }
}
