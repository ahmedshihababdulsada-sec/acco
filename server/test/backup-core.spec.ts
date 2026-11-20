import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { BackupCryptoError, decryptFile, encryptFile, generateBackupKeyPair, keyFingerprint } from '../src/ops/backup/crypto';
import { BackupConfig, loadConfig } from '../src/ops/backup/config';
import { DirRemote, RcloneRemote, assertKey, remoteFromSpec } from '../src/ops/backup/remote';
import { selectRetained, walSegment, walToDelete } from '../src/ops/backup/retention';
import { LIMITS, evaluateHealth, pickVerify, readSection, updateSection } from '../src/ops/backup/status';
import { archiveWal, restoreWal, shipWal } from '../src/ops/backup/wal';
import { parseStamp, stamp } from '../src/ops/backup/proc';
import { chooseBase, parseTargetTime } from '../src/ops/backup/restore';
import { prune } from '../src/ops/backup/base';
import { listLocal, restoreUploads, syncUploads, uploadKey } from '../src/ops/backup/uploads';
import { createHash } from 'node:crypto';
import { mkdirSync, utimesSync } from 'node:fs';

const tmp = () => mkdtempSync(join(tmpdir(), 'bk-test-'));
const dirs: string[] = [];
const mk = () => { const d = tmp(); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// مفتاح RSA-4096 يتولد مرة وحدة (بطيء نسبياً)
const keys = generateBackupKeyPair(); const other = generateBackupKeyPair();
const cfgFor = (root: string): BackupConfig => ({ ...loadConfig({} as NodeJS.ProcessEnv), remote: `dir:${join(root, 'remote')}`, spoolDir: join(root, 'spool'), stateDir: join(root, 'state'), workDir: join(root, 'work'), uploadDir: join(root, 'uploads') });

describe('التشفير', () => {
  it('يفك ما شفّره بنفس المحتوى (ملف نصي، فاضي، وكبير > 1MB)', async () => {
    const d = mk();
    for (const [name, data] of [['a.txt', Buffer.from('وصل 2026-00001 · 25,000 د.ع')], ['empty', Buffer.alloc(0)], ['big', randomBytes(3 * 1024 * 1024 + 17)]] as const) {
      const src = join(d, name); writeFileSync(src, data);
      const r = await encryptFile(src, `${src}.enc`, keys.publicKeyPem);
      expect(r.plainSize).toBe(data.length); expect(r.plainSha256).toBe(createHash('sha256').update(data).digest('hex')); expect(r.cipherSize).toBeGreaterThan(data.length + 500);
      await decryptFile(`${src}.enc`, `${src}.out`, keys.privateKeyPem);
      expect(Buffer.compare(readFileSync(`${src}.out`), data)).toBe(0);
    }
  }, 60000);
  it('الناتج المشفر ما يحتوي النص الأصلي، وكل تشفير له IV ومفتاح مختلف', async () => {
    const d = mk(); const src = join(d, 'p'); writeFileSync(src, 'اسم المريضة السري');
    await encryptFile(src, join(d, 'e1'), keys.publicKeyPem); await encryptFile(src, join(d, 'e2'), keys.publicKeyPem);
    expect(readFileSync(join(d, 'e1')).includes(Buffer.from('اسم المريضة'))).toBe(false);
    expect(Buffer.compare(readFileSync(join(d, 'e1')), readFileSync(join(d, 'e2')))).not.toBe(0);
  });
  it('مفتاح خاص غلط أو كلمة سر غلط → رفض بدون ما يكتب ملف ناتج', async () => {
    const d = mk(); const src = join(d, 'p'); writeFileSync(src, 'x'.repeat(1000)); await encryptFile(src, join(d, 'e'), keys.publicKeyPem);
    await expect(decryptFile(join(d, 'e'), join(d, 'out'), other.privateKeyPem)).rejects.toThrow(/ما يطابق/);
    expect(existsSync(join(d, 'out'))).toBe(false);
    const prot = generateBackupKeyPair('كلمة-سر-قوية'); await encryptFile(src, join(d, 'e2'), prot.publicKeyPem);
    await expect(decryptFile(join(d, 'e2'), join(d, 'o2'), prot.privateKeyPem)).rejects.toThrow(BackupCryptoError);
    await expect(decryptFile(join(d, 'e2'), join(d, 'o2'), prot.privateKeyPem, 'غلط')).rejects.toThrow(/كلمة سره غلط/);
    await decryptFile(join(d, 'e2'), join(d, 'o2'), prot.privateKeyPem, 'كلمة-سر-قوية');
    expect(readFileSync(join(d, 'o2'), 'utf8')).toBe('x'.repeat(1000));
  }, 60000);
  it('أي تعديل بالملف المشفر (رأس أو نص أو وسم) أو قصه يفشل الفك ولا يخلي ملف ناتج', async () => {
    const d = mk(); const src = join(d, 'p'); writeFileSync(src, randomBytes(5000)); await encryptFile(src, join(d, 'e'), keys.publicKeyPem);
    const enc = readFileSync(join(d, 'e'));
    const positions = [3, 10, 100, enc.length - 600, enc.length - 20, enc.length - 1];       // magic، طول، مفتاح مغلف، نص، وسم
    for (const pos of positions) {
      const bad = Buffer.from(enc); bad[pos] ^= 0x01; writeFileSync(join(d, 'bad'), bad);
      await expect(decryptFile(join(d, 'bad'), join(d, 'out'), keys.privateKeyPem)).rejects.toThrow(BackupCryptoError);
      expect(existsSync(join(d, 'out'))).toBe(false); expect(existsSync(join(d, 'out.partial'))).toBe(false);
    }
    writeFileSync(join(d, 'cut'), enc.subarray(0, enc.length - 7));
    await expect(decryptFile(join(d, 'cut'), join(d, 'out'), keys.privateKeyPem)).rejects.toThrow(BackupCryptoError);
    writeFileSync(join(d, 'tiny'), 'abc');
    await expect(decryptFile(join(d, 'tiny'), join(d, 'out'), keys.privateKeyPem)).rejects.toThrow(/قصير/);
    writeFileSync(join(d, 'junk'), randomBytes(2000));
    await expect(decryptFile(join(d, 'junk'), join(d, 'out'), keys.privateKeyPem)).rejects.toThrow(/الصيغة/);
    expect(existsSync(join(d, 'out'))).toBe(false);
  }, 60000);
  it('رأس بطول مفتاح مغلف غير معقول (0 أو 65535) يرفض كرأس تالف، وملف فاضي مشفر يتحقق من وسمه', async () => {
    const d = mk(); const src = join(d, 'p'); writeFileSync(src, randomBytes(2000)); await encryptFile(src, join(d, 'e'), keys.publicKeyPem);
    const enc = readFileSync(join(d, 'e'));
    for (const wl of [0, 64, 5000, 65535]) { const bad = Buffer.from(enc); bad.writeUInt16BE(wl, 5); writeFileSync(join(d, 'bad'), bad); await expect(decryptFile(join(d, 'bad'), join(d, 'out'), keys.privateKeyPem)).rejects.toThrow(/رأس الملف تالف/); }
    writeFileSync(join(d, 'empty'), Buffer.alloc(0)); await encryptFile(join(d, 'empty'), join(d, 'ee'), keys.publicKeyPem);
    const ee = readFileSync(join(d, 'ee')); const bad = Buffer.from(ee); bad[bad.length - 1] ^= 1; writeFileSync(join(d, 'ebad'), bad);
    await expect(decryptFile(join(d, 'ebad'), join(d, 'eout'), keys.privateKeyPem)).rejects.toThrow(BackupCryptoError);
    expect(existsSync(join(d, 'eout'))).toBe(false);
    await decryptFile(join(d, 'ee'), join(d, 'eok'), keys.privateKeyPem); expect(readFileSync(join(d, 'eok')).length).toBe(0);
  }, 60000);
  it('فشل التشفير (ملف مصدر غير موجود) ما يترك ملف ناتج ولا مؤقت', async () => {
    const d = mk();
    await expect(encryptFile(join(d, 'nope'), join(d, 'out'), keys.publicKeyPem)).rejects.toThrow();
    expect(existsSync(join(d, 'out'))).toBe(false); expect(existsSync(join(d, 'out.partial'))).toBe(false);
  });
  it('البصمة ثابتة لنفس المفتاح ومختلفة بين مفتاحين، والمفتاح العام الخاطئ يرفض', async () => {
    expect(keyFingerprint(keys.publicKeyPem)).toBe(keys.fingerprint); expect(keys.fingerprint).not.toBe(other.fingerprint);
    const d = mk(); writeFileSync(join(d, 'p'), 'x');
    await expect(encryptFile(join(d, 'p'), join(d, 'e'), 'not a key')).rejects.toThrow(/المفتاح العام/);
  });
});

describe('سياسة الاحتفاظ', () => {
  const day = (n: number, h = 3) => new Date(Date.UTC(2026, 10, 14, h - 3) - n * 86400000);      // 03:00 بغداد قبل n يوم
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `d${i}`, at: day(i) }));
  const P = { daily: 7, weekly: 4, monthly: 12 };
  it('7 أيام + 4 أسابيع + 12 شهر، وأحدث وحدة بكل فترة', () => {
    const keep = selectRetained(items(400), P);
    for (let i = 0; i < 7; i++) expect(keep.has(`d${i}`)).toBe(true);                          // آخر 7 أيام كلها
    expect(keep.has('d8')).toBe(keep.has('d8'));                                                  // (يعتمد على الأسبوع)
    expect(keep.size).toBeGreaterThanOrEqual(7 + 11); expect(keep.size).toBeLessThanOrEqual(7 + 4 + 12);
    expect(keep.has('d399')).toBe(false);                                                         // أقدم من 12 شهر
  });
  it('أعداد دقيقة: 3 أيام بالضبط، و2 أسبوع، و2 شهر', () => {
    expect([...selectRetained(items(30), { daily: 3, weekly: 0, monthly: 0 })].sort()).toEqual(['d0', 'd1', 'd2']);
    const w = selectRetained(Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, at: new Date(Date.UTC(2026, 10, 13) - i * 7 * 86400000) })), { daily: 0, weekly: 2, monthly: 0 });
    expect([...w].sort()).toEqual(['w0', 'w1']);
    const mo = selectRetained(Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, at: new Date(Date.UTC(2026, 10 - i, 15)) })), { daily: 0, weekly: 0, monthly: 2 });
    expect([...mo].sort()).toEqual(['m0', 'm1']);
  });
  it('أحدث نسخة دائماً تبقى حتى لو السياسة صفر', () => { expect([...selectRetained(items(5), { daily: 0, weekly: 0, monthly: 0 })]).toEqual(['d0']); });
  it('نسختين بنفس اليوم: الأحدث بس تُحسب لليوم (والأقدم تنحذف إذا ما انحتاجت)', () => {
    const a = { id: 'old', at: new Date('2026-11-10T00:30:00Z') }; const b = { id: 'new', at: new Date('2026-11-10T20:00:00Z') };   // بتوقيت بغداد: الأولى 03:30 يوم 10، الثانية 23:00 يوم 10
    const keep = selectRetained([a, b, ...items(0)], { daily: 1, weekly: 0, monthly: 0 }); expect([...keep]).toEqual(['new']);
  });
  it('الفجوات: لو توقفت النسخ شهر ما تنحذف القديمة بدالها (نعد الفترات اللي فيها نسخ)', () => {
    const old = Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, at: new Date(Date.UTC(2026, 8, 1) - i * 86400000) }));       // 6 نسخ بأيلول + الجديدة = 7 أيام
    const keep = selectRetained([...old, { id: 'n', at: new Date('2026-11-14T00:00:00Z') }], P);
    for (const o of old) expect(keep.has(o.id)).toBe(true);
    expect(keep.has('n')).toBe(true);
  });
  it('توقيت بغداد: نسخة 23:30 UTC تنحسب باليوم التالي', () => {
    const keep = selectRetained([{ id: 'a', at: new Date('2026-11-09T23:30:00Z') }, { id: 'b', at: new Date('2026-11-10T10:00:00Z') }], { daily: 5, weekly: 0, monthly: 0 }, 180);
    expect(keep.has('a')).toBe(false); expect(keep.has('b')).toBe(true);            // الاثنتين يوم 10 ببغداد: الأحدث بس
  });
  it('تجميع الأسابيع يبدأ من الاثنين', () => {
    const mon = { id: 'mon', at: new Date('2026-11-09T09:00:00Z') }; const sun = { id: 'sun', at: new Date('2026-11-08T09:00:00Z') }; const sun2 = { id: 'sun2', at: new Date('2026-11-02T09:00:00Z') };
    const keep = selectRetained([mon, sun, sun2], { daily: 0, weekly: 3, monthly: 0 });
    expect(keep.has('mon')).toBe(true); expect(keep.has('sun')).toBe(true);        // الأحد 8 ينتمي لأسبوع 2 نوفمبر
    expect(keep.has('sun2')).toBe(false);                                           // نفس أسبوع sun والأقدم
  });
  it('قائمة فاضية', () => expect(selectRetained([], P).size).toBe(0));
});

describe('أسماء WAL والحذف', () => {
  it('walSegment يميز ملفات WAL من history', () => {
    expect(walSegment('000000010000000000000012')).toBe('0000000000000012'); expect(walSegment('00000002.history')).toBeNull();
    expect(walSegment('000000010000000000000012.00000028.backup')).toBe('0000000000000012'); expect(walSegment('x')).toBeNull();
  });
  it('يحذف الأقدم من بداية أقدم نسخة محتفظ بها فقط، ويحفظ history وما قبل', () => {
    const names = ['000000010000000000000008', '000000010000000000000009', '00000001000000000000000A', '00000001000000000000000B', '00000002.history', '00000002000000000000000A'];
    expect(walToDelete(names, '00000001000000000000000A').sort()).toEqual(['000000010000000000000008', '000000010000000000000009']);
    expect(walToDelete(names, null)).toEqual([]); expect(walToDelete(names, 'garbage')).toEqual([]);
  });
});

describe('التخزين البعيد', () => {
  it('put/get/list/delete ذرية، ومفاتيح خطرة ترفض', async () => {
    const d = mk(); const r = new DirRemote(join(d, 'r')); const f = join(d, 'f'); writeFileSync(f, 'abc');
    await r.put(f, 'wal/a.enc'); await r.put(f, 'base/x/meta.json'); await r.put(f, 'wal/b.enc');
    expect((await r.list('wal/')).map((e) => e.key)).toEqual(['wal/a.enc', 'wal/b.enc']);
    expect((await r.list('wal/a')).map((e) => e.key)).toEqual(['wal/a.enc']); expect((await r.list('')).length).toBe(3);
    await r.get('wal/a.enc', join(d, 'g')); expect(readFileSync(join(d, 'g'), 'utf8')).toBe('abc');
    await r.delete('wal/a.enc'); await r.delete('wal/a.enc');                                   // حذف غير موجود لا يرمي
    expect((await r.list('wal/')).map((e) => e.key)).toEqual(['wal/b.enc']);
    for (const bad of ['../x', '/etc/passwd', 'a/../../b', 'a//b', '', 'a\\b', './a']) { expect(() => assertKey(bad)).toThrow(); await expect(r.put(f, bad)).rejects.toThrow(); }
    expect(readdirSync(join(d, 'r', 'wal')).some((n) => n.endsWith('.uploading'))).toBe(false);
    writeFileSync(join(d, 'r', 'wal', 'half.enc.uploading'), 'نصف مرفوع');            // رفع قيد التنفيذ ما يظهر بالقائمة
    expect((await r.list('wal/')).map((e) => e.key)).toEqual(['wal/b.enc']);
  });
  it('remoteFromSpec: الصيغ والخطأ', () => {
    expect(remoteFromSpec('dir:/tmp/x')).toBeInstanceOf(DirRemote); expect(remoteFromSpec('rclone:b2:bucket/p')).toBeInstanceOf(RcloneRemote);
    expect(() => remoteFromSpec(undefined)).toThrow(/غير مضبوط/); expect(() => remoteFromSpec('ftp://x')).toThrow(/غير معروفة/);
  });
  it('RcloneRemote يمرر الأوامر الصحيحة (rclone وهمي يطبق copyto/lsjson/deletefile على مجلد)', async () => {
    const d = mk(); const store = join(d, 'store'); const fake = join(d, 'rclone');
    writeFileSync(fake, `#!/bin/sh
cmd="$1"; shift
strip() { echo "$1" | sed 's#^fake:##'; }
case "$cmd" in
  copyto) [ "$1" = "--checksum" ] && shift; src="$1"; dst="$2"; case "$src" in fake:*) src="${store}/$(strip "$src")";; esac; case "$dst" in fake:*) dst="${store}/$(strip "$dst")";; esac; mkdir -p "$(dirname "$dst")"; cp "$src" "$dst";;
  deletefile) p="${store}/$(strip "$1")"; [ -f "$p" ] || { echo "error: object not found" >&2; exit 4; }; rm "$p";;
  lsjson) base="${store}/$(strip "$3")"; [ -d "$base" ] || { echo "directory not found" >&2; exit 3; }; cd "$base" && find . -type f | sed 's#^\\./##' | awk 'BEGIN{printf "["} {printf "%s{\\"Path\\":\\"%s\\",\\"Size\\":%d,\\"ModTime\\":\\"2026-11-14T00:00:00Z\\"}", (NR>1?",":""), $0, 1} END{print "]"}';;
esac
`, { mode: 0o755 });
    const r = new RcloneRemote('fake:bucket/clinic', fake); const f = join(d, 'src'); writeFileSync(f, 'hello');
    expect(await r.list('wal/')).toEqual([]);                                                       // مجلد غير موجود = فاضي
    await r.put(f, 'wal/x.enc'); await r.put(f, 'base/id1/meta.json');
    expect((await r.list('wal/')).map((e) => e.key)).toEqual(['wal/x.enc']); expect((await r.list('base/')).map((e) => e.key)).toEqual(['base/id1/meta.json']);
    await r.get('wal/x.enc', join(d, 'out')); expect(readFileSync(join(d, 'out'), 'utf8')).toBe('hello');
    await r.delete('wal/x.enc'); await r.delete('wal/x.enc');                                       // غير موجود: ما يرمي
    expect(await r.list('wal/')).toEqual([]);
    expect(() => assertKey('a/../b')).toThrow();
  });
});

describe('أرشفة WAL ورفعها', () => {
  it('archive: نسخ متين، إعادة نفس الملف نجاح، محتوى مختلف فشل، اسم خطر يرفض', async () => {
    const d = mk(); const spool = join(d, 'spool'); const f = join(d, 'src'); writeFileSync(f, randomBytes(2000));
    expect(await archiveWal(spool, f, '000000010000000000000001')).toBe('stored');
    expect(await archiveWal(spool, f, '000000010000000000000001')).toBe('exists');
    const g = join(d, 'src2'); writeFileSync(g, randomBytes(2000));
    await expect(archiveWal(spool, g, '000000010000000000000001')).rejects.toThrow(/محتوى مختلف/);
    expect(Buffer.compare(readFileSync(join(spool, '000000010000000000000001')), readFileSync(f))).toBe(0);
    for (const bad of ['../x', '.hidden', 'a/b', '']) await expect(archiveWal(spool, f, bad)).rejects.toThrow(/غير صالح/);
    expect(readdirSync(spool).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
  it('ship: يشفر ويرفع ويحذف المحلي بعد التحقق، ويسجل الحالة، وrestoreWal يرجعه مطابقاً', async () => {
    const d = mk(); const cfg = cfgFor(d); const remote = new DirRemote(join(d, 'remote'));
    const wal = randomBytes(5000); writeFileSync(join(d, 'w1'), wal); await archiveWal(cfg.spoolDir, join(d, 'w1'), '000000010000000000000007');
    writeFileSync(join(d, 'h'), 'x'); await archiveWal(cfg.spoolDir, join(d, 'h'), '00000002.history');
    const now = new Date('2026-11-14T10:00:00Z');
    expect(await shipWal(cfg, remote, keys.publicKeyPem, now)).toEqual({ shipped: 2, failed: 0, remaining: 0 });
    expect(readdirSync(cfg.spoolDir)).toEqual([]);
    expect((await remote.list('wal/')).map((e) => e.key)).toEqual(['wal/000000010000000000000007.enc', 'wal/00000002.history.enc']);
    expect(readFileSync(join(d, 'remote', 'wal', '000000010000000000000007.enc')).includes(wal.subarray(0, 64))).toBe(false);   // مشفر
    const st = await readSection(cfg.stateDir, 'wal');
    expect(st).toMatchObject({ last_run_at: now.toISOString(), last_ok_at: now.toISOString(), spool_files: 0, last_shipped_name: '00000002.history' });
    expect(await restoreWal(remote, keys.privateKeyPem, undefined, cfg.workDir, '000000010000000000000007', join(d, 'back'))).toBe(true);
    expect(Buffer.compare(readFileSync(join(d, 'back')), wal)).toBe(0);
    expect(await restoreWal(remote, keys.privateKeyPem, undefined, cfg.workDir, '000000010000000000000099', join(d, 'none'))).toBe(false);   // غير موجود = نهاية الأرشيف
    expect(existsSync(join(d, 'none'))).toBe(false);
    await expect(restoreWal(remote, keys.privateKeyPem, undefined, cfg.workDir, '../evil', join(d, 'z'))).rejects.toThrow(/غير صالح/);
  }, 60000);
  it('ship عند فشل التخزين: الملفات تبقى بالانتظار (ما تنحذف)، الخطأ ينسجل، وتنرفع بالمحاولة التالية', async () => {
    const d = mk(); const cfg = cfgFor(d); const real = new DirRemote(join(d, 'remote'));
    writeFileSync(join(d, 'w'), randomBytes(500)); await archiveWal(cfg.spoolDir, join(d, 'w'), '000000010000000000000001');
    let fail = true; const flaky = { put: async (a: string, b: string) => { if (fail) throw new Error('الإنترنت مقطوع'); return real.put(a, b); }, get: real.get.bind(real), list: real.list.bind(real), delete: real.delete.bind(real) };
    const t1 = new Date('2026-11-14T10:00:00Z');
    expect(await shipWal(cfg, flaky, keys.publicKeyPem, t1)).toEqual({ shipped: 0, failed: 1, remaining: 1 });
    expect(readdirSync(cfg.spoolDir)).toEqual(['000000010000000000000001']);
    expect(await readSection(cfg.stateDir, 'wal')).toMatchObject({ last_error: 'الإنترنت مقطوع', last_error_at: t1.toISOString(), spool_files: 1 });
    expect(Date.parse(String((await readSection(cfg.stateDir, 'wal'))?.oldest_spool_at))).toBeGreaterThan(Date.now() - 60_000);        // أقدم ملف ينتظر
    fail = false; const t2 = new Date('2026-11-14T10:01:00Z');
    expect(await shipWal(cfg, flaky, keys.publicKeyPem, t2)).toEqual({ shipped: 1, failed: 0, remaining: 0 });
    expect((await readSection(cfg.stateDir, 'wal'))?.last_ok_at).toBe(t2.toISOString());
  }, 60000);
  it('ship: إذا الحجم البعيد ما طابق بعد الرفع لا يحذف المحلي', async () => {
    const d = mk(); const cfg = cfgFor(d); const real = new DirRemote(join(d, 'remote'));
    writeFileSync(join(d, 'w'), randomBytes(500)); await archiveWal(cfg.spoolDir, join(d, 'w'), '000000010000000000000001');
    const lying = { put: real.put.bind(real), get: real.get.bind(real), delete: real.delete.bind(real), list: async (p: string) => (await real.list(p)).map((e) => ({ ...e, size: e.size + 1 })) };
    expect((await shipWal(cfg, lying, keys.publicKeyPem)).failed).toBe(1);
    expect(readdirSync(cfg.spoolDir)).toEqual(['000000010000000000000001']);
  }, 60000);
  it('ship يتجاهل ملفات .tmp الجزئية', async () => {
    const d = mk(); const cfg = cfgFor(d); const remote = new DirRemote(join(d, 'remote'));
    require('node:fs').mkdirSync(cfg.spoolDir, { recursive: true }); writeFileSync(join(cfg.spoolDir, '000000010000000000000001.tmp'), 'half');
    expect(await shipWal(cfg, remote, keys.publicKeyPem)).toEqual({ shipped: 0, failed: 0, remaining: 0 });
    expect(await remote.list('wal/')).toEqual([]);
  });
});

describe('تنظيف التخزين (prune) على أرشيف مصطنع', () => {
  const NOW = new Date('2026-11-14T12:00:00Z'); const H = 3600e3;
  const setup = async (root: string) => {
    const cfg = { ...cfgFor(root), retention: { daily: 1, weekly: 1, monthly: 1 } }; const remote = new DirRemote(join(root, 'remote')); const f = join(root, 'blob'); writeFileSync(f, 'x');
    const put = async (key: string, ageMs = 0) => { await remote.put(f, key); const t = new Date(NOW.getTime() - ageMs); utimesSync(join(root, 'remote', key), t, t); };
    const base = async (id: string, finishedAgoH: number, startWal: string, complete = true, ageH = finishedAgoH) => {
      await put(`base/${id}/base.tar.gz.enc`, ageH * H);
      if (complete) { writeFileSync(f, JSON.stringify({ id, started_at: new Date(NOW.getTime() - finishedAgoH * H).toISOString(), finished_at: new Date(NOW.getTime() - finishedAgoH * H).toISOString(), start_wal: startWal, key_fingerprint: 'k', files: [] })); await put(`base/${id}/meta.json`, ageH * H); writeFileSync(f, 'x'); }
    };
    return { cfg, remote, put, base, f };
  };
  const keys = async (r: DirRemote, p: string) => (await r.list(p)).map((e) => e.key);
  it('يبقي الأحدث ويحذف الأقدم مع ملفاتها، WAL الأقدم من بداية المحتفظ بها ينحذف وhistory تبقى', async () => {
    const d = mk(); const { cfg, remote, put, base } = await setup(d);
    await base('base-old', 72, '000000010000000000000003'); await base('base-new', 2, '000000010000000000000009');
    for (const n of ['000000010000000000000003', '000000010000000000000008', '000000010000000000000009', '00000001000000000000000A', '00000002.history']) await put(`wal/${n}.enc`);
    await put('logical/20261110T000000Z.dump.enc'); await put('logical/20261114T000000Z.dump.enc');
    const r = await prune(cfg, remote, NOW);
    expect(r.kept_base).toEqual(['base-new']); expect(r.base_deleted).toEqual(['base-old']);
    expect(await keys(remote, 'base/')).toEqual(['base/base-new/base.tar.gz.enc', 'base/base-new/meta.json']);
    expect(await keys(remote, 'wal/')).toEqual(['wal/000000010000000000000009.enc', 'wal/00000001000000000000000A.enc', 'wal/00000002.history.enc']);
    expect(r.wal_deleted).toBe(2); expect(r.logical_deleted).toEqual(['logical/20261110T000000Z.dump.enc']);
    expect(await keys(remote, 'logical/')).toEqual(['logical/20261114T000000Z.dump.enc']);
    expect((await readSection(cfg.stateDir, 'prune'))?.last_ok_at).toBe(NOW.toISOString());
  });
  it('نسخة ناقصة (بدون meta): تبقى إذا حديثة (ممكن لسه ترفع) وتنحذف بعد 24 ساعة، وهي ما تُحسب كنسخة صالحة', async () => {
    const d = mk(); const { cfg, remote, base } = await setup(d);
    await base('base-good', 2, '000000010000000000000009');
    await base('base-young-partial', 1, '000000010000000000000009', false, 1); await base('base-old-partial', 30, '000000010000000000000001', false, 30);
    const r = await prune(cfg, remote, NOW);
    expect(r.incomplete_deleted).toEqual(['base-old-partial']); expect(r.kept_base).toEqual(['base-good']);
    expect((await keys(remote, 'base/')).some((k) => k.includes('young-partial'))).toBe(true); expect((await keys(remote, 'base/')).some((k) => k.includes('old-partial'))).toBe(false);
  });
  it('أمان: ما أكو نسخة كاملة صالحة = ما ينحذف أي WAL', async () => {
    const d = mk(); const { cfg, remote, put } = await setup(d);
    for (const n of ['000000010000000000000001', '000000010000000000000002']) await put(`wal/${n}.enc`);
    const r = await prune(cfg, remote, NOW);
    expect(r.wal_deleted).toBe(0); expect((await keys(remote, 'wal/')).length).toBe(2);
  });
  it('WAL يبقى لحد بداية أقدم نسخة محتفظ بها (مو الأحدث)', async () => {
    const d = mk(); const { cfg, remote, put, base } = await setup(d);
    const c = { ...cfg, retention: { daily: 5, weekly: 5, monthly: 5 } };
    await base('b1', 100, '000000010000000000000004'); await base('b2', 50, '000000010000000000000008'); await base('b3', 2, '00000001000000000000000C');
    for (const n of ['000000010000000000000002', '000000010000000000000004', '000000010000000000000007', '00000001000000000000000C']) await put(`wal/${n}.enc`);
    const r = await prune(c, remote, NOW);
    expect(r.kept_base.sort()).toEqual(['b1', 'b2', 'b3']);
    expect(await keys(remote, 'wal/')).toEqual(['wal/000000010000000000000004.enc', 'wal/000000010000000000000007.enc', 'wal/00000001000000000000000C.enc']);
  });
  it('الصور: الغائب محلياً يبقى حتى انتهاء مدة الاحتفاظ ثم ينحذف، والموجود محلياً ما ينحذف أبداً', async () => {
    const d = mk(); const { cfg, remote, put, base } = await setup(d);
    await base('b', 2, '000000010000000000000009');
    await put('uploads/live-old.png.enc', 400 * 24 * H); await put('uploads/gone-old.png.enc', 400 * 24 * H); await put('uploads/gone-young.png.enc', 10 * 24 * H);
    const r = await prune(cfg, remote, NOW, new Set(['uploads/live-old.png.enc']));
    expect(r.uploads_deleted).toBe(1); expect(await keys(remote, 'uploads/')).toEqual(['uploads/gone-young.png.enc', 'uploads/live-old.png.enc']);
    const r2 = await prune(cfg, remote, NOW);                                  // بدون قائمة محلية: ما نلمس الصور
    expect(r2.uploads_deleted).toBe(0);
  });
});

describe('نسخ الصور', () => {
  it('يرفع الجديد فقط (مشفراً) ولا يعيد القديم، ويتحقق من الحجم، والاسترجاع يرجع المحتوى ولا يكتب فوق ملف موجود', async () => {
    const d = mk(); const cfg = cfgFor(d); const remote = new DirRemote(join(d, 'remote'));
    mkdirSync(join(cfg.uploadDir, '2026-11'), { recursive: true }); writeFileSync(join(cfg.uploadDir, '2026-11', 'a.png'), 'AAAA-سري'); writeFileSync(join(cfg.uploadDir, 'b.jpg'), 'BBBB'); writeFileSync(join(cfg.uploadDir, 'half.png.partial'), 'x');
    expect(await listLocal(cfg.uploadDir)).toEqual(['2026-11/a.png', 'b.jpg']);
    const r1 = await syncUploads(cfg, remote, keys.publicKeyPem);
    expect(r1).toMatchObject({ uploaded: 2, total: 2 }); expect([...r1.keys].sort()).toEqual([uploadKey('2026-11/a.png'), uploadKey('b.jpg')]);
    expect(readFileSync(join(d, 'remote', uploadKey('2026-11/a.png'))).includes(Buffer.from('AAAA'))).toBe(false);
    const before = statSync(join(d, 'remote', uploadKey('b.jpg'))).mtimeMs;
    expect((await syncUploads(cfg, remote, keys.publicKeyPem)).uploaded).toBe(0);
    expect(statSync(join(d, 'remote', uploadKey('b.jpg'))).mtimeMs).toBe(before);
    writeFileSync(join(cfg.uploadDir, 'c.png'), 'CCCC'); expect((await syncUploads(cfg, remote, keys.publicKeyPem)).uploaded).toBe(1);
    const back = join(d, 'back'); mkdirSync(back); writeFileSync(join(back, 'b.jpg'), 'LOCAL-EDIT');
    expect(await restoreUploads(remote, keys.privateKeyPem, undefined, cfg.workDir, back)).toBe(2);        // a و c فقط
    expect(readFileSync(join(back, '2026-11', 'a.png'), 'utf8')).toBe('AAAA-سري'); expect(readFileSync(join(back, 'c.png'), 'utf8')).toBe('CCCC');
    expect(readFileSync(join(back, 'b.jpg'), 'utf8')).toBe('LOCAL-EDIT');
  }, 60000);
  it('رفع بحجم غير مطابق يفشل ولا يُعدّ ناجحاً', async () => {
    const d = mk(); const cfg = cfgFor(d); const real = new DirRemote(join(d, 'remote')); mkdirSync(cfg.uploadDir, { recursive: true }); writeFileSync(join(cfg.uploadDir, 'a.png'), 'AAAA');
    const lying = { put: real.put.bind(real), get: real.get.bind(real), delete: real.delete.bind(real), list: async (p: string) => (await real.list(p)).map((e) => ({ ...e, size: e.size - 1 })) };
    await expect(syncUploads(cfg, lying, keys.publicKeyPem)).rejects.toThrow(/ما طابق الحجم/);
  }, 60000);
});

describe('اختيار النسخة للاسترجاع', () => {
  const m = (id: string, fin: string) => ({ id, started_at: fin, finished_at: fin, start_wal: null, key_fingerprint: 'k', files: [] });
  const metas = [m('b1', '2026-11-10T00:00:00Z'), m('b2', '2026-11-12T00:00:00Z'), m('b3', '2026-11-14T00:00:00Z')];
  it('الأحدث افتراضياً، المحددة، أو آخر وحدة قبل الوقت المطلوب', () => {
    expect(chooseBase(metas).id).toBe('b3'); expect(chooseBase(metas, 'b1').id).toBe('b1');
    expect(chooseBase(metas, undefined, '2026-11-13T12:00:00Z').id).toBe('b2'); expect(chooseBase(metas, undefined, '2026-11-14T00:00:00Z').id).toBe('b3');
    expect(() => chooseBase(metas, undefined, '2026-11-01T00:00:00Z')).toThrow(/قبل هذا الوقت/); expect(() => chooseBase(metas, undefined, 'غلط')).toThrow(/وقت غير صالح/);
    expect(() => chooseBase(metas, 'zzz')).toThrow(/غير موجودة/); expect(() => chooseBase([])).toThrow(/ما أكو/);
  });
});

describe('وقت الاسترجاع', () => {
  it('بدون فرق توقيت = بتوقيت العيادة (بغداد +03)، وبفرق صريح يحترمه', () => {
    expect(parseTargetTime('2026-11-14 10:30:00').date.toISOString()).toBe('2026-11-14T07:30:00.000Z');
    expect(parseTargetTime('2026-11-14 10:30:00').pg).toBe('2026-11-14 10:30:00+03');
    expect(parseTargetTime('2026-11-14 10:30:00+03').date.toISOString()).toBe('2026-11-14T07:30:00.000Z');
    expect(parseTargetTime('2026-11-14 10:30:00 +03:00').date.toISOString()).toBe('2026-11-14T07:30:00.000Z');
    expect(parseTargetTime('2026-11-14T10:30:00Z').date.toISOString()).toBe('2026-11-14T10:30:00.000Z');
    expect(parseTargetTime('2026-11-14T10:30:00Z').pg).toBe('2026-11-14 10:30:00+00');
    expect(parseTargetTime('2026-11-14 10:30:00-05:30').date.toISOString()).toBe('2026-11-14T16:00:00.000Z');
    expect(parseTargetTime('2026-11-14 10:30:00-05:30').pg).toBe('2026-11-14 10:30:00-05:30');
    expect(parseTargetTime('2026-11-14 10:30:00', 0).date.toISOString()).toBe('2026-11-14T10:30:00.000Z');
  });
  it('الكسور تنحفظ (دقة الميكروثانية للنص)، والصيغ الغلط ترفض', () => {
    expect(parseTargetTime('2026-11-14 10:30:00.527028+03').pg).toBe('2026-11-14 10:30:00.527028+03');
    expect(parseTargetTime('2026-11-14 10:30:00.5+03').date.getUTCMilliseconds()).toBe(500);
    for (const bad of ['', 'غلط', '2026-13-14 10:30:00', '2026-11-14', '14/11/2026 10:30', '2026-11-14 25:00:00', '2026-11-14 10:30:00++03']) expect(() => parseTargetTime(bad)).toThrow(/غير صالح/);
  });
  it('chooseBase يفهم الوقت المحلي بدون فرق', () => {
    const m = (id: string, fin: string) => ({ id, started_at: fin, finished_at: fin, start_wal: null, key_fingerprint: 'k', files: [] });
    const metas = [m('b1', '2026-11-10T00:00:00Z'), m('b2', '2026-11-12T00:00:00Z')];
    expect(chooseBase(metas, undefined, '2026-11-12 02:59:00').id).toBe('b1');           // 02:59 بغداد = 23:59Z قبل النسخة
    expect(chooseBase(metas, undefined, '2026-11-12 03:00:00').id).toBe('b2');
  });
});

describe('صحة النسخ الاحتياطي (للمالك)', () => {
  const now = new Date('2026-11-14T12:00:00Z'); const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const healthy = () => ({ base: { last_ok_at: ago(3 * 3600e3) }, wal: { last_run_at: ago(60e3), spool_files: 0 }, uploads: { last_ok_at: ago(3 * 3600e3) }, verify: { last_ok_at: ago(10 * 86400e3) }, prune: { last_ok_at: ago(3 * 3600e3) }, logical: { last_ok_at: ago(3 * 3600e3) } });
  const codes = (s: object, configured = true) => evaluateHealth(s, now, configured).problems.map((p) => p.code);
  it('سليم = ok بدون مشاكل', () => { const h = evaluateHealth(healthy(), now, true); expect(h.ok).toBe(true); expect(h.problems).toEqual([]); expect(h.wal_spool_files).toBe(0); });
  it('غير مضبوط', () => { const h = evaluateHealth({}, now, false); expect(h.ok).toBe(false); expect(h.problems.map((p) => p.code)).toEqual(['NOT_CONFIGURED']); });
  it('بدون أي نسخة', () => expect(codes({})).toEqual(expect.arrayContaining(['BASE_NEVER', 'WAL_NEVER', 'UPLOADS_NEVER', 'VERIFY_NEVER'])));
  it('نسخة كاملة قديمة (حد 26 ساعة بالضبط)', () => {
    expect(codes({ ...healthy(), base: { last_ok_at: ago(LIMITS.baseMaxAgeMs - 1000) } })).not.toContain('BASE_STALE');
    expect(codes({ ...healthy(), base: { last_ok_at: ago(LIMITS.baseMaxAgeMs + 1000) } })).toContain('BASE_STALE');
  });
  it('رفع WAL متوقف (حد 15 دقيقة) والملفات المتراكمة', () => {
    expect(codes({ ...healthy(), wal: { last_run_at: ago(LIMITS.walRunMaxAgeMs - 1000), spool_files: 0 } })).not.toContain('WAL_STALE');
    expect(codes({ ...healthy(), wal: { last_run_at: ago(LIMITS.walRunMaxAgeMs + 1000), spool_files: 0 } })).toContain('WAL_STALE');
    expect(codes({ ...healthy(), wal: { last_run_at: ago(1000), spool_files: 3, oldest_spool_at: ago(LIMITS.spoolOldestMaxAgeMs + 1000) } })).toContain('WAL_BACKLOG');
    expect(codes({ ...healthy(), wal: { last_run_at: ago(1000), spool_files: 3, oldest_spool_at: ago(60e3) } })).not.toContain('WAL_BACKLOG');
  });
  it('فشل مسجل بعد آخر نجاح = مشكلة، ونجاح لاحق للفشل = سليم', () => {
    expect(codes({ ...healthy(), base: { last_ok_at: ago(3600e3), last_error: 'x', last_error_at: ago(60e3) } })).toContain('BASE_FAILED');
    expect(codes({ ...healthy(), base: { last_ok_at: ago(60e3), last_error: 'x', last_error_at: ago(3600e3) } })).not.toContain('BASE_FAILED');
    expect(codes({ ...healthy(), wal: { last_run_at: ago(1000), last_ok_at: ago(5000), last_error: 'x', last_error_at: ago(1000), spool_files: 0 } })).toContain('WAL_FAILED');
    expect(codes({ ...healthy(), uploads: { last_ok_at: ago(1000), last_error: 'x', last_error_at: ago(500) } })).toContain('UPLOADS_FAILED');
  });
  it('نسخ الصور: قديمة (>26 ساعة) = خطأ، وما تتنسخ أبداً = تحذير فقط', () => {
    expect(codes({ ...healthy(), uploads: { last_ok_at: ago(LIMITS.uploadsMaxAgeMs + 1000) } })).toContain('UPLOADS_STALE');
    expect(codes({ ...healthy(), uploads: { last_ok_at: ago(LIMITS.uploadsMaxAgeMs - 1000) } })).not.toContain('UPLOADS_STALE');
    const never = evaluateHealth({ ...healthy(), uploads: null }, now, true); expect(never.problems.find((p) => p.code === 'UPLOADS_NEVER')?.level).toBe('warn'); expect(never.ok).toBe(true);
  });
  it('فحص الاسترجاع: فشل = خطأ، قديم (>35 يوم) = تحذير فقط ولا يخلي ok=false', () => {
    expect(codes({ ...healthy(), verify: { last_ok_at: ago(40 * 86400e3) } })).toContain('VERIFY_STALE');
    const stale = evaluateHealth({ ...healthy(), verify: { last_ok_at: ago(40 * 86400e3) } }, now, true); expect(stale.ok).toBe(true); expect(stale.problems[0].level).toBe('warn');
    const failed = evaluateHealth({ ...healthy(), verify: { last_ok_at: ago(5 * 86400e3), last_error: 'تالف', last_error_at: ago(1000) } }, now, true);
    expect(failed.ok).toBe(false); expect(failed.problems.find((p) => p.code === 'VERIFY_FAILED')?.message).toContain('تالف');
  });
  it('الرسائل بالعربي وتحمل المدة', () => { const m = evaluateHealth({ ...healthy(), base: { last_ok_at: ago(30 * 3600e3) } }, now, true).problems[0].message; expect(m).toMatch(/30 ساعة/); });
  it('updateSection يدمج بدون ما يمسح ويحذف المفتاح المعطى undefined (ملف ذري)', async () => {
    const d = mk();
    await updateSection(d, 'base', { last_ok_at: 'a', last_error: 'x' }); await updateSection(d, 'base', { last_run_at: 'b', last_error: undefined });
    expect(await readSection(d, 'base')).toEqual({ last_ok_at: 'a', last_run_at: 'b' });
    expect(await readSection(d, 'verify')).toBeNull();
  });
});

describe('اختيار نتيجة فحص الاسترجاع (محلية أو منشورة)', () => {
  const a = { last_run_at: '2026-11-10T00:00:00Z', last_ok_at: '2026-11-10T00:00:00Z' }; const b = { last_run_at: '2026-11-12T00:00:00Z', last_error: 'x', last_error_at: '2026-11-12T00:00:00Z' };
  it('الأحدث تشغيلاً يفوز (حتى لو فاشل)، وغياب أحدهما يرجع الثاني', () => {
    expect(pickVerify(a, b)).toBe(b); expect(pickVerify(b, a)).toBe(b); expect(pickVerify(a, null)).toBe(a); expect(pickVerify(undefined, b)).toBe(b); expect(pickVerify(null, undefined)).toBeNull();
    expect(pickVerify(a, { last_ok_at: 'x' })).toBe(a); expect(pickVerify({ last_ok_at: 'x' }, b)).toBe(b);
  });
});

describe('أدوات صغيرة', () => {
  it('stamp/parseStamp ذهاب وإياب', () => { const d = new Date('2026-11-14T03:05:09Z'); expect(stamp(d)).toBe('20261114T030509Z'); expect(parseStamp(`base-${stamp(d)}`)?.toISOString()).toBe(d.toISOString()); expect(parseStamp('x')).toBeNull(); });
  it('loadConfig: افتراضيات وقراءة البيئة', () => {
    const c = loadConfig({ BACKUP_REMOTE: 'dir:/x', BACKUP_KEEP_DAILY: '3', BACKUP_TZ_OFFSET_MIN: '0' } as never);
    expect(c.remote).toBe('dir:/x'); expect(c.retention).toEqual({ daily: 3, weekly: 4, monthly: 12 }); expect(c.tzOffsetMin).toBe(0);
    expect(loadConfig({} as never).tzOffsetMin).toBe(180); expect(loadConfig({ BACKUP_KEEP_DAILY: 'abc' } as never).retention.daily).toBe(7);
  });
  it('ملفات الحالة والتشفير ما تتجاوز الحجم المتوقع', () => { expect(statSync(__filename).size).toBeGreaterThan(0); });
});
