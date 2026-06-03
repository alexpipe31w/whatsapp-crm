import { Module, forwardRef } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailModule } from '../email/email.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    EmailModule,
    forwardRef(() => WhatsappModule),
  ],
  controllers: [ReportsController],
  providers:   [ReportsService],
  exports:     [ReportsService],
})
export class ReportsModule {}
