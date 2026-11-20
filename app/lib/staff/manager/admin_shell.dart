import 'package:flutter/foundation.dart';
import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../../core/api.dart';
import '../../core/session.dart';
import '../../core/theme.dart';
import '../home_shell.dart';

/// الفرع اللي تنطبق عليه شاشات المدير/المالك: المدير فرعه، والمالك يختار (إذا أكثر من فرع).
class BranchScope extends ChangeNotifier {
  BranchScope(this.api, this.isOwner);
  final Api api;
  final bool isOwner;
  List<Map<String, dynamic>> branches = [];
  int? selected;
  int version = 0;

  Future<void> load() async {
    final j = Map<String, dynamic>.from(await api.get('/branches') as Map);
    branches = (j['branches'] as List).cast<Map<String, dynamic>>();
    if (isOwner && branches.isNotEmpty) selected ??= branches.first['id'] as int;
    notifyListeners();
  }

  void select(int id) { selected = id; version++; notifyListeners(); }
  void bump() { version++; notifyListeners(); }

  /// ترويسة الاستعلام: المالك لازم يحدد الفرع، والمدير ما يحتاج.
  Map<String, dynamic> get q => isOwner && selected != null ? {'branch_id': selected} : {};
  Map<String, dynamic> body(Map<String, dynamic> b) => isOwner && selected != null ? {...b, 'branch_id': selected} : b;
}

/// تنقل بين أقسام الإطار بالاسم (تستخدمه بطاقات «المهام» بالرئيسية).
class AdminNav {
  AdminNav(this.go);
  final void Function(String title) go;
}

class AdminSection {
  const AdminSection(this.title, this.icon, this.build);
  final String title;
  final IconData icon;
  final Widget Function(BuildContext) build;
}

/// إطار المدير والمالك: قائمة أقسام جانبية (شاشة عريضة) أو درج (جوال)، وكل قسم صفحة. المالك عنده أقسام إضافية ومبدّل فروع.
class AdminShell extends StatefulWidget {
  const AdminShell({super.key, required this.title, required this.sections});
  final String title;
  final List<AdminSection> sections;
  @override
  State<AdminShell> createState() => _AdminShellState();
}

class _AdminShellState extends State<AdminShell> {
  int _i = 0;
  late final BranchScope scope = BranchScope(context.read<Api>(), context.read<Session>().user!.role == 'owner');
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    scope.load().then((_) { if (mounted) setState(() => _ready = true); }).catchError((_) { if (mounted) setState(() => _ready = true); });
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.sections[_i];
    return MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: scope),
        Provider.value(value: AdminNav((t) { final i = widget.sections.indexWhere((e) => e.title == t); if (i >= 0 && mounted) setState(() => _i = i); })),
      ],
      child: LayoutBuilder(builder: (context, c) {
        final wide = c.maxWidth >= 900;
        final body = !_ready ? const Center(child: CircularProgressIndicator()) : Consumer<BranchScope>(builder: (_, sc, __) => KeyedSubtree(key: ValueKey('${_i}-${sc.version}-${sc.selected}'), child: s.build(context)));
        final bar = staffBar(context, '${widget.title} · ${s.title}', actions: [
          if (scope.isOwner && scope.branches.length > 1) Consumer<BranchScope>(builder: (_, sc, __) => Padding(padding: const EdgeInsets.symmetric(horizontal: 8), child: DropdownButton<int>(value: sc.selected, underline: const SizedBox.shrink(), items: [for (final b in sc.branches) DropdownMenuItem(value: b['id'] as int, child: Text(b['name'] as String))], onChanged: (v) => sc.select(v!)))),
          IconButton(tooltip: 'تحديث', icon: const Icon(Icons.refresh), onPressed: scope.bump),
        ]);
        if (wide) {
          return Scaffold(
            appBar: bar,
            body: Row(children: [
              SizedBox(width: 220, child: Material(color: Palette.surface, child: ListView(children: [for (final (i, e) in widget.sections.indexed) ListTile(dense: true, selected: i == _i, selectedTileColor: Palette.primarySoft, selectedColor: Palette.primaryDark, leading: Icon(e.icon, size: 20), title: Text(e.title), onTap: () => setState(() => _i = i))]))),
              const VerticalDivider(width: 1),
              Expanded(child: body),
            ]),
          );
        }
        return Scaffold(
          appBar: bar,
          drawer: Drawer(child: SafeArea(child: ListView(children: [
            Padding(padding: const EdgeInsets.all(16), child: Text(widget.title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 18))),
            for (final (i, e) in widget.sections.indexed) ListTile(selected: i == _i, leading: Icon(e.icon), title: Text(e.title), onTap: () { setState(() => _i = i); Navigator.pop(context); }),
          ]))),
          body: body,
        );
      }),
    );
  }
}
