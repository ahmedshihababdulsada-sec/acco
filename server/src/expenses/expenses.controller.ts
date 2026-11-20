import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { CancelExpenseDto, CreateCategoryDto, CreateExpenseDto, EditExpenseDto, UpdateCategoryDto } from './expenses.dto';
import { ExpensesService } from './expenses.service';

const ip = (r: Request) => r.ip ?? null;
const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));

@Controller()
export class ExpensesController {
  constructor(private readonly svc: ExpensesService) {}

  @Get('expense-categories') @Require('expenses.record')
  categories(@CurrentUser() u: AuthUser, @Query('all') all?: string, @Query('branch_id') b?: string) { return this.svc.listCategories(u, all === '1', num(b)); }

  @Post('expense-categories') @Require('expenses.record')
  createCategory(@CurrentUser() u: AuthUser, @Body() dto: CreateCategoryDto, @Req() r: Request) { return this.svc.createCategory(u, dto, ip(r)); }

  @Patch('expense-categories/:id') @Require('expenses.record')
  updateCategory(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateCategoryDto, @Req() r: Request) { return this.svc.updateCategory(u, id, dto, ip(r)); }

  @Post('expenses') @Require('expenses.record')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateExpenseDto, @Req() r: Request) { return this.svc.create(u, dto, ip(r)); }

  @Get('expenses') @Require('expenses.record')
  list(@CurrentUser() u: AuthUser, @Query('month') month?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('category_id') c?: string, @Query('status') status?: string, @Query('branch_id') b?: string) {
    return this.svc.list(u, { month, from, to, categoryId: num(c), status, branchId: num(b) });
  }

  @Get('expenses/:id') @Require('expenses.record')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.svc.get(u, id); }

  @Put('expenses/:id') @Require('expenses.edit')
  edit(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: EditExpenseDto, @Req() r: Request) { return this.svc.edit(u, id, dto, ip(r)); }

  @Post('expenses/:id/cancel') @Require('expenses.edit')
  cancel(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: CancelExpenseDto, @Req() r: Request) { return this.svc.cancel(u, id, dto, ip(r)); }
}
