import { Controller, Post, Get, Body, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAiConfigDto } from './dto/create-ai-config.dto';

@UseGuards(JwtAuthGuard)
@Controller('ai-config')
export class AiController {
  constructor(private prisma: PrismaService) {}

  @Post()
  async create(@Body() dto: CreateAiConfigDto) {
    return this.prisma.aIConfiguration.upsert({
      where: { storeId: dto.storeId },
      update: dto,
      create: dto,
    });
  }

  @Get(':storeId')
  async findOne(@Param('storeId') storeId: string) {
    return this.prisma.aIConfiguration.findUnique({ where: { storeId } });
  }
}
