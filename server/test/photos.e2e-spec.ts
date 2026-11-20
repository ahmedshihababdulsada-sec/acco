import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { AttachmentsService } from '../src/attachments/attachments.service';
import { auth, makeApp, pool, seedUser, tokenFor } from './helpers';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = () => Buffer.concat([PNG, randomBytes(64)]);
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(64)]);

interface World { id: number; code: string; mgr: string; mgrId: number; cash: string; nurse: string; docA: string; docAId: number; docB: string; cashMethod: number; svc: number }

describe('صور قبل/بعد، الشعار، التحذير من الصورة المكررة، تنظيف اليتيمة، وإلغاء السحب', () => {
  let app: INestApplication; let db: Pool; let today: string; let owner: string; let attachments: AttachmentsService;
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(url).set(auth(t));
  const post = (t: string, url: string, body: object = {}) => http().post(url).set(auth(t)).send(body);
  const put = (t: string, url: string, body: object) => http().put(url).set(auth(t)).send(body);
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  let phoneSeq = 0; let seq = 0;
  const key = () => `ph-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

  async function world(code: string): Promise<World> {
    const id = Number((await db.query(`insert into branches (code, name) values ($1,$1) returning id`, [code])).rows[0].id);
    await db.query(`insert into safes (branch_id) values ($1)`, [id]);
    const mgrId = await seedUser(db, `mgr_${code}`, 'manager', id); await seedUser(db, `cash_${code}`, 'cashier', id);
    await seedUser(db, `nurse_${code}`, 'nurse', id);
    const docAId = await seedUser(db, `docA_${code}`, 'doctor', id); await seedUser(db, `docB_${code}`, 'doctor', id);
    await db.query(`insert into safe_movements (branch_id, direction, amount, kind, note, created_by) values ($1,'in',100000000,'opening_balance','تجربة',$2)`, [id, mgrId]);
    const [mgr, cash, nurse, docA, docB] = await Promise.all([`mgr_${code}`, `cash_${code}`, `nurse_${code}`, `docA_${code}`, `docB_${code}`].map((u) => tokenFor(app, u)));
    expect((await put(mgr, `/schedule/doctors/${docAId}/weekly`, { days: [1, 2, 3, 4, 5, 6, 7].map((x) => ({ weekday: x, start_time: '09:00', end_time: '13:00' })), effective_from: today })).status).toBe(200);
    const cur = (await get(mgr, '/settings')).body.settings.find((s: any) => s.key === 'booking.daily_limit');
    expect((await put(mgr, '/settings/booking.daily_limit', { value: 1000, expected_version: cur.version })).status).toBe(200);
    const cs = Number((await db.query(`insert into services (branch_id, name_ar, kind, pricing_model, is_active) values ($1,'كشفية','consultation','fixed',true) returning id`, [id])).rows[0].id);
    await db.query(`insert into service_prices (service_id, price, set_by) values ($1,30000,$2)`, [cs, mgrId]);
    const cashMethod = Number((await db.query(`insert into payment_methods (branch_id, name_ar, kind, sort_order) values ($1,'كاش','cash',0) returning id`, [id])).rows[0].id);
    expect((await post(cash, '/shifts/open', { opening_float: 0 })).status).toBe(201);
    const bs = (await post(mgr, '/services', { name_ar: `ليزر ${code}`, pricing_model: 'per_unit', price: 50000 })).body;
    await post(mgr, `/services/${bs.id}/fields`, { field_key: 'cc', label_ar: 'كم', field_type: 'number', unit_label: 'cc', pricing_role: 'quantity', is_required: true });
    expect((await post(mgr, `/services/${bs.id}/activate`)).status).toBe(200);
    return { id, code, mgr, mgrId, cash, nurse, docA, docAId, docB, cashMethod, svc: bs.id };
  }
  /** زبون بكشفية مدفوعة دخل عليها docA وخطة بجلستين؛ الجلسة الأولى مدفوعة */
  async function patient(w: World) {
    phoneSeq++;
    const c = (await post(w.cash, '/customers', { full_name: `زبون صور ${phoneSeq}`, phone: `0799${String(phoneSeq).padStart(7, '0')}` })).body.id as number;
    const b = await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docAId, date: today }); expect(b.status).toBe(201);
    const cons = b.body.consultation.id as number;
    expect((await http().post('/payments/consultation').set(auth(w.cash)).set('Idempotency-Key', key()).send({ consultation_id: cons, tenders: [{ method_id: w.cashMethod, amount: 30000 }] })).status).toBe(201);
    expect((await post(w.docA, `/consultations/${cons}/enter`)).status).toBe(201);
    const pl = await post(w.docA, `/consultations/${cons}/plan`, { items: [{ service_id: w.svc, values: { cc: 1 }, sessions_count: 2, interval_days: 7, first_session_date: today }] });
    expect(pl.status).toBe(201);
    const sid = pl.body.items[0].sessions[0].id as number;
    const pr = await http().post('/payments/sessions').set(auth(w.cash)).set('Idempotency-Key', key()).send({ session_ids: [sid], tenders: [{ method_id: w.cashMethod, amount: 50000 }] });
    expect(pr.status).toBe(201);
    return { customer: c, cons, sid };
  }
  const photo = (t: string, buf: Buffer, f: Record<string, string>, filename = 'p.png') => {
    let r = http().post('/photos').set(auth(t));
    for (const [k, v] of Object.entries(f)) r = r.field(k, v);
    return r.attach('file', buf, { filename });
  };
  const upload = (t: string, buf: Buffer, kind: string | null = 'expense_proof', extra: Record<string, string> = {}) => {
    let r = http().post('/attachments').set(auth(t));
    if (kind !== null) r = r.field('kind', kind);
    for (const [k, v] of Object.entries(extra)) r = r.field(k, v);
    return r.attach('file', buf, { filename: 'a.png' });
  };

  const countFiles = (dir: string): number => { if (!existsSync(dir)) return 0; let n = 0; for (const f of readdirSync(dir)) { const full = join(dir, f); n += statSync(full).isDirectory() ? countFiles(full) : 1; } return n; };

  let w: World; let wb: World;
  beforeAll(async () => {
    app = await makeApp(); db = pool(); attachments = app.get(AttachmentsService);
    today = (await db.query(`select clinic_today()::text as d`)).rows[0].d;
    owner = await tokenFor(app, 'owner');
    w = await world('PHA'); wb = await world('PHB');
  });
  afterAll(async () => { await app.close(); await db.end(); });

  // ------------------------------------------------------------------------------------------------
  describe('صور قبل وبعد', () => {
    it('الممرض يرفع «قبل» لجلسة مدفوعة، والطبيب صاحب الزبون يرفع «بعد»، والقائمة تعرضهم بالتفاصيل', async () => {
      const p = await patient(w);
      const before = await photo(w.nurse, png(), { phase: 'before', session_id: String(p.sid), body_area: 'الوجه' });
      expect(before.status).toBe(201);
      expect(before.body).toMatchObject({ customer_id: p.customer, phase: 'before', body_area: 'الوجه', session_id: p.sid, consultation_id: null, duplicate_of_attachment: null });
      const after = await photo(w.docA, png(), { phase: 'after', session_id: String(p.sid) });
      expect(after.status).toBe(201);
      const onCons = await photo(w.docA, png(), { phase: 'before', consultation_id: String(p.cons) });
      expect(onCons.status).toBe(201);
      for (const t of [w.docA, owner]) {
        const l = await get(t, `/customers/${p.customer}/photos`);
        expect(l.status).toBe(200);
        expect(l.body.photos.map((x: any) => x.id).sort()).toEqual([before.body.id, after.body.id, onCons.body.id].sort());
        const b = l.body.photos.find((x: any) => x.id === before.body.id);
        expect(b).toMatchObject({ phase: 'before', body_area: 'الوجه', session_id: p.sid, mime: 'image/png', session_seq_no: 1, uploaded_by: { full_name: expect.any(String) } });
        expect(b.service_name).toMatch(/ليزر/);
      }
      const row = await one(`select a.kind, a.customer_id::int as c, a.branch_id::int as b, a.mime from session_photos p join attachments a on a.id = p.attachment_id where p.id = $1`, [before.body.id]);
      expect(row).toEqual({ kind: 'before_after', c: p.customer, b: w.id, mime: 'image/png' });
      expect((await db.query(`select 1 from audit_log where action = 'photo.upload' and entity_id = $1`, [before.body.id])).rowCount).toBe(1);
    });

    it('الصلاحيات: المدير والكاشير لا يرفعون ولا يشوفون، الممرض يرفع بس ما يشوف، وطبيب ثاني ما يشوف زبون غيره', async () => {
      const p = await patient(w);
      const ok = await photo(w.nurse, png(), { phase: 'before', session_id: String(p.sid) }); expect(ok.status).toBe(201);
      for (const t of [w.mgr, w.cash, owner]) expect((await photo(t, png(), { phase: 'before', session_id: String(p.sid) })).status).toBe(403);
      expect((await http().post('/photos').field('phase', 'before').field('session_id', String(p.sid)).attach('file', png(), { filename: 'a.png' })).status).toBe(401);
      for (const t of [w.mgr, w.cash, w.nurse]) { expect((await get(t, `/customers/${p.customer}/photos`)).status).toBe(403); expect((await get(t, `/photos/${ok.body.id}`)).status).toBe(403); }
      expect((await get(w.docB, `/customers/${p.customer}/photos`)).status).toBe(404);
      expect((await get(w.docB, `/photos/${ok.body.id}`)).status).toBe(404);
      expect((await photo(w.docB, png(), { phase: 'after', session_id: String(p.sid) })).status).toBe(404);
      expect((await photo(w.docB, png(), { phase: 'after', consultation_id: String(p.cons) })).status).toBe(404);
      expect((await photo(w.nurse, png(), { phase: 'before', consultation_id: String(p.cons) })).status).toBe(403);         // صور الكشفية للطبيب بس
    });

    it('ممرض فرع ثاني ما يرفع لجلسة فرع غيره (404)', async () => {
      const p = await patient(w);
      const otherNurse = wb.nurse;
      expect((await photo(otherNurse, png(), { phase: 'before', session_id: String(p.sid) })).status).toBe(404);
      expect((await one(`select count(*)::int as n from session_photos where customer_id = $1`, [p.customer])).n).toBe(0);
    });

    it('التحقق: المرحلة والهدف والنوع والحجم، وما يتخزن شي عند الرفض', async () => {
      const p = await patient(w);
      const before = Number((await one(`select count(*)::int as n from attachments`)).n);
      const base = { phase: 'before', session_id: String(p.sid) };
      expect((await photo(w.nurse, png(), { session_id: String(p.sid) })).body.code).toBe('INVALID_PHASE');
      expect((await photo(w.nurse, png(), { ...base, phase: 'during' })).body.code).toBe('INVALID_PHASE');
      expect((await photo(w.nurse, png(), { phase: 'before' })).body.code).toBe('TARGET_REQUIRED');
      expect((await photo(w.docA, png(), { ...base, consultation_id: String(p.cons) })).body.code).toBe('TARGET_REQUIRED');
      expect((await photo(w.nurse, png(), { ...base, session_id: 'x1' })).body.code).toBe('INVALID_ID');
      expect((await photo(w.nurse, pdf(), base, 'a.pdf')).body.code).toBe('INVALID_FILE_TYPE');                        // صور فقط
      expect((await photo(w.nurse, Buffer.from('not an image at all'), base)).body.code).toBe('INVALID_FILE_TYPE');
      expect((await photo(w.nurse, png(), { ...base, session_id: '999999999' })).status).toBe(404);
      expect((await photo(w.nurse, png(), { ...base, body_area: 'x'.repeat(101) })).body.code).toBe('INVALID_AREA');
      expect((await http().post('/photos').set(auth(w.nurse)).field('phase', 'before').field('session_id', String(p.sid))).body.code).toBe('FILE_REQUIRED');
      const big = Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024 + 10)]);
      expect((await photo(w.nurse, big, base)).status).toBe(413);
      expect(Number((await one(`select count(*)::int as n from attachments`)).n)).toBe(before);
    });

    it('جلسة ما تنحجز/ملغاة ما تقبل صور', async () => {
      const p = await patient(w);
      const second = Number((await one(`select id from treatment_sessions where plan_item_id = (select plan_item_id from treatment_sessions where id = $1) and id <> $1 limit 1`, [p.sid])).id);
      const planId = Number((await one(`select pi.plan_id from treatment_sessions s join plan_items pi on pi.id = s.plan_item_id where s.id = $1`, [second])).plan_id);
      expect((await post(w.docA, `/plans/${planId}/stop`, { reason: 'إيقاف الخطة' })).status).toBe(201);
      expect((await one(`select status from treatment_sessions where id = $1`, [second])).status).toBe('cancelled');
      expect((await photo(w.nurse, png(), { phase: 'before', session_id: String(second) })).body.code).toBe('SESSION_NOT_ACTIVE');
    });

    it('كشفية ملغاة ما تقبل صور (حجز انلغى قبل الدفع)', async () => {
      phoneSeq++;
      const c = (await post(w.cash, '/customers', { full_name: `زبون ملغى ${phoneSeq}`, phone: `0799${String(phoneSeq).padStart(7, '0')}` })).body.id;
      const b = await post(w.cash, '/bookings', { customer_id: c, doctor_id: w.docAId, date: today }); expect(b.status).toBe(201);
      expect((await post(w.cash, `/bookings/${b.body.id}/cancel`, { reason: 'تجربة' })).status).toBe(201);
      expect((await one(`select status from consultations where id = $1`, [b.body.consultation.id])).status).toBe('cancelled');
      expect((await photo(w.docA, png(), { phase: 'before', consultation_id: String(b.body.consultation.id) })).body.code).toBe('CONSULTATION_CANCELLED');
    });

    it('رفض بعد كتابة الملف على القرص ينظف الملف (ما يبقى يتيم على القرص)', async () => {
      const p = await patient(w); const dir = process.env.UPLOAD_DIR!;
      const before = countFiles(dir);
      expect((await photo(w.nurse, png(), { phase: 'before', session_id: '999999999' })).status).toBe(404);              // الملف انكتب ثم فشل التسجيل
      expect((await photo(w.docB, png(), { phase: 'before', session_id: String(p.sid) })).status).toBe(404);
      expect(countFiles(dir)).toBe(before);
      const ok = await photo(w.nurse, png(), { phase: 'before', session_id: String(p.sid) }); expect(ok.status).toBe(201);
      expect(countFiles(dir)).toBe(before + 1);
    });

    it('المرفقات المحفوظة كصور مرضى ما تنفتح من واجهة المرفقات المالية (404 للمدير والمالك)', async () => {
      const p = await patient(w); const up = await photo(w.nurse, png(), { phase: 'before', session_id: String(p.sid) });
      const att = Number((await one(`select attachment_id from session_photos where id = $1`, [up.body.id])).attachment_id);
      for (const t of [w.mgr, owner]) expect((await get(t, `/attachments/${att}`)).status).toBe(404);
    });

    it('عرض الملف: نفس البايتات، no-store، ومالك الصورة فقط', async () => {
      const p = await patient(w); const buf = png();
      const up = await photo(w.nurse, buf, { phase: 'before', session_id: String(p.sid) });
      const r = await get(w.docA, `/photos/${up.body.id}`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('image/png'); expect(r.headers['cache-control']).toBe('private, no-store');
      expect(Buffer.compare(r.body as Buffer, buf)).toBe(0);
      expect((await get(owner, `/photos/${up.body.id}`)).status).toBe(200);
      expect((await get(owner, '/photos/999999999')).status).toBe(404);
    });

    it('الحذف للمالك وحده، بسبب إلزامي، ناعم (الملف يبقى)، وينسجل، ولا يظهر بعدها', async () => {
      const p = await patient(w);
      const up = await photo(w.nurse, png(), { phase: 'before', session_id: String(p.sid) });
      for (const t of [w.docA, w.nurse, w.mgr, w.cash]) expect((await post(t, `/photos/${up.body.id}/delete`, { reason: 'خطأ' })).status).toBe(403);
      expect((await post(owner, `/photos/${up.body.id}/delete`, {})).body.code).toBe('REASON_REQUIRED');
      expect((await post(owner, `/photos/${up.body.id}/delete`, { reason: 'ab' })).body.code).toBe('REASON_REQUIRED');
      const key = (await one(`select a.storage_key from session_photos p join attachments a on a.id = p.attachment_id where p.id = $1`, [up.body.id])).storage_key;
      expect((await post(owner, `/photos/${up.body.id}/delete`, { reason: 'صورة خطأ' })).body).toEqual({ id: up.body.id, deleted: true });
      expect(existsSync(join(process.env.UPLOAD_DIR!, key))).toBe(true);
      expect((await one(`select deleted_by::int as d from attachments where storage_key = $1`, [key])).d).not.toBeNull();
      expect((await get(w.docA, `/customers/${p.customer}/photos`)).body.photos).toEqual([]);
      expect((await get(owner, `/photos/${up.body.id}`)).status).toBe(404);
      expect((await post(owner, `/photos/${up.body.id}/delete`, { reason: 'مرة ثانية' })).status).toBe(404);
      expect((await db.query(`select 1 from audit_log where action = 'photo.delete' and entity_id = $1 and reason = 'صورة خطأ'`, [up.body.id])).rowCount).toBe(1);
    });

    it('تحذير الصورة المكررة: نفس المحتوى يرجع duplicate_of (تحذير مو منع)، وبفرع ثاني ما يتعتبر مكرر', async () => {
      const p = await patient(w); const buf = png();
      const a = await photo(w.nurse, buf, { phase: 'before', session_id: String(p.sid) });
      const rowA = Number((await one(`select attachment_id from session_photos where id = $1`, [a.body.id])).attachment_id);
      const b = await photo(w.nurse, buf, { phase: 'after', session_id: String(p.sid) });
      expect(b.status).toBe(201); expect(b.body.duplicate_of_attachment).toBe(rowA);
      const f1 = await upload(w.mgr, buf, 'expense_proof'); const f2 = await upload(w.mgr, buf, 'expense_proof');
      expect(f1.body.duplicate_of).toBeNull(); expect(f2.status).toBe(201); expect(f2.body.duplicate_of).toBe(f1.body.id);
      expect((await upload(w.mgr, buf, 'purchase_receipt')).body.duplicate_of).toBeNull();                         // نوع ثاني
      expect((await upload(wb.mgr, buf, 'expense_proof')).body.duplicate_of).toBeNull();                           // فرع ثاني
      await db.query(`update attachments set deleted_at = now() where branch_id = $1 and kind = 'expense_proof' and sha256 = (select sha256 from attachments where id = $2)`, [w.id, f1.body.id]);
      expect((await upload(w.mgr, buf, 'expense_proof')).body.duplicate_of).toBeNull();                            // المحذوف ما يُحسب
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('شعار الوصل', () => {
    it('المدير يرفع الشعار (صورة فقط) ويضبطه بالإعداد، والكاشير ينزله للطباعة', async () => {
      expect((await upload(w.cash, png(), 'logo')).status).toBe(403);
      expect((await upload(w.mgr, pdf(), 'logo')).body.code).toBe('INVALID_FILE_TYPE');
      expect((await get(w.cash, '/attachments/logo/current')).status).toBe(404);                                 // ما مضبوط بعد
      const buf = png(); const up = await upload(w.mgr, buf, 'logo'); expect(up.status).toBe(201);
      const cur = (await get(w.mgr, '/settings')).body.settings.find((s: any) => s.key === 'receipt.logo_attachment_id');
      expect((await put(w.mgr, '/settings/receipt.logo_attachment_id', { value: up.body.id, expected_version: cur.version })).status).toBe(200);
      for (const t of [w.cash, w.mgr]) {
        const r = await get(t, '/attachments/logo/current').buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
        expect(r.status).toBe(200); expect(r.headers['content-type']).toBe('image/png'); expect(Buffer.compare(r.body as Buffer, buf)).toBe(0);
      }
      for (const t of [w.nurse, w.docA]) expect((await get(t, '/attachments/logo/current')).status).toBe(403);
      expect((await get(wb.cash, '/attachments/logo/current')).status).toBe(404);                                // فرع ثاني ما عنده شعار
      // الوصل يحمل رقم الشعار بلقطة العيادة
      const p = await patient(w);
      const pay = await http().post('/payments/sessions').set(auth(w.cash)).set('Idempotency-Key', key()).send({ session_ids: [(await one(`select id from treatment_sessions where plan_item_id = (select plan_item_id from treatment_sessions where id = $1) and id <> $1 limit 1`, [p.sid])).id], tenders: [{ method_id: w.cashMethod, amount: 50000 }] });
      if (pay.status === 201) expect(pay.body.clinic.logo_attachment_id).toBe(up.body.id);
    });

    it('حتى لو الإعداد انكتب بالقاعدة برقم غلط (مرفق مالي أو شعار فرع ثاني) الشعار يرجع 404 مو ملف ثاني', async () => {
      const proof = (await upload(w.mgr, png(), 'expense_proof')).body.id; const other = (await upload(wb.mgr, png(), 'logo')).body.id;
      const set = async (v: number) => { const u = await db.query(`update settings set value = to_jsonb($2::bigint) where branch_id = $1 and key = 'receipt.logo_attachment_id'`, [w.id, v]); if (!u.rowCount) await db.query(`insert into settings (branch_id, key, value, version, updated_by) values ($1,'receipt.logo_attachment_id',to_jsonb($2::bigint),1,$3)`, [w.id, v, w.mgrId]); };
      try {
        await set(proof); expect((await get(w.cash, '/attachments/logo/current')).status).toBe(404);
        await set(other); expect((await get(w.cash, '/attachments/logo/current')).status).toBe(404);
      } finally { await db.query(`update settings set value = 'null'::jsonb where branch_id = $1 and key = 'receipt.logo_attachment_id'`, [w.id]); }
    });

    it('رقم شعار غلط يتمنع: نوع غير شعار، فرع ثاني، غير موجود، أو محذوف؛ و null يزيل الشعار', async () => {
      const proof = await upload(w.mgr, png(), 'expense_proof'); const other = await upload(wb.mgr, png(), 'logo');
      const cur = (await get(w.mgr, '/settings')).body.settings.find((s: any) => s.key === 'receipt.logo_attachment_id');
      for (const v of [proof.body.id, other.body.id, 999999999]) {
        const r = await put(w.mgr, '/settings/receipt.logo_attachment_id', { value: v, expected_version: cur.version });
        expect(r.status).toBe(400); expect(r.body.code).toBe('INVALID_LOGO');
      }
      const gone = await upload(w.mgr, png(), 'logo'); await db.query(`update attachments set deleted_at = now() where id = $1`, [gone.body.id]);
      expect((await put(w.mgr, '/settings/receipt.logo_attachment_id', { value: gone.body.id, expected_version: cur.version })).body.code).toBe('INVALID_LOGO');
      const ok = await upload(w.mgr, png(), 'logo');
      const s1 = await put(w.mgr, '/settings/receipt.logo_attachment_id', { value: ok.body.id, expected_version: cur.version }); expect(s1.status).toBe(200);
      const s2 = await put(w.mgr, '/settings/receipt.logo_attachment_id', { value: null, expected_version: s1.body.version }); expect(s2.status).toBe(200);
      expect((await get(w.cash, '/attachments/logo/current')).status).toBe(404);
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('تنظيف المرفقات اليتيمة', () => {
    const attRow = async (id: number) => one(`select id, storage_key from attachments where id = $1`, [id]);
    it('ينحذف اليتيم المالي القديم (صف + ملف) ويبقى: الحديث، المربوط بمصروف، الشعار، صور قبل/بعد', async () => {
      const mk = async (t: string, kind: string) => (await upload(t, png(), kind)).body.id as number;
      const old = await mk(w.mgr, 'expense_proof'); const oldPurchase = await mk(w.mgr, 'purchase_receipt'); const oldSupplier = await mk(w.mgr, 'supplier_payment_proof');
      const young = await mk(w.mgr, 'expense_proof'); const used = await mk(w.mgr, 'expense_proof'); const logo = await mk(w.mgr, 'logo');
      const p = await patient(w); const ph = await photo(w.nurse, png(), { phase: 'before', session_id: String(p.sid) });
      const phAtt = Number((await one(`select attachment_id from session_photos where id = $1`, [ph.body.id])).attachment_id);
      const cat = (await post(w.mgr, '/expense-categories', { name: `نوع ${++seq}` })).body.id;
      expect((await post(w.mgr, '/expenses', { category_id: cat, amount: 1000, expense_date: today, pay_source: 'safe', proof_attachment_id: used })).status).toBe(201);
      const keys = new Map<number, string>(); for (const id of [old, oldPurchase, oldSupplier, young, used, logo, phAtt]) keys.set(id, (await attRow(id)).storage_key);
      await db.query(`update attachments set created_at = now() - interval '25 hours' where id = any($1::bigint[])`, [[old, oldPurchase, oldSupplier, used, logo, phAtt]]);
      await db.query(`update attachments set created_at = now() - interval '23 hours' where id = $1`, [young]);
      const n = await attachments.cleanupOrphans(w.id);
      expect(n).toBe(3);
      for (const id of [old, oldPurchase, oldSupplier]) { expect(await attRow(id)).toBeUndefined(); expect(existsSync(join(process.env.UPLOAD_DIR!, keys.get(id)!))).toBe(false); }
      for (const id of [young, used, logo, phAtt]) { expect(await attRow(id)).toBeDefined(); expect(existsSync(join(process.env.UPLOAD_DIR!, keys.get(id)!))).toBe(true); }
      expect((await db.query(`select 1 from audit_log where action = 'attachment.cleanup' and entity_id = any($1::bigint[]) and actor_role = 'system'`, [[old, oldPurchase, oldSupplier]])).rowCount).toBe(3);
      expect(await attachments.cleanupOrphans(w.id)).toBe(0);                                                  // إعادة بدون أثر
    });

    it('سباق: مصروف يربط المرفق بنفس لحظة التنظيف → ما ينحذف ولا ينكسر التنظيف (23503 يتخطى)', async () => {
      const id = (await upload(w.mgr, png(), 'expense_proof')).body.id as number;
      await db.query(`update attachments set created_at = now() - interval '2 days' where id = $1`, [id]);
      const cat = (await post(w.mgr, '/expense-categories', { name: `نوع سباق ${++seq}` })).body.id;
      const client = await db.connect();
      try {
        await client.query('begin');
        await client.query(`insert into expenses (branch_id, category_id, amount, expense_date, pay_source, bank_name, proof_attachment_id, recorded_by) values ($1,$2,1000,clinic_today(),'electronic','مصرف تجربة',$3,$4)`, [w.id, cat, id, w.mgrId]);
        const cleaning = attachments.cleanupOrphans(w.id);                                      // يشوف المرفق يتيم (المصروف ما انثبت) ويحاول يحذفه فيقف على القفل
        await new Promise((r) => setTimeout(r, 400));
        await client.query('commit');
        expect(await cleaning).toBe(0);
      } finally { client.release(); }
      expect(await attRow(id)).toBeDefined();
    });

    it('يتقيد بالفرع، والمهمة المجدولة تنفذه (orphans_removed)', async () => {
      const a = (await upload(w.mgr, png(), 'expense_proof')).body.id; const b = (await upload(wb.mgr, png(), 'expense_proof')).body.id;
      await db.query(`update attachments set created_at = now() - interval '2 days' where id = any($1::bigint[])`, [[a, b]]);
      expect(await attachments.cleanupOrphans(w.id)).toBe(1);
      expect(await attRow(a)).toBeUndefined(); expect(await attRow(b)).toBeDefined();
      const r = await post(owner, '/jobs/run', { branch_id: wb.id });
      expect(r.status).toBe(200); expect(r.body.orphans_removed).toBe(1);
      expect(await attRow(b)).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------------------------------------
  describe('إلغاء المدير لطلب سحب المالك', () => {
    const wd = (over: object = {}) => ({ amount: 200000, withdrawn_by_name: 'المالك', withdrawal_date: today, ...over });
    const bal = async (id: number) => Number((await one(`select balance from safes where branch_id = $1`, [id])).balance);
    it('المدير يلغي طلبه المعلق: الخزنة ما تتغير، والقرار بعده 409، وينسجل', async () => {
      const before = await bal(w.id);
      const r = await post(w.mgr, '/safe/withdrawals', wd()); expect(r.status).toBe(201);
      const c = await post(w.mgr, `/safe/withdrawals/${r.body.id}/cancel`, { note: 'سجلته بالغلط' });
      expect(c.status).toBe(201);
      expect(c.body).toMatchObject({ id: r.body.id, status: 'cancelled', decision_note: 'سجلته بالغلط', decided_by: { id: w.mgrId } });
      expect(await bal(w.id)).toBe(before);
      expect((await post(owner, `/safe/withdrawals/${r.body.id}/approve`, {})).body.code).toBe('ALREADY_DECIDED');
      expect((await post(owner, `/safe/withdrawals/${r.body.id}/reject`, {})).body.message).toMatch(/انلغى/);
      expect((await post(w.mgr, `/safe/withdrawals/${r.body.id}/cancel`, {})).body.code).toBe('ALREADY_DECIDED');
      expect((await get(w.mgr, '/safe/withdrawals?status=cancelled')).body.map((x: any) => x.id)).toContain(r.body.id);
      expect((await get(w.mgr, '/safe/withdrawals?status=pending')).body.map((x: any) => x.id)).not.toContain(r.body.id);
      expect((await db.query(`select 1 from audit_log where action = 'withdrawal.cancel' and entity_id = $1`, [r.body.id])).rowCount).toBe(1);
    });
    it('سباق: المالك يقرر بنفس لحظة الإلغاء → الإلغاء يشوف القرار ويرجع 409 (ما يكتب فوقه)', async () => {
      const r = await post(w.mgr, '/safe/withdrawals', wd({ amount: 5000 }));
      const client = await db.connect();
      try {
        await client.query('begin');
        await client.query(`select 1 from owner_withdrawals where id = $1 for update`, [r.body.id]);
        const cancelling = post(w.mgr, `/safe/withdrawals/${r.body.id}/cancel`, { note: 'تأخرت' }).then((x) => x);          // .then يرسل الطلب فوراً (supertest كسول)
        await new Promise((x) => setTimeout(x, 400));
        await client.query(`update owner_withdrawals set status = 'rejected', decided_by = $2, decided_at = now() where id = $1`, [r.body.id, w.mgrId]);
        await client.query('commit');
        const res = await cancelling;
        expect(res.status).toBe(409); expect(res.body.code).toBe('ALREADY_DECIDED');
      } finally { client.release(); }
      expect((await one(`select status from owner_withdrawals where id = $1`, [r.body.id])).status).toBe('rejected');
    });

    it('المدير ما يلغي طلب موافق عليه ولا طلب مدير ثاني، والمالك والكاشير ما يلغون', async () => {
      const mgr2Id = await seedUser(db, 'mgr2_PHA', 'manager', w.id); const mgr2 = await tokenFor(app, 'mgr2_PHA'); expect(mgr2Id).toBeGreaterThan(0);
      const r = await post(w.mgr, '/safe/withdrawals', wd({ amount: 1000 }));
      expect((await post(mgr2, `/safe/withdrawals/${r.body.id}/cancel`, {})).status).toBe(404);
      for (const t of [owner, w.cash, w.docA, w.nurse]) expect((await post(t, `/safe/withdrawals/${r.body.id}/cancel`, {})).status).toBe(403);
      expect((await post(wb.mgr, `/safe/withdrawals/${r.body.id}/cancel`, {})).status).toBe(404);
      expect((await post(owner, `/safe/withdrawals/${r.body.id}/approve`, {})).status).toBe(201);
      expect((await post(w.mgr, `/safe/withdrawals/${r.body.id}/cancel`, {})).body.code).toBe('ALREADY_DECIDED');
      expect((await post(w.mgr, '/safe/withdrawals/999999999/cancel', {})).status).toBe(404);
    });
  });
});
