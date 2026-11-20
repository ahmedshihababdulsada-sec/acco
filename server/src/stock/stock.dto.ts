import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

const QTY = { maxDecimalPlaces: 3, allowNaN: false, allowInfinity: false };

export class CreateMaterialDto {
  @IsString() @MinLength(2) @MaxLength(100) name: string;
  /** وحدة الاستهلاك (cc / قطعة) */
  @IsString() @MinLength(1) @MaxLength(30) base_unit: string;
  /** وحدة الشراء (كرتون) */
  @IsString() @MinLength(1) @MaxLength(30) pack_unit: string;
  /** وحدة وسطية اختيارية (علبة). كرتون = mid_per_pack علبة، والعلبة = base_per_mid من وحدة الاستهلاك */
  @IsOptional() @IsString() @MaxLength(30) mid_unit?: string;
  @IsOptional() @IsNumber(QTY) @Min(0.001) @Max(1_000_000) mid_per_pack?: number;
  @IsOptional() @IsNumber(QTY) @Min(0.001) @Max(1_000_000) base_per_mid?: number;
  @IsOptional() @IsNumber(QTY) @Min(0) @Max(1_000_000_000) low_threshold?: number;
  @IsOptional() @IsInt() branch_id?: number;
}

export class UpdateMaterialDto {
  @IsInt() @Min(1) expected_version: number;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @IsOptional() @IsNumber(QTY) @Min(0) @Max(1_000_000_000) low_threshold?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
  /** الوحدات والتحويل: تتغير بس إذا المادة بدون أي حركة مخزون (تنقفل بعدها) */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(30) base_unit?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(30) pack_unit?: string;
  @IsOptional() @IsString() @MaxLength(30) mid_unit?: string;
  @IsOptional() @IsNumber(QTY) @Min(0.001) @Max(1_000_000) mid_per_pack?: number;
  @IsOptional() @IsNumber(QTY) @Min(0.001) @Max(1_000_000) base_per_mid?: number;
}


export class CreateWasteDto {
  @IsInt() batch_id: number;
  @IsNumber(QTY) @Min(0.001) @Max(1_000_000_000) qty: number;
  @IsIn(['expired', 'damaged', 'opened_unused', 'prep_error', 'other']) reason: 'expired' | 'damaged' | 'opened_unused' | 'prep_error' | 'other';
  /** السبب «أخرى» يحتاج ملاحظة */
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class CountLineDto {
  /** batch: جرد دفعة موجودة · material_level: تصحيح مادة سالبة بدفعة جديدة */
  @IsIn(['batch', 'material_level']) kind: 'batch' | 'material_level';
  @IsOptional() @IsInt() batch_id?: number;
  @IsOptional() @IsInt() material_id?: number;
  /** الكمية الفعلية اللي عدّها المدير */
  @IsNumber(QTY) @Min(0) @Max(1_000_000_000) actual_qty: number;
  /** كمية النظام اللي شافها المدير بورقة الجرد: إذا تغيرت قبل الحفظ (انصرف شي) يرجع 409 ويعيد العدّ */
  @IsNumber(QTY) @Min(-1_000_000_000) @Max(1_000_000_000) expected_system_qty: number;
  /** أي فرق يحتاج ملاحظة */
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  /** للمادة السالبة: صلاحية الدفعة الجديدة وكلفة وحدتها (الافتراضي آخر سعر شراء) */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'التاريخ بصيغة YYYY-MM-DD' }) new_batch_expiry?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(1_000_000_000) new_batch_unit_cost?: number;
}

export class CreateCountDto {
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => CountLineDto) lines: CountLineDto[];
}
