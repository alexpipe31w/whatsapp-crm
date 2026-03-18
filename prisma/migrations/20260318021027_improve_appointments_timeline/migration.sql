/*
  Warnings:

  - You are about to alter the column `type` on the `appointments` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(100)`.
  - The `status` column on the `appointments` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to alter the column `description` on the `order_items` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(500)`.
  - You are about to alter the column `image_url` on the `products` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(500)`.
  - You are about to drop the column `duration` on the `services` table. All the data in the column will be lost.
  - You are about to drop the column `price` on the `services` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "PriceType" AS ENUM ('FIXED', 'PER_HOUR', 'PER_DAY', 'PER_UNIT', 'VARIABLE');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED');

-- CreateEnum
CREATE TYPE "AppointmentPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "AppointmentSource" AS ENUM ('AI', 'MANUAL', 'WHATSAPP', 'API');

-- DropForeignKey
ALTER TABLE "products" DROP CONSTRAINT "products_store_id_fkey";

-- DropForeignKey
ALTER TABLE "services" DROP CONSTRAINT "services_store_id_fkey";

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "agreed_price" DECIMAL(10,2),
ADD COLUMN     "cancel_reason" VARCHAR(500),
ADD COLUMN     "cancelled_at" TIMESTAMP(3),
ADD COLUMN     "completed_at" TIMESTAMP(3),
ADD COLUMN     "confirmed_at" TIMESTAMP(3),
ADD COLUMN     "duration_minutes" INTEGER,
ADD COLUMN     "ends_at" TIMESTAMP(3),
ADD COLUMN     "internal_notes" TEXT,
ADD COLUMN     "priority" "AppointmentPriority" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "reminder_sent_at" TIMESTAMP(3),
ADD COLUMN     "service_id" TEXT,
ADD COLUMN     "service_variant_id" TEXT,
ADD COLUMN     "source" "AppointmentSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "started_at" TIMESTAMP(3),
ALTER COLUMN "type" SET DATA TYPE VARCHAR(100),
DROP COLUMN "status",
ADD COLUMN     "status" "AppointmentStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "service_variant_id" TEXT,
ADD COLUMN     "variant_id" TEXT,
ALTER COLUMN "description" SET DATA TYPE VARCHAR(500);

-- AlterTable: product_variants — DEFAULT NOW() para filas existentes
ALTER TABLE "product_variants" ADD COLUMN     "attributes" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "image_url" VARCHAR(500),
ADD COLUMN     "profit_margin" DECIMAL(5,2),
ADD COLUMN     "sort_order" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
ADD COLUMN     "weight" DECIMAL(8,3),
ALTER COLUMN "cost_price" DROP NOT NULL,
ALTER COLUMN "cost_price" SET DEFAULT 0,
ALTER COLUMN "sale_price" DROP NOT NULL;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "category_id" TEXT,
ADD COLUMN     "has_variants" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "profit_margin" DECIMAL(5,2),
ADD COLUMN     "shipping_express" DECIMAL(10,2) DEFAULT 0,
ADD COLUMN     "shipping_standard" DECIMAL(10,2) DEFAULT 0,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "weight" DECIMAL(8,3),
ALTER COLUMN "cost_price" SET DEFAULT 0,
ALTER COLUMN "image_url" SET DATA TYPE VARCHAR(500);

-- AlterTable: services — DEFAULT NOW() para filas existentes
ALTER TABLE "services" DROP COLUMN "duration",
DROP COLUMN "price",
ADD COLUMN     "base_price" DECIMAL(10,2),
ADD COLUMN     "category" VARCHAR(100),
ADD COLUMN     "cost_price" DECIMAL(10,2),
ADD COLUMN     "custom_fields" JSONB DEFAULT '{}',
ADD COLUMN     "estimated_minutes" INTEGER,
ADD COLUMN     "has_variants" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "image_url" VARCHAR(500),
ADD COLUMN     "max_price" DECIMAL(10,2),
ADD COLUMN     "min_price" DECIMAL(10,2),
ADD COLUMN     "price_type" "PriceType" NOT NULL DEFAULT 'FIXED',
ADD COLUMN     "unit_label" VARCHAR(50),
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT NOW();

-- CreateTable
CREATE TABLE "categories" (
    "category_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("category_id")
);

-- CreateTable
CREATE TABLE "service_variants" (
    "variant_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "price_override" DECIMAL(10,2),
    "price_modifier" DECIMAL(5,2),
    "estimated_minutes" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT NOW(),

    CONSTRAINT "service_variants_pkey" PRIMARY KEY ("variant_id")
);

-- CreateTable
CREATE TABLE "appointment_timelines" (
    "timeline_id" TEXT NOT NULL,
    "appointment_id" TEXT NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "previous_status" "AppointmentStatus",
    "new_status" "AppointmentStatus",
    "note" TEXT,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "performed_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_timelines_pkey" PRIMARY KEY ("timeline_id")
);

-- CreateIndex
CREATE INDEX "categories_store_id_idx" ON "categories"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_store_id_slug_key" ON "categories"("store_id", "slug");

-- CreateIndex
CREATE INDEX "service_variants_service_id_is_active_idx" ON "service_variants"("service_id", "is_active");

-- CreateIndex
CREATE INDEX "service_variants_service_id_idx" ON "service_variants"("service_id");

-- CreateIndex
CREATE INDEX "appointment_timelines_appointment_id_idx" ON "appointment_timelines"("appointment_id");

-- CreateIndex
CREATE INDEX "appointment_timelines_appointment_id_created_at_idx" ON "appointment_timelines"("appointment_id", "created_at");

-- CreateIndex
CREATE INDEX "appointments_store_id_status_idx" ON "appointments"("store_id", "status");

-- CreateIndex
CREATE INDEX "appointments_store_id_status_scheduled_at_idx" ON "appointments"("store_id", "status", "scheduled_at");

-- CreateIndex
CREATE INDEX "appointments_service_id_idx" ON "appointments"("service_id");

-- CreateIndex
CREATE INDEX "appointments_store_id_created_at_idx" ON "appointments"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_items_product_id_idx" ON "order_items"("product_id");

-- CreateIndex
CREATE INDEX "order_items_service_id_idx" ON "order_items"("service_id");

-- CreateIndex
CREATE INDEX "product_variants_product_id_is_active_idx" ON "product_variants"("product_id", "is_active");

-- CreateIndex
CREATE INDEX "product_variants_product_id_idx" ON "product_variants"("product_id");

-- CreateIndex
CREATE INDEX "products_store_id_category_id_idx" ON "products"("store_id", "category_id");

-- CreateIndex
CREATE INDEX "products_store_id_created_at_idx" ON "products"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "services_store_id_is_active_idx" ON "services"("store_id", "is_active");

-- CreateIndex
CREATE INDEX "services_store_id_price_type_idx" ON "services"("store_id", "price_type");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("category_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_variants" ADD CONSTRAINT "service_variants_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("service_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("variant_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_service_variant_id_fkey" FOREIGN KEY ("service_variant_id") REFERENCES "service_variants"("variant_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("service_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_variant_id_fkey" FOREIGN KEY ("service_variant_id") REFERENCES "service_variants"("variant_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_timelines" ADD CONSTRAINT "appointment_timelines_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("appointment_id") ON DELETE CASCADE ON UPDATE CASCADE;