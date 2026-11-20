import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { DATE_RE } from '../schedule/schedule.dto';

const DATE_MSG = { message: 'التاريخ بصيغة YYYY-MM-DD' };

export class CreateCategoryDto {
  @IsString() @MinLength(2) @MaxLength(60) name: string;
  /** operating: مصروف تشغيلي (الافتراضي) · payment_fee: عمولة جهاز/مصرف · equipment: معدات طويلة الاستخدام (خارج ربح الإدارة) */
  @IsOptional() @IsIn(['operating', 'payment_fee', 'equipment']) kind?: 'operating' | 'payment_fee' | 'equipment';
  @IsOptional() @IsInt() branch_id?: number;
}
export class UpdateCategoryDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(60) name?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

export class CreateExpenseDto {
  @IsInt() category_id: number;
  @IsInt() @Min(1) amount: number;
  @Matches(DATE_RE, DATE_MSG) expense_date: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  /** safe: من الخزنة (ينقص رصيدها) · electronic: تحويل، واسم المصرف إلزامي وما يلمس الخزنة */
  @IsIn(['safe', 'electronic']) pay_source: 'safe' | 'electronic';
  @IsOptional() @IsString() @MaxLength(100) bank_name?: string;
  /** صورة الإثبات (إلزامية): معرّف مرفق من نوع expense_proof مرفوع مسبقاً */
  @IsInt() proof_attachment_id: number;
  @IsOptional() @IsInt() branch_id?: number;
}

export class EditExpenseDto {
  @IsInt() @Min(1) expected_version: number;
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
  @IsOptional() @IsInt() category_id?: number;
  @IsOptional() @IsInt() @Min(1) amount?: number;
  @IsOptional() @Matches(DATE_RE, DATE_MSG) expense_date?: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
}

export class CancelExpenseDto {
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
}
