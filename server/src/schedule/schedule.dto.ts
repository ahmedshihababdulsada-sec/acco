import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, Max, ValidateNested } from 'class-validator';

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_MSG = { message: 'التاريخ بصيغة YYYY-MM-DD' };

export class ClinicDayDto {
  @IsInt() @Min(1) @Max(7) weekday: number;           // 1=الاثنين ... 7=الأحد (ISO)
  @IsBoolean() is_open: boolean;
}
export class SetClinicDaysDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @ValidateNested({ each: true }) @Type(() => ClinicDayDto) days: ClinicDayDto[];
  @IsOptional() @IsInt() branch_id?: number;
}

export class CreateHolidayDto {
  @Matches(DATE_RE, DATE_MSG) date: string;
  @IsString() @MaxLength(100) name: string;
  @IsOptional() @IsIn(['official', 'sudden']) kind?: 'official' | 'sudden';
  @IsOptional() @IsInt() branch_id?: number;
}

export class WeekDayDto {
  @IsInt() @Min(1) @Max(7) weekday: number;
  @Matches(TIME_RE, { message: 'الوقت بصيغة HH:MM' }) start_time: string;
  @Matches(TIME_RE, { message: 'الوقت بصيغة HH:MM' }) end_time: string;
}
export class SetWeeklyDto {
  /** الأسبوع الجديد كامل: الأيام اللي مو مذكورة = الطبيب ما يداوم بها. فاضية = ما يداوم أبداً. */
  @IsArray() @ArrayMaxSize(7) @ValidateNested({ each: true }) @Type(() => WeekDayDto) days: WeekDayDto[];
  /** يبدي من هذا التاريخ ولا يغير اللي قبله (اليوم أو بعده) */
  @Matches(DATE_RE, DATE_MSG) effective_from: string;
}

export class CreateDayOffDto {
  @Matches(DATE_RE, DATE_MSG) date: string;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}
