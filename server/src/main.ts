import 'reflect-metadata';
import { createApp } from './app.factory';
import { loadConfig } from './config/config';

async function bootstrap() {
  const cfg = loadConfig();
  const app = await createApp();
  await app.listen(cfg.port, '0.0.0.0');
}
bootstrap().catch((err) => { console.error(err); process.exit(1); });
