import { IsString, IsOptional, IsNumber, IsInt, IsBoolean, IsUrl, Min, Max, MaxLength, MinLength } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class CreateProductDto {
  // storeId ignorado en controller — viene del JWT
  @IsString()
  @IsOptional()
  storeId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  sku?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01, { message: 'El precio de costo debe ser mayor a 0' })
  @Max(99_999_999)
  costPrice: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01, { message: 'El precio de venta debe ser mayor a 0' })
  @Max(99_999_999)
  salePrice: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(999_999)
  @IsOptional()
  stock?: number;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @IsUrl({}, { message: 'imageUrl debe ser una URL válida' })
  @IsOptional()
  @MaxLength(500)
  imageUrl?: string;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  hasShipping?: boolean;
}