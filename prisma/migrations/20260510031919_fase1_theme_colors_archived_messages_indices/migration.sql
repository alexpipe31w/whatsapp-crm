-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "accent_color" VARCHAR(7) DEFAULT '#f59e0b',
ADD COLUMN     "primary_color" VARCHAR(7) DEFAULT '#2563eb',
ADD COLUMN     "secondary_color" VARCHAR(7) DEFAULT '#9333ea';

-- CreateTable
CREATE TABLE "archived_messages" (
    "message_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "is_ai_response" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "archived_messages_pkey" PRIMARY KEY ("message_id")
);

-- CreateIndex
CREATE INDEX "archived_messages_store_id_created_at_idx" ON "archived_messages"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "archived_messages_conversation_id_idx" ON "archived_messages"("conversation_id");

-- CreateIndex
CREATE INDEX "conversations_store_id_last_message_at_idx" ON "conversations"("store_id", "last_message_at");
