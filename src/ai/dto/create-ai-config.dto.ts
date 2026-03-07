import { IsString, IsOptional, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateAiConfigDto {
  @IsString()
  storeId: string;

  @IsString()
  groqApiKey: string;

  @IsString()
  systemPrompt: string;

  @IsString()
  @IsOptional()
  model?: string;

  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  temperature?: number;

  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  maxTokens?: number;
}
