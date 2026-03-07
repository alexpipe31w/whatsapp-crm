import { IsString, IsOptional } from 'class-validator';

export class UpdateConversationDto {
  @IsString()
  @IsOptional()
  status?: string; // 'active' | 'closed' | 'pending'
}
