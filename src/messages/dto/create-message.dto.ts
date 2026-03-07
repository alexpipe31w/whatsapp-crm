import { IsString, IsOptional, IsBoolean } from 'class-validator';

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
}
