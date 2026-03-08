import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { IsString, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class ChatMessageDto {
  @IsString()
  role: 'user' | 'assistant';

  @IsString()
  content: string;
}

class AiAdvisorDto {
  @IsString()
  storeId: string;

  @IsString()
  context: string; // resumen de datos del negocio (calculado en frontend)

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  messages: ChatMessageDto[];
}

@UseGuards(JwtAuthGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Post('ai-advisor')
  askAdvisor(@Body() dto: AiAdvisorDto) {
    return this.analyticsService.askAdvisor(dto.storeId, dto.context, dto.messages);
  }
}
