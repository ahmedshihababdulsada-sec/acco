import 'package:clinic_app/core/widgets.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

void main() {
  testWidgets('Loader reload (builder callback and controller) refetches without a setState-Future error', (t) async {
    var n = 0; final ctl = LoaderController(); Future<void> Function()? reload;
    await t.pumpWidget(MaterialApp(home: Loader<int>(controller: ctl, load: () async => ++n, builder: (c, v, r) { reload = r; return Text('v$v'); })));
    await t.pump(); await t.pump();
    expect(find.text('v1'), findsOneWidget);
    await reload!(); await t.pump(); await t.pump();
    expect(find.text('v2'), findsOneWidget);
    ctl.reload(); await t.pump(); await t.pump();
    expect(find.text('v3'), findsOneWidget);
    expect(t.takeException(), isNull);
  });
}
