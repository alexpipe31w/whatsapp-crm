import { IsString, IsOptional, IsNumber, IsInt, Min, Max, MaxLength, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateServiceDto {
  // storeId ignorado en controller — viene del JWT
  @IsString()
  @IsOptional()
  storeId?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  @Min(0.01, { message: 'El precio debe ser mayor a 0' })
  @Max(99_999_999)
  price?: number; // opcional — algunos servicios tienen precio variable

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(1440) // máximo 24 horas en minutos
  duration?: number;
}