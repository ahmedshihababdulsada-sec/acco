import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

export class TenderDto {
  @IsInt() method_id: number;
  @IsInt() @Min(1) amount: number;
  /** رقم مرجع العملية من الجهاز (اختياري، القاعدة 11 من القواعد المحاسبية) */
  @IsOptional() @IsString() @MaxLength(100) reference?: string;
}

export class PayConsultationDto {
  @IsInt() consultation_id: number;
  /** كيف دفع: الوصل الواحد يقدر ينقسم على أكثر من طريقة. فاضية بس إذا الصافي صفر. */
  @IsOptional() @IsArray() @ArrayMaxSize(5) @ValidateNested({ each: true }) @Type(() => TenderDto) tenders?: TenderDto[];
  /** الزبون وافق يستخدم نقاطه (لحد السقف) */
  @IsOptional() @IsBoolean() redeem_points?: boolean;
  /** طلب خصم معتمد من المدير (اختياري) */
  @IsOptional() @IsInt() discount_request_id?: number;
}

export class PrintBatchDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @IsInt({ each: true }) payment_ids: number[];
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

export class PrintDto {
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

export class CancelCheckInDto {
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class PaySessionsDto {
  /** الجلسات اللي يدفعها الزبون هسه (من جلساته المحجوزة اليوم) */
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ArrayUnique() @IsInt({ each: true }) session_ids: number[];
  @IsOptional() @IsArray() @ArrayMaxSize(5) @ValidateNested({ each: true }) @Type(() => TenderDto) tenders?: TenderDto[];
  @IsOptional() @IsBoolean() redeem_points?: boolean;
  @IsOptional() @IsInt() discount_request_id?: number;
}
