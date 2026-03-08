import { Module } from '@nestjs/common';
import { BlockedController } from './blocked.controller';
import { BlockedService } from './blocked.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [BlockedController],
  providers: [BlockedService],
  exports: [BlockedService],
})
export class BlockedModule {}