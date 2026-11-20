import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { BookingsModule } from '../bookings/bookings.module';
import { DiscountsModule } from '../discounts/discounts.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PayrollModule } from '../payroll/payroll.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

@Module({ imports: [AttachmentsModule, BookingsModule, DiscountsModule, NotificationsModule, PayrollModule], controllers: [JobsController], providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
