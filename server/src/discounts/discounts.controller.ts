import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { ApproveDiscountDto, CreateDiscountRequestDto, ListDiscountQuery, RejectDiscountDto } from './discounts.dto';
import { DiscountsService } from './discounts.service';

const ip = (r: Request) => r.ip ?? null;
const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));

@Controller('discount-requests')
export class DiscountsController {
  constructor(private readonly svc: DiscountsService) {}

  @Post() @Require('discount.request')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateDiscountRequestDto, @Req() r: Request) { return this.svc.create(u, dto, ip(r)); }

  @Get() @Require('payments.read')
  list(@CurrentUser() u: AuthUser, @Query() q: ListDiscountQuery) { return this.svc.list(u, { status: q.status, branchId: num(q.branch_id) }); }

  @Get(':id') @Require('payments.read')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.svc.get(u, id); }

  @Post(':id/approve') @Require('discount.approve')
  approve(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ApproveDiscountDto, @Req() r: Request) { return this.svc.approve(u, id, dto, ip(r)); }

  @Post(':id/reject') @Require('discount.approve')
  reject(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: RejectDiscountDto, @Req() r: Request) { return this.svc.reject(u, id, dto, ip(r)); }

  @Post(':id/cancel') @Require('payments.read')
  cancel(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Req() r: Request) { return this.svc.cancel(u, id, ip(r)); }
}
