import { IsIn, IsInt, IsOptional, IsString, Length, MaxLength, Matches } from 'class-validator';

export class CreateStaffDto {
  @IsString() @Length(3, 50) @Matches(/^[A-Za-z0-9._-]+$/, { message: 'اسم المستخدم حروف إنجليزية وأرقام ونقطة وشرطة فقط' })
  username: string;

  @IsString() @Length(2, 120) full_name: string;

  @IsOptional() @IsString() @MaxLength(30) phone?: string;

  @IsIn(['manager', 'cashier', 'doctor', 'nurse']) role: 'manager' | 'cashier' | 'doctor' | 'nurse';

  /** المالك يحدد الفرع، والمدير ينضاف دائماً لفرعه. */
  @IsOptional() @IsInt() branch_id?: number;

  @IsOptional() @IsString() @MaxLength(100) title?: string;   // للطبيب
  @IsOptional() @IsString() @MaxLength(50) room?: string;     // للطبيب
}

export class ReasonDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
