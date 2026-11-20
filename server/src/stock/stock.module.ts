import { Module } from '@nestjs/common';
import { AlertsService } from './alerts.service';
import { CountsService } from './counts.service';
import { MaterialsController } from './materials.controller';
import { MaterialsService } from './materials.service';
import { StockOpsController } from './stock-ops.controller';
import { WasteService } from './waste.service';

@Module({ controllers: [MaterialsController, StockOpsController], providers: [MaterialsService, WasteService, CountsService, AlertsService], exports: [MaterialsService, WasteService, CountsService] })
export class StockModule {}
