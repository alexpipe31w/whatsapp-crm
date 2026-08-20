import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../generated/prisma/client';

// Migraciones aditivas seguras que se corren en cada arranque.
// Solo operaciones idempotentes y no destructivas: ADD COLUMN / CREATE TABLE IF NOT
// EXISTS, y UPDATEs de saneamiento acotados que dejan de matchear tras la 1ª pasada.
const STARTUP_MIGRATIONS = [
  `ALTER TABLE staff ADD COLUMN IF NOT EXISTS commission_percentage DOUBLE PRECISION`,
  `ALTER TABLE staff ADD COLUMN IF NOT EXISTS suspended_from TIMESTAMP`,
  `ALTER TABLE staff ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMP`,
  `ALTER TABLE stores ADD COLUMN IF NOT EXISTS default_service_id TEXT`,
  `ALTER TABLE stores ADD COLUMN IF NOT EXISTS auto_confirm_appointments BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS stockup_product_id VARCHAR(50)`,
  `ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS stockup_variant_id VARCHAR(50)`,
  `ALTER TABLE categories ADD COLUMN IF NOT EXISTS stockup_category_id VARCHAR(50)`,
  // orden evento-contra-evento del receptor (A6): occurredAt del último evento
  // StockUp aplicado, NUNCA comparar contra updatedAt local (colapsa backlogs).
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS stockup_synced_at TIMESTAMP`,
  `ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS stockup_synced_at TIMESTAMP`,
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
  // Saneamiento de modelos de IA muertos. Groq decomisionó la familia llama y Google
  // capó gemini 2.0/1.5 (ver DEAD_GROQ_MODEL_RE / DEAD_GEMINI_MODEL_RE en providers.ts).
  // El pool ya normaliza en memoria, pero la BD seguiría mostrando el modelo muerto en el
  // panel y sirviéndoselo a analytics. Idempotente: tras la primera pasada el WHERE deja
  // de matchear, así que en arranques siguientes son no-ops sin escrituras.
  `ALTER TABLE ai_configurations ALTER COLUMN model SET DEFAULT 'openai/gpt-oss-120b'`,
  `UPDATE ai_configurations
      SET model = 'openai/gpt-oss-120b'
    WHERE ai_provider = 'groq'
      AND model ~* '^(llama[-0-9]|meta-llama/llama-[34]|mixtral|gemma)'`,
  `UPDATE ai_configurations
      SET model = 'gemini-2.5-flash'
    WHERE ai_provider = 'gemini'
      AND model ~* '^gemini-(2[.]0|1[.]5|1[.]0|pro)'`,
  `UPDATE ai_configurations
      SET cartridges = (
            SELECT jsonb_agg(
                     CASE WHEN c->>'provider' = 'groq'   AND c->>'model' ~* '^(llama[-0-9]|meta-llama/llama-[34]|mixtral|gemma)'
                          THEN jsonb_set(c, '{model}', to_jsonb('openai/gpt-oss-120b'::text))
                          WHEN c->>'provider' = 'gemini' AND c->>'model' ~* '^gemini-(2[.]0|1[.]5|1[.]0|pro)'
                          THEN jsonb_set(c, '{model}', to_jsonb('gemini-2.5-flash'::text))
                          ELSE c END
                     ORDER BY ord)
              FROM jsonb_array_elements(cartridges) WITH ORDINALITY AS t(c, ord)
          )
    WHERE jsonb_typeof(cartridges) = 'array'
      AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(cartridges) AS c
             WHERE (c->>'provider' = 'groq'   AND c->>'model' ~* '^(llama[-0-9]|meta-llama/llama-[34]|mixtral|gemma)')
                OR (c->>'provider' = 'gemini' AND c->>'model' ~* '^gemini-(2[.]0|1[.]5|1[.]0|pro)')
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
