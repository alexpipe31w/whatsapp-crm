import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { OutboundModule } from '../outbound/outbound.module';

@Module({
  imports: [PrismaModule, EmailModule, OutboundModule],
  providers:  [NotificationsService],
  exports:    [NotificationsService],
})
export class NotificationsModule {}
