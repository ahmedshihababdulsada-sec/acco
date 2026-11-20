import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { CurrentUser, Require } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { AttachmentsService, UploadedFile as UFile } from './attachments.service';

@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly svc: AttachmentsService) {}

  /** multipart: الحقل file، وحقل kind (expense_proof | purchase_receipt | supplier_payment_proof | logo)، وbranch_id للمالك */
  @Post() @Require('expenses.record')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? 8 * 1024 * 1024), files: 1 } }))
  upload(@CurrentUser() u: AuthUser, @UploadedFile() file: UFile | undefined, @Body() body: { kind?: string; branch_id?: string }, @Req() r: Request) {
    const b = body?.branch_id === undefined || body.branch_id === '' ? undefined : Number(body.branch_id);
    return this.svc.upload(u, file, String(body?.kind ?? ''), b, r.ip ?? null);
  }

  /** شعار الوصل الحالي: الكاشير (يطبع) والمدير والمالك. لازم قبل :id */
  @Get('logo/current') @Require('payments.take', 'settings.receipt_and_methods')
  async logo(@CurrentUser() u: AuthUser, @Query('branch_id') b: string | undefined, @Res() res: Response) {
    const f = await this.svc.openLogo(u, b === undefined || b === '' ? undefined : Number(b));
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Length', String(f.size));
    res.setHeader('Cache-Control', 'private, no-store');
    f.stream.on('error', () => res.destroy());
    f.stream.pipe(res);
  }

  @Get(':id') @Require('expenses.record')
  async get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const f = await this.svc.open(u, id);
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Length', String(f.size));
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-store');
    f.stream.on('error', () => res.destroy());
    f.stream.pipe(res);
  }
}
