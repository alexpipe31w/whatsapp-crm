import { IsString, IsOptional, MaxLength, MinLength, Matches } from 'class-validator';

export class CreateCustomerDto {
  // storeId ignorado en controller — viene del JWT
  @IsString()
  @IsOptional()
  storeId?: string;

  @IsString()
  @MinLength(7, { message: 'El teléfono debe tener al menos 7 dígitos' })
  @MaxLength(20)
  @Matches(/^\+?[\d\s\-().]+$/, { message: 'Formato de teléfono inválido' })
  phone: string;

  @IsString()
  @IsOptional()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  city?: string;
}