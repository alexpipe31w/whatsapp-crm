import { Module, forwardRef } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { MessagesModule } from '../messages/messages.module';
import { CustomersModule } from '../customers/customers.module';

@Module({
  imports: [
    PrismaModule,
    AiModule,
    ConversationsModule,
    forwardRef(() => MessagesModule), // ✅ forwardRef en ambos lados del ciclo
    CustomersModule,
  ],
  controllers: [WhatsappController],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}