import { Controller, Post, Get, Body, Query, UseGuards, Request } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { IsString, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class ChatMessageDto {
  @IsString() role: 'user' | 'assistant';
  @IsString() content: string;
}

class AiAdvisorDto {
  @IsString()                storeId:  string;
  @IsString()                context:  string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto) messages: ChatMessageDto[];
}

@UseGuards(JwtAuthGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  // AI Advisor chat — storeId desde el body (retrocompatible con el frontend actual)
  @Post('ai-advisor')
  askAdvisor(@Body() dto: AiAdvisorDto) {
    return this.analyticsService.askAdvisor(dto.storeId, dto.context, dto.messages);
  }

  // Análisis de satisfacción desde summaries de conversaciones archivadas
  @Post('conversation-insights')
  getConversationInsights(@Request() req: any) {
    return this.analyticsService.getConversationInsights(req.user.storeId);
  }

  // Tendencias de ingresos — ?days=30 (default) | ?days=14 | ?days=7
  @Get('trends')
  getRevenueTrends(@Request() req: any, @Query('days') daysStr?: string) {
    const days = Math.min(90, Math.max(7, parseInt(daysStr ?? '30') || 30));
    return this.analyticsService.getRevenueTrends(req.user.storeId, days);
  }
}
