-- AlterTable
ALTER TABLE "users" ADD COLUMN     "store_id" TEXT;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("store_id") ON DELETE SET NULL ON UPDATE CASCADE;
