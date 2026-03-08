import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [AiController], // ✅ faltaba esto
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}