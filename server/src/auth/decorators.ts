import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Permission } from './permissions';
import { AuthedRequest } from './auth.types';

export const IS_PUBLIC = 'isPublic';
export const REQUIRED_PERMISSIONS = 'requiredPermissions';
export const ALLOW_PASSWORD_CHANGE = 'allowPasswordChange';

/** مسار بدون تسجيل دخول (تسجيل الدخول، التجديد، الصحة). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** يتطلب واحدة من الصلاحيات المذكورة (أي موظف مسجل ما عنده صلاحية → 403). */
export const Require = (...permissions: Permission[]) => SetMetadata(REQUIRED_PERMISSIONS, permissions);
/** مسارات تنفتح حتى لو الموظف لازم يغيّر رمزه (تغيير الرمز، الخروج، من أنا). */
export const AllowPasswordChange = () => SetMetadata(ALLOW_PASSWORD_CHANGE, true);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) =>
  ctx.switchToHttp().getRequest<AuthedRequest>().user);
