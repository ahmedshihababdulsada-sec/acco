import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { PlansModule } from '../plans/plans.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';

@Module({ imports: [PlansModule, BookingsModule], controllers: [PaymentsController], providers: [PaymentsService, RefundsService], exports: [PaymentsService] })
export class PaymentsModule {}
