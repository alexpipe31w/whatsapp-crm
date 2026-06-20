import { Module } from '@nestjs/common';
import { AutoConfirmService } from './auto-confirm.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AppointmentsModule } from '../appointments/appointments.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports:   [PrismaModule, AppointmentsModule, NotificationsModule],
  providers: [AutoConfirmService],
  exports:   [AutoConfirmService],
})
export class AutoConfirmModule {}
