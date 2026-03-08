-- AlterTable
ALTER TABLE "products" ADD COLUMN     "has_shipping" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "image_url" TEXT;
