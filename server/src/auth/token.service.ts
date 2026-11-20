import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { APP_CONFIG, AppConfig } from '../config/config';
import { Queryable } from '../db/db.service';
import { AccessPayload } from './auth.types';

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService, @Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  /** توكن وصول (قصير) + توكن تجديد عشوائي ينحفظ بصمته بس. */
  async issue(q: Queryable, user: { id: number; role: string }, device?: string): Promise<TokenPair> {
    const payload: AccessPayload = { typ: 'access', sub: user.id, role: user.role as AccessPayload['role'] };
    const access = await this.jwt.signAsync(payload, { expiresIn: this.cfg.accessTtlSeconds });
    const refresh = randomBytes(32).toString('base64url');
    await q.query(
      `insert into refresh_tokens (user_id, token_hash, device, expires_at) values ($1, $2, $3, now() + make_interval(days => $4))`,
      [user.id, sha256(refresh), device?.slice(0, 200) ?? null, this.cfg.refreshTtlDays]);
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: this.cfg.accessTtlSeconds };
  }
}
