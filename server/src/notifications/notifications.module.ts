import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { LogPushSender, PUSH_SENDER } from './push-sender';

@Module({ providers: [NotificationsService, { provide: PUSH_SENDER, useClass: LogPushSender }], exports: [NotificationsService, PUSH_SENDER] })
export class NotificationsModule {}
