import { Module, forwardRef } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [
    PrismaModule,
    EmailModule,
    forwardRef(() => WhatsappModule),
  ],
  providers:  [NotificationsService],
  exports:    [NotificationsService],
})
export class NotificationsModule {}
