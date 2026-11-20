import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { Errors } from '../common/errors';
import { ExtraUsageDto, RevertConfirmationDto } from './nurse.dto';
import { NurseService } from './nurse.service';
import { RatingsService } from './ratings.service';

const ip = (r: Request) => r.ip ?? null;
const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));
const DATE = /^\d{4}-\d{2}-\d{2}$/;

@Controller()
export class NurseController {
  constructor(private readonly svc: NurseService, private readonly ratings: RatingsService) {}

  @Get('nurse/queue') @Require('session.confirm')
  queue(@CurrentUser() u: AuthUser) { return this.svc.queue(u); }

  @Post('sessions/:id/complete') @Require('session.confirm')
  complete(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Req() r: Request) { return this.svc.complete(u, id, ip(r)); }

  @Post('sessions/:id/revert-confirmation') @Require('session.revert_confirmation')
  revert(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: RevertConfirmationDto, @Req() r: Request) { return this.svc.revert(u, id, dto, ip(r)); }

  @Post('sessions/:id/extra-usage') @Require('stock.manage')
  extra(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ExtraUsageDto, @Req() r: Request) { return this.svc.recordExtraUsage(u, id, dto, ip(r)); }

  @Get('ratings') @Require('ratings.view')
  ratingsReport(@CurrentUser() u: AuthUser, @Query('from') from?: string, @Query('to') to?: string, @Query('service_id') s?: string, @Query('nurse_id') n?: string, @Query('branch_id') b?: string) {
    if ((from && !DATE.test(from)) || (to && !DATE.test(to))) throw Errors.badRequest('INVALID_DATE', 'التاريخ بصيغة YYYY-MM-DD');
    return this.ratings.ownerReport(u, { from, to, serviceId: num(s), nurseId: num(n), branchId: num(b) });
  }
}
