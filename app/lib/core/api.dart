import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

/// خطأ من الخادم بنفس شكله: { code, message } والرمز ثابت للواجهة والرسالة عربية للمستخدم.
class ApiException implements Exception {
  ApiException(this.status, this.code, this.message, [this.body]);
  final int status;
  final String code;
  final String message;
  final Map<String, dynamic>? body;
  bool get isUnauthorized => status == 401;
  @override
  String toString() => message;
}

/// تخزين التوكنات (على الجهاز). التطبيق ما يخزن كلمات السر أبداً.
abstract class TokenStore {
  Future<({String? access, String? refresh})> load();
  Future<void> save(String access, String refresh);
  Future<void> clear();
}

class PrefsTokenStore implements TokenStore {
  PrefsTokenStore(this.prefix);
  final String prefix;
  @override
  Future<({String? access, String? refresh})> load() async {
    final p = await SharedPreferences.getInstance();
    return (access: p.getString('$prefix.access'), refresh: p.getString('$prefix.refresh'));
  }

  @override
  Future<void> save(String access, String refresh) async {
    final p = await SharedPreferences.getInstance();
    await p.setString('$prefix.access', access);
    await p.setString('$prefix.refresh', refresh);
  }

  @override
  Future<void> clear() async {
    final p = await SharedPreferences.getInstance();
    await p.remove('$prefix.access');
    await p.remove('$prefix.refresh');
  }
}

class MemoryTokenStore implements TokenStore {
  String? _a, _r;
  @override
  Future<({String? access, String? refresh})> load() async => (access: _a, refresh: _r);
  @override
  Future<void> save(String access, String refresh) async { _a = access; _r = refresh; }
  @override
  Future<void> clear() async { _a = null; _r = null; }
}

/// مفتاح منع التكرار للعمليات الحساسة (الدفع، الاسترجاع): نفس المفتاح يعني نفس العملية لو انعادت المحاولة.
String newIdempotencyKey() {
  final r = Random.secure();
  final b = List<int>.generate(16, (_) => r.nextInt(256));
  return b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
}

/// عميل الـ API: توكن وصول قصير + تجديد تلقائي مرة وحدة عند 401 (single-flight)، وأخطاء بشكل ثابت.
class Api extends ChangeNotifier {
  Api({required this.baseUrl, http.Client? client, TokenStore? store, this.refreshPath = '/auth/refresh'})
      : _client = client ?? http.Client(),
        _store = store ?? MemoryTokenStore();

  final String baseUrl;
  final String refreshPath;
  final http.Client _client;
  final TokenStore _store;
  String? _access;
  String? _refresh;
  Future<bool>? _refreshing;

  /// تُستدعى لما التجديد يفشل (انتهت الجلسة): الواجهة ترجع لشاشة الدخول.
  VoidCallback? onSessionExpired;

  bool get hasTokens => _access != null;

  Future<bool> restore() async {
    final t = await _store.load();
    _access = t.access;
    _refresh = t.refresh;
    return _access != null;
  }

  Future<void> setTokens(String access, String refresh) async {
    _access = access;
    _refresh = refresh;
    await _store.save(access, refresh);
  }

  Future<void> clearTokens() async {
    _access = null;
    _refresh = null;
    await _store.clear();
  }

  String? get refreshToken => _refresh;

  Uri _uri(String path, Map<String, dynamic>? query) {
    final q = <String, String>{};
    query?.forEach((k, v) { if (v != null && '$v'.isNotEmpty) q[k] = '$v'; });
    return Uri.parse('$baseUrl$path').replace(queryParameters: q.isEmpty ? null : q);
  }

  Map<String, String> _headers({bool json = true, String? idempotencyKey, bool auth = true}) => {
        if (json) 'Content-Type': 'application/json',
        'Accept': 'application/json',
        if (auth && _access != null) 'Authorization': 'Bearer $_access',
        if (idempotencyKey != null) 'Idempotency-Key': idempotencyKey,
      };

  Future<dynamic> get(String path, {Map<String, dynamic>? query}) => _send('GET', path, query: query);
  Future<dynamic> post(String path, {Object? body, String? idempotencyKey, bool auth = true}) => _send('POST', path, body: body ?? const {}, idempotencyKey: idempotencyKey, auth: auth);
  Future<dynamic> put(String path, {Object? body}) => _send('PUT', path, body: body ?? const {});
  Future<dynamic> patch(String path, {Object? body}) => _send('PATCH', path, body: body ?? const {});
  Future<dynamic> delete(String path, {Object? body}) => _send('DELETE', path, body: body);

  /// رفع ملف (صورة إثبات): multipart مع تجديد التوكن مرة وحدة عند 401. يرجع رد الخادم (فيه id المرفق).
  Future<Map<String, dynamic>> upload(String path, {String? kind, Map<String, String> fields = const {}, required List<int> bytes, required String filename}) async {
    Future<http.Response> send() async {
      final req = http.MultipartRequest('POST', _uri(path, null));
      req.headers.addAll(_headers(json: false));
      if (kind != null) req.fields['kind'] = kind;
      req.fields.addAll(fields);
      req.files.add(http.MultipartFile.fromBytes('file', bytes, filename: filename));
      try { return await http.Response.fromStream(await _client.send(req).timeout(const Duration(seconds: 60))); } catch (_) { throw ApiException(0, 'NETWORK', 'تعذر رفع الملف: تأكد من الإنترنت'); }
    }
    var res = await send();
    if (res.statusCode == 401 && _refresh != null && await _tryRefresh()) res = await send();
    if (res.statusCode >= 400) throw _error(res);
    return Map<String, dynamic>.from(jsonDecode(utf8.decode(res.bodyBytes)) as Map);
  }

  /// تنزيل ملف (تصدير تقرير): يرجع البايتات.
  Future<Uint8List> download(String path, {Map<String, dynamic>? query}) async {
    final res = await _raw('GET', path, query: query, json: false);
    return res.bodyBytes;
  }

  Future<dynamic> _send(String method, String path, {Map<String, dynamic>? query, Object? body, String? idempotencyKey, bool auth = true}) async {
    final res = await _raw(method, path, query: query, body: body, idempotencyKey: idempotencyKey, auth: auth);
    if (res.body.isEmpty) return null;
    return jsonDecode(utf8.decode(res.bodyBytes));
  }

  Future<http.Response> _raw(String method, String path, {Map<String, dynamic>? query, Object? body, String? idempotencyKey, bool auth = true, bool json = true, bool retried = false}) async {
    final req = http.Request(method, _uri(path, query));
    req.headers.addAll(_headers(json: body != null && json, idempotencyKey: idempotencyKey, auth: auth));
    if (body != null) req.body = jsonEncode(body);
    http.Response res;
    try {
      res = await http.Response.fromStream(await _client.send(req).timeout(const Duration(seconds: 30)));
    } on TimeoutException {
      throw ApiException(0, 'TIMEOUT', 'انتهت مهلة الاتصال: تأكد من الإنترنت وحاول من جديد');
    } catch (_) {
      throw ApiException(0, 'NETWORK', 'تعذر الاتصال بالخادم: تأكد من الإنترنت');
    }
    if (res.statusCode == 401 && auth && !retried && _refresh != null) {
      if (await _tryRefresh()) return _raw(method, path, query: query, body: body, idempotencyKey: idempotencyKey, auth: auth, json: json, retried: true);
    }
    if (res.statusCode >= 400) throw _error(res);
    return res;
  }

  ApiException _error(http.Response res) {
    Map<String, dynamic>? j;
    try { j = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>; } catch (_) {}
    final msg = (j?['message'] is String) ? j!['message'] as String : (j?['message'] is List ? (j!['message'] as List).join('، ') : 'صار خطأ بالخادم (${res.statusCode})');
    return ApiException(res.statusCode, (j?['code'] as String?) ?? 'HTTP_${res.statusCode}', msg, j);
  }

  /// تجديد واحد حتى لو أكثر من طلب فشل بنفس اللحظة. فشله = انتهت الجلسة.
  Future<bool> _tryRefresh() {
    return _refreshing ??= () async {
      try {
        final res = await _client.post(_uri(refreshPath, null), headers: _headers(auth: false), body: jsonEncode({'refresh_token': _refresh}));
        if (res.statusCode != 200) throw ApiException(res.statusCode, 'REFRESH', 'انتهت الجلسة');
        final j = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
        await setTokens(j['access_token'] as String, j['refresh_token'] as String);
        return true;
      } catch (_) {
        await clearTokens();
        onSessionExpired?.call();
        return false;
      } finally {
        _refreshing = null;
      }
    }();
  }
}
