import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { DbService } from '../db/db.service';
import { Errors } from '../common/errors';
import { ALLOW_PASSWORD_CHANGE, IS_PUBLIC, REQUIRED_PERMISSIONS } from './decorators';
import { AccessPayload, AuthedRequest } from './auth.types';
import { Permission, can } from './permissions';
import { CustomerRequest } from '../customer-app/current-customer';

/**
 * حارس عام على كل المسارات. يتحقق من التوكن، وبعدين يقرأ المستخدم من القاعدة بكل طلب
 * (حتى التعطيل وتغيير الدور يسري فوراً مو بعد انتهاء التوكن)، ويفحص الصلاحية المطلوبة.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly jwt: JwtService, private readonly db: DbService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw Errors.unauthorized();

    let payload: AccessPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessPayload>(header.slice(7), { algorithms: ['HS256'] });
    } catch {
      throw Errors.unauthorized();
    }
    if (payload.typ === 'customer') return this.customerAccess(req as unknown as CustomerRequest, payload, ctx, targets);
    if (payload.typ !== 'access') throw Errors.unauthorized();

    const { rows } = await this.db.query(
      `select id, username, role, branch_id, is_active, must_change_password from users where id = $1`, [payload.sub]);
    const u = rows[0];
    if (!u || !u.is_active) throw Errors.unauthorized();

    req.user = {
      id: Number(u.id), username: u.username, role: u.role,
      branchId: u.branch_id === null ? null : Number(u.branch_id),
      mustChangePassword: u.must_change_password,
    };

    if (req.user.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE, targets)) {
      throw Errors.passwordChangeRequired();
    }

    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(REQUIRED_PERMISSIONS, targets);
    if (required && !required.some((p) => can(req.user.role, p))) throw Errors.forbidden();
    return true;
  }

  /**
   * توكن الزبون (تطبيق الزبون): يتحقق من الزبون بكل طلب (حذف الحساب يوقف الدخول فوراً)، ومسارات الموظفين تنرفض 403
   * لأن الزبون ما عنده غير صلاحيات الزبون. المسار بدون @Require ينرفض للزبون (الافتراضي منع).
   */
  private async customerAccess(req: CustomerRequest, payload: AccessPayload, ctx: ExecutionContext, targets: unknown[]): Promise<boolean> {
    const { rows } = await this.db.query(`select id, branch_id, status, app_registered_at, app_deleted_at from customers where id = $1`, [payload.sub]);
    const c = rows[0];
    if (!c || c.status !== 'active' || !c.app_registered_at || c.app_deleted_at) throw Errors.unauthorized();
    req.customer = { id: Number(c.id), branchId: Number(c.branch_id) };
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(REQUIRED_PERMISSIONS, targets as never);
    if (!required || !required.some((p) => can('customer', p))) throw Errors.forbidden();
    void ctx;
    return true;
  }
}
