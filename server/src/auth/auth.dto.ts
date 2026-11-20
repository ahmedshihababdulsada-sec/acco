import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class LoginDto {
  @IsString() @Length(1, 100) username: string;
  @IsString() @Length(1, 200) password: string;
  @IsOptional() @IsString() @MaxLength(200) device?: string;
}

export class RefreshDto {
  @IsString() @Length(20, 200) refresh_token: string;
}

export class ChangePasswordDto {
  @IsString() @Length(1, 200) current_password: string;
  @IsString() @Length(1, 200) new_password: string;
}

export class TotpSetupDto {
  @IsString() @Length(20, 2000) challenge_token: string;
}

export class TotpEnableDto {
  @IsString() @Length(20, 2000) challenge_token: string;
  @IsString() @Length(6, 8) code: string;
  @IsOptional() @IsString() @MaxLength(200) device?: string;
}

export class TotpVerifyDto {
  @IsString() @Length(20, 2000) challenge_token: string;
  @IsOptional() @IsString() @Length(6, 8) code?: string;
  @IsOptional() @IsString() @Length(8, 20) recovery_code?: string;
  @IsOptional() @IsString() @MaxLength(200) device?: string;
}
