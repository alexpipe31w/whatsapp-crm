-- AlterTable customers
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "cedula" VARCHAR(20);
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable orders
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable products
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable (solo si no existe)
CREATE TABLE IF NOT EXISTS "appointments" (
    "appointment_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'cita',
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "address" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "appointments_pkey" PRIMARY KEY ("appointment_id")
);

-- Indexes
CREATE INDEX IF NOT EXISTS "appointments_store_id_scheduled_at_idx" ON "appointments"("store_id", "scheduled_at");
CREATE INDEX IF NOT EXISTS "appointments_store_id_status_idx" ON "appointments"("store_id", "status");
CREATE INDEX IF NOT EXISTS "appointments_customer_id_idx" ON "appointments"("customer_id");
CREATE INDEX IF NOT EXISTS "conversations_store_id_status_idx" ON "conversations"("store_id", "status");
CREATE INDEX IF NOT EXISTS "conversations_customer_id_status_idx" ON "conversations"("customer_id", "status");
CREATE INDEX IF NOT EXISTS "customers_store_id_created_at_idx" ON "customers"("store_id", "created_at");
CREATE INDEX IF NOT EXISTS "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");
CREATE INDEX IF NOT EXISTS "messages_store_id_created_at_idx" ON "messages"("store_id", "created_at");
CREATE INDEX IF NOT EXISTS "orders_store_id_status_idx" ON "orders"("store_id", "status");
CREATE INDEX IF NOT EXISTS "orders_store_id_created_at_idx" ON "orders"("store_id", "created_at");
CREATE INDEX IF NOT EXISTS "products_store_id_is_active_idx" ON "products"("store_id", "is_active");

-- Foreign Keys (solo si no existen)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointments_store_id_fkey'
  ) THEN
    ALTER TABLE "appointments" ADD CONSTRAINT "appointments_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointments_customer_id_fkey'
  ) THEN
    ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;