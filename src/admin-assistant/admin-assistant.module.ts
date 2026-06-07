import { Module } from '@nestjs/common';
import { AdminAssistantService } from './admin-assistant.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CustomersModule } from '../customers/customers.module';

@Module({
  imports:   [PrismaModule, CustomersModule],
  providers: [AdminAssistantService],
  exports:   [AdminAssistantService],
})
export class AdminAssistantModule {}
