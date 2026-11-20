import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { AttachmentsService } from '../attachments/attachments.service';
import { BookingsService } from '../bookings/bookings.service';
import { DbService } from '../db/db.service';
import { DiscountsService } from '../discounts/discounts.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PayrollService } from '../payroll/payroll.service';

/** مفتاح قفل استشاري (advisory) حتى لو شغلنا أكثر من نسخة من السيرفر، الدورة تشتغل عند وحدة بس */
const LOCK_KEY = 7_340_001;

export interface JobsReport { closed_days: { branch_id: number; missed: number }[]; discounts_expired: number; payroll_runs: number; offers: { offers: number; queued: number }; reminders: number; moved_notices: number; push: { sent: number; failed: number; cancelled: number }; orphans_removed: number }

/**
 * المهام المجدولة: إقفال الأيام الماضية، انتهاء طلبات الخصم، رواتب أول الشهر، وطوابير الإشعارات. كلها idempotent (تعيدها بأمان).
 * كل مهمة تقبل فرع واحد (للتشغيل اليدوي من المالك والاختبارات). تشتغل بمؤقت داخلي إذا SCHEDULER=1 (بالإنتاج)، وتنقدر تنشغل يدوياً من المالك. الاختبارات تستدعي runAll مباشرة.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Jobs');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DbService, private readonly bookings: BookingsService, private readonly discounts: DiscountsService,
    private readonly notifications: NotificationsService, private readonly payroll: PayrollService, private readonly attachments: AttachmentsService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.SCHEDULER !== '1') return;
    const seconds = Math.max(Number(process.env.SCHEDULER_INTERVAL_SECONDS) || 600, 30);
    this.timer = setInterval(() => { void this.tick(); }, seconds * 1000);
    this.timer.unref();
    void this.tick();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  /** دورة وحدة بقفل استشاري: نسخة ثانية تشتغل بنفس اللحظة تتخطى */
  async tick(branchId?: number): Promise<JobsReport | null> {
    const client = await this.db.pool.connect();
    try {
      const got = (await client.query(`select pg_try_advisory_lock($1) as ok`, [LOCK_KEY])).rows[0].ok;
      if (!got) return null;
      try { return await this.runAll(branchId); } finally { await client.query(`select pg_advisory_unlock($1)`, [LOCK_KEY]); }
    } catch (e) { this.log.error(`فشلت دورة المهام: ${(e as Error).message}`); return null; } finally { client.release(); }
  }

  async runAll(branchId?: number): Promise<JobsReport> {
    const branches = (await this.db.query(`select id from branches where is_active and ($1::bigint is null or id = $1) order by id`, [branchId ?? null])).rows.map((r) => Number(r.id));
    const closed_days = [];
    for (const id of branches) closed_days.push(await this.bookings.closeBranchPastDays(id, null));
    const discounts_expired = await this.discounts.sweepAll(branchId);
    const payroll_runs = await this.payroll.generateDue(branchId);
    const offers = await this.notifications.dispatchOffers(branchId);
    const reminders = (await this.notifications.queueReminders(branchId)).queued;
    const moved_notices = (await this.notifications.queueBookingMoved(branchId)).queued;
    const push = await this.notifications.sendPending(200, branchId);
    const orphans_removed = await this.attachments.cleanupOrphans(branchId);
    return { closed_days, discounts_expired, payroll_runs, offers, reminders, moved_notices, push, orphans_removed };
  }
}
