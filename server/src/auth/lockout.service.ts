import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';

/** عداد المحاولات الفاشلة والقفل: مشترك بين كلمة السر ورمز التحقق الثنائي (حتى ما يتخمن الرمز ذو الـ6 خانات). */
@Injectable()
export class LockoutService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, @Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  /** يزيد العداد ويقفل عند الحد بجملة وحدة (المحاولات المتزامنة ما تضيع). `kind` يحدد اسم الحدث بالسجل. */
  async registerFailure(u: { id: number | string; role: string; branch_id: number | string | null }, ip: string | null, kind = 'login'): Promise<void> {
    const r = await this.db.query(
      `update users set failed_logins = failed_logins + 1,
              locked_until = case when failed_logins + 1 >= $2 then now() + make_interval(mins => $3) else locked_until end
        where id = $1 returning locked_until is not null and locked_until > now() as locked`,
      [u.id, this.cfg.loginMaxFailures, this.cfg.lockMinutes]);
    await this.audit.log(this.db, {
      actorUserId: Number(u.id), actorRole: u.role, branchId: u.branch_id === null ? null : Number(u.branch_id),
      action: r.rows[0].locked ? 'auth.account_locked' : `auth.${kind}_failed`, entityType: 'user', entityId: Number(u.id), ip,
    });
  }
}
