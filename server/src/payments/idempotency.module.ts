import { Global, Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';

/** مفتاح منع التكرار خدمة مشتركة (الدفع، الاسترجاع، تأكيد الممرض...) */
@Global()
@Module({ providers: [IdempotencyService], exports: [IdempotencyService] })
export class IdempotencyModule {}
