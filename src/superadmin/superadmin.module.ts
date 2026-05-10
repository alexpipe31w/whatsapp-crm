import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SuperAdminController } from './superadmin.controller';
import { SuperAdminService } from './superadmin.service';
import { EmailService } from './email.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [SuperAdminController],
  providers: [SuperAdminService, EmailService],
})
export class SuperAdminModule {}
