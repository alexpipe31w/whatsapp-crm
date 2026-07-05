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
  `ALTER TABLE stores ADD COLUMN IF NOT EXISTS default_service_id TEXT`,
  `ALTER TABLE stores ADD COLUMN IF NOT EXISTS auto_confirm_appointments BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS stockup_product_id VARCHAR(50)`,
  `ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS stockup_variant_id VARCHAR(50)`,
  `ALTER TABLE categories ADD COLUMN IF NOT EXISTS stockup_category_id VARCHAR(50)`,
  `CREATE TABLE IF NOT EXISTS stockup_connections (
     connection_id TEXT PRIMARY KEY,
     store_id TEXT UNIQUE NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
     stockup_tenant_id VARCHAR(50),
     secret VARCHAR(200),
     enabled BOOLEAN NOT NULL DEFAULT false,
     link_code VARCHAR(20),
     link_code_expires_at TIMESTAMP,
     last_sync_at TIMESTAMP,
     created_at TIMESTAMP NOT NULL DEFAULT now(),
     updated_at TIMESTAMP NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS sync_outbox (
     id TEXT PRIMARY KEY,
     store_id TEXT NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
     event_id TEXT UNIQUE NOT NULL,
     type VARCHAR(40) NOT NULL,
     payload JSONB NOT NULL,
     status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
     attempts INT NOT NULL DEFAULT 0,
     next_retry_at TIMESTAMP NOT NULL DEFAULT now(),
     occurred_at TIMESTAMP NOT NULL DEFAULT now(),
     created_at TIMESTAMP NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS sync_outbox_status_retry ON sync_outbox (status, next_retry_at)`,
  `CREATE TABLE IF NOT EXISTS sync_inbox (
     event_id TEXT PRIMARY KEY,
     processed_at TIMESTAMP NOT NULL DEFAULT now()
   )`,
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
