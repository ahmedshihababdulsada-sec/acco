import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomInt } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { Errors, apiError } from '../common/errors';
import { clock } from '../common/clock';
import { decryptSecret, encryptSecret } from '../common/secret-box';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { LockoutService } from './lockout.service';
import { TokenService, sha256 } from './token.service';
import { findValidStep, generateSecret, otpauthUri } from './totp';

const CHALLENGE_PURPOSE = 'totp_challenge';
const CHALLENGE_TTL_SECONDS = 300;
const RECOVERY_CODES = 8;
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** مين يلزمه التحقق الثنائي: المالك بس (الخطة القسم 3). */
export const requiresTotp = (role: string): boolean => role === 'owner';

const totpInvalid = () => apiError(401, 'TOTP_INVALID', 'رمز التحقق غير صحيح أو منتهي');

interface ChallengeUser {
  id: number; username: string; full_name: string; role: string; branch_id: number | null; must_change_password: boolean;
  totp_secret_enc: string | null; totp_enabled_at: Date | null; totp_last_step: string | null;
}

@Injectable()
export class TotpService {
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly lockout: LockoutService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** بعد نجاح كلمة السر: بدل التوكنات نرجع «تحدي» قصير العمر. الوضع: setup (أول مرة) أو verify. */
  async startChallenge(u: { id: number | string; role: string; branch_id: number | string | null; totp_enabled_at: Date | null }, ip: string | null) {
    const token = await this.jwt.signAsync({ purpose: CHALLENGE_PURPOSE, sub: Number(u.id) }, { expiresIn: CHALLENGE_TTL_SECONDS });
    await this.audit.log(this.db, { actorUserId: Number(u.id), actorRole: u.role, action: 'auth.password_ok_totp_pending', entityType: 'user', entityId: Number(u.id), ip });
    return { status: 'totp_required' as const, mode: u.totp_enabled_at ? ('verify' as const) : ('setup' as const), challenge_token: token };
  }

  /** يرجع مفتاح جديد ورابط otpauth (يتحول لـ QR بالواجهة). كل استدعاء يبدل المفتاح المعلق. */
  async setup(challengeToken: string, ip: string | null) {
    const u = await this.loadChallenge(challengeToken);
    if (u.totp_enabled_at) throw Errors.conflict('TOTP_ALREADY_ENABLED', 'التحقق الثنائي مفعل مسبقاً. لو ضاع تلفونك، إعادة التعيين تصير من السيرفر');
    const secret = generateSecret();
    await this.db.query(`update users set totp_secret_enc = $2, totp_last_step = null where id = $1 and totp_enabled_at is null`,
      [u.id, encryptSecret(secret, this.cfg.totpEncKey)]);
    await this.audit.log(this.db, { actorUserId: u.id, actorRole: u.role, action: 'auth.totp_setup_started', entityType: 'user', entityId: u.id, ip });
    return { secret, otpauth_uri: otpauthUri(secret, u.username, this.cfg.totpIssuer) };
  }

  /** يأكد المفتاح برمز من التطبيق، ويفعل التحقق، ويرجع رموز الاسترجاع (تظهر مرة وحدة) مع التوكنات. */
  async enable(challengeToken: string, code: string, device: string | undefined, ip: string | null) {
    const u = await this.loadChallenge(challengeToken);
    if (u.totp_enabled_at) throw Errors.conflict('TOTP_ALREADY_ENABLED', 'التحقق الثنائي مفعل مسبقاً');
    if (!u.totp_secret_enc) throw Errors.badRequest('TOTP_NOT_STARTED', 'ابدأ الإعداد أول');
    const step = findValidStep(decryptSecret(u.totp_secret_enc, this.cfg.totpEncKey), code, clock.now());
    if (step === null) { await this.lockout.registerFailure({ id: u.id, role: u.role, branch_id: u.branch_id }, ip, 'totp'); throw totpInvalid(); }

    const recovery = Array.from({ length: RECOVERY_CODES }, () => randomRecoveryCode());
    return this.db.tx(async (q) => {
      const done = await q.query(
        `update users set totp_enabled_at = now(), totp_last_step = $2, failed_logins = 0, locked_until = null
          where id = $1 and totp_enabled_at is null`, [u.id, step]);
      if (!done.rowCount) throw Errors.conflict('TOTP_ALREADY_ENABLED', 'التحقق الثنائي مفعل مسبقاً');
      await q.query(`delete from totp_recovery_codes where user_id = $1`, [u.id]);
      for (const c of recovery) await q.query(`insert into totp_recovery_codes (user_id, code_hash) values ($1, $2)`, [u.id, sha256(normalizeRecovery(c))]);
      await this.audit.log(q, { actorUserId: u.id, actorRole: u.role, action: 'auth.totp_enabled', entityType: 'user', entityId: u.id, ip });
      const tokens = await this.tokens.issue(q, u, device);
      return { status: 'authenticated' as const, ...tokens, user: publicUser(u), recovery_codes: recovery };
    });
  }

  /** دخول بالرمز (أو برمز استرجاع واحد). الرمز يُقبل مرة وحدة بس (منع إعادة الاستخدام). */
  async verify(challengeToken: string, input: { code?: string; recovery_code?: string }, device: string | undefined, ip: string | null) {
    if ((input.code === undefined) === (input.recovery_code === undefined)) {
      throw Errors.badRequest('VALIDATION', 'أرسل رمز التحقق أو رمز استرجاع، مو الاثنين');
    }
    const u = await this.loadChallenge(challengeToken);
    if (!u.totp_enabled_at || !u.totp_secret_enc) throw Errors.badRequest('TOTP_NOT_ENABLED', 'التحقق الثنائي مو مفعل: سوّي الإعداد أول');

    const ok = input.code !== undefined
      ? await this.consumeCode(u, input.code)
      : await this.consumeRecoveryCode(u, input.recovery_code!);
    if (!ok) { await this.lockout.registerFailure({ id: u.id, role: u.role, branch_id: u.branch_id }, ip, 'totp'); throw totpInvalid(); }

    return this.db.tx(async (q) => {
      await q.query(`update users set failed_logins = 0, locked_until = null where id = $1`, [u.id]);
      const tokens = await this.tokens.issue(q, u, device);
      await this.audit.log(q, { actorUserId: u.id, actorRole: u.role, action: input.code !== undefined ? 'auth.login' : 'auth.login_recovery_code', entityType: 'user', entityId: u.id, ip });
      const left = await q.query(`select count(*)::int as n from totp_recovery_codes where user_id = $1 and used_at is null`, [u.id]);
      return { status: 'authenticated' as const, ...tokens, user: publicUser(u), recovery_codes_left: left.rows[0].n };
    });
  }

  /** الخطوة تنقبل بس إذا أكبر من آخر خطوة مقبولة، بتحديث ذري (سباقين بنفس الرمز: واحد ينجح). */
  private async consumeCode(u: ChallengeUser, code: string): Promise<boolean> {
    const step = findValidStep(decryptSecret(u.totp_secret_enc!, this.cfg.totpEncKey), code, clock.now());
    if (step === null) return false;
    const r = await this.db.query(`update users set totp_last_step = $2 where id = $1 and (totp_last_step is null or totp_last_step < $2)`, [u.id, step]);
    return r.rowCount === 1;
  }

  private async consumeRecoveryCode(u: ChallengeUser, raw: string): Promise<boolean> {
    const r = await this.db.query(
      `update totp_recovery_codes set used_at = now() where user_id = $1 and code_hash = $2 and used_at is null`,
      [u.id, sha256(normalizeRecovery(raw))]);
    return r.rowCount === 1;
  }

  private async loadChallenge(token: string): Promise<ChallengeUser> {
    let payload: { purpose?: string; sub?: number };
    try { payload = await this.jwt.verifyAsync(token, { algorithms: ['HS256'] }); } catch { throw Errors.unauthorized(); }
    if (payload.purpose !== CHALLENGE_PURPOSE || typeof payload.sub !== 'number') throw Errors.unauthorized();
    const { rows } = await this.db.query(
      `select id, username, full_name, role, branch_id, must_change_password, is_active,
              totp_secret_enc, totp_enabled_at, totp_last_step, (locked_until is not null and locked_until > now()) as is_locked
         from users where id = $1`, [payload.sub]);
    const u = rows[0];
    if (!u || !u.is_active || u.is_locked || !requiresTotp(u.role)) throw Errors.invalidCredentials();
    return { ...u, id: Number(u.id), branch_id: u.branch_id === null ? null : Number(u.branch_id) };
  }
}

function randomRecoveryCode(): string {
  const pick = () => Array.from({ length: 5 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
  return `${pick()}-${pick()}`;
}
const normalizeRecovery = (c: string) => c.replace(/[\s-]/g, '').toUpperCase();

function publicUser(u: ChallengeUser) {
  return { id: u.id, username: u.username, full_name: u.full_name, role: u.role, branch_id: u.branch_id, must_change_password: u.must_change_password };
}
