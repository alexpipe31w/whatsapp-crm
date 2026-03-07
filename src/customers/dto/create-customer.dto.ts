import { IsString, IsOptional } from 'class-validator';

export class CreateCustomerDto {
  @IsString()
  storeId: string;

  @IsString()
  phone: string;

  @IsString()
  @IsOptional()
  name?: string;
}
