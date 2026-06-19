import {
  IsString, IsNotEmpty, IsArray, ArrayMinSize, ValidateNested,
  IsOptional, IsInt, Min, IsIn, MaxLength, MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

class PublicOrderItemDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  @IsString()
  @IsOptional()
  variantId?: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

export class PublicOrderDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  customerName!: string;

  @IsString()
  @MinLength(7)
  @MaxLength(20)
  customerPhone!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PublicOrderItemDto)
  items!: PublicOrderItemDto[];

  // Método de pago a coordinar en el local; set acotado igual que el resto de la
  // plataforma. Se conserva en las notas del pedido (CreateOrderDto no expone un
  // campo de pago con este mismo set de valores).
  @IsOptional()
  @IsIn(['efectivo', 'transferencia', 'tarjeta', 'nequi', 'daviplata', 'otro'])
  paymentMethod?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
