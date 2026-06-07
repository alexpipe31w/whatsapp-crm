import { IsString, IsOptional, IsBoolean, IsArray, IsInt, IsObject, Min, IsEmail, IsUrl, Matches } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateStoreDto {
  @IsString()
  name: string;

  @IsString()
  phone: string;

  @IsString() @IsOptional() ownerName?: string;
  @IsString() @IsOptional() adminPhone?: string;

  // Información del negocio
  @IsString() @IsOptional() description?: string;
  @IsString() @IsOptional() address?: string;
  @IsString() @IsOptional() neighborhood?: string;
  @IsString() @IsOptional() directions?: string;
  @IsString() @IsOptional() googleMapsUrl?: string;

  // Contacto y redes
  @IsEmail() @IsOptional() email?: string;
  @IsUrl() @IsOptional() website?: string;
  @IsString() @IsOptional() instagram?: string;
  @IsString() @IsOptional() facebook?: string;
  @IsString() @IsOptional() tiktok?: string;

  // Pagos
  @IsArray() @IsString({ each: true }) @IsOptional() paymentMethods?: string[];
  @IsString() @IsOptional() paymentAccount?: string;
  @IsBoolean() @IsOptional() @Type(() => Boolean) requiresDeposit?: boolean;
  @IsString() @IsOptional() depositAmount?: string;

  // Políticas
  @IsInt() @Min(0) @IsOptional() @Type(() => Number) minAdvanceMinutes?: number;
  @IsString() @IsOptional() cancellationPolicy?: string;
  @IsBoolean() @IsOptional() @Type(() => Boolean) hasDelivery?: boolean;
  @IsString() @IsOptional() deliveryZone?: string;
  @IsBoolean() @IsOptional() @Type(() => Boolean) hasParking?: boolean;

  // Datos del cliente que la IA debe pedir/guardar (varían según tipo de negocio)
  @IsBoolean() @IsOptional() @Type(() => Boolean) requiresCustomerAddress?: boolean;
  @IsBoolean() @IsOptional() @Type(() => Boolean) requiresCustomerCedula?: boolean;

  // Horarios
  @IsObject() @IsOptional() businessHours?: Record<string, any>;

  @IsString() @IsOptional() staffLabel?: string;

  @IsString()
  @IsOptional()
  @Matches(/^[a-z0-9-]{3,100}$/, { message: 'Slug: solo minúsculas, números y guiones (3-100 chars)' })
  slug?: string;
}
