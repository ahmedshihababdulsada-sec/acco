import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { Errors } from '../common/errors';
import { AdjustItemDto, GeneratePayrollDto, PayItemDto, PayRuleDto, SetBaseDto } from './payroll.dto';
import { PayrollService } from './payroll.service';

const ip = (r: Request) => r.ip ?? null;
const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

@Controller()
export class PayrollController {
  constructor(private readonly svc: PayrollService) {}

  /** الصلاحية الدقيقة (حسب دور الموظف المستهدف) تنفحص بالخدمة: المدير للكاشير والممرض، والمالك للطبيب والمدير */
  @Put('staff/:id/pay-rule') @Require('salary.staff_set')
  setRule(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: PayRuleDto, @Req() r: Request) { return this.svc.setPayRule(u, id, dto, ip(r)); }

  @Get('staff/:id/pay-rules') @Require('salary.staff_set')
  rules(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.svc.payRules(u, id); }

  @Get('payroll/staff') @Require('payroll.read')
  staff(@CurrentUser() u: AuthUser, @Query('branch_id') b?: string) { return this.svc.staffOverview(u, num(b)); }

  @Get('payroll') @Require('payroll.read')
  list(@CurrentUser() u: AuthUser, @Query('month') month?: string, @Query('branch_id') b?: string) {
    if (!month || !MONTH_RE.test(month)) throw Errors.badRequest('INVALID_MONTH', 'الشهر بصيغة YYYY-MM');
    return this.svc.list(u, month, num(b));
  }

  @Post('payroll/generate') @Require('payroll.read')
  generate(@CurrentUser() u: AuthUser, @Body() dto: GeneratePayrollDto) { return this.svc.generate(u, dto.month, dto.branch_id); }

  @Post('payroll/items/:id/adjust') @Require('safe.pay')
  adjust(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: AdjustItemDto, @Req() r: Request) { return this.svc.adjust(u, id, dto, ip(r)); }

  @Post('payroll/items/:id/set-base') @Require('salary.doctor_manager_set')
  setBase(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: SetBaseDto, @Req() r: Request) { return this.svc.setBase(u, id, dto, ip(r)); }

  @Post('payroll/items/:id/pay') @Require('safe.pay')
  pay(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: PayItemDto, @Req() r: Request) { return this.svc.pay(u, id, dto, ip(r)); }
}
