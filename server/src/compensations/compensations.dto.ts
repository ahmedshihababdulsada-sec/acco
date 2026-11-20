import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { DATE_RE } from '../schedule/schedule.dto';

export class CreateCompensationDto {
  @IsInt() session_id: number;
  @IsInt() @Min(1) @Max(1_000_000_000) amount: number;
  @IsString() @MaxLength(500) reason: string;
  @IsIn(['safe', 'electronic']) pay_source: 'safe' | 'electronic';
  @IsOptional() @IsString() @MaxLength(80) bank_name?: string;
}

export class ListCompensationsQuery {
  @IsOptional() @IsString() branch_id?: string;
  @IsOptional() @Matches(DATE_RE, { message: 'التاريخ بصيغة YYYY-MM-DD' }) from?: string;
  @IsOptional() @Matches(DATE_RE, { message: 'التاريخ بصيغة YYYY-MM-DD' }) to?: string;
}
