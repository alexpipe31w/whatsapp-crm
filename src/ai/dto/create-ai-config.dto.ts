import { IsString, IsOptional, IsNumber, IsInt, Min, Max } from 'class-validator';
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
  model?: string; // default: 'llama-3.3-70b-versatile'

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(2)
  @IsOptional()
  temperature?: number; // default: 0.70

  @Type(() => Number)
  @IsInt()
  @Min(256)
  @Max(4096)
  @IsOptional()
  maxTokens?: number; // default: 1024
}
