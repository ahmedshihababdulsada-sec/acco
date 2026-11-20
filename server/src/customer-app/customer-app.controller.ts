import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public, Require } from '../auth/decorators';
import { NotificationsService } from '../notifications/notifications.service';
import { RatingsService } from '../nurse/ratings.service';
import { CurrentCustomer, CustomerPrincipal } from './current-customer';
import { AppBookingDto, AvailabilityQuery, MoveDateDto } from './customer-app.dto';
import { CustomerAppService } from './customer-app.service';
import { CustomerAuthService } from './customer-auth.service';
import { DeleteAccountDto, DeviceDto, MarkReadDto, RateSessionDto, RefreshDto, RemoveDeviceDto, RequestOtpDto, UpdateProfileDto, VerifyOtpDto } from './customer-app.dto';
import { OtpService } from './otp.service';
import { Errors } from '../common/errors';
import { BookingsService } from '../bookings/bookings.service';
import { SessionsService } from '../plans/sessions.service';

const ip = (r: Request) => r.ip ?? null;
const otpLimit = Number(process.env.OTP_RATE_LIMIT ?? 10);

@Controller('customer')
export class CustomerAppController {
  constructor(
    private readonly otp: OtpService, private readonly auth: CustomerAuthService, private readonly app: CustomerAppService,
    private readonly notifications: NotificationsService, private readonly ratings: RatingsService,
    private readonly bookingsSvc: BookingsService, private readonly sessionsSvc: SessionsService,
  ) {}

  // ---------------------------------------------------------------- دخول (بدون توكن)
  @Public() @Throttle({ default: { limit: otpLimit, ttl: 60_000 } }) @Post('auth/request-otp') @HttpCode(200)
  requestOtp(@Body() dto: RequestOtpDto) { return this.otp.request(dto.phone); }

  @Public() @Throttle({ default: { limit: otpLimit * 2, ttl: 60_000 } }) @Post('auth/verify-otp') @HttpCode(200)
  verify(@Body() dto: VerifyOtpDto, @Req() r: Request) { return this.auth.verify(dto, ip(r)); }

  @Public() @Throttle({ default: { limit: otpLimit * 3, ttl: 60_000 } }) @Post('auth/refresh') @HttpCode(200)
  refresh(@Body() dto: RefreshDto, @Req() r: Request) { return this.auth.refresh(dto.refresh_token, ip(r)); }

  @Public() @Get('branches')
  async branches() { return { branches: await this.app.branches() }; }

  // ---------------------------------------------------------------- حسابي
  @Require('customer.self') @Post('auth/logout') @HttpCode(200)
  async logout(@CurrentCustomer() c: CustomerPrincipal, @Body() dto: Partial<RefreshDto>) { await this.auth.logout(c.id, dto?.refresh_token); return { ok: true }; }

  @Require('customer.self') @Get('me')
  me(@CurrentCustomer() c: CustomerPrincipal) { return this.app.profile(c.id); }

  @Require('customer.self') @Put('me')
  update(@CurrentCustomer() c: CustomerPrincipal, @Body() dto: UpdateProfileDto) { return this.app.updateProfile(c.id, dto); }

  @Require('customer.self') @Delete('me')
  remove(@CurrentCustomer() c: CustomerPrincipal, @Body() dto: DeleteAccountDto, @Req() r: Request) {
    if (dto.confirm !== true) throw Errors.badRequest('CONFIRM_REQUIRED', 'أكد حذف الحساب');
    return this.auth.deleteAccount(c.id, ip(r));
  }

  @Require('customer.self') @Get('sessions') sessions(@CurrentCustomer() c: CustomerPrincipal) { return this.app.sessions(c.id); }
  @Require('customer.self') @Get('bookings') bookings(@CurrentCustomer() c: CustomerPrincipal) { return this.app.bookings(c.id); }
  @Require('customer.self') @Get('payments') payments(@CurrentCustomer() c: CustomerPrincipal) { return this.app.payments(c.id); }
  @Require('customer.self') @Get('payments/:id') payment(@CurrentCustomer() c: CustomerPrincipal, @Param('id', ParseIntPipe) id: number) { return this.app.payment(c.id, id); }
  @Require('customer.self') @Get('points') points(@CurrentCustomer() c: CustomerPrincipal) { return this.app.points(c.id); }
  @Require('customer.self') @Get('offers') offers(@CurrentCustomer() c: CustomerPrincipal) { return this.app.offers(c.id); }

  // ---------------------------------------------------------------- إشعارات وأجهزة وتقييم
  @Require('customer.self') @Get('notifications')
  notifs(@CurrentCustomer() c: CustomerPrincipal, @Query('unread') unread?: string) { return this.notifications.listForCustomer(c.id, { unreadOnly: unread === '1' }); }

  @Require('customer.self') @Post('notifications/read') @HttpCode(200)
  read(@CurrentCustomer() c: CustomerPrincipal, @Body() dto: MarkReadDto) { return this.notifications.markRead(c.id, dto.id); }

  @Require('customer.self') @Post('devices') @HttpCode(200)
  device(@CurrentCustomer() c: CustomerPrincipal, @Body() dto: DeviceDto) { return this.notifications.registerDevice(c.id, dto.platform, dto.token); }

  @Require('customer.self') @Delete('devices')
  removeDevice(@CurrentCustomer() c: CustomerPrincipal, @Body() dto: RemoveDeviceDto) { return this.notifications.unregisterDevice(c.id, dto.token); }

  @Require('rating.submit') @Post('sessions/:id/rating')
  rate(@CurrentCustomer() c: CustomerPrincipal, @Param('id', ParseIntPipe) id: number, @Body() dto: RateSessionDto) { return this.ratings.submit(c.id, id, dto); }

  // ---------------------------------------------------------------- الحجز من التطبيق
  @Require('customer.self') @Get('doctors')
  doctors(@CurrentCustomer() c: CustomerPrincipal) { return this.app.doctors(c.id, c.branchId); }

  @Require('customer.self') @Get('availability')
  availability(@CurrentCustomer() c: CustomerPrincipal, @Query() q: AvailabilityQuery) { return this.bookingsSvc.daysForCustomer(c, q.from, q.to, q.doctor_id ? Number(q.doctor_id) : undefined); }

  @Require('customer.self') @Post('bookings')
  book(@CurrentCustomer() c: CustomerPrincipal, @Body() dto: AppBookingDto, @Req() r: Request) { return this.bookingsSvc.createForCustomer(c, dto, ip(r)); }

  @Require('customer.self') @Post('bookings/:id/cancel') @HttpCode(200)
  cancelBooking(@CurrentCustomer() c: CustomerPrincipal, @Param('id', ParseIntPipe) id: number, @Req() r: Request) { return this.bookingsSvc.cancelForCustomer(c, id, ip(r)); }

  @Require('customer.self') @Post('bookings/:id/move') @HttpCode(200)
  moveBooking(@CurrentCustomer() c: CustomerPrincipal, @Param('id', ParseIntPipe) id: number, @Body() dto: MoveDateDto, @Req() r: Request) { return this.bookingsSvc.moveForCustomer(c, id, dto.date, ip(r)); }

  /** معاينة نقل الجلسة: كل التواريخ اللي راح تتغير بدون حفظ */
  @Require('customer.self') @Post('sessions/:id/move-preview') @HttpCode(200)
  previewMove(@CurrentCustomer() c: CustomerPrincipal, @Param('id', ParseIntPipe) id: number, @Body() dto: MoveDateDto, @Req() r: Request) { return this.sessionsSvc.moveForCustomer(c, id, dto.date, ip(r), true); }

  @Require('customer.self') @Post('sessions/:id/move') @HttpCode(200)
  moveSession(@CurrentCustomer() c: CustomerPrincipal, @Param('id', ParseIntPipe) id: number, @Body() dto: MoveDateDto, @Req() r: Request) { return this.sessionsSvc.moveForCustomer(c, id, dto.date, ip(r), false); }
}
