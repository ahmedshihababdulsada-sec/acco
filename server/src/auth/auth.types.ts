import { Request } from 'express';
import { StaffRole } from './permissions';

export interface AuthUser {
  id: number;
  username: string;
  role: StaffRole;
  branchId: number | null;   // null للمالك (كل الفروع)
  mustChangePassword: boolean;
}

export interface AuthedRequest extends Request {
  user: AuthUser;
}

export interface AccessPayload {
  typ: 'access' | 'customer';          // يمنع قبول توكن التحدي (TOTP) كتوكن وصول؛ 'customer' توكن تطبيق الزبون
  sub: number;
  role: StaffRole | 'customer';
}
