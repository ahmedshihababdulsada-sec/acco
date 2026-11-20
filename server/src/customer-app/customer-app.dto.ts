import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { DATE_RE } from '../schedule/schedule.dto';

export class RequestOtpDto { @IsString() @MaxLength(30) phone: string }

export class VerifyOtpDto {
  @IsString() @MaxLength(30) phone: string;
  @Matches(/^\d{6}$/, { message: 'الرمز 6 أرقام' }) code: string;
  /** للتسجيل الأول بس */
  @IsOptional() @IsString() @MaxLength(120) full_name?: string;
  @IsOptional() @IsInt() branch_id?: number;
  @IsOptional() @IsString() @MaxLength(200) device?: string;
}

export class RefreshDto { @IsString() @MinLength(10) @MaxLength(200) refresh_token: string }

export class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(120) full_name?: string;
  @IsOptional() @IsIn(['female', 'male']) gender?: 'female' | 'male';
  @IsOptional() @Matches(DATE_RE, { message: 'التاريخ بصيغة YYYY-MM-DD' }) birth_date?: string;
  @IsOptional() @IsBoolean() notify_offers?: boolean;
}

export class DeleteAccountDto { @IsBoolean() confirm: boolean }

export class RateSessionDto {
  @IsInt() stars: number;
  @IsOptional() @IsString() @MaxLength(1000) comment?: string;
}

export class DeviceDto {
  @IsIn(['ios', 'android']) platform: 'ios' | 'android';
  @IsString() @MinLength(8) @MaxLength(4096) token: string;
}

export class RemoveDeviceDto { @IsString() @MinLength(8) @MaxLength(4096) token: string }

export class MarkReadDto { @IsOptional() @IsInt() id?: number }

export class AppBookingDto {
  @IsInt() doctor_id: number;
  @Matches(DATE_RE, { message: 'التاريخ بصيغة YYYY-MM-DD' }) date: string;
  @IsOptional() @IsIn(['standard', 'sessions_only']) type?: 'standard' | 'sessions_only';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsInt() service_id?: number;
}

export class MoveDateDto {
  @Matches(DATE_RE, { message: 'التاريخ بصيغة YYYY-MM-DD' }) date: string;
}

export class AvailabilityQuery {
  @IsOptional() @IsString() doctor_id?: string;
  @Matches(DATE_RE, { message: 'التاريخ بصيغة YYYY-MM-DD' }) from: string;
  @Matches(DATE_RE, { message: 'التاريخ بصيغة YYYY-MM-DD' }) to: string;
}
