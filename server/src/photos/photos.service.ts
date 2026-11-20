import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { AttachmentsService, UploadedFile } from '../attachments/attachments.service';
import { Errors } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';

export interface UploadPhotoInput { phase?: string; body_area?: string; session_id?: string; consultation_id?: string }

/**
 * صور قبل وبعد: الطبيب والممرض يرفعون، والطبيب (لزبائنه بس) والمالك يشوفون، والمالك وحده يحذف (حذف ناعم بسبب مكتوب).
 * كل صورة تنربط بجلسة (الممرض أو الطبيب) أو بكشفية (الطبيب).
 */
@Injectable()
export class PhotosService {
  constructor(private readonly db: DbService, private readonly attachments: AttachmentsService, private readonly audit: AuditService) {}

  private int(v: string | undefined, what: string): number | null {
    if (v === undefined || v === '') return null;
    if (!/^\d+$/.test(v)) throw Errors.badRequest('INVALID_ID', `${what} غير صحيح`);
    return Number(v);
  }

  private async doctorOwns(q: Queryable, doctorId: number, customerId: number): Promise<boolean> {
    return !!(await q.query(`select 1 from v_doctor_customers where doctor_id = $1 and customer_id = $2`, [doctorId, customerId])).rowCount;
  }

  async upload(actor: AuthUser, file: UploadedFile | undefined, input: UploadPhotoInput, ip: string | null) {
    const phase = input.phase;
    if (phase !== 'before' && phase !== 'after') throw Errors.badRequest('INVALID_PHASE', 'حدد قبل أو بعد (phase)');
    const sessionId = this.int(input.session_id, 'رقم الجلسة'); const consultationId = this.int(input.consultation_id, 'رقم الكشفية');
    if ((sessionId === null) === (consultationId === null)) throw Errors.badRequest('TARGET_REQUIRED', 'حدد جلسة أو كشفية (وحدة بس)');
    const area = input.body_area?.replace(/\s+/g, ' ').trim() || null;
    if (area && area.length > 100) throw Errors.badRequest('INVALID_AREA', 'اسم المنطقة طويل');
    const w = await this.attachments.writeFile(file, { imagesOnly: true });
    try {
      return await this.db.tx(async (q) => {
        let customerId: number; let branchId: number;
        if (sessionId !== null) {
          const s = (await q.query(`select s.id, s.status, s.customer_id, s.branch_id from treatment_sessions s where s.id = $1`, [sessionId])).rows[0];
          if (!s) throw Errors.notFound('الجلسة');
          customerId = Number(s.customer_id); branchId = Number(s.branch_id);
          if (actor.role === 'nurse' && branchId !== actor.branchId) throw Errors.notFound('الجلسة');
          if (actor.role === 'doctor' && !(await this.doctorOwns(q, actor.id, customerId))) throw Errors.notFound('الجلسة');
          if (!['booked', 'paid', 'completed'].includes(s.status)) throw Errors.conflict('SESSION_NOT_ACTIVE', 'الجلسة غير فعالة: ما تنرفع لها صور');
        } else {
          if (actor.role !== 'doctor') throw Errors.forbidden();                            // صور الكشفية للطبيب بس
          const c = (await q.query(`select c.id, c.status, c.customer_id, c.doctor_id, v.branch_id from consultations c join visits v on v.id = c.visit_id where c.id = $1`, [consultationId])).rows[0];
          if (!c || Number(c.doctor_id) !== actor.id) throw Errors.notFound('الكشفية');
          if (c.status === 'cancelled') throw Errors.conflict('CONSULTATION_CANCELLED', 'الكشفية ملغاة');
          customerId = Number(c.customer_id); branchId = Number(c.branch_id);
        }
        const att = await this.attachments.insertRow(q, actor, branchId, 'before_after', w, customerId, ip);
        const ph = (await q.query(
          `insert into session_photos (attachment_id, customer_id, consultation_id, treatment_session_id, phase, body_area, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
          [att.id, customerId, consultationId, sessionId, phase, area, actor.id])).rows[0];
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'photo.upload', entityType: 'session_photo', entityId: Number(ph.id), after: { customer_id: customerId, phase, session_id: sessionId, consultation_id: consultationId, body_area: area }, ip });
        return { id: Number(ph.id), customer_id: customerId, phase, body_area: area, session_id: sessionId, consultation_id: consultationId, duplicate_of_attachment: att.duplicate_of, created_at: att.created_at };
      });
    } catch (e) {
      await w.remove();
      throw e;
    }
  }

  /** صور زبون. الطبيب لزبائنه بس (وإلا 404)، والمالك للكل. المحذوفة ما تظهر. */
  async list(actor: AuthUser, customerId: number) {
    if (!(await this.db.query(`select 1 from customers where id = $1`, [customerId])).rowCount) throw Errors.notFound('الزبون');
    if (actor.role === 'doctor' && !(await this.doctorOwns(this.db, actor.id, customerId))) throw Errors.notFound('الزبون');
    const { rows } = await this.db.query(
      `select p.id, p.phase, p.body_area, p.consultation_id, p.treatment_session_id, p.created_at, a.mime, u.id as uid, u.full_name, sv.name_ar as service_name, ts.seq_no
         from session_photos p join attachments a on a.id = p.attachment_id join users u on u.id = p.uploaded_by
         left join treatment_sessions ts on ts.id = p.treatment_session_id left join plan_items pi on pi.id = ts.plan_item_id left join services sv on sv.id = pi.service_id
        where p.customer_id = $1 and a.deleted_at is null order by p.created_at desc, p.id desc`, [customerId]);
    return { customer_id: customerId, photos: rows.map((r) => ({
      id: Number(r.id), phase: r.phase as string, body_area: r.body_area as string | null, mime: r.mime as string, created_at: r.created_at,
      session_id: r.treatment_session_id === null ? null : Number(r.treatment_session_id), consultation_id: r.consultation_id === null ? null : Number(r.consultation_id),
      service_name: r.service_name as string | null, session_seq_no: r.seq_no as number | null, uploaded_by: { id: Number(r.uid), full_name: r.full_name as string },
    })) };
  }

  private async loadForView(actor: AuthUser, id: number) {
    const r = (await this.db.query(
      `select p.id, p.customer_id, a.storage_key, a.mime, a.size_bytes from session_photos p join attachments a on a.id = p.attachment_id where p.id = $1 and a.deleted_at is null`, [id])).rows[0];
    if (!r) throw Errors.notFound('الصورة');
    if (actor.role === 'doctor' && !(await this.doctorOwns(this.db, actor.id, Number(r.customer_id)))) throw Errors.notFound('الصورة');
    return r;
  }

  async open(actor: AuthUser, id: number) {
    const r = await this.loadForView(actor, id);
    return this.attachments.openByKey(r.storage_key, r.mime, Number(r.size_bytes));
  }

  /** حذف المالك: ناعم (الصف والملف يبقون)، بسبب إلزامي، وينسجل. */
  async remove(actor: AuthUser, id: number, reason: string | undefined, ip: string | null) {
    const why = (reason ?? '').trim();
    if (why.length < 3) throw Errors.badRequest('REASON_REQUIRED', 'اكتب سبب الحذف');
    return this.db.tx(async (q) => {
      const r = (await q.query(`select p.id, p.customer_id, p.attachment_id, a.branch_id, a.deleted_at from session_photos p join attachments a on a.id = p.attachment_id where p.id = $1 for update of a`, [id])).rows[0];
      if (!r || r.deleted_at) throw Errors.notFound('الصورة');
      await q.query(`update attachments set deleted_at = now(), deleted_by = $2 where id = $1`, [r.attachment_id, actor.id]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(r.branch_id), action: 'photo.delete', entityType: 'session_photo', entityId: id, reason: why, before: { customer_id: Number(r.customer_id) }, ip });
      return { id, deleted: true };
    });
  }
}
