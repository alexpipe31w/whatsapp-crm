-- AlterTable
ALTER TABLE "appointments" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "customers" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "orders" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "products" ALTER COLUMN "updated_at" DROP DEFAULT;
