import 'dart:convert';

import 'package:clinic_app/core/api.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response json(Object body, [int status = 200]) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json; charset=utf-8'});

void main() {
  test('errors keep server code and Arabic message', () async {
    final api = Api(baseUrl: 'http://x', client: MockClient((_) async => json({'code': 'DAY_FULL', 'message': 'اليوم ممتلئ'}, 409)));
    await expectLater(api.get('/a'), throwsA(isA<ApiException>().having((e) => e.code, 'code', 'DAY_FULL').having((e) => e.message, 'message', 'اليوم ممتلئ').having((e) => e.status, 'status', 409)));
  });

  test('validation message arrays are joined', () async {
    final api = Api(baseUrl: 'http://x', client: MockClient((_) async => json({'code': 'VALIDATION', 'message': ['أ', 'ب']}, 400)));
    await expectLater(api.get('/a'), throwsA(isA<ApiException>().having((e) => e.message, 'message', 'أ، ب')));
  });

  test('network failure becomes a friendly ApiException', () async {
    final api = Api(baseUrl: 'http://x', client: MockClient((_) async => throw Exception('offline')));
    await expectLater(api.get('/a'), throwsA(isA<ApiException>().having((e) => e.code, 'code', 'NETWORK')));
  });

  test('401 triggers exactly one refresh even for concurrent requests, then retries', () async {
    var refreshCalls = 0; const token = 'new';  // الخادم يقبل الجديد بس: القديم ينرفض ويحتاج تجديد
    final api = Api(baseUrl: 'http://x', client: MockClient((req) async {
      if (req.url.path == '/auth/refresh') { refreshCalls++; await Future<void>.delayed(const Duration(milliseconds: 20)); return json({'access_token': 'new', 'refresh_token': 'r2'}); }
      return req.headers['Authorization'] == 'Bearer $token' ? json({'ok': true}) : json({'code': 'UNAUTHORIZED', 'message': 'x'}, 401);
    }));
    await api.setTokens('old', 'r1');
    final res = await Future.wait([api.get('/a'), api.get('/b'), api.get('/c')]);
    expect(res.every((r) => (r as Map)['ok'] == true), isTrue);
    expect(refreshCalls, 1);
    expect(api.refreshToken, 'r2');
  });

  test('failed refresh clears tokens and signals session expiry', () async {
    var expired = false;
    final api = Api(baseUrl: 'http://x', client: MockClient((req) async => req.url.path == '/auth/refresh' ? json({'code': 'X', 'message': 'x'}, 401) : json({'code': 'UNAUTHORIZED', 'message': 'x'}, 401)));
    api.onSessionExpired = () => expired = true;
    await api.setTokens('a', 'r');
    await expectLater(api.get('/a'), throwsA(isA<ApiException>()));
    expect(expired, isTrue);
    expect(api.hasTokens, isFalse);
  });

  test('customer API refreshes on its own endpoint', () async {
    final seen = <String>[];
    final api = Api(baseUrl: 'http://x', refreshPath: '/customer/auth/refresh', client: MockClient((req) async {
      seen.add(req.url.path);
      if (req.url.path == '/customer/auth/refresh') return json({'access_token': 'n', 'refresh_token': 'n2'});
      return req.headers['Authorization'] == 'Bearer n' ? json({'ok': 1}) : json({'code': 'U', 'message': 'x'}, 401);
    }));
    await api.setTokens('o', 'r');
    await api.get('/customer/me');
    expect(seen, ['/customer/me', '/customer/auth/refresh', '/customer/me']);
  });

  test('idempotency key header and JSON body are sent on POST', () async {
    late http.Request got;
    final api = Api(baseUrl: 'http://x', client: MockClient((req) async { got = req; return json({'id': 1}, 201); }));
    final key = newIdempotencyKey();
    await api.post('/payments', body: {'a': 1}, idempotencyKey: key);
    expect(got.headers['Idempotency-Key'], key);
    expect(jsonDecode(got.body), {'a': 1});
    expect(key.length, 32);
    expect(newIdempotencyKey(), isNot(key));
  });

  test('null and empty query values are dropped', () async {
    late Uri uri;
    final api = Api(baseUrl: 'http://x', client: MockClient((req) async { uri = req.url; return json({}); }));
    await api.get('/a', query: {'x': 1, 'y': null, 'z': ''});
    expect(uri.queryParameters, {'x': '1'});
  });

  test('upload sends kind and file as multipart with auth', () async {
    late http.BaseRequest got;
    final api = Api(baseUrl: 'http://x', client: MockClient.streaming((req, body) async {
      got = req; await body.drain<void>();
      return http.StreamedResponse(Stream.value(utf8.encode(jsonEncode({'id': 9}))), 201, headers: {'content-type': 'application/json'});
    }));
    await api.setTokens('t', 'r');
    final r = await api.upload('/attachments', kind: 'expense_proof', bytes: [1, 2, 3], filename: 'a.png');
    expect(r['id'], 9);
    expect(got.headers['Authorization'], 'Bearer t');
    expect(got.headers['content-type'], startsWith('multipart/form-data'));
  });
}
