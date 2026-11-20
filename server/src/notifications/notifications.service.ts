import { Inject, Injectable } from '@nestjs/common';
import { Errors } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { DEFAULT_NOTIFY_BODY, DEFAULT_NOTIFY_TITLE } from '../offers/offers.service';
import { PUSH_SENDER, PushSender } from './push-sender';

/** عملاء يوصلهم إشعار: مسجلين بالتطبيق، فعالين، وعندهم جهاز فعال (اللي ما عنده تطبيق ما يوصله شي: الخطة القسم 13 ب) */
const APP_CUSTOMER = `c.status = 'active' and c.app_registered_at is not null and c.app_deleted_at is null and exists (select 1 from customer_devices d where d.customer_id = c.id and d.is_active)`;

/**
 * الإشعارات (القسم 13): طابور بجدول notifications. المهام (jobs) تنشئ الصفوف (عرض، تذكير، نقل موعد)، والإرسال ينفذ الطابور.
 * نص الإشعار بدون اسم علاج (شاشة القفل). الزبون يطفي إشعارات العروض فقط، والتذكير يبقى.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly db: DbService, @Inject(PUSH_SENDER) private readonly sender: PushSender) {}

  /** عروض بلغ يوم إشعارها: صف إشعار لكل زبون مستهدف (مرة وحدة لكل عرض/زبون) */
  async dispatchOffers(branchId?: number): Promise<{ offers: number; queued: number }> {
    const ids = (await this.db.query(
      `select id from offers where status <> 'cancelled' and notify_audience <> 'none' and notification_sent_at is null and notify_at <= clinic_today() and end_date >= clinic_today() and ($1::bigint is null or branch_id = $1) order by id`, [branchId ?? null])).rows.map((r) => Number(r.id));
    let offers = 0; let queued = 0;
    for (const id of ids) {
      const n = await this.db.tx(async (q) => {
        const o = (await q.query(`select * from offers where id = $1 and status <> 'cancelled' and notification_sent_at is null for update skip locked`, [id])).rows[0];
        if (!o) return null;
        const r = await q.query(
          `insert into notifications (customer_id, kind, title, body, data, offer_id)
           select c.id, 'offer', $2, $3, jsonb_build_object('offer_id', $1::bigint), $1 from customers c
            where c.branch_id = $4 and ${APP_CUSTOMER} and c.notify_offers
              and ($5 = 'all' or exists (select 1 from treatment_sessions s join plan_items i on i.id = s.plan_item_id where s.customer_id = c.id and s.status = 'completed' and i.service_id = $6))
           on conflict do nothing`,
          [id, o.notify_title ?? DEFAULT_NOTIFY_TITLE, o.notify_body ?? DEFAULT_NOTIFY_BODY, o.branch_id, o.notify_audience, o.notify_service_id]);
        await q.query(`update offers set notification_sent_at = now() where id = $1`, [id]);
        return r.rowCount ?? 0;
      });
      if (n !== null) { offers++; queued += n; }
    }
    return { offers, queued };
  }

  /** تذكير بموعد بكرة (زيارة محجوزة). النص بدون اسم علاج. مرة وحدة لكل زيارة. */
  async queueReminders(branchId?: number): Promise<{ queued: number }> {
    const r = await this.db.query(
      `insert into notifications (customer_id, kind, title, body, data)
       select v.customer_id, 'reminder', 'تذكير بموعدك', 'عندك موعد بكرة بالعيادة. نتشرف بزيارتك', jsonb_build_object('visit_id', v.id, 'date', v.visit_date::text, 'seq_no', v.seq_no)
         from visits v join customers c on c.id = v.customer_id
        where v.visit_date = clinic_today() + 1 and v.status = 'booked' and ($1::bigint is null or v.branch_id = $1) and ${APP_CUSTOMER}
       on conflict do nothing`, [branchId ?? null]);
    return { queued: r.rowCount ?? 0 };
  }

  /** الزبون انتقل موعده بسبب عطلة/إجازة: إشعار «تم تعديل موعدك» (حدث نقل بآخر 3 أيام، مرة وحدة لكل حدث) */
  async queueBookingMoved(branchId?: number): Promise<{ queued: number }> {
    const r = await this.db.query(
      `insert into notifications (customer_id, kind, title, body, data)
       select v.customer_id, 'booking_moved', 'تعديل موعدك', 'تم تعديل موعدك بسبب ظرف بالعيادة. افتح التطبيق وشوف الموعد الجديد',
              jsonb_build_object('visit_id', v.id, 'from_date', e.from_date::text, 'to_date', e.to_date::text, 'event_id', e.id)
         from booking_events e join visits v on v.id = e.visit_id join customers c on c.id = v.customer_id
        where e.event = 'moved_by_closure' and e.created_at > now() - interval '3 days' and v.status in ('booked','arrived') and ($1::bigint is null or v.branch_id = $1) and ${APP_CUSTOMER}
       on conflict do nothing`, [branchId ?? null]);
    return { queued: r.rowCount ?? 0 };
  }

  /** تنفيذ الطابور: يتحقق من صلاحية كل إشعار وقت الإرسال (العرض انلغى، الموعد انتقل، الزبون طفى العروض، ما عنده جهاز) */
  async sendPending(limit = 200, branchId?: number): Promise<{ sent: number; failed: number; cancelled: number }> {
    const out = { sent: 0, failed: 0, cancelled: 0 };
    await this.db.tx(async (q) => {
      const rows = (await q.query(
        `select n.*, c.notify_offers, c.status as customer_status, c.app_deleted_at from notifications n join customers c on c.id = n.customer_id
          where n.status = 'pending' and n.scheduled_at <= now() and ($2::bigint is null or c.branch_id = $2) order by n.id limit $1 for update of n skip locked`, [limit, branchId ?? null])).rows;
      for (const n of rows) {
        const id = Number(n.id);
        if (!(await this.stillValid(q, n))) { await q.query(`update notifications set status = 'cancelled' where id = $1`, [id]); out.cancelled++; continue; }
        const devices = (await q.query(`select push_token as token, platform from customer_devices where customer_id = $1 and is_active order by id`, [n.customer_id])).rows;
        if (!devices.length) { await q.query(`update notifications set status = 'cancelled' where id = $1`, [id]); out.cancelled++; continue; }
        try {
          await this.sender.send(devices, { title: n.title, body: n.body, data: { notification_id: id, kind: n.kind, ...(n.data ?? {}) } });
          await q.query(`update notifications set status = 'sent', sent_at = now() where id = $1`, [id]); out.sent++;
        } catch { await q.query(`update notifications set status = 'failed' where id = $1`, [id]); out.failed++; }
      }
    });
    return out;
  }

  private async stillValid(q: Queryable, n: any): Promise<boolean> {
    if (n.customer_status !== 'active' || n.app_deleted_at !== null) return false;
    if (n.kind === 'offer') {
      if (!n.notify_offers) return false;
      const o = (await q.query(`select 1 from offers where id = $1 and status <> 'cancelled' and end_date >= clinic_today()`, [n.offer_id])).rowCount;
      return !!o;
    }
    if (n.kind === 'reminder') {
      return !!(await q.query(`select 1 from visits where id = $1 and status = 'booked' and visit_date::text = $2`, [n.data?.visit_id, n.data?.date])).rowCount;
    }
    if (n.kind === 'rating_request') {
      return !!(await q.query(`select 1 from treatment_sessions s where s.id = $1 and s.status = 'completed' and not exists (select 1 from session_ratings r where r.session_id = s.id)`, [n.treatment_session_id])).rowCount;
    }
    return true;
  }

  // ================================================================ للزبون (يربط مع تسجيل دخول الزبون)
  async listForCustomer(customerId: number, p: { unreadOnly?: boolean; limit?: number } = {}) {
    const { rows } = await this.db.query(
      `select id, kind, title, body, data, created_at, read_at from notifications where customer_id = $1 and status = 'sent' and ($2::boolean is not true or read_at is null) order by id desc limit $3`,
      [customerId, p.unreadOnly ?? false, Math.min(p.limit ?? 50, 200)]);
    return { notifications: rows.map((r) => ({ id: Number(r.id), kind: r.kind, title: r.title, body: r.body, data: r.data, created_at: r.created_at, read: r.read_at !== null })) };
  }

  async markRead(customerId: number, id?: number): Promise<{ marked: number }> {
    const r = await this.db.query(`update notifications set read_at = now() where customer_id = $1 and status = 'sent' and read_at is null and ($2::bigint is null or id = $2)`, [customerId, id ?? null]);
    if (id !== undefined && !r.rowCount) {
      const exists = (await this.db.query(`select 1 from notifications where id = $1 and customer_id = $2 and status = 'sent'`, [id, customerId])).rowCount;
      if (!exists) throw Errors.notFound('الإشعار');
    }
    return { marked: r.rowCount ?? 0 };
  }

  /** تسجيل جهاز الزبون للإشعارات: التوكن فريد، وإذا انتقل لزبون ثاني (نفس الجهاز) ينتقل بدون تكرار */
  async registerDevice(customerId: number, platform: 'ios' | 'android', token: string) {
    const t = token.trim();
    if (t.length < 8 || t.length > 4096) throw Errors.badRequest('INVALID_TOKEN', 'رمز الجهاز غير صحيح');
    await this.db.query(
      `insert into customer_devices (customer_id, platform, push_token, last_seen_at) values ($1,$2,$3,now())
       on conflict (push_token) do update set customer_id = excluded.customer_id, platform = excluded.platform, is_active = true, last_seen_at = now()`, [customerId, platform, t]);
    return { registered: true };
  }

  async unregisterDevice(customerId: number, token: string) {
    const r = await this.db.query(`update customer_devices set is_active = false where customer_id = $1 and push_token = $2`, [customerId, token.trim()]);
    return { removed: r.rowCount ?? 0 };
  }
}
