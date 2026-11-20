import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { DATE_RE } from '../schedule/schedule.dto';

const DATE_MSG = { message: 'التاريخ بصيغة YYYY-MM-DD' };

export class CreateCustomerDto {
  @IsString() @MinLength(2) @MaxLength(100) full_name: string;
  @IsString() @MaxLength(30) phone: string;
  @IsOptional() @IsIn(['female', 'male']) gender?: 'female' | 'male';
  @IsOptional() @Matches(DATE_RE, DATE_MSG) birth_date?: string;
  @IsOptional() @IsInt() branch_id?: number;
}

export class UpdateCustomerDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) full_name?: string;
  @IsOptional() @IsIn(['female', 'male']) gender?: 'female' | 'male';
  @IsOptional() @Matches(DATE_RE, DATE_MSG) birth_date?: string;
  @IsOptional() @IsBoolean() notify_offers?: boolean;
}

export class ChangePhoneDto {
  @IsString() @MaxLength(30) phone: string;
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class MergeCustomersDto {
  /** الملف اللي يبقى (الملف المكرر هو اللي بالمسار) */
  @IsInt() into_id: number;
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
}
