import { HttpException } from '@nestjs/common';

/** كل أخطاء الـ API بنفس الشكل: { code, message } والرمز ثابت للواجهة والرسالة عربية للمستخدم. */
export function apiError(status: number, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

export const Errors = {
  invalidCredentials: () => apiError(401, 'INVALID_CREDENTIALS', 'اسم المستخدم أو الرمز السري غير صحيح، أو الحساب مقفل مؤقتاً'),
  unauthorized: () => apiError(401, 'UNAUTHORIZED', 'سجّل الدخول من جديد'),
  forbidden: () => apiError(403, 'FORBIDDEN', 'ما عندك صلاحية لهذا الإجراء'),
  passwordChangeRequired: () => apiError(403, 'PASSWORD_CHANGE_REQUIRED', 'لازم تغيّر رمزك السري أول'),
  notFound: (what = 'السجل') => apiError(404, 'NOT_FOUND', `${what} غير موجود`),
  conflict: (code: string, message: string) => apiError(409, code, message),
  /** 409 مع حقول إضافية للواجهة (مثل اقتراح يوم بديل) */
  conflictWith: (code: string, message: string, extra: object) => new HttpException({ code, message, ...extra }, 409),
  badRequest: (code: string, message: string) => apiError(400, code, message),
};
