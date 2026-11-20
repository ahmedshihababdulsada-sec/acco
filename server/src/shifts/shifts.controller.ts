import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { SafeService } from './safe.service';
import { CloseShiftDto, ConfirmShiftDto, DecideWithdrawalDto, ForceCloseDto, OpenShiftDto, OpeningBalanceDto, WithdrawalDto } from './shifts.dto';
import { ShiftsService } from './shifts.service';

const ip = (r: Request) => r.ip ?? null;
const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));

@Controller()
export class ShiftsController {
  constructor(private readonly svc: ShiftsService, private readonly safe: SafeService) {}

  @Post('shifts/open') @Require('shifts.open')
  open(@CurrentUser() u: AuthUser, @Body() dto: OpenShiftDto, @Req() r: Request) { return this.svc.open(u, dto, ip(r)); }

  @Get('shifts/current') @Require('shifts.open')
  current(@CurrentUser() u: AuthUser) { return this.svc.current(u); }

  /** الكاشير يسكّر شفته ويدخل عدّ الكاش وكشف كل جهاز */
  @Post('shifts/current/close') @Require('shifts.open')
  close(@CurrentUser() u: AuthUser, @Body() dto: CloseShiftDto, @Req() r: Request) { return this.svc.close(u, dto, ip(r)); }

  /** تسكير إجباري من المدير/المالك لشفت منسي بسبب مكتوب */
  @Post('shifts/:id/force-close') @Require('shifts.force_close')
  forceClose(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ForceCloseDto, @Req() r: Request) { return this.svc.forceClose(u, id, dto.reason, ip(r)); }

  /** المدير يأكد كل طريقة لحالها، والكاش المؤكد يدخل الخزنة */
  @Post('shifts/:id/confirm') @Require('safe.pay')
  confirm(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ConfirmShiftDto, @Req() r: Request) { return this.svc.confirm(u, id, dto, ip(r)); }

  @Get('shifts') @Require('shifts.read')
  list(@CurrentUser() u: AuthUser, @Query('status') status?: string, @Query('date') date?: string, @Query('branch_id') b?: string) { return this.svc.list(u, { status, date, branchId: num(b) }); }

  @Get('shifts/:id') @Require('shifts.read')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.svc.get(u, id); }

  @Get('safe') @Require('safe.read')
  getSafe(@CurrentUser() u: AuthUser, @Query('branch_id') b?: string, @Query('limit') l?: string) { return this.safe.get(u, num(b), num(l)); }

  @Post('safe/opening-balance') @Require('safe.opening')
  setOpening(@CurrentUser() u: AuthUser, @Body() dto: OpeningBalanceDto, @Req() r: Request) { return this.safe.setOpening(u, dto, ip(r)); }

  @Post('safe/withdrawals') @Require('withdrawal.record')
  recordWithdrawal(@CurrentUser() u: AuthUser, @Body() dto: WithdrawalDto, @Req() r: Request) { return this.safe.recordWithdrawal(u, dto, ip(r)); }

  @Get('safe/withdrawals') @Require('safe.read')
  withdrawals(@CurrentUser() u: AuthUser, @Query('status') status?: string, @Query('branch_id') b?: string) { return this.safe.listWithdrawals(u, status, num(b)); }

  @Post('safe/withdrawals/:id/approve') @Require('withdrawal.approve')
  approveWithdrawal(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: DecideWithdrawalDto, @Req() r: Request) { return this.safe.approveWithdrawal(u, id, dto, ip(r)); }

  @Post('safe/withdrawals/:id/reject') @Require('withdrawal.approve')
  rejectWithdrawal(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: DecideWithdrawalDto, @Req() r: Request) { return this.safe.rejectWithdrawal(u, id, dto, ip(r)); }

  /** المدير يلغي طلب سحب سجله هو وما قرر عليه المالك */
  @Post('safe/withdrawals/:id/cancel') @Require('withdrawal.record')
  cancelWithdrawal(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: DecideWithdrawalDto, @Req() r: Request) { return this.safe.cancelWithdrawal(u, id, dto, ip(r)); }
}
