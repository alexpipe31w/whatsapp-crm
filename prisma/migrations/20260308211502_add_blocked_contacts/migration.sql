-- CreateTable
CREATE TABLE "blocked_contacts" (
    "blocked_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "label" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocked_contacts_pkey" PRIMARY KEY ("blocked_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "blocked_contacts_store_id_phone_key" ON "blocked_contacts"("store_id", "phone");

-- AddForeignKey
ALTER TABLE "blocked_contacts" ADD CONSTRAINT "blocked_contacts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("store_id") ON DELETE CASCADE ON UPDATE CASCADE;
