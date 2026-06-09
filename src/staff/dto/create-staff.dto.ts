import { IsString, IsOptional, IsObject, IsNumber, Min, Max, MaxLength } from 'class-validator';

export class CreateStaffDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsObject()
  @IsOptional()
  schedule?: Record<string, any> | null;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(100)
  commissionPercentage?: number | null;
}
