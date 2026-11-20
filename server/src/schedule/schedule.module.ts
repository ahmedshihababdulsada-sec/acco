import { Global, Module } from '@nestjs/common';
import { ScheduleController } from './schedule.controller';
import { ScheduleService } from './schedule.service';

@Global()
@Module({ controllers: [ScheduleController], providers: [ScheduleService], exports: [ScheduleService] })
export class ScheduleModule {}
