import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { CompensationsService } from './compensations.service';
import { CreateCompensationDto, ListCompensationsQuery } from './compensations.dto';

const ip = (r: Request) => r.ip ?? null;
const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));

@Controller('compensations')
export class CompensationsController {
  constructor(private readonly svc: CompensationsService) {}

  @Post() @Require('compensation.decide')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateCompensationDto, @Req() r: Request) { return this.svc.create(u, dto, ip(r)); }

  @Get() @Require('compensation.decide')
  list(@CurrentUser() u: AuthUser, @Query() q: ListCompensationsQuery) { return this.svc.list(u, { branchId: num(q.branch_id), from: q.from, to: q.to }); }
}
