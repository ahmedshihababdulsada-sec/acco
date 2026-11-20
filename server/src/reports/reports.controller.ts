import { Controller, Get, Param, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { Request, Response } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { Errors } from '../common/errors';
import { REPORT_NAMES, ReportName, ReportsService } from './reports.service';

const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));

interface RangeQuery { from?: string; to?: string; branch_id?: string; format?: string }

@Controller('reports')
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  @Get('dashboard') @Require('reports.all')
  async dashboard(@CurrentUser() u: AuthUser, @Query() q: RangeQuery) { const { table: _t, ...rest } = await this.svc.dashboard(await this.svc.params(u, q.from, q.to, num(q.branch_id))); return rest; }

  @Get('sales') @Require('reports.all')
  async sales(@CurrentUser() u: AuthUser, @Query() q: RangeQuery) { const { table: _t, ...rest } = await this.svc.sales(await this.svc.params(u, q.from, q.to, num(q.branch_id))); return rest; }

  @Get('services') @Require('reports.all')
  async services(@CurrentUser() u: AuthUser, @Query() q: RangeQuery) { const { table: _t, ...rest } = await this.svc.services(await this.svc.params(u, q.from, q.to, num(q.branch_id))); return rest; }

  @Get('cashiers') @Require('reports.all')
  async cashiers(@CurrentUser() u: AuthUser, @Query() q: RangeQuery) { const { table: _t, ...rest } = await this.svc.cashiers(await this.svc.params(u, q.from, q.to, num(q.branch_id))); return rest; }

  @Get('stock') @Require('reports.all')
  async stock(@CurrentUser() u: AuthUser, @Query() q: RangeQuery) { const { table: _t, ...rest } = await this.svc.stock(await this.svc.params(u, q.from, q.to, num(q.branch_id))); return rest; }

  @Get('doctors') @Require('reports.all')
  async doctors(@CurrentUser() u: AuthUser, @Query() q: RangeQuery) { const { table: _t, ...rest } = await this.svc.doctors(await this.svc.params(u, q.from, q.to, num(q.branch_id))); return rest; }

  @Get('payroll') @Require('reports.all')
  async payroll(@CurrentUser() u: AuthUser, @Query() q: RangeQuery) { const { table: _t, ...rest } = await this.svc.payroll(await this.svc.params(u, q.from, q.to, num(q.branch_id))); return rest; }

  /** تصدير Excel أو CSV (المالك بس) وينسجل بسجل الحركات */
  @Get(':name/export') @Require('reports.all')
  async export(@CurrentUser() u: AuthUser, @Param('name') name: string, @Query() q: RangeQuery, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    if (!(REPORT_NAMES as readonly string[]).includes(name)) throw Errors.notFound('التقرير');
    const format = q.format ?? 'xlsx';
    if (format !== 'xlsx' && format !== 'csv') throw Errors.badRequest('INVALID_FORMAT', 'الصيغة xlsx أو csv');
    const out = await this.svc.export(u, name as ReportName, await this.svc.params(u, q.from, q.to, num(q.branch_id)), format, r.ip ?? null);
    res.set({ 'Content-Type': out.contentType, 'Content-Disposition': `attachment; filename="${out.filename}"`, 'Cache-Control': 'no-store' });
    return new StreamableFile(out.body);
  }
}
