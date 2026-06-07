import { Controller, Post, Get, Body, Param, UseGuards, Request, ForbiddenException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAiConfigDto } from './dto/create-ai-config.dto';
import { getPoolSnapshot } from './key-pool';

@UseGuards(JwtAuthGuard)
@Controller('ai-config')
export class AiController {
  constructor(private prisma: PrismaService) {}

  @Post()
  async create(@Body() dto: CreateAiConfigDto, @Request() req: any) {
    const storeId = req.user.storeId;
    const { storeId: _ignored, ...updateData } = dto as any;
    return this.prisma.aIConfiguration.upsert({
      where: { storeId },
      update: updateData,
      create: { ...updateData, storeId },
    });
  }

  // IMPORTANTE: esta ruta estática DEBE ir antes de ':storeId' para que NestJS no la confunda
  @Get('pool-status')
  async poolStatus(@Request() req: any) {
    return getPoolSnapshot(req.user.storeId);
  }

  @Get(':storeId')
  async findOne(@Param('storeId') storeId: string, @Request() req: any) {
    if (req.user.storeId !== storeId)
      throw new ForbiddenException('No puedes ver la configuración de otra tienda');
    return this.prisma.aIConfiguration.findUnique({ where: { storeId } });
  }
}