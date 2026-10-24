import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: the WhatsApp webhook verifies Meta's X-Hub-Signature-256 over the exact bytes received.
  const app = await NestFactory.create(AppModule, { rawBody: true, logger: ['log', 'warn', 'error'] });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`darija-receptionist-api listening on :${port}`);
}
bootstrap();
