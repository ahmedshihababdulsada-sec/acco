import { Controller, Get } from '@nestjs/common';
import { Require } from '../auth/decorators';
import { OpsService } from './ops.service';

@Controller('ops')
export class OpsController {
  constructor(private readonly svc: OpsService) {}
  /** صحة النسخ الاحتياطي: المالك فقط */
  @Get('backup-status') @Require('reports.all')
  status() { return this.svc.backupStatus(); }
}
