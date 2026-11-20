import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Require } from '../auth/decorators';
import { Errors } from '../common/errors';
import { RunJobsDto } from './jobs.dto';
import { JobsService } from './jobs.service';

@Controller('jobs')
export class JobsController {
  constructor(private readonly svc: JobsService) {}

  /** تشغيل دورة المهام يدوياً (المالك): إقفال الأيام، الرواتب المستحقة، وطوابير الإشعارات. آمنة لو انعادت. */
  @Post('run') @HttpCode(200) @Require('jobs.run')
  async run(@Body() body: RunJobsDto) {
    const r = await this.svc.tick(body?.branch_id);
    if (!r) throw Errors.conflict('JOBS_BUSY', 'دورة ثانية شغالة هسه: جرب بعد شوي');
    return r;
  }
}
