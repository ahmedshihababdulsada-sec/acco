import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AttachmentsModule } from './attachments/attachments.module';
import { PhotosModule } from './photos/photos.module';
import { OpsModule } from './ops/ops.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BookingsModule } from './bookings/bookings.module';
import { CatalogModule } from './catalog/catalog.module';
import { CustomersModule } from './customers/customers.module';
import { DbModule } from './db/db.module';
import { DoctorsModule } from './doctors/doctors.module';
import { ExpensesModule } from './expenses/expenses.module';
import { HealthController } from './health/health.controller';
import { IdempotencyModule } from './payments/idempotency.module';
import { DiscountsModule } from './discounts/discounts.module';
import { OffersModule } from './offers/offers.module';
import { CompensationsModule } from './compensations/compensations.module';
import { BranchesModule } from './branches/branches.module';
import { CustomerAppModule } from './customer-app/customer-app.module';
import { ReportsModule } from './reports/reports.module';
import { JobsModule } from './jobs/jobs.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PayrollModule } from './payroll/payroll.module';
import { NurseModule } from './nurse/nurse.module';
import { PaymentMethodsModule } from './payment-methods/payment-methods.module';
import { PaymentsModule } from './payments/payments.module';
import { PlansModule } from './plans/plans.module';
import { ScheduleModule } from './schedule/schedule.module';
import { SettingsModule } from './settings/settings.module';
import { ShiftsModule } from './shifts/shifts.module';
import { StaffModule } from './staff/staff.module';
import { StockModule } from './stock/stock.module';
import { SuppliersModule } from './suppliers/suppliers.module';

@Module({
  imports: [
    DbModule,
    AuditModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: Number(process.env.GLOBAL_RATE_LIMIT ?? 300) }]),
    AuthModule,
    StaffModule,
    SettingsModule,
    PaymentMethodsModule,
    CatalogModule,
    ScheduleModule,
    CustomersModule,
    BookingsModule,
    ShiftsModule,
    IdempotencyModule,
    PaymentsModule,
    NurseModule,
    DiscountsModule,
    OffersModule,
    NotificationsModule,
    PayrollModule,
    JobsModule,
    CustomerAppModule,
    CompensationsModule,
    ReportsModule,
    BranchesModule,
    AttachmentsModule,
    PhotosModule,
    OpsModule,
    ExpensesModule,
    StockModule,
    SuppliersModule,
    DoctorsModule,
    PlansModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
