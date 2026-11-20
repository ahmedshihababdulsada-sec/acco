import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { PhotosController } from './photos.controller';
import { PhotosService } from './photos.service';

@Module({ imports: [AttachmentsModule], controllers: [PhotosController], providers: [PhotosService] })
export class PhotosModule {}
