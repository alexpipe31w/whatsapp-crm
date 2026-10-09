import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { PrismaService } from './prisma/prisma.service';

async function bootstrap() {
  // rawBody: necesario para verificar firmas HMAC del sync StockUp (integrations)
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app);

  // Health check fuera del prefijo /api — para uptime checks
  const httpAdapter = app.getHttpAdapter();
  const prisma = app.get(PrismaService);

  httpAdapter.get('/health', async (_req: any, res: any) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.status(200).json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'error', db: 'disconnected', ts: new Date().toISOString() });
    }
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  Logger.log(`🚀 Server running on port ${port}`);
}
bootstrap();
