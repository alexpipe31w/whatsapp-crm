import {
  IsString, IsOptional, IsNumber, IsInt, IsBoolean, IsEnum,
  IsUrl, IsUUID, Min, Max, MaxLength, MinLength, IsArray, ValidateNested,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { PriceTypeDto } from './create-service.dto';

// ─── Variante en actualización ────────────────────────────────────────────────

export class UpdateServiceVariantDto {
  // Si tiene variantId → actualizar. Si no → crear.
  @IsUUID()
  @IsOptional()
  variantId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsString()
  @IsOptional()
  @MaxLength(50_000)
  description?: string;

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
  @Max(44_640)
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

export class UpdateServiceDto {
  @IsString()
  @IsOptional()
  @MinLength(2)
  @MaxLength(200)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50_000)
  description?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  category?: string;

  @IsUrl({}, { message: 'imageUrl debe ser una URL válida' })
  @IsOptional()
  @MaxLength(500)
  imageUrl?: string;

  @IsEnum(PriceTypeDto, { message: 'priceType debe ser FIXED, PER_HOUR, PER_DAY, PER_UNIT o VARIABLE' })
  @IsOptional()
  priceType?: PriceTypeDto;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(99_999_999)
  @Type(() => Number)
  basePrice?: number;

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

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  costPrice?: number;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  unitLabel?: string;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  hasVariants?: boolean;

  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(44_640)
  @Type(() => Number)
  estimatedMinutes?: number;

  @IsOptional()
  customFields?: Record<string, any>;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  isActive?: boolean;

  // Si se envía este array, el service sincroniza todas las variantes
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateServiceVariantDto)
  @IsOptional()
  variants?: UpdateServiceVariantDto[];
}