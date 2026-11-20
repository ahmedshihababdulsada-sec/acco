import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_CONFIG, AppConfig } from '../config/config';
import { BookingsModule } from '../bookings/bookings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { NurseModule } from '../nurse/nurse.module';
import { PlansModule } from '../plans/plans.module';
import { SettingsModule } from '../settings/settings.module';
import { CustomerAppController } from './customer-app.controller';
import { CustomerAppService } from './customer-app.service';
import { CustomerAuthService } from './customer-auth.service';
import { LogOtpSender, OTP_SENDER, OtpService } from './otp.service';

@Module({
  imports: [
    JwtModule.registerAsync({ inject: [APP_CONFIG], useFactory: (cfg: AppConfig) => ({ secret: cfg.jwtSecret, signOptions: { algorithm: 'HS256' } }) }),
    NotificationsModule, NurseModule, PlansModule, BookingsModule, SettingsModule,
  ],
  controllers: [CustomerAppController],
  providers: [OtpService, CustomerAuthService, CustomerAppService, { provide: OTP_SENDER, useClass: LogOtpSender }],
  exports: [OtpService, CustomerAuthService, OTP_SENDER],
})
export class CustomerAppModule {}
