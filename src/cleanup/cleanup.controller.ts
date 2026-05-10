import { Controller, Post, UseGuards, Headers, ForbiddenException } from '@nestjs/common';
import { CleanupService } from './cleanup.service';

@Controller('cleanup')
export class CleanupController {
  constructor(private readonly cleanupService: CleanupService) {}

  // Endpoint protegido por CRON_SECRET para forzar el cleanup desde Render Cron Jobs
  @Post('run')
  async triggerCleanup(@Headers('authorization') auth: string) {
    const secret = process.env.CRON_SECRET;
    if (!secret || auth !== `Bearer ${secret}`) {
      throw new ForbiddenException('No autorizado');
    }
    return this.cleanupService.runManual();
  }
}
