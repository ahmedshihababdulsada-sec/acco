import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module';
import { DiscountsController } from './discounts.controller';
import { DiscountsService } from './discounts.service';

@Module({ imports: [PlansModule], controllers: [DiscountsController], providers: [DiscountsService], exports: [DiscountsService] })
export class DiscountsModule {}
