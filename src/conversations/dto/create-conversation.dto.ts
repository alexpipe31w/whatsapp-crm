import { IsString, IsOptional, MaxLength } from 'class-validator';

export class CreateConversationDto {
  // storeId ignorado en controller — viene del JWT
  @IsString()
  @IsOptional()
  storeId?: string;

  @IsString()
  @MaxLength(100)
  customerId: string;
}