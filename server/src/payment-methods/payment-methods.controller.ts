import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { CreatePaymentMethodDto, MoveDto, UpdatePaymentMethodDto } from './payment-methods.dto';
import { PaymentMethodsService } from './payment-methods.service';

@Controller('payment-methods')
export class PaymentMethodsController {
  constructor(private readonly svc: PaymentMethodsService) {}

  /** الكاشير (يختار طريقة الدفع) والمدير والمالك. المعطلة تظهر للمدير والمالك بس مع ?all=1 */
  @Get() @Require('payments.take', 'settings.receipt_and_methods')
  list(@CurrentUser() u: AuthUser, @Query('all') all?: string, @Query('branch_id') branch?: string) {
    return this.svc.list(u, all === '1', branch === undefined ? undefined : Number(branch));
  }

  @Post() @Require('settings.receipt_and_methods')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreatePaymentMethodDto, @Req() req: Request) { return this.svc.create(u, dto, req.ip ?? null); }

  @Patch(':id') @Require('settings.receipt_and_methods')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePaymentMethodDto, @Req() req: Request) {
    return this.svc.update(u, id, dto, req.ip ?? null);
  }

  @Post(':id/disable') @HttpCode(200) @Require('settings.receipt_and_methods')
  disable(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.svc.disable(u, id, req.ip ?? null); }

  @Post(':id/enable') @HttpCode(200) @Require('settings.receipt_and_methods')
  enable(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.svc.enable(u, id, req.ip ?? null); }

  @Post(':id/move') @HttpCode(200) @Require('settings.receipt_and_methods')
  move(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: MoveDto, @Req() req: Request) {
    return this.svc.move(u, id, dto.direction, req.ip ?? null);
  }
}
