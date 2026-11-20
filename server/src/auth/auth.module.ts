import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';
import { APP_CONFIG, AppConfig } from '../config/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LockoutService } from './lockout.service';
import { TokenService } from './token.service';
import { TotpService } from './totp.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => ({ secret: cfg.jwtSecret, signOptions: { algorithm: 'HS256' } }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    LockoutService,
    TotpService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },   // الأول: تحديد المعدل
    { provide: APP_GUARD, useClass: JwtAuthGuard },     // بعده: الهوية والصلاحية
  ],
  exports: [AuthService],
})
export class AuthModule {}
