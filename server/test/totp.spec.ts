import { base32Decode, base32Encode, findValidStep, generateSecret, hotp, otpauthUri, stepAt, totpAt } from '../src/auth/totp';
import { decryptSecret, encryptSecret } from '../src/common/secret-box';
import { loadConfig } from '../src/config/config';

// مفتاح اختبار RFC 4226 / RFC 6238: ASCII "12345678901234567890"
const RFC_SECRET = Buffer.from('12345678901234567890');
const RFC_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('TOTP (RFC 4226 و RFC 6238)', () => {
  it('base32 يطابق القيمة المعروفة ويرجع للأصل', () => {
    expect(base32Encode(RFC_SECRET)).toBe(RFC_B32);
    expect(base32Decode(RFC_B32).equals(RFC_SECRET)).toBe(true);
    expect(base32Decode(RFC_B32.toLowerCase() + '====').equals(RFC_SECRET)).toBe(true);
    for (const n of [1, 5, 10, 20, 33]) {
      const buf = Buffer.alloc(n, n);
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
    expect(() => base32Decode('abc1')).toThrow();
  });

  it('HOTP يطابق متجهات RFC 4226 الرسمية (العدّاد 0..9)', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });

  it('TOTP يطابق متجهات RFC 6238 (آخر 6 خانات من القيم 8 خانات)', () => {
    // الوقت بالثواني → الرمز بـ 8 خانات بالـ RFC؛ نأخذ آخر 6
    const vectors: Array<[number, string]> = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037']];
    for (const [t, code8] of vectors) expect(totpAt(RFC_B32, t * 1000)).toBe(code8.slice(2));
  });

  it('findValidStep: نافذة ±1 خطوة، والباقي مرفوض', () => {
    const now = 1_700_000_000_000;
    const cur = stepAt(now);
    expect(findValidStep(RFC_B32, totpAt(RFC_B32, now), now)).toBe(cur);
    expect(findValidStep(RFC_B32, totpAt(RFC_B32, now - 30_000), now)).toBe(cur - 1);
    expect(findValidStep(RFC_B32, totpAt(RFC_B32, now + 30_000), now)).toBe(cur + 1);
    expect(findValidStep(RFC_B32, totpAt(RFC_B32, now - 90_000), now)).toBeNull();
    expect(findValidStep(RFC_B32, totpAt(RFC_B32, now + 90_000), now)).toBeNull();
  });

  it('findValidStep: صيغ غلط ترفض (حروف، طول، فراغات تنقبل)', () => {
    const now = 1_700_000_000_000; const good = totpAt(RFC_B32, now);
    expect(findValidStep(RFC_B32, 'abcdef', now)).toBeNull();
    expect(findValidStep(RFC_B32, good + '0', now)).toBeNull();
    expect(findValidStep(RFC_B32, good.slice(0, 5), now)).toBeNull();
    expect(findValidStep(RFC_B32, '', now)).toBeNull();
    expect(findValidStep(RFC_B32, `${good.slice(0, 3)} ${good.slice(3)}`, now)).toBe(stepAt(now));
  });

  it('المفتاح المولد 160 بت base32 وعشوائي، والرابط بصيغة otpauth', () => {
    const a = generateSecret(); const b = generateSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(a).not.toBe(b);
    const uri = otpauthUri(a, 'owner@x', 'Beauty Clinic');
    expect(uri).toBe(`otpauth://totp/Beauty%20Clinic%3Aowner%40x?secret=${a}&issuer=Beauty%20Clinic&algorithm=SHA1&digits=6&period=30`);
  });
});

describe('تشفير الأسرار AES-256-GCM', () => {
  const key = Buffer.alloc(32, 9);
  it('يفك لنفس القيمة، والمخرج ما يحتوي النص الأصلي، وكل تشفير مختلف', () => {
    const enc = encryptSecret(RFC_B32, key);
    expect(enc).not.toContain(RFC_B32);
    expect(enc.startsWith('v1.')).toBe(true);
    expect(decryptSecret(enc, key)).toBe(RFC_B32);
    expect(encryptSecret(RFC_B32, key)).not.toBe(enc);
  });
  it('مفتاح غلط أو تلاعب بالنص يفشل', () => {
    const enc = encryptSecret(RFC_B32, key);
    expect(() => decryptSecret(enc, Buffer.alloc(32, 1))).toThrow();
    const parts = enc.split('.');
    const tampered = [parts[0], parts[1], parts[2], Buffer.from('xxxxxxxx').toString('base64url')].join('.');
    expect(() => decryptSecret(tampered, key)).toThrow();
    expect(() => decryptSecret('garbage', key)).toThrow();
  });
});

describe('إعدادات التحقق الثنائي', () => {
  const base = { DATABASE_URL: 'postgres://x', JWT_SECRET: 'x'.repeat(32) } as NodeJS.ProcessEnv;
  it('TOTP_ENC_KEY إلزامي و32 بايت', () => {
    expect(() => loadConfig(base)).toThrow(/TOTP_ENC_KEY/);
    expect(() => loadConfig({ ...base, TOTP_ENC_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/TOTP_ENC_KEY/);
    expect(loadConfig({ ...base, TOTP_ENC_KEY: Buffer.alloc(32).toString('base64') }).totpEncKey).toHaveLength(32);
  });
});
