import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { MergeCustomersDto, ChangePhoneDto, CreateCustomerDto, UpdateCustomerDto } from './customers.dto';
import { CustomersService } from './customers.service';

const ip = (r: Request) => r.ip ?? null;

@Controller('customers')
export class CustomersController {
  constructor(private readonly svc: CustomersService) {}

  @Post() @Require('customer.register_and_book')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateCustomerDto, @Req() r: Request) { return this.svc.create(u, dto, ip(r)); }

  @Get() @Require('customer.register_and_book')
  search(@Query('q') q?: string) { return this.svc.search(q); }

  @Get(':id') @Require('customer.register_and_book')
  get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }

  @Patch(':id') @Require('customer.register_and_book')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateCustomerDto, @Req() r: Request) { return this.svc.update(u, id, dto, ip(r)); }

  @Put(':id/phone') @Require('customer.merge_or_recode')
  changePhone(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ChangePhoneDto, @Req() r: Request) { return this.svc.changePhone(u, id, dto, ip(r)); }

  /** دمج ملف مكرر (بالمسار) بملف ثاني: المالك بس */
  @Post(':id/merge') @Require('customer.merge_or_recode')
  merge(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: MergeCustomersDto, @Req() r: Request) { return this.svc.merge(u, id, dto, ip(r)); }
}
