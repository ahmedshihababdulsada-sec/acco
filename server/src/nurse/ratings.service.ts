import { Injectable } from '@nestjs/common';
import { Errors } from '../common/errors';
import { AuthUser } from '../auth/auth.types';
import { DbService } from '../db/db.service';

/**
 * تقييم الجلسات (القسم 13 ج): الزبون يقيّم جلسته المكتملة بنجوم 1–5 وتعليق اختياري (مرة وحدة)،
 * والمالك بس يشوف التقييمات لكل خدمة ولكل ممرض. الممرض يتسجل لقطة وقت التقييم.
 * submit خدمة جاهزة لتطبيق الزبون (دخول الزبون OTP ينبني بالمرحلة 2)، وما إلها مسار HTTP لحد هسه.
 */
@Injectable()
export class RatingsService {
  constructor(private readonly db: DbService) {}

  async submit(customerId: number, sessionId: number, input: { stars: number; comment?: string | null }) {
    if (!Number.isInteger(input.stars) || input.stars < 1 || input.stars > 5) throw Errors.badRequest('INVALID_STARS', 'التقييم من 1 إلى 5');
    const comment = input.comment?.trim() ? input.comment.trim().slice(0, 1000) : null;
    return this.db.tx(async (q) => {
      const s = (await q.query(
        `select s.id, s.customer_id, s.status, s.completed_by, i.service_id from treatment_sessions s join plan_items i on i.id = s.plan_item_id where s.id = $1 for update of s`, [sessionId])).rows[0];
      if (!s || Number(s.customer_id) !== customerId) throw Errors.notFound('الجلسة');
      if (s.status !== 'completed') throw Errors.conflict('NOT_COMPLETED', 'تقدر تقيّم الجلسة بعد ما تكتمل');
      if ((await q.query(`select 1 from session_ratings where session_id = $1`, [sessionId])).rowCount) throw Errors.conflict('ALREADY_RATED', 'قيّمت هذي الجلسة مسبقاً');
      const r = (await q.query(
        `insert into session_ratings (session_id, customer_id, service_id, nurse_id, stars, comment) values ($1,$2,$3,$4,$5,$6) returning id, created_at`,
        [sessionId, customerId, s.service_id, s.completed_by, input.stars, comment])).rows[0];
      await q.query(`update notifications set read_at = coalesce(read_at, now()), status = case when status = 'pending' then 'cancelled' else status end where treatment_session_id = $1 and kind = 'rating_request'`, [sessionId]);
      return { id: Number(r.id), session_id: sessionId, stars: input.stars, comment, created_at: r.created_at };
    });
  }

  /** للمالك فقط: متوسط وعدد لكل خدمة ولكل ممرض، وقائمة التقييمات (الأحدث أول) */
  async ownerReport(_actor: AuthUser, p: { from?: string; to?: string; serviceId?: number; nurseId?: number; branchId?: number }) {
    const where = `($1::date is null or r.created_at::date >= $1) and ($2::date is null or r.created_at::date <= $2) and ($3::bigint is null or r.service_id = $3) and ($4::bigint is null or r.nurse_id = $4)
                   and ($5::bigint is null or s.branch_id = $5)`;
    const args = [p.from ?? null, p.to ?? null, p.serviceId ?? null, p.nurseId ?? null, p.branchId ?? null];
    const base = `from session_ratings r join treatment_sessions s on s.id = r.session_id`;
    const byService = (await this.db.query(`select r.service_id, sv.name_ar, count(*)::int as n, round(avg(r.stars), 2)::float as avg ${base} join services sv on sv.id = r.service_id where ${where} group by r.service_id, sv.name_ar order by sv.name_ar`, args)).rows;
    const byNurse = (await this.db.query(`select r.nurse_id, u.full_name, count(*)::int as n, round(avg(r.stars), 2)::float as avg ${base} join users u on u.id = r.nurse_id where ${where} group by r.nurse_id, u.full_name order by u.full_name`, args)).rows;
    const list = (await this.db.query(
      `select r.id, r.session_id, r.stars, r.comment, r.created_at, r.service_id, sv.name_ar as service_name, r.nurse_id, u.full_name as nurse_name, cu.id as customer_id, cu.full_name as customer_name
         ${base} join services sv on sv.id = r.service_id join users u on u.id = r.nurse_id join customers cu on cu.id = r.customer_id where ${where} order by r.id desc limit 200`, args)).rows;
    return {
      by_service: byService.map((r) => ({ service_id: Number(r.service_id), service_name: r.name_ar, count: r.n, average: r.avg })),
      by_nurse: byNurse.map((r) => ({ nurse_id: Number(r.nurse_id), nurse_name: r.full_name, count: r.n, average: r.avg })),
      ratings: list.map((r) => ({ id: Number(r.id), session_id: Number(r.session_id), stars: r.stars, comment: r.comment, created_at: r.created_at,
        service: { id: Number(r.service_id), name: r.service_name }, nurse: { id: Number(r.nurse_id), name: r.nurse_name }, customer: { id: Number(r.customer_id), full_name: r.customer_name } })),
    };
  }
}
