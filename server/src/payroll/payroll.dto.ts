import { IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { DATE_RE } from '../schedule/schedule.dto';

const DATE_MSG = { message: 'التاريخ بصيغة YYYY-MM-DD' };
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export class PayRuleDto {
  @Matches(DATE_RE, DATE_MSG) effective_from: string;
  /** null = الراتب ما انحدد. إذا انحذف الحقل يبقى اللي كان ساري */
  @IsOptional() @IsInt() @Min(0) @Max(10_000_000_000) monthly_salary?: number | null;
  /** للأطباء بس (المالك). null = ماكو نسبة */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false }) @Min(0) @Max(100) consult_percent?: number | null;
}

export class GeneratePayrollDto {
  @Matches(MONTH_RE, { message: 'الشهر بصيغة YYYY-MM' }) month: string;
  @IsOptional() @IsInt() branch_id?: number;
}

export class PayItemDto {
  @IsIn(['safe', 'electronic']) pay_source: 'safe' | 'electronic';
  @IsOptional() @IsString() @MaxLength(80) bank_name?: string;
  @IsOptional() @Matches(DATE_RE, DATE_MSG) paid_on?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class AdjustItemDto {
  /** مبلغ التعديل (موجب إضافة، سالب خصم) يستبدل التعديل السابق. صفر = إلغاء التعديل */
  @IsInt() @Min(-10_000_000_000) @Max(10_000_000_000) amount: number;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class SetBaseDto {
  @IsInt() @Min(0) @Max(10_000_000_000) base_salary: number;
  @IsString() @MaxLength(300) reason: string;
}
