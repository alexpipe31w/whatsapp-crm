import { IsString, IsOptional, IsNumber, IsInt, Min, Max, MaxLength, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateAiConfigDto {
  // storeId se ignora en el controller — viene del JWT
  // Se mantiene opcional aquí para no romper clientes existentes
  @IsString()
  @IsOptional()
  storeId?: string;

  @IsString()
  @MinLength(20)
  @MaxLength(200)
  groqApiKey: string;

  @IsString()
  @MinLength(10, { message: 'El system prompt debe tener al menos 10 caracteres' })
  @MaxLength(100_000, { message: 'El system prompt no puede superar 100.000 caracteres' })
  systemPrompt: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  model?: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(2)
  @IsOptional()
  temperature?: number;

  @Type(() => Number)
  @IsInt()
  @Min(256)
  @Max(4096)
  @IsOptional()
  maxTokens?: number;
}