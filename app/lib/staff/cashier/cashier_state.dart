import 'package:flutter/foundation.dart';

import '../../core/api.dart';

/// حالة شاشة الكاشير: الشفت الحالي وقائمة حجوزات اليوم والزبون المختار.
class CashierState extends ChangeNotifier {
  CashierState(this.api);
  final Api api;
  Map<String, dynamic>? shift;
  bool loaded = false;
  List<Map<String, dynamic>> queue = [];
  Map<String, dynamic>? day;
  int? selectedCustomerId;
  int version = 0; // يزيد بكل تحديث حتى تعيد اللوحات تحميل نفسها

  Set<int> _activeCustomers = {};
  /// زيارات فيها شغل متبقي (الكاشير يحتاجها)، والمنتهية/الملغية تنعرض بسطر مطوي
  List<Map<String, dynamic>> get activeQueue => queue.where((b) => b['done'] != true).toList();
  List<Map<String, dynamic>> get doneQueue => queue.where((b) => b['done'] == true).toList();

  Future<void> refresh() async {
    final s = await api.get('/shifts/current');
    shift = s == null ? null : Map<String, dynamic>.from(s as Map);
    final b = Map<String, dynamic>.from(await api.get('/bookings') as Map);
    queue = (b['bookings'] as List).cast<Map<String, dynamic>>();
    day = b['day'] == null ? null : Map<String, dynamic>.from(b['day'] as Map);
    // الزبون اللي كان عنده شغل وخلص (انتهت زيارته): الشاشة تتفرغ، ما يبقى ملفه مفتوح للزبون الجاي
    final nowActive = {for (final x in activeQueue) (x['customer'] as Map)['id'] as int};
    if (selectedCustomerId != null && _activeCustomers.contains(selectedCustomerId) && !nowActive.contains(selectedCustomerId)) selectedCustomerId = null;
    _activeCustomers = nowActive;
    loaded = true;
    version++;
    notifyListeners();
  }

  void select(int? id) {
    selectedCustomerId = id;
    notifyListeners();
  }

  void bump() { version++; notifyListeners(); }

  bool get shiftOpen => shift != null;
}
