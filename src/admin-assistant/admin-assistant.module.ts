import { Module } from '@nestjs/common';
import { AdminAssistantService } from './admin-assistant.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports:   [PrismaModule],
  providers: [AdminAssistantService],
  exports:   [AdminAssistantService],
})
export class AdminAssistantModule {}
