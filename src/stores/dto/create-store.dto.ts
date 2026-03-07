import { IsString, IsOptional, IsPhoneNumber } from 'class-validator';

export class CreateStoreDto {
  @IsString()
  name: string;

  @IsString()
  phone: string;

  @IsString()
  @IsOptional()
  ownerName?: string;
}
