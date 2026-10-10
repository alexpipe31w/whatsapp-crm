import { Module } from '@nestjs/common';
import { AdminAssistantService } from './admin-assistant.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CustomersModule } from '../customers/customers.module';
import { OutboundModule } from '../outbound/outbound.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports:   [PrismaModule, CustomersModule, OutboundModule, NotificationsModule],
  providers: [AdminAssistantService],
  exports:   [AdminAssistantService],
})
export class AdminAssistantModule {}
