import 'package:flutter/foundation.dart';

import '../core/api.dart';

/// جلسة الزبون: دخول برمز تأكيد (OTP) على التلفون، بدون كلمة سر. التسجيل الأول ينطلب فيه الاسم (والفرع إذا أكثر من فرع).
class CustomerSession extends ChangeNotifier {
  CustomerSession(this.api) {
    api.onSessionExpired = () { profile = null; notifyListeners(); };
  }
  final Api api;
  Map<String, dynamic>? profile;
  bool restoring = true;

  int get unreadHint => _unread;
  int _unread = 0;
  set unread(int v) { _unread = v; notifyListeners(); }

  Future<void> restore() async {
    try {
      if (await api.restore()) profile = Map<String, dynamic>.from(await api.get('/customer/me') as Map);
    } catch (_) {
      await api.clearTokens();
      profile = null;
    }
    restoring = false;
    notifyListeners();
  }

  Future<List<Map<String, dynamic>>> branches() async =>
      ((await api.get('/customer/branches', query: null) as Map)['branches'] as List).cast<Map<String, dynamic>>();

  /// يرجع الثواني قبل ما يسمح بطلب رمز جديد.
  Future<int> requestOtp(String phone) async {
    final j = Map<String, dynamic>.from(await api.post('/customer/auth/request-otp', body: {'phone': phone.trim()}, auth: false) as Map);
    return (j['resend_after'] as int?) ?? 60;
  }

  /// يرمي ApiException برمز NAME_REQUIRED أو BRANCH_REQUIRED إذا التسجيل الأول ينقصه معلومات (والرمز يبقى صالح).
  Future<void> verify(String phone, String code, {String? fullName, int? branchId}) async {
    final j = Map<String, dynamic>.from(await api.post('/customer/auth/verify-otp', auth: false, body: {
      'phone': phone.trim(), 'code': code.trim(), 'device': 'customer-app',
      if (fullName != null && fullName.trim().isNotEmpty) 'full_name': fullName.trim(),
      if (branchId != null) 'branch_id': branchId,
    }) as Map);
    await api.setTokens(j['access_token'] as String, j['refresh_token'] as String);
    profile = Map<String, dynamic>.from(j['customer'] as Map);
    notifyListeners();
  }

  Future<void> reloadProfile() async {
    profile = Map<String, dynamic>.from(await api.get('/customer/me') as Map);
    notifyListeners();
  }

  Future<void> updateProfile(Map<String, dynamic> body) async {
    profile = Map<String, dynamic>.from(await api.put('/customer/me', body: body) as Map);
    notifyListeners();
  }

  Future<void> logout() async {
    try { await api.post('/customer/auth/logout', body: {if (api.refreshToken != null) 'refresh_token': api.refreshToken}); } catch (_) {}
    await api.clearTokens();
    profile = null;
    notifyListeners();
  }

  Future<void> deleteAccount() async {
    await api.delete('/customer/me', body: {'confirm': true});
    await api.clearTokens();
    profile = null;
    notifyListeners();
  }
}
