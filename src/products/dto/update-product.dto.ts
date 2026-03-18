import {
  IsString, IsOptional, IsNumber, IsInt, IsBoolean,
  IsUrl, IsUUID, Min, Max, MaxLength, MinLength,
  IsArray, ValidateNested,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { CreateVariantInlineDto } from './create-product.dto';

export class UpdateProductDto {
  // ── Organización ──────────────────────────────────────────────────────────
  @IsUUID()
  @IsOptional()
  categoryId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  sku?: string;

  @IsString()
  @IsOptional()
  @MinLength(2)
  @MaxLength(200)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50_000)
  description?: string;

  // ── Precios ───────────────────────────────────────────────────────────────
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(99_999_999)
  @IsOptional()
  salePrice?: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(99_999_999)
  @IsOptional()
  costPrice?: number;

  // ── Inventario ────────────────────────────────────────────────────────────
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  stock?: number;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  hasVariants?: boolean;

  // ── Imagen ────────────────────────────────────────────────────────────────
  @IsUrl({}, { message: 'imageUrl debe ser una URL válida' })
  @IsOptional()
  @MaxLength(500)
  imageUrl?: string;

  // ── Envío ─────────────────────────────────────────────────────────────────
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  hasShipping?: boolean;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  weight?: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  shippingStandard?: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  shippingExpress?: number;

  // ── Estado ────────────────────────────────────────────────────────────────
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  isActive?: boolean;

  // ── Variantes (sync completo — reemplaza todas las variantes) ─────────────
  // Si se envía este array, el service sincroniza:
  //   - crea las nuevas (_isNew = true o sin id)
  //   - actualiza las existentes (con id)
  //   - desactiva las que ya no están en el array
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateVariantInlineDto)
  @IsOptional()
  variants?: UpdateVariantInlineDto[];
}

// ─── Variante dentro del DTO de actualización ────────────────────────────────

export class UpdateVariantInlineDto {
  // Si tiene id → actualizar. Si no → crear.
  @IsUUID()
  @IsOptional()
  variantId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  sku?: string;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  salePrice?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  costPrice?: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  @Type(() => Number)
  stock?: number;

  @IsOptional()
  attributes?: Record<string, string>;

  @IsUrl({}, { message: 'imageUrl de variante debe ser una URL válida' })
  @IsOptional()
  @MaxLength(500)
  imageUrl?: string;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  weight?: number;

  @IsInt()
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  sortOrder?: number;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  isActive?: boolean;
}