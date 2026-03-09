import { IsString, IsOptional, IsBoolean, IsIn, MaxLength } from 'class-validator';

export class CreateMessageDto {
  @IsString()
  @MaxLength(100)
  conversationId: string;

  // storeId ignorado en controller — viene del JWT
  @IsString()
  @IsOptional()
  storeId?: string;

  @IsString()
  @MaxLength(4096, { message: 'El mensaje no puede superar 4096 caracteres' })
  content: string;

  @IsString()
  @IsOptional()
  @IsIn(['text', 'image', 'audio'], { message: 'Tipo inválido' })
  type?: string;

  @IsBoolean()
  @IsOptional()
  isAiResponse?: boolean;

  @IsString()
  @IsOptional()
  @IsIn(['customer', 'store', 'ai'])
  sender?: string;
}