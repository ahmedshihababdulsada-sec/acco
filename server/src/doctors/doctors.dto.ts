import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class HealthRecordDto {
  @IsOptional() @IsString() @MaxLength(500) allergies?: string;
  @IsOptional() @IsIn(['no', 'yes', 'unknown']) pregnancy?: 'no' | 'yes' | 'unknown';
  @IsOptional() @IsString() @MaxLength(500) chronic_conditions?: string;
  @IsOptional() @IsString() @MaxLength(500) medications?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class QueueQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'التاريخ بصيغة YYYY-MM-DD' }) date?: string;
}
