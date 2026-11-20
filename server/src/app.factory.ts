import { INestApplication, ValidationError, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { apiError } from './common/errors';

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: process.env.NODE_ENV === 'test' ? false : undefined });
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use(helmet());
  // CORS لتطبيق الويب (Flutter web) أو أدوات التطوير: يُفعّل بالقائمة فقط (CORS_ORIGINS=https://a.com,https://b.com). التطبيقات الأصلية (iOS/Android/Windows) ما تحتاجه.
  const origins = (process.env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  if (origins.length) app.enableCors({ origin: origins, allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'], exposedHeaders: ['Content-Disposition'], maxAge: 600 });
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors: ValidationError[]) =>
      apiError(400, 'VALIDATION', errors.flatMap((e) => Object.values(e.constraints ?? {})).join('، ') || 'بيانات غير صحيحة'),
  }));
  app.enableShutdownHooks();
  return app;
}
