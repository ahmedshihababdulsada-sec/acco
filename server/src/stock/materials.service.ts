import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { resolveBranch } from '../common/branch';
import { Errors } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { CreateMaterialDto, UpdateMaterialDto } from './stock.dto';

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** المواد وأرصدتها (القسم 7). الوحدات والتحويل تنقفل لما تصير حركات. المواد للاستخدام داخل العيادة بس (ما تنباع). */
@Injectable()
export class MaterialsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async create(actor: AuthUser, dto: CreateMaterialDto, ip: string | null) {
    const name = clean(dto.name);
    if (name.length < 2) throw Errors.badRequest('INVALID_NAME', 'الاسم قصير');
    if ((dto.mid_unit === undefined) !== (dto.mid_per_pack === undefined)) throw Errors.badRequest('MID_UNIT_INCOMPLETE', 'الوحدة الوسطية وعددها بالكرتون يجون سوا');
    const branchId = await resolveBranch(this.db, actor, dto.branch_id);
    try {
      return await this.db.tx(async (q) => {
        const { rows } = await q.query(
          `insert into materials (branch_id, name, base_unit, pack_unit, mid_unit, mid_per_pack, base_per_mid, low_threshold, created_by)
           values ($1,$2,$3,$4,$5,$6,coalesce($7::numeric, 1),coalesce($8::numeric, 0),$9) returning id`,
          [branchId, name, clean(dto.base_unit), clean(dto.pack_unit), dto.mid_unit ? clean(dto.mid_unit) : null, dto.mid_per_pack ?? null, dto.base_per_mid ?? null, dto.low_threshold ?? null, actor.id]);
        const id = Number(rows[0].id);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId, action: 'material.create', entityType: 'material', entityId: id, after: { name, base_unit: dto.base_unit, pack_unit: dto.pack_unit }, ip });
        return this.detailQ(q, id);
      });
    } catch (e: any) {
      if (e?.code === '23505') throw Errors.conflict('MATERIAL_EXISTS', 'المادة موجودة');
      throw e;
    }
  }

  async update(actor: AuthUser, id: number, dto: UpdateMaterialDto, ip: string | null) {
    const name = dto.name === undefined ? undefined : clean(dto.name);
    if (name !== undefined && name.length < 2) throw Errors.badRequest('INVALID_NAME', 'الاسم قصير');
    const unitsTouched = [dto.base_unit, dto.pack_unit, dto.mid_unit, dto.mid_per_pack, dto.base_per_mid].some((v) => v !== undefined);
    try {
      return await this.db.tx(async (q) => {
        const m = (await q.query(`select * from materials where id = $1 for update`, [id])).rows[0];
        if (!m || (actor.role !== 'owner' && Number(m.branch_id) !== actor.branchId)) throw Errors.notFound('المادة');
        if (Number(m.version) !== dto.expected_version) throw Errors.conflictWith('VERSION_CONFLICT', 'المادة تعدلت من شخص ثاني: حدّث الصفحة', { current_version: Number(m.version) });
        if (name === undefined && dto.low_threshold === undefined && dto.is_active === undefined && !unitsTouched) throw Errors.badRequest('NO_CHANGE', 'ما أكو تغيير');
        const mid_unit = dto.mid_unit === undefined ? m.mid_unit : clean(dto.mid_unit) || null;
        const mid_per_pack = dto.mid_per_pack === undefined ? m.mid_per_pack : dto.mid_per_pack;
        if ((mid_unit === null) !== (mid_per_pack === null)) throw Errors.badRequest('MID_UNIT_INCOMPLETE', 'الوحدة الوسطية وعددها بالكرتون يجون سوا');
        await q.query(
          `update materials set name = coalesce($2, name), low_threshold = coalesce($3::numeric, low_threshold), is_active = coalesce($4, is_active),
                  base_unit = coalesce($5, base_unit), pack_unit = coalesce($6, pack_unit), mid_unit = $7, mid_per_pack = $8, base_per_mid = coalesce($9::numeric, base_per_mid), version = version + 1 where id = $1`,
          [id, name ?? null, dto.low_threshold ?? null, dto.is_active ?? null, dto.base_unit ? clean(dto.base_unit) : null, dto.pack_unit ? clean(dto.pack_unit) : null, mid_unit, mid_per_pack, dto.base_per_mid ?? null]);
        await this.audit.log(q, { actorUserId: actor.id, actorRole: actor.role, branchId: Number(m.branch_id), action: 'material.update', entityType: 'material', entityId: id,
          before: { name: m.name, low_threshold: m.low_threshold, is_active: m.is_active }, after: { name: name ?? m.name, low_threshold: dto.low_threshold ?? m.low_threshold, is_active: dto.is_active ?? m.is_active, units_changed: unitsTouched }, ip });
        return this.detailQ(q, id);
      });
    } catch (e: any) {
      if (e?.code === '23505') throw Errors.conflict('MATERIAL_EXISTS', 'المادة موجودة');
      if (e?.code === '23514' && String(e.message).includes('material units are locked')) throw Errors.conflict('UNITS_LOCKED', 'وحدات المادة والتحويل تنقفل بعد أول حركة مخزون');
      throw e;
    }
  }

  async list(actor: AuthUser, all: boolean, requestedBranch?: number) {
    const branchId = await resolveBranch(this.db, actor, requestedBranch);
    const { rows } = await this.db.query(`select m.id from materials m where m.branch_id = $1 and ($2 or m.is_active) order by m.name`, [branchId, all]);
    return { branch_id: branchId, materials: await Promise.all(rows.map((r) => this.detailQ(this.db, Number(r.id), false))) };
  }

  async get(actor: AuthUser, id: number) {
    const d = await this.detailQ(this.db, id);
    if (!d || (actor.role !== 'owner' && d.branch_id !== actor.branchId)) throw Errors.notFound('المادة');
    return d;
  }

  async detailQ(q: Queryable, id: number, withBatches = true) {
    const m = (await q.query(
      `select m.*, v.on_hand, v.valid_qty, v.expired_qty, v.near_expiry_qty, v.reserved, v.available, v.is_low, v.is_negative
         from materials m join v_material_stock v on v.material_id = m.id where m.id = $1`, [id])).rows[0];
    if (!m) return null;
    const out: any = {
      id: Number(m.id), branch_id: Number(m.branch_id), name: m.name, is_active: m.is_active, version: Number(m.version),
      units: { base_unit: m.base_unit, pack_unit: m.pack_unit, mid_unit: m.mid_unit, mid_per_pack: m.mid_per_pack === null ? null : Number(m.mid_per_pack), base_per_mid: Number(m.base_per_mid), base_per_pack: Number(m.base_per_pack) },
      low_threshold: Number(m.low_threshold), last_unit_cost: m.last_unit_cost === null ? null : Number(m.last_unit_cost),
      stock: { on_hand: Number(m.on_hand), valid: Number(m.valid_qty), expired: Number(m.expired_qty), near_expiry: Number(m.near_expiry_qty), reserved: Number(m.reserved), available: Number(m.available) },
      flags: { low: m.is_low, negative: m.is_negative, near_expiry: Number(m.near_expiry_qty) > 0, has_expired: Number(m.expired_qty) > 0 },
    };
    if (withBatches) {
      const days = Number((await q.query(`select setting_int($1, 'stock.near_expiry_days', 30) as d`, [m.branch_id])).rows[0].d);
      const b = (await q.query(
        `select b.id, b.source, b.received_on::text as received_on, b.expiry_date::text as expiry_date, b.unit_cost, b.qty_initial, b.qty_on_hand, pi.purchase_id, p.invoice_no,
                (b.expiry_date < clinic_today()) as expired, (b.expiry_date >= clinic_today() and b.expiry_date <= clinic_today() + $2::int) as near
           from material_batches b left join purchase_items pi on pi.id = b.purchase_item_id left join purchases p on p.id = pi.purchase_id
          where b.material_id = $1 order by b.expiry_date, b.id`, [id, days])).rows;
      out.batches = b.map((r) => ({ id: Number(r.id), source: r.source, received_on: r.received_on, expiry_date: r.expiry_date, unit_cost: Number(r.unit_cost), qty_initial: Number(r.qty_initial), qty_on_hand: Number(r.qty_on_hand),
        purchase_id: r.purchase_id === null ? null : Number(r.purchase_id), invoice_no: r.invoice_no, status: Number(r.qty_on_hand) === 0 ? 'empty' : r.expired ? 'expired' : r.near ? 'near_expiry' : 'ok' }));
    }
    return out;
  }
}
