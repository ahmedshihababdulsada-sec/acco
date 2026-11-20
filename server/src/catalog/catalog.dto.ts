import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Matches, MaxLength, Min, ValidateNested } from 'class-validator';

export class CreateServiceDto {
  @IsString() @Length(2, 100) name_ar: string;
  @IsOptional() @IsString() @MaxLength(100) name_en?: string;
  @IsIn(['fixed', 'per_unit', 'per_option']) pricing_model: 'fixed' | 'per_unit' | 'per_option';
  /** سعر الجلسة (ثابت) أو سعر الوحدة. الخدمة بسعر الخيارات ما إلها سعر عام. */
  @IsOptional() @IsInt() @Min(0) price?: number;
  @IsOptional() @IsInt() branch_id?: number;
}

export class UpdateServiceDto {
  @IsOptional() @IsString() @Length(2, 100) name_ar?: string;
  @IsOptional() @IsString() @MaxLength(100) name_en?: string;
  @IsOptional() @IsInt() sort_order?: number;
  @IsInt() @Min(1) expected_version: number;
}

export class PriceDto {
  @IsInt() @Min(0) price: number;
}

export class OptionInputDto {
  @IsString() @Length(1, 100) label_ar: string;
  @IsOptional() @IsString() @MaxLength(100) label_en?: string;
  @IsOptional() @IsBoolean() is_exclusive?: boolean;
  @IsOptional() @IsInt() @Min(0) price?: number;
  @IsOptional() @IsInt() sort_order?: number;
}

export class CreateFieldDto {
  @IsString() @Matches(/^[a-z][a-z0-9_]{0,39}$/, { message: 'مفتاح الحقل حروف إنجليزية صغيرة وأرقام وشرطة سفلية، يبدأ بحرف' }) field_key: string;
  @IsString() @Length(1, 100) label_ar: string;
  @IsOptional() @IsString() @MaxLength(100) label_en?: string;
  @IsIn(['number', 'select', 'multi_select', 'text', 'bool']) field_type: 'number' | 'select' | 'multi_select' | 'text' | 'bool';
  @IsOptional() @IsString() @MaxLength(30) unit_label?: string;
  @IsOptional() @IsBoolean() is_required?: boolean;
  @IsOptional() @IsIn(['none', 'quantity', 'option']) pricing_role?: 'none' | 'quantity' | 'option';
  @IsOptional() @IsInt() sort_order?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => OptionInputDto) options?: OptionInputDto[];
}

export class UpdateFieldDto {
  @IsOptional() @IsString() @Length(1, 100) label_ar?: string;
  @IsOptional() @IsString() @MaxLength(100) label_en?: string;
  @IsOptional() @IsString() @MaxLength(30) unit_label?: string;
  @IsOptional() @IsBoolean() is_required?: boolean;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() sort_order?: number;
  @IsInt() @Min(1) expected_version: number;
}

export class UpdateOptionDto {
  @IsOptional() @IsString() @Length(1, 100) label_ar?: string;
  @IsOptional() @IsString() @MaxLength(100) label_en?: string;
  @IsOptional() @IsBoolean() is_exclusive?: boolean;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() sort_order?: number;
}

export class MaterialLinkDto {
  @IsInt() @Min(1) material_id: number;
  @IsIn(['per_field_value', 'fixed_per_session']) formula: 'per_field_value' | 'fixed_per_session';
  @IsOptional() @IsInt() @Min(1) field_id?: number;
  /** المعامل بدقة 4 خانات عشرية كحد أقصى، يوصل كنص أو رقم */
  @Matches(/^(?!0+(\.0+)?$)\d{1,10}(\.\d{1,4})?$/, { message: 'المعامل رقم موجب بحد أقصى 4 خانات عشرية' }) factor: string;
}

export class SetMaterialsDto {
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => MaterialLinkDto) items: MaterialLinkDto[];
}

export class QuoteDto {
  @IsObject() values: Record<string, unknown>;
  @IsOptional() @IsString() at?: string;
}
