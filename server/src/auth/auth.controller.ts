import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AllowPasswordChange, CurrentUser, Public } from './decorators';
import { ChangePasswordDto, LoginDto, RefreshDto, TotpEnableDto, TotpSetupDto, TotpVerifyDto } from './auth.dto';
import { AuthService } from './auth.service';
import { AuthUser } from './auth.types';
import { TotpService } from './totp.service';

const ip = (req: Request) => req.ip ?? null;
const loginLimit = Number(process.env.LOGIN_RATE_LIMIT ?? 10);

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly totp: TotpService) {}

  @Public() @Post('login') @HttpCode(200)
  @Throttle({ default: { limit: loginLimit, ttl: 60_000 } })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto.username, dto.password, dto.device, ip(req));
  }

  /** المالك بس: يرجع مفتاح ورابط QR لتطبيق المصادقة (تحتاج challenge_token من login). */
  @Public() @Post('totp/setup') @HttpCode(200)
  @Throttle({ default: { limit: loginLimit, ttl: 60_000 } })
  totpSetup(@Body() dto: TotpSetupDto, @Req() req: Request) {
    return this.totp.setup(dto.challenge_token, ip(req));
  }

  @Public() @Post('totp/enable') @HttpCode(200)
  @Throttle({ default: { limit: loginLimit, ttl: 60_000 } })
  totpEnable(@Body() dto: TotpEnableDto, @Req() req: Request) {
    return this.totp.enable(dto.challenge_token, dto.code, dto.device, ip(req));
  }

  @Public() @Post('totp/verify') @HttpCode(200)
  @Throttle({ default: { limit: loginLimit, ttl: 60_000 } })
  totpVerify(@Body() dto: TotpVerifyDto, @Req() req: Request) {
    return this.totp.verify(dto.challenge_token, { code: dto.code, recovery_code: dto.recovery_code }, dto.device, ip(req));
  }

  @Public() @Post('refresh') @HttpCode(200)
  @Throttle({ default: { limit: loginLimit * 3, ttl: 60_000 } })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refresh_token, ip(req));
  }

  @Post('logout') @HttpCode(204) @AllowPasswordChange()
  async logout(@CurrentUser() user: AuthUser, @Body() body: { refresh_token?: string }, @Req() req: Request) {
    await this.auth.logout(user.id, typeof body?.refresh_token === 'string' ? body.refresh_token : undefined, ip(req));
  }

  @Get('me') @AllowPasswordChange()
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  @Post('change-password') @HttpCode(204) @AllowPasswordChange()
  async changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto, @Req() req: Request) {
    await this.auth.changePassword(user, dto.current_password, dto.new_password, ip(req));
  }
}
