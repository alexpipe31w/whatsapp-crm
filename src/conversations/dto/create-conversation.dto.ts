import { IsString } from 'class-validator';

export class CreateConversationDto {
  @IsString()
  storeId: string;

  @IsString()
  customerId: string;
}
