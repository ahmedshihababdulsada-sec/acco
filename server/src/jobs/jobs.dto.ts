import { IsInt, IsOptional } from 'class-validator';

export class RunJobsDto {
  /** تشغيل لفرع واحد (افتراضياً كل الفروع) */
  @IsOptional() @IsInt() branch_id?: number;
}
