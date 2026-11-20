import { IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { DATE_RE } from '../schedule/schedule.dto';

const DATE_MSG = { message: 'التاريخ بصيغة YYYY-MM-DD' };
const PCT = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false };

export class CreateOfferDto {
  @IsOptional() @IsInt() branch_id?: number;
  @IsInt() service_id: number;
  @IsString() @MinLength(2) @MaxLength(120) title: string;
  @IsNumber(PCT) @Min(0.01) @Max(99.99) percent: number;
  @Matches(DATE_RE, DATE_MSG) start_date: string;
  @Matches(DATE_RE, DATE_MSG) end_date: string;
  @IsOptional() @IsIn(['all', 'did_service', 'none']) notify_audience?: 'all' | 'did_service' | 'none';
  /** فئة الإشعار: اللي سووا هالخدمة قبل */
  @IsOptional() @IsInt() notify_service_id?: number;
  @IsOptional() @IsString() @MaxLength(80) notify_title?: string;
  @IsOptional() @IsString() @MaxLength(240) notify_body?: string;
  @IsOptional() @Matches(DATE_RE, DATE_MSG) notify_at?: string;
}

export class UpdateOfferDto {
  @IsInt() expected_version: number;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) title?: string;
  @IsOptional() @IsNumber(PCT) @Min(0.01) @Max(99.99) percent?: number;
  @IsOptional() @Matches(DATE_RE, DATE_MSG) start_date?: string;
  @IsOptional() @Matches(DATE_RE, DATE_MSG) end_date?: string;
  @IsOptional() @IsIn(['all', 'did_service', 'none']) notify_audience?: 'all' | 'did_service' | 'none';
  @IsOptional() @IsInt() notify_service_id?: number;
  @IsOptional() @IsString() @MaxLength(80) notify_title?: string;
  @IsOptional() @IsString() @MaxLength(240) notify_body?: string;
  @IsOptional() @Matches(DATE_RE, DATE_MSG) notify_at?: string;
}

export class CancelOfferDto {
  @IsString() @MaxLength(300) reason: string;
}
