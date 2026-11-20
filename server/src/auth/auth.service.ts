import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import { assertPasswordPolicy, dummyVerify, hashPassword, verifyPassword } from '../common/passwords';
import { DbService } from '../db/db.service';
import { AuthUser } from './auth.types';
import { LockoutService } from './lockout.service';
import { TokenPair, TokenService, sha256 } from './token.service';
import { TotpService, requiresTotp } from './totp.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly lockout: LockoutService,
    private readonly totp: TotpService,
  ) {}

  async login(username: string, password: string, device: string | undefined, ip: string | null) {
    const { rows } = await this.db.query(
      `select id, username, full_name, password_hash, role, branch_id, is_active, must_change_password, locked_until, totp_enabled_at,
              (locked_until is not null and locked_until > now()) as is_locked
         from users where lower(username) = lower($1)`, [username.trim()]);
    const u = rows[0];

    // كل الإخفاقات ترجع نفس الرد حتى ما ينكشف إذا الاسم موجود أو الحساب مقفل أو معطل
    if (!u) { await dummyVerify(password); throw Errors.invalidCredentials(); }
    if (!u.is_active || u.is_locked) {
      await dummyVerify(password);
      await this.audit.log(this.db, { actorUserId: Number(u.id), actorRole: u.role, branchId: u.branch_id, action: 'auth.login_rejected', entityType: 'user', entityId: Number(u.id), reason: u.is_active ? 'locked' : 'inactive', ip });
      throw Errors.invalidCredentials();
    }

    if (!(await verifyPassword(u.password_hash, password))) {
      await this.lockout.registerFailure(u, ip, 'login');
      throw Errors.invalidCredentials();
    }

    // المالك: كلمة السر وحدها ما تكفي. نرجع تحدي، والتوكنات تطلع بعد رمز التحقق الثنائي
    if (requiresTotp(u.role)) return this.totp.startChallenge(u, ip);

    return this.db.tx(async (q) => {
      await q.query(`update users set failed_logins = 0, locked_until = null where id = $1`, [u.id]);
      const tokens = await this.tokens.issue(q, { id: Number(u.id), role: u.role }, device);
      await this.audit.log(q, { actorUserId: Number(u.id), actorRole: u.role, branchId: u.branch_id, action: 'auth.login', entityType: 'user', entityId: Number(u.id), ip });
      return { status: 'authenticated' as const, ...tokens, user: publicUser(u) };
    });
  }

  async refresh(refreshToken: string, ip: string | null): Promise<TokenPair> {
    const hash = sha256(refreshToken);
    // نرجع نتيجة بدل ما نرمي داخل المعاملة، حتى سحب كل التوكنات عند إعادة الاستخدام يتثبت
    const outcome = await this.db.tx(async (q) => {
      const { rows } = await q.query(
        `select t.id, t.user_id, t.device, t.revoked_at, t.expires_at < now() as expired, u.role, u.branch_id, u.is_active
           from refresh_tokens t join users u on u.id = t.user_id
          where t.token_hash = $1 for update of t`, [hash]);
      const t = rows[0];
      if (!t) return { ok: false as const };
      if (t.revoked_at) {
        await q.query(`update refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null`, [t.user_id]);
        await this.audit.log(q, { actorUserId: Number(t.user_id), actorRole: t.role, branchId: t.branch_id, action: 'auth.refresh_reuse_detected', entityType: 'user', entityId: Number(t.user_id), ip });
        return { ok: false as const };
      }
      if (t.expired || !t.is_active) return { ok: false as const };
      await q.query(`update refresh_tokens set revoked_at = now() where id = $1`, [t.id]);
      const pair = await this.tokens.issue(q, { id: Number(t.user_id), role: t.role }, t.device ?? undefined);
      return { ok: true as const, pair };
    });
    if (!outcome.ok) throw Errors.unauthorized();
    return outcome.pair;
  }

  async logout(userId: number, refreshToken: string | undefined, ip: string | null): Promise<void> {
    if (refreshToken) {
      await this.db.query(`update refresh_tokens set revoked_at = now() where token_hash = $1 and user_id = $2 and revoked_at is null`, [sha256(refreshToken), userId]);
    }
    await this.audit.log(this.db, { actorUserId: userId, action: 'auth.logout', entityType: 'user', entityId: userId, ip });
  }

  async changePassword(user: AuthUser, current: string, next: string, ip: string | null): Promise<void> {
    const { rows } = await this.db.query(`select password_hash from users where id = $1`, [user.id]);
    if (!rows[0] || !(await verifyPassword(rows[0].password_hash, current))) {
      throw Errors.badRequest('WRONG_CURRENT_PASSWORD', 'الرمز السري الحالي غير صحيح');
    }
    assertPasswordPolicy(next, user.username);
    if (next === current) throw Errors.badRequest('SAME_PASSWORD', 'الرمز الجديد لازم يختلف عن الحالي');
    const newHash = await hashPassword(next);
    await this.db.tx(async (q) => {
      await q.query(`update users set password_hash = $2, must_change_password = false where id = $1`, [user.id, newHash]);
      await q.query(`update refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null`, [user.id]); // يطلع من كل الأجهزة
      await this.audit.log(q, { actorUserId: user.id, actorRole: user.role, branchId: user.branchId, action: 'auth.password_changed', entityType: 'user', entityId: user.id, ip });
    });
  }

  async me(userId: number) {
    const { rows } = await this.db.query(
      `select id, username, full_name, role, branch_id, must_change_password from users where id = $1`, [userId]);
    return publicUser(rows[0]);
  }
}

function publicUser(u: any) {
  return {
    id: Number(u.id), username: u.username, full_name: u.full_name, role: u.role,
    branch_id: u.branch_id === null ? null : Number(u.branch_id), must_change_password: u.must_change_password,
  };
}
