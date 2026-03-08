-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "city" VARCHAR(100);

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "description" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "delivery_address" TEXT,
ADD COLUMN     "estimated_time" INTEGER,
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'product';
