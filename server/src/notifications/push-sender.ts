export interface PushTarget { token: string; platform: 'ios' | 'android' }
export interface PushMessage { title: string; body: string; data?: Record<string, unknown> }

/**
 * إرسال الإشعارات الفورية (Push). النسخة الأولى تسجل بس (بدون إرسال خارجي)، وربط Firebase (FCM) يتم عند التنصيب
 * بإضافة تنفيذ ثاني لنفس الواجهة وربطه بـ PUSH_SENDER. الإشعار المجاني (بدون واتساب/SMS) حسب الخطة القسم 13.
 */
export interface PushSender { send(targets: PushTarget[], msg: PushMessage): Promise<void> }
export const PUSH_SENDER = Symbol('PUSH_SENDER');

export class LogPushSender implements PushSender {
  readonly sent: { targets: PushTarget[]; msg: PushMessage }[] = [];
  async send(targets: PushTarget[], msg: PushMessage): Promise<void> { this.sent.push({ targets, msg }); if (this.sent.length > 1000) this.sent.shift(); }
}
