import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { CreateDayOffDto, CreateHolidayDto, SetClinicDaysDto, SetWeeklyDto } from './schedule.dto';
import { ScheduleService } from './schedule.service';

const ip = (r: Request) => r.ip ?? null;
const num = (v?: string) => (v === undefined ? undefined : Number(v));

@Controller('schedule')
export class ScheduleController {
  constructor(private readonly svc: ScheduleService) {}

  @Get('clinic-days') @Require('schedule.read')
  clinicDays(@CurrentUser() u: AuthUser, @Query('branch_id') b?: string) { return this.svc.getClinicDays(u, num(b)); }

  @Put('clinic-days') @Require('schedule.manage')
  setClinicDays(@CurrentUser() u: AuthUser, @Body() dto: SetClinicDaysDto, @Req() r: Request) { return this.svc.setClinicDays(u, dto, ip(r)); }

  @Get('holidays') @Require('schedule.read')
  holidays(@CurrentUser() u: AuthUser, @Query('from') from?: string, @Query('to') to?: string, @Query('branch_id') b?: string) {
    return this.svc.listHolidays(u, from, to, num(b));
  }

  @Post('holidays') @Require('schedule.manage')
  createHoliday(@CurrentUser() u: AuthUser, @Body() dto: CreateHolidayDto, @Req() r: Request) { return this.svc.createHoliday(u, dto, ip(r)); }

  @Post('holidays/:id/cancel') @HttpCode(204) @Require('schedule.manage')
  async cancelHoliday(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Req() r: Request) { await this.svc.cancelHoliday(u, id, ip(r)); }

  @Get('doctors') @Require('schedule.read')
  doctors(@CurrentUser() u: AuthUser, @Query('branch_id') b?: string) { return this.svc.listDoctors(u, num(b)); }

  @Get('doctors/:id') @Require('schedule.read')
  doctor(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Query('date') date?: string) { return this.svc.getDoctor(u, id, date); }

  @Put('doctors/:id/weekly') @Require('schedule.manage')
  setWeekly(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: SetWeeklyDto, @Req() r: Request) { return this.svc.setWeekly(u, id, dto, ip(r)); }

  @Post('doctors/:id/days-off') @Require('schedule.manage')
  addDayOff(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: CreateDayOffDto, @Req() r: Request) { return this.svc.addDayOff(u, id, dto, ip(r)); }

  @Post('days-off/:id/cancel') @HttpCode(204) @Require('schedule.manage')
  async cancelDayOff(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Req() r: Request) { await this.svc.cancelDayOff(u, id, ip(r)); }

  /** التوفر لمدى (حتى 62 يوم): للكاشير والزبون وصفحة الحجوزات. */
  @Get('availability') @Require('schedule.read')
  availability(@CurrentUser() u: AuthUser, @Query('from') from: string, @Query('to') to: string, @Query('doctor_id') d?: string, @Query('branch_id') b?: string) {
    return this.svc.availability(u, from, to, num(d), num(b));
  }
}
