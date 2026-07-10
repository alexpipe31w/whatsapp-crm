// src/integrations/integrations.module.ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SyncService } from './sync.service';

@Module({
  imports: [PrismaModule],
  providers: [SyncService],
  exports: [SyncService],
})
export class IntegrationsModule {}
