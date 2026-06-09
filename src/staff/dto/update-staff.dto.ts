import { IsString, IsOptional, IsObject, IsBoolean, IsNumber, Min, Max, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateStaffDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string;

  @IsBoolean()
  @IsOptional()
  @Type(() => Boolean)
  isActive?: boolean;

  @IsObject()
  @IsOptional()
  schedule?: Record<string, any> | null;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(100)
  commissionPercentage?: number | null;
}
