import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { CancelBookingDto, CreateBookingDto, MoveBookingDto, StopDayDto } from './bookings.dto';
import { BookingsService } from './bookings.service';

const ip = (r: Request) => r.ip ?? null;
const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));

@Controller('bookings')
export class BookingsController {
  constructor(private readonly svc: BookingsService) {}

  @Get() @Require('bookings.read')
  list(@CurrentUser() u: AuthUser, @Query('date') date?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('doctor_id') d?: string,
    @Query('customer_id') c?: string, @Query('status') status?: string, @Query('branch_id') b?: string) {
    return this.svc.list(u, { date, from, to, doctorId: num(d), customerId: num(c), status, branchId: num(b) });
  }

  @Get('days') @Require('customer.register_and_book')
  days(@CurrentUser() u: AuthUser, @Query('from') from: string, @Query('to') to: string, @Query('doctor_id') d?: string, @Query('branch_id') b?: string) {
    return this.svc.days(u, from, to, num(d), num(b));
  }

  @Get('follow-up') @Require('customer.register_and_book')
  followUp(@CurrentUser() u: AuthUser, @Query('days') days?: string, @Query('branch_id') b?: string) { return this.svc.followUp(u, num(days), num(b)); }

  @Post('days/:date/stop') @HttpCode(200) @Require('bookings.close_day')
  stopDay(@CurrentUser() u: AuthUser, @Param('date') date: string, @Body() dto: StopDayDto, @Req() r: Request) { return this.svc.stopDay(u, date, dto, ip(r)); }

  @Post('days/:date/resume') @HttpCode(200) @Require('bookings.close_day')
  resumeDay(@CurrentUser() u: AuthUser, @Param('date') date: string, @Query('branch_id') b?: string, @Req() r?: Request) { return this.svc.resumeDay(u, date, num(b), r ? ip(r) : null); }

  @Post('close-past-days') @Require('bookings.close_day')
  closePastDays(@CurrentUser() u: AuthUser, @Query('branch_id') b?: string) { return this.svc.closePastDays(u, num(b)); }

  @Post() @Require('customer.register_and_book')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateBookingDto, @Req() r: Request) { return this.svc.create(u, dto, ip(r)); }

  @Post(':id/cancel') @Require('customer.register_and_book')
  cancel(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: CancelBookingDto, @Req() r: Request) { return this.svc.cancel(u, id, dto, ip(r)); }

  @Post(':id/move') @Require('customer.register_and_book')
  move(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: MoveBookingDto, @Req() r: Request) { return this.svc.move(u, id, dto, ip(r)); }
}
