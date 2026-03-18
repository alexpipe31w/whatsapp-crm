import {
  IsString, IsOptional, IsNumber, IsInt, IsBoolean,
  IsUrl, IsUUID, Min, Max, MaxLength, MinLength,
  IsArray, ValidateNested,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

// ─── Variante dentro del DTO de creación ─────────────────────────────────────
// Se usa cuando el producto se crea con variantes en un solo request.

export class CreateVariantInlineDto {
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

  // Atributos libres: { "color": "Rojo", "talla": "M", "capacidad": "128GB" }
  // Cada negocio define los atributos que necesita
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

// ─── DTO principal ───────────────────────────────────────────────────────────

export class CreateProductDto {
  // Ignorado en controller — viene del JWT
  @IsString()
  @IsOptional()
  storeId?: string;

  // ── Organización ──────────────────────────────────────────────────────────
  @IsUUID()
  @IsOptional()
  categoryId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  sku?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  // description acepta HTML enriquecido (Tiptap) — límite generoso
  @IsString()
  @IsOptional()
  @MaxLength(50_000)
  description?: string;

  // ── Precios ───────────────────────────────────────────────────────────────
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(99_999_999)
  salePrice: number;

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
  @Max(999_999)
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

  // ── Variantes (creación en un solo request) ───────────────────────────────
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateVariantInlineDto)
  @IsOptional()
  variants?: CreateVariantInlineDto[];
}