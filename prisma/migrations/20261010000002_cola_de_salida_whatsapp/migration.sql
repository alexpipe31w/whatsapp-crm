-- Bloque 1a: cola de salida de WhatsApp (wa_outbound), dedupe de entrada (wa_inbound)
-- y customers.last_inbound_at. Solo añade: ningún DROP ni cambio de datos existentes,
-- salvo el relleno de last_inbound_at del final.
-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "last_inbound_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "wa_outbound" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "to_jid" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "priority" INTEGER NOT NULL,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "group_key" VARCHAR(120),
    "not_before" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(500),
    "claim_token" VARCHAR(64),
    "locked_until" TIMESTAMP(3),
    "provider_message_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "delivery_status" VARCHAR(16),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wa_outbound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wa_inbound" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "provider_message_id" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wa_inbound_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wa_outbound_idempotency_key_key" ON "wa_outbound"("idempotency_key");

-- CreateIndex
CREATE INDEX "wa_outbound_status_not_before_priority_idx" ON "wa_outbound"("status", "not_before", "priority");

-- CreateIndex
CREATE INDEX "wa_outbound_store_id_status_idx" ON "wa_outbound"("store_id", "status");

-- CreateIndex
CREATE INDEX "wa_outbound_group_key_status_idx" ON "wa_outbound"("group_key", "status");

-- CreateIndex
CREATE INDEX "wa_inbound_created_at_idx" ON "wa_inbound"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "wa_inbound_store_id_provider_message_id_key" ON "wa_inbound"("store_id", "provider_message_id");

-- CreateIndex
CREATE INDEX "customers_store_id_last_inbound_at_idx" ON "customers"("store_id", "last_inbound_at");

-- AddForeignKey
ALTER TABLE "wa_outbound" ADD CONSTRAINT "wa_outbound_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wa_inbound" ADD CONSTRAINT "wa_inbound_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Un solo envío en curso por tienda, garantizado por la BD (no solo por el despachador).
-- Índice único PARCIAL: Prisma no lo declara (igual que customers_store_wa_lid_key).
CREATE UNIQUE INDEX "wa_outbound_one_sending_per_store"
  ON "wa_outbound" ("store_id") WHERE "status" = 'sending';

-- Relleno de last_inbound_at con lo que se sabe hoy:
-- 1) el último mensaje del cliente que aún esté en `messages` (se purgan a las 24 h);
UPDATE "customers" c
SET "last_inbound_at" = s.last_in
FROM (
  SELECT conv."customer_id", max(m."created_at") AS last_in
  FROM "messages" m
  JOIN "conversations" conv ON conv."conversation_id" = m."conversation_id"
  WHERE m."sender" = 'customer'
  GROUP BY conv."customer_id"
) s
WHERE c."customer_id" = s."customer_id";

-- 2) los que tienen resumen de conversación: CleanupService solo lo genera con 2+
--    mensajes del cliente, así que escribieron seguro. La fecha es aproximada.
UPDATE "customers"
SET "last_inbound_at" = "updated_at"
WHERE "last_inbound_at" IS NULL AND "last_conversation_summary" IS NOT NULL;
