import { Injectable } from '@nestjs/common';
import { DbService, Queryable } from '../db/db.service';
import { Errors } from '../common/errors';
import { offerDiscount } from '../offers/offer-math';
import { OffersService } from '../offers/offers.service';
import { PlansService } from '../plans/plans.service';
import { SettingsService } from '../settings/settings.service';
import { CustomerAuthService } from './customer-auth.service';
import { UpdateProfileDto } from './customer-app.dto';

const cleanName = (s: string) => s.replace(/\s+/g, ' ').trim();

/** تطبيق الزبون: كل شي محصور بالزبون نفسه (الهوية من التوكن، مو من الطلب). */
@Injectable()
export class CustomerAppService {
  constructor(private readonly db: DbService, private readonly auth: CustomerAuthService, private readonly plans: PlansService, private readonly settings: SettingsService) {}

  profile(customerId: number) { return this.auth.profileQ(this.db, customerId); }

  async updateProfile(customerId: number, dto: UpdateProfileDto) {
    const name = dto.full_name !== undefined ? cleanName(dto.full_name) : undefined;
    if (name !== undefined && name.length < 2) throw Errors.badRequest('INVALID_NAME', 'الاسم قصير');
    if (dto.birth_date !== undefined) {
      const d = new Date(`${dto.birth_date}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== dto.birth_date) throw Errors.badRequest('INVALID_BIRTH_DATE', 'تاريخ الميلاد غير صحيح');
      const today = (await this.db.query(`select clinic_today()::text as d`)).rows[0].d;
      if (dto.birth_date > today || dto.birth_date < '1900-01-01') throw Errors.badRequest('INVALID_BIRTH_DATE', 'تاريخ الميلاد غير منطقي');
    }
    if (name === undefined && dto.gender === undefined && dto.birth_date === undefined && dto.notify_offers === undefined) throw Errors.badRequest('NOTHING_TO_UPDATE', 'ما أكو شي يتحدث');
    await this.db.query(
      `update customers set full_name = coalesce($2, full_name), gender = coalesce($3, gender), birth_date = coalesce($4::date, birth_date), notify_offers = coalesce($5, notify_offers), updated_at = now() where id = $1`,
      [customerId, name ?? null, dto.gender ?? null, dto.birth_date ?? null, dto.notify_offers ?? null]);
    return this.profile(customerId);
  }

  /** جلسات الزبون وحالاتها وسعرها (التقديري بسعر اليوم بعد العرض، والنهائي يتحدد يوم الدفع) */
  async sessions(customerId: number) {
    const today = (await this.db.query(`select clinic_today()::text as d`)).rows[0].d;
    const { rows } = await this.db.query(
      `select s.id, s.seq_no, s.status, s.scheduled_date::text as d, s.plan_item_id, s.branch_id, i.plan_id, sv.name_ar as service_name, i.sessions_count, v.id as visit_id, v.seq_no as visit_seq, v.status as visit_status
         from treatment_sessions s join plan_items i on i.id = s.plan_item_id join services sv on sv.id = i.service_id left join visits v on v.id = s.visit_id
        where s.customer_id = $1 and s.status <> 'cancelled' order by i.plan_id desc, i.sort_order, i.id, s.seq_no`, [customerId]);
    const out = [];
    for (const r of rows) {
      let estimate: number | null = null; let afterOffer: number | null = null; let offerPercent: number | null = null;
      if (['booked', 'awaiting_booking'].includes(r.status)) {
        try {
          const qt = await this.plans.quotePlanItem(this.db, Number(r.plan_item_id));
          estimate = qt.quote.list_price; afterOffer = estimate;
          const offer = await OffersService.activeFor(this.db, Number(r.branch_id), qt.svc.id);
          if (offer) { offerPercent = Number(offer.percent); afterOffer = estimate - offerDiscount(estimate, offer.percent); }
        } catch { estimate = null; afterOffer = null; }
      }
      const paid = await this.paidPrice(this.db, Number(r.id), r.status);
      out.push({
        id: Number(r.id), plan_id: Number(r.plan_id), service_name: r.service_name, seq_no: r.seq_no, of: Number(r.sessions_count), status: r.status as string,
        scheduled_date: r.d as string | null, visit_seq_no: r.visit_seq === null ? null : Number(r.visit_seq),
        movable: r.status === 'booked' && r.d !== null && r.d > today || (r.status === 'booked' && r.d === today),            // «ما مندفعة» بس
        estimate_price: estimate, estimate_after_offer: afterOffer, offer_percent: offerPercent, paid_amount: paid,
      });
    }
    return { today, sessions: out };
  }

  private async paidPrice(q: Queryable, sessionId: number, status: string): Promise<number | null> {
    if (!['paid', 'completed'].includes(status)) return null;
    const r = (await q.query(`select net_amount from payment_items where session_id = $1 and status = 'paid' order by id desc limit 1`, [sessionId])).rows[0];
    return r ? Number(r.net_amount) : null;
  }

  /** حجوزات الزبون: القادمة (محجوزة/حضر) أول، وبعدها آخر 20 سابقة */
  async bookings(customerId: number) {
    const rows = (await this.db.query(
      `select v.id, v.visit_date::text as d, v.seq_no, v.status, v.source, c.id as consultation_id, c.status as consultation_status, c.kind, u.full_name as doctor_name,
              (select count(*)::int from treatment_sessions s where s.visit_id = v.id and s.status in ('booked','paid')) as sessions, v.branch_id,
              (v.visit_date = clinic_today() and v.status in ('booked','arrived')) as today_active,
              (select count(*)::int from visits o left join consultations oc on oc.visit_id = o.id and oc.status <> 'cancelled'
                where o.branch_id = v.branch_id and o.visit_date = v.visit_date and o.seq_no < v.seq_no and o.status = 'arrived'
                  and (oc.status in ('paid','with_doctor') or exists (select 1 from treatment_sessions os where os.visit_id = o.id and os.status = 'paid'))) as ahead
         from visits v left join consultations c on c.visit_id = v.id and c.status <> 'cancelled' left join users u on u.id = v.doctor_id
        where v.customer_id = $1 and (v.visit_date >= clinic_today() and v.status in ('booked','arrived') or v.visit_date < clinic_today() or v.status in ('cancelled','missed'))
        order by (v.visit_date >= clinic_today() and v.status in ('booked','arrived')) desc, case when v.visit_date >= clinic_today() then v.visit_date end asc, v.visit_date desc, v.id desc limit 60`, [customerId])).rows;
    // انتهت عند الزبون: حضر وما بقى شي (ما أكو كشفية فعالة ولا جلسة محجوزة/مدفوعة). ما تطلع «موعدك القادم» ولا بيها رقم دور.
    const finished = (r: any) => r.status === 'arrived' && r.consultation_id === null && Number(r.sessions) === 0
      || r.status === 'arrived' && r.consultation_status === 'finished' && Number(r.sessions) === 0;
    return { bookings: rows.map((r) => ({
      finished: finished(r),
      id: Number(r.id), date: r.d as string, seq_no: Number(r.seq_no), status: r.status as string, kind: r.consultation_id ? (r.kind === 'free_followup' ? 'followup' : r.kind === 'sessions_only' ? 'sessions_only' : 'consultation') : 'sessions',
      turn: r.today_active && !finished(r) ? { seq_no: Number(r.seq_no), ahead: Number(r.ahead) } : null,        // «حاضرين قدامك» (دفعوا وما انخدموا بعد)
      doctor_name: r.doctor_name as string | null, consultation_status: r.consultation_status as string | null, sessions_count: Number(r.sessions),
      changeable: r.status === 'booked' && r.consultation_status === 'awaiting_payment' && Number(r.sessions) === 0,                // تغيير الموعد (يحرك الجلسات إذا موجودة، فمو للزيارة اللي بيها جلسات)
      cancellable: r.consultation_status === 'awaiting_payment' && (r.status === 'booked' || (r.status === 'arrived' && Number(r.sessions) > 0)),   // «حضر» ممكن إذا جلسة اندفعت قبل الكشفية المنضمة                                    // إلغاء الكشفية (إذا بالزيارة جلسات تنلغي الكشفية بس)
    })) };
  }

  /** الوصولات (دفعاتي) وتفاصيل وصل واحد */
  async payments(customerId: number) {
    const rows = (await this.db.query(`select id, receipt_no, kind, status, business_date::text as d, gross_amount, offer_discount, manual_discount, points_discount, net_amount, points_earned, points_used from payments where customer_id = $1 order by id desc limit 100`, [customerId])).rows;
    return { payments: rows.map((r) => this.paymentShape(r)) };
  }

  async payment(customerId: number, id: number) {
    const p = (await this.db.query(`select id, receipt_no, kind, status, business_date::text as d, gross_amount, offer_discount, manual_discount, points_discount, net_amount, points_earned, points_used from payments where id = $1 and customer_id = $2`, [id, customerId])).rows[0];
    if (!p) throw Errors.notFound('الوصل');
    const items = (await this.db.query(`select service_name, quantity, list_price, offer_percent, offer_discount, net_amount, status from payment_items where payment_id = $1 order by id`, [id])).rows;
    return { ...this.paymentShape(p), items: items.map((i) => ({ service_name: i.service_name, quantity: Number(i.quantity), list_price: Number(i.list_price), offer_percent: i.offer_percent === null ? null : Number(i.offer_percent), offer_discount: Number(i.offer_discount), net_amount: Number(i.net_amount), status: i.status })) };
  }
  private paymentShape(r: any) {
    return { id: Number(r.id), receipt_no: r.receipt_no, kind: r.kind, status: r.status, date: r.d, gross_amount: Number(r.gross_amount), offer_discount: Number(r.offer_discount), manual_discount: Number(r.manual_discount), points_discount: Number(r.points_discount), net_amount: Number(r.net_amount), points_earned: r.points_earned, points_used: r.points_used };
  }

  /** رصيد النقاط وحركاتها */
  async points(customerId: number) {
    const bal = (await this.db.query(`select points_balance from customers where id = $1`, [customerId])).rows[0];
    const rows = (await this.db.query(
      `select l.id, l.entry_type, l.points, l.created_at, p.receipt_no from points_ledger l left join payments p on p.id = l.payment_id where l.customer_id = $1 order by l.id desc limit 100`, [customerId])).rows;
    return { balance: Number(bal.points_balance), entries: rows.map((r) => ({ id: Number(r.id), type: r.entry_type, points: r.points, receipt_no: r.receipt_no, at: r.created_at })) };
  }

  /** أطباء فرع الزبون (للحجز) */
  async doctors(customerId: number, branchId: number) {
    const { rows } = await this.db.query(`select d.user_id, u.full_name, d.title from doctors d join users u on u.id = d.user_id where u.branch_id = $1 and u.is_active order by u.full_name`, [branchId]);
    // سعر كشفية «جلسات فقط» (0 = مجانية): يعرضه التطبيق عند اختيار نوع الحجز
    const sessionsOnlyFee = await this.settings.effective<number>(this.db, branchId, 'consultation.sessions_only_fee');
    // «أول مرة»: ما عنده كشفية دفعها ولا جلسة اندفعت. الزبون الراجع الافتراضي له «جلسات فقط» (الكشفية للجديد بس)
    const first = (await this.db.query(
      `select not (exists (select 1 from consultations where customer_id = $1 and status in ('paid','with_doctor','finished')) or exists (select 1 from treatment_sessions where customer_id = $1 and status in ('paid','completed'))) as first`, [customerId])).rows[0].first as boolean;
    const services = (await this.db.query(`select id, name_ar from services where branch_id = $1 and kind = 'treatment' and is_active order by sort_order, name_ar`, [branchId])).rows;
    return { sessions_only_fee: sessionsOnlyFee, is_first_time: first, services: services.map((s) => ({ id: Number(s.id), name: s.name_ar as string })), doctors: rows.map((r) => ({ id: Number(r.user_id), full_name: r.full_name as string, title: r.title as string | null })) };
  }

  /** قائمة الفروع الفعالة (للتسجيل الأول لما يكون أكثر من فرع) */
  async branches() {
    return (await this.db.query(`select id, name from branches where is_active order by id`)).rows.map((r) => ({ id: Number(r.id), name: r.name as string }));
  }

  /** صفحة العروض: العروض الفعالة اليوم بفرع الزبون */
  async offers(customerId: number) {
    const rows = (await this.db.query(
      `select o.id, o.title, o.percent::float as percent, o.end_date::text as end_date, s.name_ar from offers o join services s on s.id = o.service_id join customers c on c.branch_id = o.branch_id
        where c.id = $1 and o.status <> 'cancelled' and o.start_date <= clinic_today() and o.end_date >= clinic_today() order by o.end_date, s.name_ar`, [customerId])).rows;
    return { offers: rows.map((r) => ({ id: Number(r.id), title: r.title, percent: r.percent, service_name: r.name_ar, ends_on: r.end_date })) };
  }
}
