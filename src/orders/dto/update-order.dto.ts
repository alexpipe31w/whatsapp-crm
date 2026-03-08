import { IsString, IsOptional, IsInt, Min } from 'class-validator';

export class UpdateOrderDto {
  @IsString()
  @IsOptional()
  status?: 'pending' | 'confirmed' | 'preparing' | 'ready' | 'delivered' | 'cancelled';

  @IsString()
  @IsOptional()
  notes?: string;

  // Actualizar tiempo estimado en curso (ej: cocina avisa demora extra)
  @IsInt()
  @IsOptional()
  @Min(0)
  estimatedTime?: number;

  @IsString()
  @IsOptional()
  deliveryAddress?: string;
}
