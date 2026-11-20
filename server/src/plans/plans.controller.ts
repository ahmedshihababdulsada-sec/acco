import { Body, Controller, Get, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { CreatePlanDto, PlanItemDto, StopPlanDto } from './plans.dto';
import { PlansService } from './plans.service';

const ip = (r: Request) => r.ip ?? null;

@Controller()
export class PlansController {
  constructor(private readonly svc: PlansService) {}

  @Post('consultations/:id/plan') @Require('consultation.write')
  create(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: CreatePlanDto, @Req() r: Request) { return this.svc.create(u, id, dto, ip(r)); }

  @Get('consultations/:id/plan') @Require('customer.file.view')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.svc.getByConsultation(u, id); }

  @Post('plans/:id/stop') @Require('consultation.write')
  stop(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: StopPlanDto, @Req() r: Request) { return this.svc.stop(u, id, dto, ip(r)); }

  /** إضافة بند علاج لخطة فعالة */
  @Post('plans/:id/items') @Require('consultation.write')
  addItem(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: PlanItemDto, @Req() r: Request) { return this.svc.addItem(u, id, dto, ip(r)); }

  /** إيقاف بند واحد من الخطة */
  @Post('plans/items/:id/stop') @Require('consultation.write')
  stopItem(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: StopPlanDto, @Req() r: Request) { return this.svc.stopItem(u, id, dto, ip(r)); }
}
