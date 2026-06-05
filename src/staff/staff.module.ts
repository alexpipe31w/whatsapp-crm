import { Module } from '@nestjs/common';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports:     [PrismaModule],
  controllers: [StaffController],
  providers:   [StaffService],
  exports:     [StaffService],
})
export class StaffModule {}
