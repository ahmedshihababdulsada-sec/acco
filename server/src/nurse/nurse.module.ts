import { Module } from '@nestjs/common';
import { NurseController } from './nurse.controller';
import { NurseService } from './nurse.service';
import { RatingsService } from './ratings.service';

@Module({ controllers: [NurseController], providers: [NurseService, RatingsService], exports: [NurseService, RatingsService] })
export class NurseModule {}
