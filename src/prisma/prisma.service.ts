import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../generated/prisma/client';

// Migraciones aditivas seguras que se corren en cada arranque.
// Solo operaciones ADD COLUMN IF NOT EXISTS — idempotentes, nunca destruyen datos.
const STARTUP_MIGRATIONS = [
  `ALTER TABLE staff ADD COLUMN IF NOT EXISTS commission_percentage DOUBLE PRECISION`,
  `ALTER TABLE staff ADD COLUMN IF NOT EXISTS suspended_from TIMESTAMP`,
  `ALTER TABLE staff ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMP`,
];

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

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
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Conectado a la base de datos');
    await this.runStartupMigrations();
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Desconectado de la base de datos');
  }

  private async runStartupMigrations() {
    for (const sql of STARTUP_MIGRATIONS) {
      try {
        await this.$executeRawUnsafe(sql);
        this.logger.log(`[Migration] OK: ${sql.slice(0, 60)}...`);
      } catch (err: any) {
        this.logger.error(`[Migration] Error en migración: ${err.message}`);
      }
    }
  }
}
