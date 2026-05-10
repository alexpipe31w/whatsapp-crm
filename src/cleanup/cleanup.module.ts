import { Module } from '@nestjs/common';
import { CleanupService } from './cleanup.service';
import { CleanupController } from './cleanup.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [CleanupService],
  controllers: [CleanupController],
  exports: [CleanupService],
})
export class CleanupModule {}
