import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { CatalogService } from './catalog.service';
import {
  CreateFieldDto, CreateServiceDto, OptionInputDto, PriceDto, QuoteDto, SetMaterialsDto, UpdateFieldDto, UpdateOptionDto, UpdateServiceDto,
} from './catalog.dto';

const ip = (r: Request) => r.ip ?? null;

@Controller()
export class CatalogController {
  constructor(private readonly svc: CatalogService) {}

  @Get('services') @Require('services.read')
  list(@CurrentUser() u: AuthUser, @Query('all') all?: string, @Query('branch_id') branch?: string) {
    return this.svc.list(u, all === '1', branch === undefined ? undefined : Number(branch));
  }

  @Get('services/:id') @Require('services.read')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.svc.get(u, id); }

  @Post('services') @Require('services.define')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateServiceDto, @Req() r: Request) { return this.svc.create(u, dto, ip(r)); }

  @Patch('services/:id') @Require('services.define')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateServiceDto, @Req() r: Request) { return this.svc.update(u, id, dto, ip(r)); }

  @Put('services/:id/price') @Require('services.prices')
  setPrice(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: PriceDto, @Req() r: Request) { return this.svc.setPrice(u, id, dto.price, ip(r)); }

  @Post('services/:id/activate') @HttpCode(200) @Require('services.define')
  activate(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Req() r: Request) { return this.svc.activate(u, id, ip(r)); }

  @Post('services/:id/deactivate') @HttpCode(200) @Require('services.define')
  deactivate(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Req() r: Request) { return this.svc.deactivate(u, id, ip(r)); }

  @Post('services/:id/fields') @Require('services.define')
  addField(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: CreateFieldDto, @Req() r: Request) { return this.svc.addField(u, id, dto, ip(r)); }

  @Put('services/:id/materials') @Require('services.define')
  setMaterials(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: SetMaterialsDto, @Req() r: Request) { return this.svc.setMaterials(u, id, dto.items, ip(r)); }

  /** معاينة السعر والاستهلاك (صفحة الطبيب والمدير). ما تحفظ شي. */
  @Post('services/:id/quote') @HttpCode(200) @Require('services.read')
  quote(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: QuoteDto) { return this.svc.quote(u, id, dto.values, dto.at); }

  @Patch('fields/:id') @Require('services.define')
  updateField(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateFieldDto, @Req() r: Request) { return this.svc.updateField(u, id, dto, ip(r)); }

  @Post('fields/:id/options') @Require('services.define')
  addOption(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: OptionInputDto, @Req() r: Request) { return this.svc.addOption(u, id, dto, ip(r)); }

  @Patch('options/:id') @Require('services.define')
  updateOption(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateOptionDto, @Req() r: Request) { return this.svc.updateOption(u, id, dto, ip(r)); }

  @Put('options/:id/price') @Require('services.prices')
  setOptionPrice(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: PriceDto, @Req() r: Request) { return this.svc.setOptionPrice(u, id, dto.price, ip(r)); }
}
