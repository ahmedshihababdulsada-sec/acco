import { Module } from '@nestjs/common';
import { SafeService } from './safe.service';
import { ShiftsController } from './shifts.controller';
import { ShiftsService } from './shifts.service';

@Module({ controllers: [ShiftsController], providers: [ShiftsService, SafeService], exports: [ShiftsService, SafeService] })
export class ShiftsModule {}
