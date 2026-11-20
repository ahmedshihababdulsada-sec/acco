import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { PurchasesService } from './purchases.service';
import { CreatePurchaseDto, CreateReturnDto, CreateSupplierDto, SupplierPaymentDto, UpdateSupplierDto, VoidPurchaseDto } from './suppliers.dto';
import { SuppliersService } from './suppliers.service';

const ip = (r: Request) => r.ip ?? null;
const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));

@Controller()
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService, private readonly purchases: PurchasesService) {}

  @Post('suppliers') @Require('stock.manage')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateSupplierDto, @Req() r: Request) { return this.suppliers.create(u, dto, ip(r)); }

  @Get('suppliers') @Require('stock.manage')
  list(@CurrentUser() u: AuthUser, @Query('all') all?: string, @Query('branch_id') b?: string) { return this.suppliers.list(u, all === '1', num(b)); }

  @Put('suppliers/:id') @Require('stock.manage')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateSupplierDto, @Req() r: Request) { return this.suppliers.update(u, id, dto, ip(r)); }

  @Get('suppliers/:id/statement') @Require('stock.manage')
  statement(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.suppliers.statement(u, id); }

  @Post('suppliers/:id/payments') @Require('safe.pay')
  pay(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: SupplierPaymentDto, @Req() r: Request) { return this.suppliers.pay(u, id, dto, ip(r)); }

  @Post('purchases') @Require('stock.manage')
  createPurchase(@CurrentUser() u: AuthUser, @Body() dto: CreatePurchaseDto, @Req() r: Request) { return this.purchases.create(u, dto, ip(r)); }

  @Get('purchases') @Require('stock.manage')
  listPurchases(@CurrentUser() u: AuthUser, @Query('supplier_id') s?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('status') status?: string, @Query('branch_id') b?: string) {
    return this.purchases.list(u, { supplierId: num(s), from, to, status, branchId: num(b) });
  }

  @Get('purchases/:id') @Require('stock.manage')
  getPurchase(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.purchases.get(u, id); }

  @Post('purchases/:id/void') @Require('purchases.void')
  voidPurchase(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: VoidPurchaseDto, @Req() r: Request) { return this.purchases.voidPurchase(u, id, dto, ip(r)); }

  @Post('supplier-returns') @Require('stock.manage')
  createReturn(@CurrentUser() u: AuthUser, @Body() dto: CreateReturnDto, @Req() r: Request) { return this.purchases.createReturn(u, dto, ip(r)); }
}
