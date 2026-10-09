import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../generated/prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly pool: Pool;

  constructor() {
    // Pool de conexiones — Render Starter tiene límites, max 10 evita saturar
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL as string,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    const adapter = new PrismaPg(pool);
    super({ adapter });
    this.pool = pool;
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Conectado a la base de datos');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    // El adaptador no cierra el pool que le pasamos: sin esto las conexiones ociosas
    // sobreviven 30 s al apagado (cuelga Jest y retrasa el cierre del proceso).
    await this.pool.end().catch(() => undefined);
    this.logger.log('Desconectado de la base de datos');
  }
}
