import { Body, Controller, Get, Param, Put, Query, Req, ParseIntPipe } from '@nestjs/common';
import { Request } from 'express';
import { Allow, IsInt, IsOptional, IsString, Min, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { SettingsService } from './settings.service';

export class UpdateSettingDto {
  // القيمة تتحقق منها السجلات حسب نوع المفتاح، فهنا نقبل أي JSON
  @Allow() value: unknown;
  @IsInt() @Min(0) expected_version: number;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
  @IsOptional() @IsInt() branch_id?: number;
}

class BranchQuery {
  @IsOptional() @Type(() => Number) @IsInt() branch_id?: number;
}

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get() @Require('settings.read')
  list(@CurrentUser() u: AuthUser, @Query() q: BranchQuery) { return this.settings.list(u, q.branch_id); }

  @Get(':key/history') @Require('settings.read')
  history(@CurrentUser() u: AuthUser, @Param('key') key: string, @Query() q: BranchQuery) { return this.settings.history(u, key, q.branch_id); }

  /** الصلاحية حسب المفتاح (نقاط: المالك، الحد اليومي: المدير والمالك...) تنفحص بالخدمة. */
  @Put(':key') @Require('settings.read')
  update(@CurrentUser() u: AuthUser, @Param('key') key: string, @Body() dto: UpdateSettingDto, @Req() req: Request) {
    return this.settings.update(u, key, dto.value, dto.expected_version, dto.reason, dto.branch_id, req.ip ?? null);
  }
}
