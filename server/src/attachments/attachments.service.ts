import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { resolveBranch } from '../common/branch';
import { Errors } from '../common/errors';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService, Queryable } from '../db/db.service';
import { SettingsService } from '../settings/settings.service';

/** الأنواع اللي يرفعها المدير والمالك: صور الإثبات المالية. صور قبل وبعد بوحدتها (photos/). */
export const FINANCE_KINDS = ['expense_proof', 'purchase_receipt', 'supplier_payment_proof'] as const;
export type FinanceKind = (typeof FINANCE_KINDS)[number];
/** + شعار الوصل (صورة فقط، المدير والمالك). */
export const UPLOAD_KINDS = [...FINANCE_KINDS, 'logo'] as const;
/** مرفق مالي ما انربط بسجل خلال هالمدة يتعتبر يتيم وينحذف بالمهام المجدولة */
export const ORPHAN_HOURS = 24;

export interface UploadedFile { buffer: Buffer; originalname: string; size: number }

/** نكتشف النوع من محتوى الملف نفسه (مو من الاسم ولا من اللي يدعيه العميل) */
export function sniff(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  return null;
}

/**
 * رفع صور الإثبات: تخزين على قرص الخادم هسه (التخزين السحابي عند التنصيب). المفتاح عشوائي (ما يكشف شي)، والمسار ما يطلع برا المجلد،
 * والنوع يتحقق من المحتوى، والحجم محدود، والملف ما ينعرض لغير المدير والمالك بفرعه.
 */
@Injectable()
export class AttachmentsService {
  private readonly root: string;
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly settings: SettingsService, @Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.root = resolve(config.uploadDir);
  }

  /** يكتب الملف على القرص بعد التحقق من الحجم والنوع (من المحتوى). المستدعي يسجله بالقاعدة وينادي remove() إذا فشل. */
  async writeFile(file: UploadedFile | undefined, opts: { imagesOnly?: boolean } = {}) {
    if (!file || !file.buffer?.length) throw Errors.badRequest('FILE_REQUIRED', 'ما انرسل ملف (الحقل file)');
    if (file.size > this.config.maxUploadBytes || file.buffer.length > this.config.maxUploadBytes) throw Errors.badRequest('FILE_TOO_LARGE', 'الملف أكبر من الحد المسموح');
    const type = sniff(file.buffer);
    if (!type || (opts.imagesOnly && type.mime === 'application/pdf')) throw Errors.badRequest('INVALID_FILE_TYPE', opts.imagesOnly ? 'لازم صورة (JPG أو PNG أو WEBP)' : 'نوع الملف غير مسموح (صورة JPG/PNG/WEBP أو PDF)');
    const sha = createHash('sha256').update(file.buffer).digest('hex');
    const key = `${new Date().toISOString().slice(0, 7)}/${randomUUID()}.${type.ext}`;
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, file.buffer, { flag: 'wx' });
    return { key, mime: type.mime, size: file.buffer.length, sha, remove: () => unlink(full).catch(() => undefined) };
  }

  /** يسجل المرفق بمعاملة المستدعي. يرجع duplicate_of إذا نفس الصورة (بالمحتوى) مرفوعة سابقاً بنفس الفرع والنوع: تحذير مو منع. */
  async insertRow(q: Queryable, actor: AuthUser, branchId: number, kind: string, w: { key: string; mime: string; size: number; sha: string }, customerId: number | null = null, ip: string | null = null) {
    const dup = (await q.query(`select id from attachments where branch_id = $1 and kind = $2 and sha256 = $3 and deleted_at is null order by id limit 1`, [branchId, kind, w.sha])).rows[0];
    const { rows } = await q.query(
      `insert into attachments (branch_id, kind, storage_key, mime, size_bytes, sha256, customer_id, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, created_at`,
      [branchId, kind, w.key, w.mime, w.size, w.sha, customerId, actor.id]);
    await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'attachment.upload', entityType: 'attachment', entityId: Number(rows[0].id), after: { kind, mime: w.mime, size: w.size, sha256: w.sha }, ip });
    return { id: Number(rows[0].id), branch_id: branchId, kind, mime: w.mime, size_bytes: w.size, sha256: w.sha, created_at: rows[0].created_at, duplicate_of: dup ? Number(dup.id) : null };
  }

  async upload(actor: AuthUser, file: UploadedFile | undefined, kind: string, requestedBranch: number | undefined, ip: string | null) {
    if (!(UPLOAD_KINDS as readonly string[]).includes(kind)) throw Errors.badRequest('INVALID_KIND', 'نوع المرفق غير مدعوم');
    const w = await this.writeFile(file, { imagesOnly: kind === 'logo' });
    try {
      const branchId = await resolveBranch(this.db, actor, requestedBranch);
      return await this.db.tx((q) => this.insertRow(q, actor, branchId, kind, w, null, ip));
    } catch (e) {
      await w.remove();                                                // ما نخلي ملف يتيم إذا فشل التسجيل
      throw e;
    }
  }

  /** مسار الملف + نوعه للعرض. المدير والمالك بفرعهم، والمحذوف 404. */
  async open(actor: AuthUser, id: number) {
    const a = (await this.db.query(`select * from attachments where id = $1 and deleted_at is null`, [id])).rows[0];
    if (!a || (actor.role !== 'owner' && Number(a.branch_id) !== actor.branchId)) throw Errors.notFound('المرفق');
    if (!(UPLOAD_KINDS as readonly string[]).includes(a.kind)) throw Errors.notFound('المرفق');
    return { stream: createReadStream(this.pathFor(a.storage_key)), mime: a.mime as string, size: Number(a.size_bytes) };
  }

  /** شعار الوصل الحالي لفرع المستخدم (الكاشير يطبع به). 404 إذا ما مضبوط. */
  async openLogo(actor: AuthUser, requestedBranch?: number) {
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    const id = await this.settings.effective<number | null>(this.db, branchId, 'receipt.logo_attachment_id');
    if (!id) throw Errors.notFound('الشعار');
    const a = (await this.db.query(`select * from attachments where id = $1 and kind = 'logo' and branch_id = $2 and deleted_at is null`, [id, branchId])).rows[0];
    if (!a) throw Errors.notFound('الشعار');
    return { stream: createReadStream(this.pathFor(a.storage_key)), mime: a.mime as string, size: Number(a.size_bytes) };
  }

  /** مسار ملف داخلي (للصور): بدون فحص دور، المستدعي يتحقق. */
  async openByKey(key: string, mime: string, size: number) {
    return { stream: createReadStream(this.pathFor(key)), mime, size };
  }

  /**
   * ينظف المرفقات المالية اليتيمة: مرفوعة من أكثر من ORPHAN_HOURS ساعة وما انربطت بمصروف ولا فاتورة شراء ولا دفعة مورد.
   * الشعار وصور قبل/بعد ما تنمس. الحذف الفعلي (صف + ملف) لأنها ما صارت سجل مالي.
   */
  async cleanupOrphans(branchId?: number): Promise<number> {
    const { rows } = await this.db.query(
      `select a.id, a.branch_id, a.storage_key from attachments a
        where a.kind = any($2::text[]) and a.deleted_at is null and a.created_at < now() - make_interval(hours => $3)
          and ($1::bigint is null or a.branch_id = $1)
          and not exists (select 1 from expenses e where e.proof_attachment_id = a.id)
          and not exists (select 1 from purchases p where p.receipt_attachment_id = a.id)
          and not exists (select 1 from supplier_payments sp where sp.proof_attachment_id = a.id)
        order by a.id limit 500`, [branchId ?? null, [...FINANCE_KINDS], ORPHAN_HOURS]);
    let removed = 0;
    for (const r of rows) {
      try {
        await this.db.tx(async (q) => {
          const del = await q.query(`delete from attachments where id = $1 returning id`, [r.id]);
          if (!del.rowCount) return;
          await this.audit.log(q, { actorUserId: null, actorRole: 'system', branchId: Number(r.branch_id), action: 'attachment.cleanup', entityType: 'attachment', entityId: Number(r.id), reason: 'مرفق مالي ما انربط بسجل', ip: null });
          removed++;
        });
        await unlink(this.pathFor(r.storage_key)).catch(() => undefined);
      } catch (e) {
        if ((e as { code?: string }).code !== '23503') throw e;          // انربط بسجل بنفس اللحظة: نتركه
      }
    }
    return removed;
  }

  private pathFor(key: string): string {
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw Errors.badRequest('INVALID_PATH', 'مسار غير صالح');
    return full;
  }
}
