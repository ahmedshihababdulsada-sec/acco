import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateDiscountRequestDto {
  /** الكشفية أو جلسات اليوم اللي الكاشير يريد الخصم عليها (واحد من النوعين) */
  @IsOptional() @IsInt() consultation_id?: number;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsInt({ each: true }) session_ids?: number[];
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class ApproveDiscountDto {
  /** المدير يدخل المبلغ (دينار صحيح) */
  @IsInt() @Min(1) @Max(1_000_000_000) amount: number;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class RejectDiscountDto {
  @IsString() @MaxLength(300) note: string;
}

export class ListDiscountQuery {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() branch_id?: string;
}
