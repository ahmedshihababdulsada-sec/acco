import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { AlertsService } from './alerts.service';
import { CountsService } from './counts.service';
import { CreateCountDto, CreateWasteDto } from './stock.dto';
import { WasteService } from './waste.service';

const ip = (r: Request) => r.ip ?? null;
const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));

@Controller('stock')
export class StockOpsController {
  constructor(private readonly waste: WasteService, private readonly counts: CountsService, private readonly alerts: AlertsService) {}

  @Post('waste') @Require('stock.manage')
  createWaste(@CurrentUser() u: AuthUser, @Body() dto: CreateWasteDto, @Req() r: Request) { return this.waste.create(u, dto, ip(r)); }

  @Get('waste') @Require('stock.manage')
  listWaste(@CurrentUser() u: AuthUser, @Query('month') month?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('material_id') m?: string, @Query('branch_id') b?: string) {
    return this.waste.list(u, { month, from, to, materialId: num(m), branchId: num(b) });
  }

  @Get('counts/sheet') @Require('stock.manage')
  sheet(@CurrentUser() u: AuthUser, @Query('branch_id') b?: string) { return this.counts.sheet(u, num(b)); }

  @Post('counts') @Require('stock.manage')
  createCount(@CurrentUser() u: AuthUser, @Body() dto: CreateCountDto, @Req() r: Request) { return this.counts.create(u, dto, ip(r)); }

  @Get('counts') @Require('stock.manage')
  listCounts(@CurrentUser() u: AuthUser, @Query('branch_id') b?: string) { return this.counts.list(u, num(b)); }

  @Get('counts/:id') @Require('stock.manage')
  getCount(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.counts.get(u, id); }

  @Get('alerts') @Require('stock.manage')
  getAlerts(@CurrentUser() u: AuthUser, @Query('branch_id') b?: string) { return this.alerts.get(u, num(b)); }
}
