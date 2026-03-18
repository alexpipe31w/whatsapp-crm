import {
  IsString, IsOptional, IsNumber, IsInt, IsBoolean, IsEnum,
  IsUrl, Min, Max, MaxLength, MinLength, IsArray, ValidateNested,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

// ─── Enum local (espejo del schema) ──────────────────────────────────────────
// Se importa aquí para no depender del cliente generado de Prisma en los DTOs

export enum PriceTypeDto {
  FIXED    = 'FIXED',
  PER_HOUR = 'PER_HOUR',
  PER_DAY  = 'PER_DAY',
  PER_UNIT = 'PER_UNIT',
  VARIABLE = 'VARIABLE',
}

// ─── Variante inline ──────────────────────────────────────────────────────────

export class CreateServiceVariantDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsString()
  @IsOptional()
  @MaxLength(50_000)
  description?: string;

  // priceOverride → precio fijo de esta variante (reemplaza basePrice del servicio)
  // priceModifier → % sobre basePrice del servicio (ej: 30 = +30%)
  // Solo uno de los dos debe estar presente
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  priceOverride?: number;

  @IsNumber()
  @IsOptional()
  @Min(-100)
  @Max(1000)
  @Type(() => Number)
  priceModifier?: number;

  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(44_640) // máximo ~31 días en minutos
  @Type(() => Number)
  estimatedMinutes?: number;

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

// ─── DTO principal ────────────────────────────────────────────────────────────

export class CreateServiceDto {
  // Ignorado en controller — viene del JWT
  @IsString()
  @IsOptional()
  storeId?: string;

  // ── Identificación ────────────────────────────────────────────────────────
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  // Acepta HTML enriquecido (Tiptap)
  @IsString()
  @IsOptional()
  @MaxLength(50_000)
  description?: string;

  // Categoría libre — no es FK, cada negocio define las suyas
  // Ej: "Cortes", "Reparaciones", "Instalaciones", "Eventos"
  @IsString()
  @IsOptional()
  @MaxLength(100)
  category?: string;

  @IsUrl({}, { message: 'imageUrl debe ser una URL válida' })
  @IsOptional()
  @MaxLength(500)
  imageUrl?: string;

  // ── Modelo de precio ──────────────────────────────────────────────────────
  // FIXED    → basePrice es el precio final
  // PER_HOUR → basePrice × horas que el cliente indique en la orden
  // PER_DAY  → basePrice × días
  // PER_UNIT → basePrice × unidades/cantidad
  // VARIABLE → sin precio fijo, el admin cotiza manualmente
  @IsEnum(PriceTypeDto, { message: 'priceType debe ser FIXED, PER_HOUR, PER_DAY, PER_UNIT o VARIABLE' })
  @IsOptional()
  priceType?: PriceTypeDto;

  // Requerido para FIXED, PER_HOUR, PER_DAY, PER_UNIT
  // Opcional para VARIABLE (se cotiza caso a caso)
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(99_999_999)
  @Type(() => Number)
  basePrice?: number;

  // Rango de referencia — útil para VARIABLE (orienta al admin al cotizar)
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  minPrice?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  maxPrice?: number;

  // Costo interno (para analytics de margen)
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  costPrice?: number;

  // Etiqueta de la unidad que se muestra al cliente
  // Ej: "hora", "día", "sesión", "m²", "panel", "persona", "evento"
  @IsString()
  @IsOptional()
  @MaxLength(50)
  unitLabel?: string;

  // ── Configuración ─────────────────────────────────────────────────────────
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  hasVariants?: boolean;

  // Duración estimada en minutos (para agendar y mostrar al cliente)
  // Ej: corte = 30, instalación panel = 480, evento = 240
  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(44_640)
  @Type(() => Number)
  estimatedMinutes?: number;

  // JSON libre para campos extra sin cambios de schema
  // Ej: { "requiereVisita": true, "garantiaMeses": 6, "materialIncluido": false }
  @IsOptional()
  customFields?: Record<string, any>;

  // ── Variantes ─────────────────────────────────────────────────────────────
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateServiceVariantDto)
  @IsOptional()
  variants?: CreateServiceVariantDto[];
}