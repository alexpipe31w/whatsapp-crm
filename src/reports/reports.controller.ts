import { Controller, Post, Get, Query, UseGuards, Request, HttpCode } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly prisma:  PrismaService,
  ) {}

  @Post('generate')
  @HttpCode(202)
  async generate(@Request() req: any) {
    this.reports.generateAndSendReport(req.user.storeId).catch(() => {});
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
      take:    parseInt(limit ?? '30'),
    });
  }
}
