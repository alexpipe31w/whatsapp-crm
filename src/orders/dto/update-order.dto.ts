import { IsString, IsOptional } from 'class-validator';

export class UpdateOrderDto {
  @IsString()
  @IsOptional()
  status?: 'pending' | 'confirmed' | 'delivered' | 'cancelled';

  @IsString()
  @IsOptional()
  notes?: string;
}
