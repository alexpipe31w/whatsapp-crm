import { Controller, Post, Get, Query, UseGuards, Request, HttpCode, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  private readonly logger = new Logger(ReportsController.name);

  constructor(
    private readonly reports: ReportsService,
    private readonly prisma:  PrismaService,
  ) {}

  @Post('generate')
  @HttpCode(202)
  async generate(@Request() req: any) {
    const storeId: string = req.user.storeId;
    this.reports
      .generateAndSendReport(storeId, { manualRequestId: randomUUID() })
      .catch((err: any) => this.logger.error(`[reportes] manual (store ${storeId}): ${err.message}`));
    return { message: 'Reporte en generación, recibirás el resultado por email y WA.' };
  }

  @Get('daily')
  async getDailyReports(
    @Request() req: any,
    @Query('limit') limit?: string,
  ) {
    return this.prisma.dailyReport.findMany({
      where:   { storeId: req.user.storeId },
      orderBy: { date: 'desc' },
      take:    Math.max(1, parseInt(limit ?? '30') || 30),
    });
  }
}
