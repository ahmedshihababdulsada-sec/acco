import 'package:flutter/foundation.dart';

import 'api.dart';

class StaffUser {
  StaffUser({required this.id, required this.username, required this.fullName, required this.role, required this.branchId, required this.mustChangePassword});
  factory StaffUser.fromJson(Map<String, dynamic> j) => StaffUser(
        id: j['id'] as int, username: j['username'] as String, fullName: j['full_name'] as String, role: j['role'] as String,
        branchId: j['branch_id'] as int?, mustChangePassword: j['must_change_password'] as bool? ?? false);
  final int id;
  final String username;
  final String fullName;
  final String role;
  final int? branchId;
  final bool mustChangePassword;
}

String roleName(String role) => const {
      'owner': 'المالك', 'manager': 'المدير', 'cashier': 'الكاشير', 'doctor': 'الطبيب', 'nurse': 'الممرض', 'customer': 'الزبون',
    }[role] ?? role;

/// نتيجة خطوة الدخول: انتهى، أو المالك يحتاج رمز التحقق الثنائي (تحقق أو إعداد أول مرة).
sealed class LoginStep {}

class LoginDone extends LoginStep {}

class LoginNeedsTotp extends LoginStep {
  LoginNeedsTotp(this.challenge, {required this.setup});
  final String challenge;
  final bool setup;
}

/// جلسة الموظف: الدخول والمالك (TOTP) وتغيير الرمز الأول والخروج.
class Session extends ChangeNotifier {
  Session(this.api) {
    api.onSessionExpired = () { user = null; notifyListeners(); };
  }
  final Api api;
  StaffUser? user;
  bool restoring = true;

  Future<void> restore() async {
    try {
      if (await api.restore()) user = StaffUser.fromJson(Map<String, dynamic>.from(await api.get('/auth/me') as Map));
    } catch (_) {
      await api.clearTokens();
      user = null;
    }
    restoring = false;
    notifyListeners();
  }

  Future<LoginStep> login(String username, String password) async {
    final j = Map<String, dynamic>.from(await api.post('/auth/login', body: {'username': username.trim(), 'password': password, 'device': 'clinic-app'}, auth: false) as Map);
    if (j['status'] == 'totp_required') return LoginNeedsTotp(j['challenge_token'] as String, setup: j['mode'] == 'setup');
    await _accept(j);
    return LoginDone();
  }

  Future<void> verifyTotp(String challenge, String code) async {
    await _accept(Map<String, dynamic>.from(await api.post('/auth/totp/verify', body: {'challenge_token': challenge, 'code': code, 'device': 'clinic-app'}, auth: false) as Map));
  }

  Future<Map<String, dynamic>> setupTotp(String challenge) async =>
      Map<String, dynamic>.from(await api.post('/auth/totp/setup', body: {'challenge_token': challenge}, auth: false) as Map);

  /// يرجع رموز الاسترجاع (تظهر مرة وحدة).
  Future<List<String>> enableTotp(String challenge, String code) async {
    final j = Map<String, dynamic>.from(await api.post('/auth/totp/enable', body: {'challenge_token': challenge, 'code': code, 'device': 'clinic-app'}, auth: false) as Map);
    await _accept(j, notify: false);
    return (j['recovery_codes'] as List?)?.cast<String>() ?? const [];
  }

  Future<void> _accept(Map<String, dynamic> j, {bool notify = true}) async {
    await api.setTokens(j['access_token'] as String, j['refresh_token'] as String);
    user = StaffUser.fromJson(Map<String, dynamic>.from(j['user'] as Map));
    if (notify) notifyListeners();
  }

  /// أول دخول لحساب جديد: كل شي مقفول غير تغيير الرمز.
  void finishTotpSetup() => notifyListeners();

  Future<void> changePassword(String current, String next) async {
    await api.post('/auth/change-password', body: {'current_password': current, 'new_password': next});
    // الخادم يلغي كل الأجهزة بعد تغيير الرمز: ندخل من جديد
    await api.clearTokens();
    user = null;
    notifyListeners();
  }

  Future<void> logout() async {
    try { await api.post('/auth/logout', body: {if (api.refreshToken != null) 'refresh_token': api.refreshToken}); } catch (_) {}
    await api.clearTokens();
    user = null;
    notifyListeners();
  }
}
