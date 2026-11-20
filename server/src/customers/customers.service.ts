import { HttpException, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { resolveBranch } from '../common/branch';
import { Errors } from '../common/errors';
import { DbService } from '../db/db.service';
import { assertDate } from '../schedule/schedule.service';
import { ChangePhoneDto, CreateCustomerDto, MergeCustomersDto, UpdateCustomerDto } from './customers.dto';
import { normalizePhone, tryNormalizePhone } from './phone';

// بدون الحروف المتشابهة (0/O و1/I/L) حتى الكاشير ما يغلط وهو يقرأ الرمز
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
export const newPublicCode = (): string => Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

const cleanName = (s: string) => s.replace(/\s+/g, ' ').trim();
const phoneExists = (c: { id: number; full_name: string; public_code: string }) =>
  new HttpException({ code: 'PHONE_EXISTS', message: 'هذا الرقم مسجل لزبون موجود', customer: c }, 409);

const COLS = `id, branch_id, public_code, phone, full_name, gender, birth_date::text as birth_date, source, status, points_balance, notify_offers, created_at`;

@Injectable()
export class CustomersService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** تسجيل زبون من الكاشير/المدير/المالك. إذا الرقم مسجل → 409 مع بيانات الزبون الموجود حتى يحجزله بدل ما يكرر. */
  async create(actor: AuthUser, dto: CreateCustomerDto, ip: string | null) {
    const name = cleanName(dto.full_name);
    if (name.length < 2) throw Errors.badRequest('INVALID_NAME', 'الاسم قصير');
    const phone = normalizePhone(dto.phone);
    if (dto.birth_date) this.assertBirthDate(dto.birth_date);
    const branchId = await resolveBranch(this.db, actor, dto.branch_id);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.db.tx(async (q) => {
          const dup = (await q.query(`select id, full_name, public_code from customers where phone = $1 and status = 'active'`, [phone])).rows[0];
          if (dup) throw phoneExists({ id: Number(dup.id), full_name: dup.full_name, public_code: dup.public_code });
          const { rows } = await q.query(
            `insert into customers (branch_id, public_code, phone, full_name, gender, birth_date, source, created_by)
             values ($1,$2,$3,$4,$5,$6,'cashier',$7) returning ${COLS}`,
            [branchId, newPublicCode(), phone, name, dto.gender ?? null, dto.birth_date ?? null, actor.id]);
          await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'customer.create', entityType: 'customer', entityId: Number(rows[0].id), after: { phone, full_name: name }, ip });
          return this.shape(rows[0]);
        });
      } catch (e: any) {
        if (e?.code === '23505' && String(e.constraint).includes('public_code')) continue;     // تصادم رمز نادر → رمز جديد
        if (e?.code === '23505' && String(e.constraint) === 'customers_phone_uq') {            // سباق: زبون ثاني سجل نفس الرقم بنفس اللحظة
          const dup = (await this.db.query(`select id, full_name, public_code from customers where phone = $1 and status = 'active'`, [phone])).rows[0];
          if (dup) throw phoneExists({ id: Number(dup.id), full_name: dup.full_name, public_code: dup.public_code });
        }
        throw e;
      }
    }
    throw Errors.conflict('CODE_GENERATION_FAILED', 'تعذر توليد رمز مميز، حاول مرة ثانية');
  }

  /** بحث بالرقم (كامل أو جزء منه)، أو الرمز المميز، أو جزء من الاسم. أقصى 20 نتيجة. الزبائن مشتركين بين فروع العيادة. */
  async search(q: string | undefined) {
    const term = (q ?? '').trim();
    if (term.length < 2) throw Errors.badRequest('QUERY_TOO_SHORT', 'اكتب حرفين على الأقل للبحث');
    const full = tryNormalizePhone(term);
    const digits = term.replace(/[٠-٩]/g, (c) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/\D/g, '');
    const esc = term.replace(/[\\%_]/g, (c) => `\\${c}`);
    const { rows } = await this.db.query(
      `select ${COLS} from customers
        where status = 'active' and (
              ($1::text is not null and phone = $1)
           or ($2::text is not null and length($2) >= 4 and phone like '%' || $2 || '%')
           or public_code = upper($3)
           or full_name ilike '%' || $4 || '%')
        order by (phone = $1) desc nulls last, (public_code = upper($3)) desc, full_name limit 20`,
      [full, digits || null, term, esc]);
    return rows.map((r) => this.shape(r));
  }

  async get(id: number) {
    const { rows } = await this.db.query(`select ${COLS}, merged_into_id from customers where id = $1`, [id]);
    if (!rows[0]) throw Errors.notFound('الزبون');
    const upcoming = await this.db.query(
      `select v.id, v.visit_date::text as date, v.seq_no, v.status, v.branch_id, v.doctor_id
         from visits v where v.customer_id = $1 and v.status in ('booked','arrived') and v.visit_date >= clinic_today() order by v.visit_date, v.seq_no`, [id]);
    return { ...this.shape(rows[0]), merged_into_id: rows[0].merged_into_id === null ? null : Number(rows[0].merged_into_id),
      upcoming_visits: upcoming.rows.map((v) => ({ id: Number(v.id), date: v.date, seq_no: v.seq_no, status: v.status, branch_id: Number(v.branch_id), doctor_id: v.doctor_id === null ? null : Number(v.doctor_id) })) };
  }

  async update(actor: AuthUser, id: number, dto: UpdateCustomerDto, ip: string | null) {
    const name = dto.full_name === undefined ? undefined : cleanName(dto.full_name);
    if (name !== undefined && name.length < 2) throw Errors.badRequest('INVALID_NAME', 'الاسم قصير');
    if (dto.birth_date) this.assertBirthDate(dto.birth_date);
    return this.db.tx(async (q) => {
      const cur = (await q.query(`select ${COLS} from customers where id = $1 for update`, [id])).rows[0];
      if (!cur) throw Errors.notFound('الزبون');
      if (cur.status !== 'active') throw Errors.conflict('CUSTOMER_MERGED', 'هذا الملف مدموج بملف ثاني');
      const { rows } = await q.query(
        `update customers set full_name = coalesce($2, full_name), gender = coalesce($3, gender), birth_date = coalesce($4::date, birth_date),
                notify_offers = coalesce($5, notify_offers), updated_at = now() where id = $1 returning ${COLS}`,
        [id, name ?? null, dto.gender ?? null, dto.birth_date ?? null, dto.notify_offers ?? null]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, action: 'customer.update', entityType: 'customer', entityId: id,
        before: { full_name: cur.full_name, gender: cur.gender, birth_date: cur.birth_date, notify_offers: cur.notify_offers },
        after: { full_name: rows[0].full_name, gender: rows[0].gender, birth_date: rows[0].birth_date, notify_offers: rows[0].notify_offers }, ip });
      return this.shape(rows[0]);
    });
  }

  /** تغيير الرقم من المالك فقط وبسبب مكتوب، ويتسجل بسجل الحركات (القسم 12 ز). */
  async changePhone(actor: AuthUser, id: number, dto: ChangePhoneDto, ip: string | null) {
    const phone = normalizePhone(dto.phone);
    const reason = dto.reason.trim();
    if (reason.length < 3) throw Errors.badRequest('REASON_REQUIRED', 'اكتب سبب التغيير');
    try {
      return await this.db.tx(async (q) => {
        const cur = (await q.query(`select ${COLS} from customers where id = $1 for update`, [id])).rows[0];
        if (!cur) throw Errors.notFound('الزبون');
        if (cur.status !== 'active') throw Errors.conflict('CUSTOMER_MERGED', 'هذا الملف مدموج بملف ثاني');
        if (cur.phone === phone) return this.shape(cur);
        const dup = (await q.query(`select id, full_name, public_code from customers where phone = $1 and status = 'active'`, [phone])).rows[0];
        if (dup) throw phoneExists({ id: Number(dup.id), full_name: dup.full_name, public_code: dup.public_code });
        const { rows } = await q.query(`update customers set phone = $2, updated_at = now() where id = $1 returning ${COLS}`, [id, phone]);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, action: 'customer.change_phone', entityType: 'customer', entityId: id, reason,
          before: { phone: cur.phone }, after: { phone }, ip });
        return this.shape(rows[0]);
      });
    } catch (e: any) {
      if (e?.code === '23505' && String(e.constraint) === 'customers_phone_uq') throw Errors.conflict('PHONE_EXISTS', 'هذا الرقم مسجل لزبون موجود');
      throw e;
    }
  }

  /**
   * دمج ملف مكرر بملف ثاني (المالك بس، بسبب): الملف المكرر يصير «مدموج» ويشير للباقي، وحجوزاته وخططه وجلساته وأجهزته ونقاطه تنتقل.
   * ما يصير إذا للمكرر **علاجات أو مدفوعات** (الوصولات والسجلات المالية ما تنتقل ولا تتعدل)، وما يصير إذا للملفين زيارتين فعالتين بنفس اليوم.
   * أبداً مو تلقائي: المالك يقارن الملفين ويقرر.
   */
  async merge(actor: AuthUser, fromId: number, dto: MergeCustomersDto, ip: string | null) {
    const reason = dto.reason.trim();
    if (reason.length < 3) throw Errors.badRequest('REASON_REQUIRED', 'اكتب سبب الدمج');
    if (fromId === dto.into_id) throw Errors.badRequest('SAME_CUSTOMER', 'ما تدمج ملف بنفسه');
    try {
      return await this.db.tx(async (q) => {
        const ids = [fromId, dto.into_id].sort((a, b) => a - b);
        const rows = (await q.query(`select ${COLS}, merged_into_id, app_registered_at, app_deleted_at from customers where id = any($1::bigint[]) order by id for update`, [ids])).rows;
        const from = rows.find((r) => Number(r.id) === fromId); const into = rows.find((r) => Number(r.id) === dto.into_id);
        if (!from || !into) throw Errors.notFound('الزبون');
        if (from.status !== 'active' || into.status !== 'active') throw Errors.conflict('CUSTOMER_MERGED', 'أحد الملفين مدموج مسبقاً');
        const blockers = (await q.query(
          `select (select count(*)::int from payments where customer_id = $1) as payments,
                  (select count(*)::int from treatment_sessions where customer_id = $1 and status in ('paid','completed')) as sessions,
                  (select count(*)::int from consultations where customer_id = $1 and status in ('paid','with_doctor','finished')) as consultations`, [fromId])).rows[0];
        if (Number(blockers.payments) || Number(blockers.sessions) || Number(blockers.consultations))
          throw Errors.conflictWith('HAS_TREATMENTS', 'الملف المكرر فيه علاجات أو مدفوعات: ما ينندمج (السجلات المالية ما تنتقل)', { payments: Number(blockers.payments), sessions: Number(blockers.sessions), consultations: Number(blockers.consultations) });
        const clash = (await q.query(
          `select a.visit_date::text as d from visits a join visits b on b.visit_date = a.visit_date and b.customer_id = $2 and b.status in ('booked','arrived') where a.customer_id = $1 and a.status in ('booked','arrived') order by a.visit_date`, [fromId, dto.into_id])).rows;
        if (clash.length) throw Errors.conflictWith('SAME_DAY_VISITS', 'للملفين حجز فعال بنفس اليوم: ألغِ أو انقل واحد منهم أول', { dates: clash.map((r) => r.d) });
        const moved: Record<string, number> = {};
        for (const t of ['visits', 'consultations', 'treatment_plans', 'treatment_sessions', 'discount_requests', 'notifications', 'session_photos', 'customer_devices']) {
          moved[t] = (await q.query(`update ${t} set customer_id = $2 where customer_id = $1`, [fromId, dto.into_id])).rowCount ?? 0;
        }
        await q.query(`update refresh_tokens set revoked_at = now() where customer_id = $1 and revoked_at is null`, [fromId]);
        const points = Number(from.points_balance);
        const m = (await q.query(`insert into customer_merges (from_customer_id, into_customer_id, reason, summary, merged_by) values ($1,$2,$3,$4,$5) returning id`, [fromId, dto.into_id, reason, JSON.stringify({ moved, points }), actor.id])).rows[0];
        if (points > 0) {
          await q.query(`insert into points_ledger (customer_id, entry_type, points, merge_id, created_by) values ($1,'merge_out',$2,$3,$4)`, [fromId, -points, m.id, actor.id]);
          await q.query(`insert into points_ledger (customer_id, entry_type, points, merge_id, created_by) values ($1,'merge_in',$2,$3,$4)`, [dto.into_id, points, m.id, actor.id]);
        }
        // المعلومات الصحية سجل إضافة فقط (ما تنتقل): آخر سجل للمكرر ينتسخ للباقي إذا الباقي ما عنده أحدث منه
        const h = (await q.query(`select * from customer_health where customer_id = $1 order by id desc limit 1`, [fromId])).rows[0];
        let healthCopied = false;
        if (h) {
          const newer = (await q.query(`select 1 from customer_health where customer_id = $1 and created_at > $2`, [dto.into_id, h.created_at])).rowCount;
          if (!newer) {
            await q.query(`insert into customer_health (customer_id, consultation_id, recorded_by, allergies, pregnancy, chronic_conditions, medications, notes) values ($1,null,$2,$3,$4,$5,$6,$7)`,
              [dto.into_id, h.recorded_by, h.allergies, h.pregnancy, h.chronic_conditions, h.medications, [h.notes, 'منقول من ملف مدموج'].filter(Boolean).join(' · ')]);
            healthCopied = true;
          }
        }
        await q.query(`update customers set status = 'merged', merged_into_id = $2, app_deleted_at = coalesce(app_deleted_at, case when app_registered_at is not null then now() end), updated_at = now() where id = $1`, [fromId, dto.into_id]);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(into.branch_id), action: 'customer.merge', entityType: 'customer', entityId: dto.into_id, reason,
          before: { from_customer_id: fromId, from_phone: from.phone }, after: { into_customer_id: dto.into_id, moved, points, health_copied: healthCopied }, ip });
        const cur = (await q.query(`select ${COLS} from customers where id = $1`, [dto.into_id])).rows[0];
        return { ...this.shape(cur), merge: { id: Number(m.id), from_customer_id: fromId, moved, points_moved: points > 0 ? points : 0, health_copied: healthCopied } };
      });
    } catch (e: any) {
      if (e?.code === '23505' && String(e.constraint).includes('visits_one_per_day')) throw Errors.conflict('SAME_DAY_VISITS', 'للملفين حجز فعال بنفس اليوم');
      throw e;
    }
  }

  private assertBirthDate(s: string) {
    assertDate(s, 'تاريخ الميلاد');
    if (s < '1900-01-01' || s > new Date().toISOString().slice(0, 10)) throw Errors.badRequest('INVALID_BIRTH_DATE', 'تاريخ الميلاد غير منطقي');
  }

  private shape(r: any) {
    return { id: Number(r.id), branch_id: Number(r.branch_id), public_code: r.public_code, phone: r.phone, full_name: r.full_name, gender: r.gender,
      birth_date: r.birth_date, source: r.source, status: r.status, points_balance: Number(r.points_balance), notify_offers: r.notify_offers, created_at: r.created_at };
  }
}
