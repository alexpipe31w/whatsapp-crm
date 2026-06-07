import { Module } from '@nestjs/common';
import { PublicController } from './public.controller';
import { PublicService } from './public.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CustomersModule } from '../customers/customers.module';
import { AppointmentsModule } from '../appointments/appointments.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports:     [PrismaModule, CustomersModule, AppointmentsModule, NotificationsModule],
  controllers: [PublicController],
  providers:   [PublicService],
  exports:     [PublicService],
})
export class PublicModule {}
