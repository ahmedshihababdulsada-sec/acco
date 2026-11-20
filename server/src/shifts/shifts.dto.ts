import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

export class OpenShiftDto {
  /** الفكة اللي استلمها الكاشير من المدير (دينار صحيح). تطلع من الخزنة. */
  @IsInt() @Min(0) opening_float: number;
  /** المدير/المالك اللي سلّم الفكة (اختياري) */
  @IsOptional() @IsInt() float_given_by?: number;
  @IsOptional() @IsInt() branch_id?: number;
}

export class CountDto {
  @IsInt() method_id: number;
  /** اللي عدّه الكاشير: كاش معدود، أو مبلغ كشف الجهاز */
  @IsInt() @Min(0) counted: number;
}
export class CloseShiftDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => CountDto) counts: CountDto[];
}

export class ConfirmLineDto {
  @IsInt() method_id: number;
  @IsInt() @Min(0) confirmed: number;
  /** إلزامية إذا المؤكد ≠ المتوقع (نقص أو زيادة) */
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
export class ConfirmShiftDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => ConfirmLineDto) lines: ConfirmLineDto[];
}

export class OpeningBalanceDto {
  @IsInt() @Min(1) amount: number;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
  @IsOptional() @IsInt() branch_id?: number;
}

export class ForceCloseDto {
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class WithdrawalDto {
  @IsInt() @Min(1) amount: number;
  /** باسم منو انسحب */
  @IsString() @MinLength(2) @MaxLength(100) withdrawn_by_name: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'التاريخ بصيغة YYYY-MM-DD' }) withdrawal_date: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class DecideWithdrawalDto {
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
