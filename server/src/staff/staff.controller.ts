import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { CreateStaffDto, ReasonDto } from './staff.dto';
import { StaffService } from './staff.service';

/** الحارس يسمح للمالك والمدير بس؛ والخدمة تفحص الدور المستهدف (المدير ما يدير مدراء). */
@Controller('staff')
@Require('staff.manage_staff', 'staff.manage_managers')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: CreateStaffDto, @Req() req: Request) {
    return this.staff.create(u, dto, req.ip ?? null);
  }

  @Get() list(@CurrentUser() u: AuthUser) { return this.staff.list(u); }

  @Post(':id/deactivate') @HttpCode(204)
  async deactivate(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ReasonDto, @Req() req: Request) {
    await this.staff.deactivate(u, id, b.reason, req.ip ?? null);
  }

  @Post(':id/reactivate') @HttpCode(204)
  async reactivate(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ReasonDto, @Req() req: Request) {
    await this.staff.reactivate(u, id, b.reason, req.ip ?? null);
  }

  @Post(':id/reset-password') @HttpCode(200)
  resetPassword(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.staff.resetPassword(u, id, req.ip ?? null);
  }
}
