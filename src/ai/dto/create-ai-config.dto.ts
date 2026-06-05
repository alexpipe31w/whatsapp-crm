import { IsString, IsOptional, IsNumber, IsInt, IsArray, Min, Max, MaxLength, MinLength, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

const AI_PROVIDERS = ['groq', 'openai', 'together', 'mistral', 'anthropic'] as const;

export class CreateAiConfigDto {
  @IsString()
  @IsOptional()
  storeId?: string;

  @IsString()
  @IsIn(AI_PROVIDERS)
  @IsOptional()
  aiProvider?: string;

  @IsString()
  @MinLength(20)
  @MaxLength(500)
  apiKey: string;

  @IsString()
  @MinLength(10, { message: 'El system prompt debe tener al menos 10 caracteres' })
  @MaxLength(100_000, { message: 'El system prompt no puede superar 100.000 caracteres' })
  systemPrompt: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
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

  @IsArray()
  @IsOptional()
  cartridges?: Array<{ provider: string; apiKey: string; model?: string }>;
}
