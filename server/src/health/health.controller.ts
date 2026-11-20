import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/decorators';
import { DbService } from '../db/db.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DbService) {}

  /** للمراقبة ولموازن التحميل: يتأكد إن القاعدة تستجيب. ما يطلع أي بيانات حساسة. */
  @Public() @Get()
  async check() {
    try { await this.db.query('select 1'); } catch { throw new ServiceUnavailableException({ code: 'DB_DOWN', message: 'قاعدة البيانات لا تستجيب' }); }
    return { status: 'ok' };
  }
}
