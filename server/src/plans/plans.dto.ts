import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { DATE_RE } from '../schedule/schedule.dto';

const DATE_MSG = { message: 'التاريخ بصيغة YYYY-MM-DD' };

export class PlanItemDto {
  @IsInt() service_id: number;
  /** قيم حقول الخدمة (كم cc، مناطق الليزر...) بمفاتيح الحقول. تنتحقق بنفس محرك التسعير. */
  @IsOptional() @IsObject() values?: Record<string, unknown>;
  @IsInt() @Min(1) @Max(60) sessions_count: number;
  /** أقل فرق بين جلسة وجلسة بالأيام (الأسبوع = 7) */
  @IsInt() @Min(0) @Max(365) interval_days: number;
  /** تاريخ أول جلسة (والنظام يطلع الباقي بالفرق). أو `dates` لتحديد كل تاريخ بالإيد. */
  @IsOptional() @Matches(DATE_RE, DATE_MSG) first_session_date?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(60) @Matches(DATE_RE, { each: true, ...DATE_MSG }) dates?: string[];
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class CreatePlanDto {
  /** العلاجات: نص حر */
  @IsOptional() @IsString() @MaxLength(1000) treatments_text?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => PlanItemDto) items: PlanItemDto[];
}

export class StopPlanDto {
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
}
