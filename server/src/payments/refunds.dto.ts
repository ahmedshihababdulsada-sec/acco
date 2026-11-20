import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

export class PayoutDto {
  /** طريقة إرجاع الفلوس الفعلية (كاش افتراضياً) */
  @IsInt() method_id: number;
  @IsInt() @Min(1) amount: number;
}

export class RefundDto {
  /** بنود الوصل المسترجعة (خدمة وحدة أو أكثر). أو الوصل كله بـ full_receipt. */
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsInt({ each: true }) items?: number[];
  @IsOptional() @IsBoolean() full_receipt?: boolean;
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
  /** من وين رجعنا الفلوس. إذا ما انذكر: كاش بالكامل. */
  @IsOptional() @IsArray() @ArrayMaxSize(5) @ValidateNested({ each: true }) @Type(() => PayoutDto) payout?: PayoutDto[];
}
