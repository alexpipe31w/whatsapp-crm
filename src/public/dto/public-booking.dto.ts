import {
  IsString, IsOptional, IsDateString, IsUUID, MaxLength, MinLength,
} from 'class-validator';

export class PublicBookingDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  customerName: string;

  // Teléfono opcional: si el cliente lo deja en blanco se agenda igual (se crea un
  // cliente con placeholder interno). Si lo escribe, se valida el formato en el service.
  @IsString()
  @IsOptional()
  @MaxLength(20)
  customerPhone?: string;

  @IsUUID()
  @IsOptional()
  serviceId?: string;

  @IsUUID()
  @IsOptional()
  serviceVariantId?: string;

  @IsUUID()
  @IsOptional()
  staffId?: string;

  // ISO 8601 con timezone: "2025-03-20T14:00:00-05:00"
  @IsDateString()
  scheduledAt: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  notes?: string;
}
