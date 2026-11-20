import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { CatalogModule } from '../catalog/catalog.module';
import { DoctorsModule } from '../doctors/doctors.module';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({ imports: [CatalogModule, BookingsModule, DoctorsModule], controllers: [PlansController, SessionsController], providers: [PlansService, SessionsService], exports: [PlansService, SessionsService] })
export class PlansModule {}
