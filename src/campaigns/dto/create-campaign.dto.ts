import { IsString, IsOptional, MinLength, MaxLength, IsDateString } from 'class-validator';

export class CreateCampaignDto {
  // storeId ignorado en controller — viene del JWT
  @IsString()
  @IsOptional()
  storeId?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @IsString()
  @MinLength(5, { message: 'El mensaje debe tener al menos 5 caracteres' })
  @MaxLength(1000, { message: 'El mensaje no puede superar 1000 caracteres (límite de WhatsApp)' })
  message: string;

  @IsDateString({}, { message: 'scheduledAt debe ser una fecha válida (ISO 8601)' })
  @IsOptional()
  scheduledAt?: string;
}