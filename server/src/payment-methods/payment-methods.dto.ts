import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class CreatePaymentMethodDto {
  @IsString() @Length(2, 60) name_ar: string;
  @IsOptional() @IsString() @MaxLength(60) name_en?: string;
  /** اسم الجهاز أو المصرف: إلزامي لأن كشف كل جهاز يتطابق لحاله بتسليم الشفت */
  @IsString() @Length(1, 60) device_label: string;
  @IsOptional() branch_id?: number;
}

export class UpdatePaymentMethodDto {
  @IsOptional() @IsString() @Length(2, 60) name_ar?: string;
  @IsOptional() @IsString() @MaxLength(60) name_en?: string;
  @IsOptional() @IsString() @Length(1, 60) device_label?: string;
}

export class MoveDto {
  @IsIn(['up', 'down']) direction: 'up' | 'down';
}
