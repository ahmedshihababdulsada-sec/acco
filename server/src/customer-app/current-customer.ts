import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

/** هوية الزبون المسجل دخوله بالتطبيق (يضبطها الحارس من التوكن) */
export interface CustomerPrincipal { id: number; branchId: number }
export interface CustomerRequest extends Request { customer?: CustomerPrincipal }

export const CurrentCustomer = createParamDecorator((_: unknown, ctx: ExecutionContext): CustomerPrincipal => ctx.switchToHttp().getRequest<CustomerRequest>().customer!);
