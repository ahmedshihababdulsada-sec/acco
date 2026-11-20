import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNumber, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

const QTY = { maxDecimalPlaces: 3, allowNaN: false, allowInfinity: false };

export class RevertConfirmationDto {
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class ExtraUseItemDto {
  @IsInt() material_id: number;
  @IsNumber(QTY) @Min(0.001) @Max(1_000_000) qty: number;
}

export class ExtraUsageDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => ExtraUseItemDto) items: ExtraUseItemDto[];
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}
