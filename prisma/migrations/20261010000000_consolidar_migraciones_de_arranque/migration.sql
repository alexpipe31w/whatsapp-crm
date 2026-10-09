-- Consolida lo que hasta 2026-10-10 aplicaban las STARTUP_MIGRATIONS de
-- src/prisma/prisma.service.ts. En producción estas columnas/tablas YA existen:
-- allí esta migración se marca como aplicada con `prisma migrate resolve --applied`
-- (ver scripts/deploy-pod.sh), nunca se ejecuta.

-- AlterTable
ALTER TABLE "ai_configurations" ADD COLUMN     "ai_provider" TEXT NOT NULL DEFAULT 'groq',
ADD COLUMN     "cartridges" JSONB,
ALTER COLUMN "model" SET DEFAULT 'openai/gpt-oss-120b',
ALTER COLUMN "max_tokens" SET DEFAULT 2000;

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "payment_amount" DECIMAL(10,2),
ADD COLUMN     "payment_confirmed_at" TIMESTAMP(3),
ADD COLUMN     "payment_method" VARCHAR(50),
ADD COLUMN     "payment_notes" TEXT,
ADD COLUMN     "payment_proof_url" TEXT,
ADD COLUMN     "payment_status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "pending_action" VARCHAR(50),
ADD COLUMN     "pending_action_at" TIMESTAMP(3),
ADD COLUMN     "pending_action_data" JSONB,
ADD COLUMN     "pending_action_reason" TEXT,
ADD COLUMN     "reminder_1h_sent_at" TIMESTAMP(3),
ADD COLUMN     "reminder_2h_sent_at" TIMESTAMP(3),
ADD COLUMN     "reminder_8h_sent_at" TIMESTAMP(3),
ADD COLUMN     "staff_id" TEXT;

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "stockup_category_id" VARCHAR(50);

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "archived_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "accepts_marketing" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "first_order_date" TIMESTAMP(3),
ADD COLUMN     "last_conversation_summary" TEXT,
ADD COLUMN     "last_order_date" TIMESTAMP(3),
ADD COLUMN     "total_orders" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "total_spent" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "wa_lid" VARCHAR(32),
ALTER COLUMN "phone" SET DATA TYPE VARCHAR(32);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "appointment_id" VARCHAR(36),
ADD COLUMN     "discount_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "discount_percent" DECIMAL(5,2),
ADD COLUMN     "idempotency_key" VARCHAR(100),
ADD COLUMN     "is_manual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "manual_payment_method" VARCHAR(50),
ADD COLUMN     "subtotal" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "stockup_synced_at" TIMESTAMP(3),
ADD COLUMN     "stockup_variant_id" VARCHAR(50);

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "stockup_product_id" VARCHAR(50),
ADD COLUMN     "stockup_synced_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "address" TEXT,
ADD COLUMN     "admin_phone" VARCHAR(20),
ADD COLUMN     "api_blocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "auto_confirm_appointments" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "business_hours" JSONB,
ADD COLUMN     "cancellation_policy" TEXT,
ADD COLUMN     "default_service_id" TEXT,
ADD COLUMN     "delivery_zone" TEXT,
ADD COLUMN     "deposit_amount" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "directions" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "facebook" TEXT,
ADD COLUMN     "google_maps_url" TEXT,
ADD COLUMN     "has_delivery" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "has_parking" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "instagram" TEXT,
ADD COLUMN     "min_advance_minutes" INTEGER,
ADD COLUMN     "neighborhood" TEXT,
ADD COLUMN     "order_deposit_amount" TEXT,
ADD COLUMN     "order_policy" TEXT,
ADD COLUMN     "order_requires_cedula" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "order_requires_deposit" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "order_shipping" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "order_shipping_zone" TEXT,
ADD COLUMN     "payment_account" TEXT,
ADD COLUMN     "payment_methods" TEXT[],
ADD COLUMN     "requires_customer_address" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requires_customer_cedula" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requires_deposit" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "slug" VARCHAR(100),
ADD COLUMN     "staff_label" VARCHAR(50) DEFAULT 'Profesional',
ADD COLUMN     "subscription_end" TIMESTAMP(3),
ADD COLUMN     "subscription_status" VARCHAR(20) NOT NULL DEFAULT 'none',
ADD COLUMN     "tiktok" TEXT,
ADD COLUMN     "website" TEXT;

-- CreateTable
CREATE TABLE "daily_reports" (
    "report_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "appointments_data" JSONB NOT NULL,
    "payments_data" JSONB NOT NULL,
    "clients_data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_reports_pkey" PRIMARY KEY ("report_id")
);

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "log_id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "target_type" VARCHAR(50) NOT NULL,
    "target_id" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("log_id")
);

-- CreateTable
CREATE TABLE "subscription_config" (
    "configId" TEXT NOT NULL DEFAULT 'singleton',
    "price_amount" DECIMAL(10,2) NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'COP',
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" VARCHAR(100),

    CONSTRAINT "subscription_config_pkey" PRIMARY KEY ("configId")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "subscription_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "price_amount" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("subscription_id")
);

-- CreateTable
CREATE TABLE "subscription_payments" (
    "payment_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "mp_payment_id" VARCHAR(100),
    "amount" DECIMAL(10,2) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_payments_pkey" PRIMARY KEY ("payment_id")
);

-- CreateTable
CREATE TABLE "staff" (
    "staff_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "schedule" JSONB,
    "commission_percentage" DOUBLE PRECISION,
    "suspended_from" TIMESTAMP(3),
    "suspended_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("staff_id")
);

-- CreateTable
CREATE TABLE "stockup_connections" (
    "connection_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "stockup_tenant_id" VARCHAR(50),
    "secret" VARCHAR(200),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "link_code" VARCHAR(20),
    "link_code_expires_at" TIMESTAMP(3),
    "last_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stockup_connections_pkey" PRIMARY KEY ("connection_id")
);

-- CreateTable
CREATE TABLE "sync_outbox" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_inbox" (
    "event_id" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_inbox_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "daily_reports_store_id_date_key" ON "daily_reports"("store_id", "date");

-- CreateIndex
CREATE INDEX "admin_audit_logs_admin_id_created_at_idx" ON "admin_audit_logs"("admin_id", "created_at");

-- CreateIndex
CREATE INDEX "admin_audit_logs_target_type_target_id_idx" ON "admin_audit_logs"("target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_store_id_key" ON "subscriptions"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_payments_mp_payment_id_key" ON "subscription_payments"("mp_payment_id");

-- CreateIndex
CREATE INDEX "subscription_payments_subscription_id_idx" ON "subscription_payments"("subscription_id");

-- CreateIndex
CREATE INDEX "staff_store_id_is_active_idx" ON "staff"("store_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "stockup_connections_store_id_key" ON "stockup_connections"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_outbox_event_id_key" ON "sync_outbox"("event_id");

-- CreateIndex
CREATE INDEX "sync_outbox_status_retry" ON "sync_outbox"("status", "next_retry_at");

-- CreateIndex
CREATE INDEX "appointments_store_id_staff_id_scheduled_at_idx" ON "appointments"("store_id", "staff_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "customers_store_id_total_spent_idx" ON "customers"("store_id", "total_spent");

-- CreateIndex
CREATE UNIQUE INDEX "orders_idempotency_key_key" ON "orders"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "orders_appointment_id_key" ON "orders"("appointment_id");

-- CreateIndex
CREATE INDEX "orders_store_id_type_idx" ON "orders"("store_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "stores_slug_key" ON "stores"("slug");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff"("staff_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("subscription_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stockup_connections" ADD CONSTRAINT "stockup_connections_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_outbox" ADD CONSTRAINT "sync_outbox_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Índice único PARCIAL: Prisma no declara índices con WHERE. Un LID por tienda,
-- solo cuando se conoce (identidad híbrida teléfono/LID de WhatsApp).
CREATE UNIQUE INDEX IF NOT EXISTS customers_store_wa_lid_key
  ON customers (store_id, wa_lid) WHERE wa_lid IS NOT NULL;
