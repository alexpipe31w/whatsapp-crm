import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import compression from 'compression';
import helmet from 'helmet';
import { PrismaService } from './prisma/prisma.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Seguridad: cabeceras HTTP hardening
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
  }));

  // Compresión gzip — reduce payload hasta 70% en respuestas JSON
  app.use(compression());

  app.enableCors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    credentials: false,
  });

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));

  app.setGlobalPrefix('api');

  // Health check fuera del prefijo /api — para Render/Railway uptime checks
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
