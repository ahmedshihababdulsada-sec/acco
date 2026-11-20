import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { CancelOfferDto, CreateOfferDto, UpdateOfferDto } from './offers.dto';
import { OffersService } from './offers.service';

const ip = (r: Request) => r.ip ?? null;
const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));

@Controller('offers')
export class OffersController {
  constructor(private readonly svc: OffersService) {}

  @Post() @Require('offers.manage')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateOfferDto, @Req() r: Request) { return this.svc.create(u, dto, ip(r)); }

  @Get() @Require('offers.manage')
  list(@CurrentUser() u: AuthUser, @Query('state') state?: string, @Query('branch_id') b?: string) { return this.svc.list(u, { state, branchId: num(b) }); }

  /** العروض الفعالة اليوم (الكاشير يعاين السعر) */
  @Get('active') @Require('services.read')
  active(@CurrentUser() u: AuthUser, @Query('branch_id') b?: string) { return this.svc.active(u, num(b)); }

  @Get(':id') @Require('offers.manage')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.svc.get(u, id); }

  @Put(':id') @Require('offers.manage')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateOfferDto, @Req() r: Request) { return this.svc.update(u, id, dto, ip(r)); }

  @Post(':id/cancel') @Require('offers.manage')
  cancel(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: CancelOfferDto, @Req() r: Request) { return this.svc.cancel(u, id, dto, ip(r)); }
}
