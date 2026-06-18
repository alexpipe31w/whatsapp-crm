import {
  IsUUID, IsOptional, IsInt, IsNumber, IsPositive, Min, Max, IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

// Mismo set permitido que UpdateAppointmentDto.paymentMethod — el walk-in termina
// pasando este valor directo a update() (sin pasar por su pipe de validación), así
// que debe respetar la misma restricción para no colar un método de pago inválido.
const PAYMENT_METHODS = ['efectivo', 'transferencia', 'tarjeta', 'nequi', 'daviplata', 'otro'] as const;

export class CreateWalkInDto {
  @IsUUID()
  customerId: string;

  @IsUUID()
  @IsOptional()
  serviceId?: string;

  @IsUUID()
  @IsOptional()
  staffId?: string;

  @IsInt() @IsOptional() @Min(5) @Max(1440) @Type(() => Number)
  durationMinutes?: number;

  @IsNumber() @IsPositive() @Type(() => Number)
  price: number;

  @IsIn(PAYMENT_METHODS)
  paymentMethod: typeof PAYMENT_METHODS[number];
}
