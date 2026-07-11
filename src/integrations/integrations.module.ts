// src/integrations/integrations.module.ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SyncService } from './sync.service';
import { IntegrationsController } from './integrations.controller';

@Module({
  imports: [PrismaModule],
  controllers: [IntegrationsController],
  providers: [SyncService],
  exports: [SyncService],
})
export class IntegrationsModule {}
