import {
  IsString, IsOptional, IsArray, ValidateNested,
  IsNumber, IsInt, IsIn, Min, Max, MaxLength, ArrayMinSize, ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateOrderItemDto {
  @IsString()
  @IsOptional()
  productId?: string;

  @IsString()
  @IsOptional()
  serviceId?: string;

  @IsString()
  @IsOptional()
  variantId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  description?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(999)
  quantity: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01, { message: 'El precio unitario debe ser mayor a 0' })
  @Max(99_999_999)
  unitPrice: number;
}

export class CreateOrderDto {
  // storeId se ignora en el controller — viene del JWT
  @IsString()
  @IsOptional()
  storeId?: string;

  @IsString()
  customerId: string;

  @IsString()
  @IsOptional()
  @IsIn(['product', 'food', 'service'])
  type?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'El pedido debe tener al menos un item' })
  @ArrayMaxSize(50, { message: 'El pedido no puede tener más de 50 items' })
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];

  @IsString()
  @IsOptional()
  @MaxLength(500)
  notes?: string;

  @IsInt()
  @IsOptional()
  @Min(0)
  @Max(1440) // máximo 24 horas en minutos
  estimatedTime?: number;

  @IsString()
  @IsOptional()
  @MaxLength(300)
  deliveryAddress?: string;
}