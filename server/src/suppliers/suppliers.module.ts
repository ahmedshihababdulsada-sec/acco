import { Module } from '@nestjs/common';
import { PurchasesService } from './purchases.service';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

@Module({ controllers: [SuppliersController], providers: [SuppliersService, PurchasesService], exports: [SuppliersService, PurchasesService] })
export class SuppliersModule {}
