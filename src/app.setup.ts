import { INestApplication, ValidationPipe } from '@nestjs/common';
import compression from 'compression';
import helmet from 'helmet';

/**
 * Configuración HTTP común a producción y tests: si los tests no pasaran por
 * aquí, probarían una app con otro CORS, otra validación y sin el prefijo /api.
 */
export function configureApp(app: INestApplication): void {
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
  }));

  app.use(compression());

  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['http://localhost:3000', 'http://localhost:3001'];

  // Capacitor: Android usa https://localhost, iOS capacitor://localhost
  const capacitorOrigins = ['https://localhost', 'capacitor://localhost', 'ionic://localhost'];

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (capacitorOrigins.includes(origin)) return callback(null, true);
      if (allowedOrigins.some(o => o === '*' || origin === o)) return callback(null, true);
      callback(new Error(`CORS: origen no permitido: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id'],
  });

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));

  app.setGlobalPrefix('api');
}
