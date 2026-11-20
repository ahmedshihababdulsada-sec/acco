import 'package:material_ui/material_ui.dart';

import 'api.dart';
import 'theme.dart';

void toast(BuildContext context, String message, {bool error = false}) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message), backgroundColor: error ? Palette.danger : Palette.primaryDark, duration: const Duration(seconds: 4)));
}

void showError(BuildContext context, Object e) => toast(context, e is ApiException ? e.message : 'صار خطأ غير متوقع: $e', error: true);

/// يشغل عملية async بزر: يعطل الزر أثناء التنفيذ، ويعرض خطأ الخادم بالعربي.
class AsyncButton extends StatefulWidget {
  const AsyncButton({super.key, required this.onPressed, required this.child, this.outlined = false, this.danger = false, this.icon});
  final Future<void> Function()? onPressed;
  final Widget child;
  final bool outlined;
  final bool danger;
  final IconData? icon;
  @override
  State<AsyncButton> createState() => _AsyncButtonState();
}

class _AsyncButtonState extends State<AsyncButton> {
  bool _busy = false;
  Future<void> _run() async {
    if (_busy || widget.onPressed == null) return;
    setState(() => _busy = true);
    try {
      await widget.onPressed!();
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final label = _busy ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.4)) : widget.child;
    final onTap = widget.onPressed == null || _busy ? null : _run;
    if (widget.outlined) {
      return OutlinedButton.icon(onPressed: onTap, icon: widget.icon == null ? const SizedBox.shrink() : Icon(widget.icon, size: 18), label: label,
          style: widget.danger ? OutlinedButton.styleFrom(foregroundColor: Palette.danger, side: const BorderSide(color: Palette.danger)) : null);
    }
    return FilledButton.icon(onPressed: onTap, icon: widget.icon == null ? const SizedBox.shrink() : Icon(widget.icon, size: 18), label: label,
        style: widget.danger ? FilledButton.styleFrom(backgroundColor: Palette.danger) : null);
  }
}

/// يحمّل بيانات من الـ API ويعرضها، مع «حاول من جديد» وتحديث (reload) من خارج الويدجت.
class Loader<T> extends StatefulWidget {
  const Loader({super.key, required this.load, required this.builder, this.controller});
  final Future<T> Function() load;
  final Widget Function(BuildContext, T, Future<void> Function() reload) builder;
  final LoaderController? controller;
  @override
  State<Loader<T>> createState() => _LoaderState<T>();
}

class LoaderController {
  VoidCallback? _reload;
  void reload() => _reload?.call();
}

class _LoaderState<T> extends State<Loader<T>> {
  late Future<T> _future;
  @override
  void initState() {
    super.initState();
    _future = widget.load();
    widget.controller?._reload = _reloadSync;
  }

  void _reloadSync() { if (mounted) { final f = widget.load(); setState(() { _future = f; }); } }

  Future<void> _reload() async {
    final f = widget.load();
    setState(() { _future = f; });
    try { await f; } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<T>(
      future: _future,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) return const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator()));
        if (snap.hasError) {
          final e = snap.error!;
          return Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                const Icon(Icons.error_outline, color: Palette.danger, size: 40),
                const SizedBox(height: 12),
                Text(e is ApiException ? e.message : 'صار خطأ: $e', textAlign: TextAlign.center),
                const SizedBox(height: 12),
                OutlinedButton(onPressed: _reload, child: const Text('حاول من جديد')),
              ]),
            ),
          );
        }
        return widget.builder(context, snap.data as T, _reload);
      },
    );
  }
}

/// بطاقة بعنوان (لوحة المحتوى الأساسية بالنماذج).
class Section extends StatelessWidget {
  const Section({super.key, this.title, required this.child, this.trailing, this.padding = const EdgeInsets.all(16)});
  final String? title;
  final Widget child;
  final Widget? trailing;
  final EdgeInsets padding;
  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: padding,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (title != null) Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Row(children: [Expanded(child: Text(title!, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700))), if (trailing != null) trailing!]),
          ),
          child,
        ]),
      ),
    );
  }
}

class Pill extends StatelessWidget {
  const Pill(this.text, {super.key, this.color = Palette.primaryDark, this.bg = Palette.primarySoft});
  final String text;
  final Color color;
  final Color bg;
  factory Pill.warn(String t) => Pill(t, color: Palette.warn, bg: Palette.warnSoft);
  factory Pill.danger(String t) => Pill(t, color: Palette.danger, bg: Palette.dangerSoft);
  factory Pill.ok(String t) => Pill(t, color: Palette.ok, bg: Palette.okSoft);
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(6)),
        child: Text(text, style: TextStyle(color: color, fontSize: 12.5, fontWeight: FontWeight.w600)),
      );
}

class Notice extends StatelessWidget {
  const Notice(this.text, {super.key, this.kind = NoticeKind.info});
  final String text;
  final NoticeKind kind;
  @override
  Widget build(BuildContext context) {
    final (bg, fg, icon) = switch (kind) {
      NoticeKind.info => (Palette.primarySoft, Palette.primaryDark, Icons.info_outline),
      NoticeKind.warn => (Palette.warnSoft, Palette.warn, Icons.warning_amber_rounded),
      NoticeKind.danger => (Palette.dangerSoft, Palette.danger, Icons.error_outline),
    };
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(8)),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Icon(icon, color: fg, size: 20), const SizedBox(width: 8), Expanded(child: Text(text, style: TextStyle(color: fg, height: 1.5)))]),
    );
  }
}

enum NoticeKind { info, warn, danger }

class KV extends StatelessWidget {
  const KV(this.k, this.v, {super.key, this.bold = false, this.valueColor});
  final String k;
  final String v;
  final bool bold;
  final Color? valueColor;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(children: [
          Expanded(child: Text(k, style: const TextStyle(color: Palette.muted))),
          Text(v, style: TextStyle(fontWeight: bold ? FontWeight.w700 : FontWeight.w500, color: valueColor)),
        ]),
      );
}

class Empty extends StatelessWidget {
  const Empty(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsets.all(28), child: Center(child: Text(text, style: const TextStyle(color: Palette.muted), textAlign: TextAlign.center)));
}

Future<bool> confirm(BuildContext context, String title, {String? body, String yes = 'تأكيد', bool danger = false}) async {
  final r = await showDialog<bool>(
    context: context,
    builder: (c) => AlertDialog(
      title: Text(title),
      content: body == null ? null : Text(body),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('رجوع')),
        FilledButton(onPressed: () => Navigator.pop(c, true), style: danger ? FilledButton.styleFrom(backgroundColor: Palette.danger) : null, child: Text(yes)),
      ],
    ),
  );
  return r ?? false;
}

/// يسأل عن نص (سبب مكتوب مثلاً): يرجع null إذا رجع.
Future<String?> askText(BuildContext context, String title, {String label = 'السبب', String yes = 'تأكيد', int minLen = 3, bool multiline = false, String? hint}) async {
  final ctrl = TextEditingController();
  String? err;
  final r = await showDialog<String>(
    context: context,
    builder: (c) => StatefulBuilder(
      builder: (c, setS) => AlertDialog(
        title: Text(title),
        content: TextField(controller: ctrl, autofocus: true, maxLines: multiline ? 3 : 1, decoration: InputDecoration(labelText: label, hintText: hint, errorText: err)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('رجوع')),
          FilledButton(
            onPressed: () {
              final v = ctrl.text.trim();
              if (v.length < minLen) { setS(() => err = 'اكتب $label (على الأقل $minLen أحرف)'); return; }
              Navigator.pop(c, v);
            },
            child: Text(yes),
          ),
        ],
      ),
    ),
  );
  return r;
}

/// إطار صفحة بعرض أقصى (الشاشات الكبيرة) وتمرير.
class ListPage extends StatelessWidget {
  const ListPage({super.key, required this.children, this.maxWidth = 960, this.padding = const EdgeInsets.all(16)});
  final List<Widget> children;
  final double maxWidth;
  final EdgeInsets padding;
  @override
  Widget build(BuildContext context) => Align(
        alignment: Alignment.topCenter,
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: maxWidth),
          child: ListView.separated(padding: padding, itemCount: children.length, separatorBuilder: (_, __) => const SizedBox(height: 12), itemBuilder: (_, i) => children[i]),
        ),
      );
}

InputDecoration deco(String label, {String? hint, String? suffix}) => InputDecoration(labelText: label, hintText: hint, suffixText: suffix);

class DateField extends StatelessWidget {
  const DateField({super.key, required this.label, required this.value, required this.onChanged, this.first, this.last});
  final String label;
  final String? value;
  final ValueChanged<String> onChanged;
  final DateTime? first;
  final DateTime? last;
  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: () async {
        final now = DateTime.now();
        final d = await showDatePicker(context: context, initialDate: value == null ? now : DateTime.parse(value!), firstDate: first ?? now.subtract(const Duration(days: 365)), lastDate: last ?? now.add(const Duration(days: 365)));
        if (d != null) onChanged('${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}');
      },
      child: InputDecorator(decoration: deco(label).copyWith(suffixIcon: const Icon(Icons.calendar_today, size: 18)), child: Text(value == null ? 'اختر التاريخ' : value!, textDirection: TextDirection.ltr, textAlign: TextAlign.start)),
    );
  }
}
