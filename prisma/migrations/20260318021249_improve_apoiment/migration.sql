-- AlterTable
ALTER TABLE "product_variants" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "service_variants" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "services" ALTER COLUMN "updated_at" DROP DEFAULT;
