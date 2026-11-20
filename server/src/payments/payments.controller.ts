import { Body, Controller, Get, Headers, HttpCode, Param, ParseIntPipe, Post, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { CancelCheckInDto, PayConsultationDto, PaySessionsDto, PrintBatchDto, PrintDto } from './payments.dto';
import { PaymentsService } from './payments.service';
import { RefundDto } from './refunds.dto';
import { RefundsService } from './refunds.service';

const ip = (r: Request) => r.ip ?? null;
const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));

@Controller()
export class PaymentsController {
  constructor(private readonly svc: PaymentsService, private readonly refunds: RefundsService) {}

  /** «تم دفع الكشفية». ترويسة Idempotency-Key إلزامية: إعادة نفس الطلب ترجع نفس الوصل (Idempotent-Replay: true). */
  @Post('payments/consultation') @Require('payments.take')
  async payConsultation(@CurrentUser() u: AuthUser, @Body() dto: PayConsultationDto, @Headers('idempotency-key') key: string | undefined, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.svc.payConsultation(u, dto, key, ip(r));
    res.status(out.status);
    if (out.replay) res.setHeader('Idempotent-Replay', 'true');
    return out.body;
  }

  /** «تم الدفع» لجلسات الزبون المحجوزة اليوم. Idempotency-Key إلزامية. */
  @Post('payments/sessions') @Require('payments.take')
  async paySessions(@CurrentUser() u: AuthUser, @Body() dto: PaySessionsDto, @Headers('idempotency-key') key: string | undefined, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.svc.paySessions(u, dto, key, ip(r));
    res.status(out.status);
    if (out.replay) res.setHeader('Idempotent-Replay', 'true');
    return out.body;
  }

  /** عرض سعر قبل الدفع: نفس حساب الدفع (العرض، الخصم المعتمد، النقاط، التقريب) بدون إصدار شي */
  @Post('payments/quote/consultation') @HttpCode(200) @Require('payments.take')
  quoteConsultation(@CurrentUser() u: AuthUser, @Body() dto: PayConsultationDto) { return this.svc.quoteConsultation(u, dto); }

  @Post('payments/quote/sessions') @HttpCode(200) @Require('payments.take')
  quoteSessions(@CurrentUser() u: AuthUser, @Body() dto: PaySessionsDto) { return this.svc.quoteSessions(u, dto); }

  @Get('payments') @Require('payments.read')
  list(@CurrentUser() u: AuthUser, @Query('receipt_no') receiptNo?: string, @Query('customer_id') c?: string, @Query('shift_id') s?: string, @Query('date') date?: string, @Query('branch_id') b?: string) {
    return this.svc.list(u, { receiptNo, customerId: num(c), shiftId: num(s), date, branchId: num(b) });
  }

  @Get('payments/:id') @Require('payments.read')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.svc.get(u, id); }

  /** وصل اليوم الجامع للزبون (كشفية + جلسات...) للطباعة مرة وحدة */
  @Get('customers/:id/day-receipt') @Require('payments.read')
  dayReceipt(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Query('date') date?: string) { return this.svc.dayReceipt(u, id, date); }

  /** تسجيل طباعة وصل جامع: كل الوصولات المشمولة بمعاملة وحدة */
  @Post('payments/print') @HttpCode(200) @Require('payments.take')
  printBatch(@CurrentUser() u: AuthUser, @Body() dto: PrintBatchDto, @Req() r: Request) { return this.svc.recordPrintBatch(u, dto.payment_ids, dto.note, ip(r)); }

  @Post('payments/:id/print') @Require('payments.take')
  print(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: PrintDto, @Req() r: Request) { return this.svc.recordPrint(u, id, dto.note, ip(r)); }

  @Post('consultations/:id/cancel-check-in') @Require('payments.take')
  cancelCheckIn(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: CancelCheckInDto, @Req() r: Request) { return this.svc.cancelFreeCheckIn(u, id, dto.reason, ip(r)); }

  /** المراجعة المجانية: الكاشير يدخل الزبون للطبيب بدون دفع */
  @Post('consultations/:id/check-in') @Require('payments.take')
  checkIn(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Req() r: Request) { return this.svc.checkInFree(u, id, ip(r)); }

  /** استرجاع بند أو أكثر أو الوصل كله. Idempotency-Key إلزامية. يتسجل بشفت الكاشير الحالي. */
  @Post('payments/:id/refund') @Require('payments.refund')
  async refund(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: RefundDto, @Headers('idempotency-key') key: string | undefined, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.refunds.refund(u, id, dto, key, ip(r));
    res.status(out.status);
    if (out.replay) res.setHeader('Idempotent-Replay', 'true');
    return out.body;
  }

  @Get('refunds/:id') @Require('payments.read')
  getRefund(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.refunds.get(u, id); }
}
