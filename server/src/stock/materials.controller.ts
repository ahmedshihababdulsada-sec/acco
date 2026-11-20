import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { MaterialsService } from './materials.service';
import { CreateMaterialDto, UpdateMaterialDto } from './stock.dto';

const ip = (r: Request) => r.ip ?? null;
const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));

@Controller('materials')
export class MaterialsController {
  constructor(private readonly svc: MaterialsService) {}

  @Post() @Require('stock.manage')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateMaterialDto, @Req() r: Request) { return this.svc.create(u, dto, ip(r)); }

  @Get() @Require('stock.manage')
  list(@CurrentUser() u: AuthUser, @Query('all') all?: string, @Query('branch_id') b?: string) { return this.svc.list(u, all === '1', num(b)); }

  @Get(':id') @Require('stock.manage')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.svc.get(u, id); }

  @Put(':id') @Require('stock.manage')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateMaterialDto, @Req() r: Request) { return this.svc.update(u, id, dto, ip(r)); }
}
