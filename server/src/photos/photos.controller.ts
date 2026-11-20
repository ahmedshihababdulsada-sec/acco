import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, Require } from '../auth/decorators';
import { UploadedFile as UFile } from '../attachments/attachments.service';
import { PhotosService, UploadPhotoInput } from './photos.service';

@Controller()
export class PhotosController {
  constructor(private readonly svc: PhotosService) {}

  /** multipart: file + phase (before|after) + (session_id | consultation_id) + body_area اختياري. الطبيب والممرض. */
  @Post('photos') @Require('photos.upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? 8 * 1024 * 1024), files: 1 } }))
  upload(@CurrentUser() u: AuthUser, @UploadedFile() file: UFile | undefined, @Body() body: UploadPhotoInput, @Req() r: Request) { return this.svc.upload(u, file, body ?? {}, r.ip ?? null); }

  @Get('customers/:id/photos') @Require('photos.view')
  list(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.svc.list(u, id); }

  @Get('photos/:id') @Require('photos.view')
  async file(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const f = await this.svc.open(u, id);
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Length', String(f.size));
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-store');
    f.stream.on('error', () => res.destroy());
    f.stream.pipe(res);
  }

  @Post('photos/:id/delete') @HttpCode(200) @Require('photos.delete')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() body: { reason?: string }, @Req() r: Request) { return this.svc.remove(u, id, body?.reason, r.ip ?? null); }
}
