import { Module } from '@nestjs/common';
import { AutoConfirmService } from './auto-confirm.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AppointmentsModule } from '../appointments/appointments.module';

@Module({
  imports:   [PrismaModule, AppointmentsModule],
  providers: [AutoConfirmService],
  exports:   [AutoConfirmService],
})
export class AutoConfirmModule {}
