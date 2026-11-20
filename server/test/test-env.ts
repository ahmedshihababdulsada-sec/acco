// يتحمل قبل كل ملف اختبار: إعدادات بيئة الاختبار (قاعدة منفصلة، حدود رفيعة بس غير مقيدة للتكرار)
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://clinic@127.0.0.1:5544/clinic_api_test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-test-secret';
process.env.ACCESS_TTL_SECONDS = '900';
process.env.REFRESH_TTL_DAYS = '30';
process.env.LOGIN_MAX_FAILURES = '5';
process.env.LOCK_MINUTES = '15';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.OTP_RATE_LIMIT = '100000';
process.env.GLOBAL_RATE_LIMIT = '100000';
process.env.TOTP_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.TOTP_ISSUER = 'TestClinic';
process.env.UPLOAD_DIR = require('node:path').join(require('node:os').tmpdir(), 'clinic-test-uploads');
