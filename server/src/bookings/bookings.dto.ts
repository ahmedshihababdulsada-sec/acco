import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { DATE_RE } from '../schedule/schedule.dto';

const DATE_MSG = { message: 'التاريخ بصيغة YYYY-MM-DD' };

export class CreateBookingDto {
  @IsInt() customer_id: number;
  /** الكشفية/المراجعة لطبيب معين. (حجوزات الجلسات تجي من الخطة العلاجية) */
  @IsInt() doctor_id: number;
  @Matches(DATE_RE, DATE_MSG) date: string;
  /** standard = كشفية (وبعدها جلسات) بسعر الكشفية؛ sessions_only = جلسات فقط (الطبيب ينظم الجلسات) بسعر قابل للضبط، الافتراضي مجانية */
  @IsOptional() @IsIn(['standard', 'sessions_only']) type?: 'standard' | 'sessions_only';
  @IsOptional() @IsInt() branch_id?: number;
  /** ملاحظة الزبون وقت الحجز (ليش يريد الخدمة، حساسية...) تظهر للطبيب */
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  /** الخدمة اللي يريدها الزبون (ليزر، بوتوكس...) اختياري */
  @IsOptional() @IsInt() service_id?: number;
}

export class StopDayDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
  @IsOptional() @IsInt() branch_id?: number;
}

export class CancelBookingDto {
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class MoveBookingDto {
  @Matches(DATE_RE, DATE_MSG) date: string;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
