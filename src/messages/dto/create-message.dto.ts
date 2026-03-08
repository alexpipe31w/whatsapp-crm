import { IsString, IsOptional, IsBoolean, IsIn } from 'class-validator';

export class CreateMessageDto {
  @IsString()
  conversationId: string;

  @IsString()
  storeId: string;

  @IsString()
  content: string;

  @IsString()
  @IsOptional()
  type?: string; // 'text' | 'image' | 'audio'

  @IsBoolean()
  @IsOptional()
  isAiResponse?: boolean;

  @IsString()
  @IsOptional()
  @IsIn(['customer', 'store', 'ai']) // ✅ solo valores válidos del schema
  sender?: string;
}