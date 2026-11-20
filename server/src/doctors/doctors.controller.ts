import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { HealthRecordDto, QueueQuery } from './doctors.dto';
import { DoctorsService } from './doctors.service';

const ip = (r: Request) => r.ip ?? null;

@Controller()
export class DoctorsController {
  constructor(private readonly svc: DoctorsService) {}

  @Get('doctor/queue') @Require('consultation.write')
  queue(@CurrentUser() u: AuthUser, @Query() q: QueueQuery) { return this.svc.queue(u, q.date); }

  @Post('consultations/:id/enter') @Require('consultation.write')
  enter(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Req() r: Request) { return this.svc.enter(u, id, ip(r)); }

  @Post('consultations/:id/health') @Require('health.record')
  health(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: HealthRecordDto, @Req() r: Request) { return this.svc.recordHealth(u, id, dto, ip(r)); }

  @Post('consultations/:id/finish') @Require('consultation.write')
  finish(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Req() r: Request) { return this.svc.finish(u, id, ip(r)); }

  @Get('customers/:id/file') @Require('customer.file.view')
  file(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.svc.customerFile(u, id); }
}
