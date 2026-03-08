import { IsString, IsOptional, IsNumber, IsInt, IsBoolean, IsUrl, Min } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class CreateProductDto {
  @IsString()
  storeId: string;

  @IsString()
  @IsOptional()
  sku?: string;

  @IsString()
  name: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costPrice: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  salePrice: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  stock?: number;

  @IsString()
  @IsOptional()
  description?: string;

  // URL pública de imagen del producto (Cloudinary, S3, etc.)
  @IsString()
  @IsOptional()
  imageUrl?: string;

  // Si el producto tiene envío disponible
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  hasShipping?: boolean;
}
