import { IsString, IsOptional } from 'class-validator';

export class CreateCampaignDto {
  @IsString()
  storeId: string;

  @IsString()
  name: string;

  @IsString()
  message: string;

  @IsString()
  @IsOptional()
  scheduledAt?: string;
}
