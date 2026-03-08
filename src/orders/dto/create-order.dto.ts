import {
  IsString, IsOptional, IsArray, ValidateNested,
  IsNumber, IsInt, IsIn, Min,
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
  description?: string; // ítem libre (comida sin producto en BD, etc.)

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitPrice: number;
}

export class CreateOrderDto {
  @IsString()
  storeId: string;

  @IsString()
  customerId: string;

  // 'product' = pedido físico | 'food' = pedido de comida | 'service' = servicio
  @IsString()
  @IsOptional()
  @IsIn(['product', 'food', 'service'])
  type?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];

  @IsString()
  @IsOptional()
  notes?: string;

  // Tiempo estimado de entrega/preparación en minutos
  @IsInt()
  @IsOptional()
  @Min(0)
  estimatedTime?: number;

  // Dirección de entrega (útil para comidas y productos físicos)
  @IsString()
  @IsOptional()
  deliveryAddress?: string;
}
