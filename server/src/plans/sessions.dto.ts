import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { DATE_RE } from '../schedule/schedule.dto';

const DATE_MSG = { message: 'التاريخ بصيغة YYYY-MM-DD' };

export class MoveSessionDto {
  @Matches(DATE_RE, DATE_MSG) date: string;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class BookSessionDto {
  /** أبكر يوم مقبول: النظام يحجز أقرب يوم صالح من هذا التاريخ (والباقي يتحجز بعده بالفرق) */
  @Matches(DATE_RE, DATE_MSG) date: string;
}
