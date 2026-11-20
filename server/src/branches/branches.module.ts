import { Controller, Get, Module } from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, Require } from '../auth/decorators';
import { DbService } from '../db/db.service';

/** فروع المستخدم: المالك كل الفروع الفعالة (يختار منها بالتقارير والإعدادات)، والمدير فرعه فقط. */
@Controller('branches')
export class BranchesController {
  constructor(private readonly db: DbService) {}

  @Get() @Require('settings.read')
  async list(@CurrentUser() u: AuthUser) {
    const { rows } = await this.db.query(`select id, code, name from branches where is_active and ($1::bigint is null or id = $1) order by id`, [u.role === 'owner' ? null : u.branchId]);
    return { branches: rows.map((r) => ({ id: Number(r.id), code: r.code as string, name: r.name as string })) };
  }
}

@Module({ controllers: [BranchesController] })
export class BranchesModule {}
