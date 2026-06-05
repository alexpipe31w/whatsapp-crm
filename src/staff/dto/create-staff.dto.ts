import { IsString, IsOptional, IsObject, MaxLength } from 'class-validator';

export class CreateStaffDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsObject()
  @IsOptional()
  schedule?: Record<string, any> | null;
}
