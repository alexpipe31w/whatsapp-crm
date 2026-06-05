import { IsString, IsOptional, IsObject, IsBoolean, MaxLength } from 'class-validator';
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
}
