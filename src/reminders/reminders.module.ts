import { Module } from '@nestjs/common';
import { RemindersService } from './reminders.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, NotificationsModule],
  providers: [RemindersService],
  exports:   [RemindersService],
})
export class RemindersModule {}
