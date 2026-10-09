-- Alinea producción con schema.prisma (diferencias que dejaron las antiguas
-- STARTUP_MIGRATIONS, detectadas con `prisma migrate diff` contra producción el
-- 2026-10-10). No borra datos: precisión de TIMESTAMP 6 -> 3 (recorta microsegundos),
-- ON UPDATE CASCADE en dos claves foráneas y sin DEFAULT en updated_at (lo pone Prisma).
-- En una BD creada desde cero con la migración consolidada no cambia nada.
-- DropForeignKey
ALTER TABLE "stockup_connections" DROP CONSTRAINT "stockup_connections_store_id_fkey";

-- DropForeignKey
ALTER TABLE "sync_outbox" DROP CONSTRAINT "sync_outbox_store_id_fkey";

-- AlterTable
ALTER TABLE "product_variants" ALTER COLUMN "stockup_synced_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "products" ALTER COLUMN "stockup_synced_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "staff" ALTER COLUMN "suspended_from" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "suspended_until" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "stockup_connections" ALTER COLUMN "link_code_expires_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "last_sync_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "sync_inbox" ALTER COLUMN "processed_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "sync_outbox" ALTER COLUMN "next_retry_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "occurred_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "stockup_connections" ADD CONSTRAINT "stockup_connections_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_outbox" ADD CONSTRAINT "sync_outbox_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;

