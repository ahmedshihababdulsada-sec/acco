import { HttpException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { can } from '../auth/permissions';
import { resolveBranch } from '../common/branch';
import { Errors } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import {
  CreateFieldDto, CreateServiceDto, MaterialLinkDto, OptionInputDto, UpdateFieldDto, UpdateOptionDto, UpdateServiceDto,
} from './catalog.dto';
import { FieldDef, MaterialLink, OptionDef, ServiceDef, completenessProblems, quote, toScaled } from './pricing';

export interface LoadedService extends ServiceDef {
  branch_id: number; name_en: string | null; is_active: boolean; version: number; sort_order: number;
  fields: (FieldDef & { label_en: string | null; version: number; sort_order: number; options: (OptionDef & { label_en: string | null; sort_order: number })[] })[];
}

const conflict = (code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, 409);

@Injectable()
export class CatalogService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  // ------------------------------------------------------------------ قراءة
  async list(actor: AuthUser, includeInactive: boolean, requestedBranch?: number): Promise<LoadedService[]> {
    const manage = can(actor.role, 'services.define');
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    const { rows } = await this.db.query(
      `select id from services where branch_id = $1 and ($2::boolean or is_active) order by sort_order, id`, [branchId, manage && includeInactive]);
    return Promise.all(rows.map((r) => this.load(this.db, Number(r.id))));
  }

  async get(actor: AuthUser, id: number): Promise<LoadedService> {
    return this.loadScoped(this.db, actor, id);
  }

  /** يجيب تعريف الخدمة كامل (سعر ساري، حقول، خيارات بأسعارها، ربط المواد). `at` للسعر التاريخي. */
  async load(q: Queryable, id: number, at?: Date): Promise<LoadedService> {
    // «الآن» من ساعة القاعدة (نفس مصدر ختم الأسعار) مو ساعة Node، حتى السعر الجديد يظهر فوراً بدون فرق ميلي ثانية
    const when = at ?? null;
    const s = (await q.query(`select * from services where id = $1`, [id])).rows[0];
    if (!s) throw Errors.notFound('الخدمة');
    const price = (await q.query(`select price from service_prices where service_id = $1 and effective_from <= coalesce($2::timestamptz, clock_timestamp()) order by effective_from desc limit 1`, [id, when])).rows[0];
    const fields = (await q.query(`select * from service_fields where service_id = $1 order by sort_order, id`, [id])).rows;
    const options = fields.length ? (await q.query(
      `select o.*, (select p.price from option_prices p where p.option_id = o.id and p.effective_from <= coalesce($2::timestamptz, clock_timestamp()) order by p.effective_from desc limit 1) as price
         from service_options o where o.field_id = any($1::bigint[]) order by o.sort_order, o.id`, [fields.map((f) => f.id), when])).rows : [];
    const mats = (await q.query(`select * from service_materials where service_id = $1 order by id`, [id])).rows;
    return {
      id: Number(s.id), branch_id: Number(s.branch_id), name_ar: s.name_ar, name_en: s.name_en, kind: s.kind, pricing_model: s.pricing_model,
      is_active: s.is_active, version: s.version, sort_order: s.sort_order, price: price ? Number(price.price) : null,
      fields: fields.map((f) => ({
        id: Number(f.id), field_key: f.field_key, label_ar: f.label_ar, label_en: f.label_en, field_type: f.field_type, unit_label: f.unit_label,
        is_required: f.is_required, pricing_role: f.pricing_role, is_active: f.is_active, version: f.version, sort_order: f.sort_order,
        options: options.filter((o) => Number(o.field_id) === Number(f.id)).map((o) => ({
          id: Number(o.id), label_ar: o.label_ar, label_en: o.label_en, is_exclusive: o.is_exclusive, is_active: o.is_active, sort_order: o.sort_order,
          price: o.price === null ? null : Number(o.price),
        })),
      })),
      materials: mats.map((m): MaterialLink => ({ material_id: Number(m.material_id), field_id: m.field_id === null ? null : Number(m.field_id), formula: m.formula, factor: String(m.factor) })),
    };
  }

  /** نطاق الفرع: غير المالك يشوف فرعه بس (فرع ثاني → 404). الطبيب والكاشير ما يشوفون الخدمة المعطلة. */
  private async loadScoped(q: Queryable, actor: AuthUser, id: number, at?: Date): Promise<LoadedService> {
    const s = await this.load(q, id, at).catch((e) => { throw e; });
    const manage = can(actor.role, 'services.define');
    if ((actor.role !== 'owner' && s.branch_id !== actor.branchId) || (!manage && !s.is_active)) throw Errors.notFound('الخدمة');
    return s;
  }

  /** نفس loadScoped لكن بقفل الصف (للتعديل). */
  private async lockService(q: Queryable, actor: AuthUser, id: number): Promise<LoadedService> {
    const r = await q.query(`select 1 from services where id = $1 for update`, [id]);
    if (!r.rowCount) throw Errors.notFound('الخدمة');
    return this.loadScoped(q, actor, id);
  }

  // ------------------------------------------------------------------ الخدمة
  async create(actor: AuthUser, dto: CreateServiceDto, ip: string | null) {
    const branchId = await resolveBranch(this.db, actor, dto.branch_id);
    if (dto.pricing_model === 'per_option' && dto.price !== undefined) throw Errors.badRequest('PRICE_PER_OPTION', 'الخدمة بسعر الخيارات ما إلها سعر عام: الأسعار على الخيارات');
    return this.db.tx(async (q) => {
      // تنشأ معطلة (مسودة) لحد ما تكتمل وتتفعّل، حتى ما يشوفها الطبيب ناقصة
      const { rows } = await q.query(
        `insert into services (branch_id, name_ar, name_en, kind, pricing_model, is_active, created_by) values ($1,$2,$3,'treatment',$4,false,$5) returning id`,
        [branchId, dto.name_ar.trim(), dto.name_en?.trim() || null, dto.pricing_model, actor.id]);
      const id = Number(rows[0].id);
      if (dto.price !== undefined) await q.query(`insert into service_prices (service_id, price, set_by) values ($1,$2,$3)`, [id, dto.price, actor.id]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'service.create', entityType: 'service', entityId: id, after: { name_ar: dto.name_ar, pricing_model: dto.pricing_model, price: dto.price ?? null }, ip });
      return this.load(q, id);
    });
  }

  async update(actor: AuthUser, id: number, dto: UpdateServiceDto, ip: string | null) {
    return this.db.tx(async (q) => {
      const s = await this.lockService(q, actor, id);
      if (s.version !== dto.expected_version) throw conflict('SERVICE_CONFLICT', 'أحد عدّل هذي الخدمة قبلك. حدّث الصفحة وراجع');
      await q.query(`update services set name_ar = coalesce($2, name_ar), name_en = coalesce($3, name_en), sort_order = coalesce($4, sort_order), version = version + 1 where id = $1`,
        [id, dto.name_ar?.trim() ?? null, dto.name_en?.trim() ?? null, dto.sort_order ?? null]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: s.branch_id, action: 'service.update', entityType: 'service', entityId: id, before: { name_ar: s.name_ar, sort_order: s.sort_order }, after: dto, ip });
      return this.load(q, id);
    });
  }

  /** السعر الجديد سجل جديد بتاريخه (التاريخ ما ينعدل). الوصولات القديمة ما تتأثر. */
  async setPrice(actor: AuthUser, id: number, price: number, ip: string | null) {
    return this.db.tx(async (q) => {
      const s = await this.lockService(q, actor, id);
      if (s.pricing_model === 'per_option') throw Errors.badRequest('PRICE_PER_OPTION', 'الخدمة بسعر الخيارات: غيّر سعر كل خيار لحاله');
      await q.query(`insert into service_prices (service_id, price, effective_from, set_by) values ($1,$2,clock_timestamp(),$3)`, [id, price, actor.id]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: s.branch_id, action: 'service.price', entityType: 'service', entityId: id, before: { price: s.price }, after: { price }, ip });
      return this.load(q, id);
    });
  }

  async activate(actor: AuthUser, id: number, ip: string | null) {
    try {
      return await this.db.tx(async (q) => {
        const s = await this.lockService(q, actor, id);
        const problems = completenessProblems(s);
        if (problems.length) throw conflict('SERVICE_INCOMPLETE', `الخدمة ناقصة: ${problems.join('، ')}`, { problems });
        if (!s.is_active) {
          await q.query(`update services set is_active = true, version = version + 1 where id = $1`, [id]);
          await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: s.branch_id, action: 'service.activate', entityType: 'service', entityId: id, ip });
        }
        return this.load(q, id);
      });
    } catch (e: any) {
      if (e?.code === '23505') throw conflict('CONSULTATION_EXISTS', 'يوجد كشفية فعالة بهذا الفرع. عطلها أول');
      throw e;
    }
  }

  async deactivate(actor: AuthUser, id: number, ip: string | null) {
    return this.db.tx(async (q) => {
      const s = await this.lockService(q, actor, id);
      if (s.is_active) {
        await q.query(`update services set is_active = false, version = version + 1 where id = $1`, [id]);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: s.branch_id, action: 'service.deactivate', entityType: 'service', entityId: id, ip });
      }
      return this.load(q, id);
    });
  }

  // ------------------------------------------------------------------ الحقول
  async addField(actor: AuthUser, serviceId: number, dto: CreateFieldDto, ip: string | null) {
    try {
      return await this.db.tx(async (q) => {
        const s = await this.lockService(q, actor, serviceId);
        const role = dto.pricing_role ?? 'none';
        this.assertRole(s, dto.field_type, role, undefined);
        if (dto.options?.length && !['select', 'multi_select'].includes(dto.field_type)) throw Errors.badRequest('OPTIONS_NOT_ALLOWED', 'الخيارات للحقول من نوع اختيار فقط');
        if (role === 'quantity' && dto.is_required === false) throw Errors.badRequest('QUANTITY_MUST_BE_REQUIRED', 'حقل الكمية لازم يكون مطلوباً');
        const f = await q.query(
          `insert into service_fields (service_id, field_key, label_ar, label_en, field_type, unit_label, is_required, pricing_role, sort_order)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
          [serviceId, dto.field_key, dto.label_ar.trim(), dto.label_en?.trim() || null, dto.field_type, dto.unit_label?.trim() || null,
            role === 'none' ? dto.is_required ?? false : true, role, dto.sort_order ?? s.fields.length + 1]);
        const fieldId = Number(f.rows[0].id);
        const seen = new Set<string>();
        for (const [i, o] of (dto.options ?? []).entries()) {
          const k = normalize(o.label_ar);
          if (seen.has(k)) throw conflict('OPTION_EXISTS', `الخيار «${o.label_ar}» مكرر`);
          seen.add(k);
          await this.insertOption(q, fieldId, o, i + 1, actor.id);
        }
        await this.snapshot(q, fieldId, actor.id);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: s.branch_id, action: 'service.field_add', entityType: 'service_field', entityId: fieldId, after: { service_id: serviceId, field_key: dto.field_key, field_type: dto.field_type, pricing_role: role }, ip });
        await this.assertStillComplete(q, serviceId);
        return this.load(q, serviceId);
      });
    } catch (e: any) {
      if (e?.code === '23505') throw conflict('FIELD_KEY_EXISTS', 'مفتاح الحقل مستخدم بهذي الخدمة');
      throw e;
    }
  }

  async updateField(actor: AuthUser, fieldId: number, dto: UpdateFieldDto, ip: string | null) {
    return this.db.tx(async (q) => {
      const { serviceId, field } = await this.lockField(q, actor, fieldId);
      if (field.version !== dto.expected_version) throw conflict('FIELD_CONFLICT', 'أحد عدّل هذا الحقل قبلك. حدّث الصفحة وراجع');
      if (field.pricing_role === 'quantity' && dto.is_required === false) throw Errors.badRequest('QUANTITY_MUST_BE_REQUIRED', 'حقل الكمية لازم يكون مطلوباً');
      if (field.pricing_role === 'option' && dto.is_required === false) throw Errors.badRequest('OPTION_MUST_BE_REQUIRED', 'حقل خيارات التسعير لازم يكون مطلوباً');
      await q.query(
        `update service_fields set label_ar = coalesce($2, label_ar), label_en = coalesce($3, label_en), unit_label = coalesce($4, unit_label),
                is_required = coalesce($5, is_required), is_active = coalesce($6, is_active), sort_order = coalesce($7, sort_order), version = version + 1 where id = $1`,
        [fieldId, dto.label_ar?.trim() ?? null, dto.label_en?.trim() ?? null, dto.unit_label?.trim() ?? null, dto.is_required ?? null, dto.is_active ?? null, dto.sort_order ?? null]);
      await this.snapshot(q, fieldId, actor.id);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, action: 'service.field_update', entityType: 'service_field', entityId: fieldId, before: { label_ar: field.label_ar, is_required: field.is_required, is_active: field.is_active }, after: dto, ip });
      await this.assertStillComplete(q, serviceId);
      return this.load(q, serviceId);
    });
  }

  // ------------------------------------------------------------------ الخيارات
  async addOption(actor: AuthUser, fieldId: number, dto: OptionInputDto, ip: string | null) {
    return this.db.tx(async (q) => {
      const { serviceId, field } = await this.lockField(q, actor, fieldId);
      if (!['select', 'multi_select'].includes(field.field_type)) throw Errors.badRequest('OPTIONS_NOT_ALLOWED', 'الخيارات للحقول من نوع اختيار فقط');
      await this.assertOptionLabelFree(q, fieldId, dto.label_ar);
      const n = Number((await q.query(`select coalesce(max(sort_order), 0) + 1 as n from service_options where field_id = $1`, [fieldId])).rows[0].n);
      const optionId = await this.insertOption(q, fieldId, dto, dto.sort_order ?? n, actor.id);
      await q.query(`update service_fields set version = version + 1 where id = $1`, [fieldId]);
      await this.snapshot(q, fieldId, actor.id);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, action: 'service.option_add', entityType: 'service_option', entityId: optionId, after: { field_id: fieldId, label_ar: dto.label_ar, price: dto.price ?? null }, ip });
      await this.assertStillComplete(q, serviceId);
      return this.load(q, serviceId);
    });
  }

  async updateOption(actor: AuthUser, optionId: number, dto: UpdateOptionDto, ip: string | null) {
    return this.db.tx(async (q) => {
      const o = (await q.query(`select * from service_options where id = $1 for update`, [optionId])).rows[0];
      if (!o) throw Errors.notFound('الخيار');
      const { serviceId } = await this.lockField(q, actor, Number(o.field_id));
      if (dto.label_ar !== undefined && normalize(dto.label_ar) !== normalize(o.label_ar)) await this.assertOptionLabelFree(q, Number(o.field_id), dto.label_ar);
      await q.query(
        `update service_options set label_ar = coalesce($2, label_ar), label_en = coalesce($3, label_en), is_exclusive = coalesce($4, is_exclusive),
                is_active = coalesce($5, is_active), sort_order = coalesce($6, sort_order), version = version + 1 where id = $1`,
        [optionId, dto.label_ar?.trim() ?? null, dto.label_en?.trim() ?? null, dto.is_exclusive ?? null, dto.is_active ?? null, dto.sort_order ?? null]);
      await q.query(`update service_fields set version = version + 1 where id = $1`, [o.field_id]);
      await this.snapshot(q, Number(o.field_id), actor.id);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, action: 'service.option_update', entityType: 'service_option', entityId: optionId, before: { label_ar: o.label_ar, is_exclusive: o.is_exclusive, is_active: o.is_active }, after: dto, ip });
      await this.assertStillComplete(q, serviceId);
      return this.load(q, serviceId);
    });
  }

  async setOptionPrice(actor: AuthUser, optionId: number, price: number, ip: string | null) {
    return this.db.tx(async (q) => {
      const o = (await q.query(`select * from service_options where id = $1 for update`, [optionId])).rows[0];
      if (!o) throw Errors.notFound('الخيار');
      const { serviceId, field } = await this.lockField(q, actor, Number(o.field_id));
      if (field.pricing_role !== 'option') throw Errors.badRequest('NOT_PRICED_OPTION', 'هذا الحقل ما يسعّر بالخيارات');
      const before = (await q.query(`select price from option_prices where option_id = $1 order by effective_from desc limit 1`, [optionId])).rows[0];
      await q.query(`insert into option_prices (option_id, price, effective_from, set_by) values ($1,$2,clock_timestamp(),$3)`, [optionId, price, actor.id]);
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, action: 'service.option_price', entityType: 'service_option', entityId: optionId, before: { price: before ? Number(before.price) : null }, after: { price }, ip });
      return this.load(q, serviceId);
    });
  }

  // ------------------------------------------------------------------ ربط المواد
  async setMaterials(actor: AuthUser, serviceId: number, items: MaterialLinkDto[], ip: string | null) {
    return this.db.tx(async (q) => {
      const s = await this.lockService(q, actor, serviceId);
      const seen = new Set<string>();
      for (const it of items) {
        try { toScaled(it.factor, 4); } catch { throw Errors.badRequest('INVALID_FACTOR', 'المعامل رقم موجب بحد أقصى 4 خانات عشرية'); }
        const mat = (await q.query(`select branch_id, is_active from materials where id = $1`, [it.material_id])).rows[0];
        if (!mat || Number(mat.branch_id) !== s.branch_id) throw Errors.badRequest('MATERIAL_NOT_FOUND', 'مادة غير موجودة بهذا الفرع');
        if (!mat.is_active) throw Errors.badRequest('MATERIAL_INACTIVE', 'المادة معطلة');
        if (it.formula === 'per_field_value') {
          const f = s.fields.find((x) => x.id === it.field_id && x.is_active);
          if (!f) throw Errors.badRequest('FIELD_NOT_FOUND', 'الحقل غير موجود بهذي الخدمة أو معطل');
          if (f.field_type !== 'number' || !f.is_required) throw Errors.badRequest('FIELD_NOT_QUANTITY', `الحقل «${f.label_ar}» لازم يكون رقماً ومطلوباً`);
        } else if (it.field_id !== undefined) {
          throw Errors.badRequest('FIELD_NOT_ALLOWED', 'الكمية الثابتة ما ترتبط بحقل');
        }
        const k = `${it.material_id}|${it.formula}|${it.field_id ?? ''}`;
        if (seen.has(k)) throw Errors.badRequest('DUPLICATE_LINK', 'ربط مكرر لنفس المادة والحقل');
        seen.add(k);
      }
      await q.query(`delete from service_materials where service_id = $1`, [serviceId]);
      for (const it of items) {
        await q.query(`insert into service_materials (service_id, field_id, material_id, formula, factor) values ($1,$2,$3,$4,$5)`,
          [serviceId, it.field_id ?? null, it.material_id, it.formula, it.factor]);
      }
      await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: s.branch_id, action: 'service.materials', entityType: 'service', entityId: serviceId, before: s.materials, after: items, ip });
      await this.assertStillComplete(q, serviceId);
      return this.load(q, serviceId);
    });
  }

  // ------------------------------------------------------------------ معاينة السعر والاستهلاك
  async quote(actor: AuthUser, id: number, values: Record<string, unknown>, at?: string) {
    let when: Date | undefined;
    if (at !== undefined) {
      when = new Date(at);
      if (Number.isNaN(when.getTime())) throw Errors.badRequest('INVALID_DATE', 'تاريخ غير صحيح');
    }
    const s = await this.loadScoped(this.db, actor, id, when);
    return { service_id: s.id, ...quote(s, values) };
  }

  // ------------------------------------------------------------------ أدوات داخلية
  private assertRole(s: LoadedService, type: string, role: string, ignoreFieldId: number | undefined) {
    const active = s.fields.filter((f) => f.is_active && f.id !== ignoreFieldId);
    if (role === 'quantity') {
      if (type !== 'number') throw Errors.badRequest('ROLE_TYPE_MISMATCH', 'حقل الكمية لازم يكون رقم');
      if (s.pricing_model !== 'per_unit') throw Errors.badRequest('ROLE_MODEL_MISMATCH', 'حقل الكمية للخدمات بسعر الوحدة فقط');
      if (active.some((f) => f.pricing_role === 'quantity')) throw conflict('DUPLICATE_PRICING_FIELD', 'يوجد حقل كمية للتسعير مسبقاً');
    } else if (role === 'option') {
      if (!['select', 'multi_select'].includes(type)) throw Errors.badRequest('ROLE_TYPE_MISMATCH', 'حقل خيارات التسعير لازم يكون اختيار');
      if (s.pricing_model !== 'per_option') throw Errors.badRequest('ROLE_MODEL_MISMATCH', 'حقل الخيارات للخدمات بسعر الخيارات فقط');
      if (active.some((f) => f.pricing_role === 'option')) throw conflict('DUPLICATE_PRICING_FIELD', 'يوجد حقل خيارات تسعير مسبقاً');
    }
  }

  private async insertOption(q: Queryable, fieldId: number, o: OptionInputDto, sortOrder: number, userId: number): Promise<number> {
    const r = await q.query(`insert into service_options (field_id, label_ar, label_en, is_exclusive, sort_order) values ($1,$2,$3,$4,$5) returning id`,
      [fieldId, o.label_ar.trim(), o.label_en?.trim() || null, o.is_exclusive ?? false, sortOrder]);
    const id = Number(r.rows[0].id);
    if (o.price !== undefined) await q.query(`insert into option_prices (option_id, price, set_by) values ($1,$2,$3)`, [id, o.price, userId]);
    return id;
  }

  private async assertOptionLabelFree(q: Queryable, fieldId: number, label: string) {
    const { rows } = await q.query(`select 1 from service_options where field_id = $1 and lower(btrim(label_ar)) = $2`, [fieldId, normalize(label)]);
    if (rows.length) throw conflict('OPTION_EXISTS', `الخيار «${label}» موجود`);
  }

  /** يقفل الحقل وخدمته ويتأكد من نطاق الفرع. */
  private async lockField(q: Queryable, actor: AuthUser, fieldId: number) {
    const f = (await q.query(`select * from service_fields where id = $1 for update`, [fieldId])).rows[0];
    if (!f) throw Errors.notFound('الحقل');
    await this.lockService(q, actor, Number(f.service_id));
    const fresh = (await q.query(`select * from service_fields where id = $1`, [fieldId])).rows[0];
    return { serviceId: Number(f.service_id), field: { ...fresh, id: Number(fresh.id) } as any };
  }

  /** نسخة للحقل بكل تعديل: بند الخطة يشير للنسخة اللي انكتب بيها. */
  private async snapshot(q: Queryable, fieldId: number, userId: number) {
    const f = (await q.query(`select * from service_fields where id = $1`, [fieldId])).rows[0];
    const opts = (await q.query(`select id, label_ar, label_en, is_exclusive, is_active from service_options where field_id = $1 order by sort_order, id`, [fieldId])).rows;
    const definition = {
      field_key: f.field_key, label_ar: f.label_ar, label_en: f.label_en, field_type: f.field_type, unit_label: f.unit_label,
      is_required: f.is_required, pricing_role: f.pricing_role, is_active: f.is_active,
      options: opts.map((o) => ({ id: Number(o.id), label_ar: o.label_ar, label_en: o.label_en, is_exclusive: o.is_exclusive, is_active: o.is_active })),
    };
    await q.query(`insert into service_field_versions (field_id, version_no, definition, changed_by) values ($1,$2,$3::jsonb,$4)`, [fieldId, f.version, JSON.stringify(definition), userId]);
  }

  /** الخدمة الفعالة لازم تبقى مكتملة بعد أي تعديل (وإلا يتراجع التعديل كله). */
  private async assertStillComplete(q: Queryable, serviceId: number) {
    const s = await this.load(q, serviceId);
    if (!s.is_active) return;
    const problems = completenessProblems(s);
    if (problems.length) throw conflict('SERVICE_INCOMPLETE', `هذا التعديل يخلي الخدمة الفعالة ناقصة: ${problems.join('، ')}. عطّل الخدمة أول`, { problems });
  }
}

const normalize = (s: string) => s.trim().toLowerCase();
