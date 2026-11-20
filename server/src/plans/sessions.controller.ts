import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { BookSessionDto, MoveSessionDto } from './sessions.dto';
import { SessionsService } from './sessions.service';

const ip = (r: Request) => r.ip ?? null;
const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));

@Controller()
export class SessionsController {
  constructor(private readonly svc: SessionsService) {}

  @Get('customers/:id/sessions') @Require('customer.register_and_book')
  customerSessions(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.svc.customerSessions(u, id); }

  @Get('sessions/follow-up') @Require('customer.register_and_book')
  followUp(@CurrentUser() u: AuthUser, @Query('branch_id') b?: string) { return this.svc.followUp(u, num(b)); }

  @Post('sessions/:id/move') @Require('customer.register_and_book')
  move(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: MoveSessionDto, @Req() r: Request) { return this.svc.move(u, id, dto, ip(r)); }

  @Post('sessions/:id/book') @Require('customer.register_and_book')
  book(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: BookSessionDto, @Req() r: Request) { return this.svc.book(u, id, dto, ip(r)); }
}
