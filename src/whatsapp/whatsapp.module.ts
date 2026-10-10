import { Module, forwardRef } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { MessagesModule } from '../messages/messages.module';
import { CustomersModule } from '../customers/customers.module';
import { BlockedModule } from '../blocked/blocked.module';
import { AdminAssistantModule } from '../admin-assistant/admin-assistant.module';
import { OutboundModule } from '../outbound/outbound.module';
import { WA_TRANSPORT } from './wa-transport';

@Module({
  imports: [
    PrismaModule,
    AiModule,
    ConversationsModule,
    forwardRef(() => MessagesModule),
    CustomersModule,
    BlockedModule,
    AdminAssistantModule,
    OutboundModule,
  ],
  controllers: [WhatsappController],
  providers: [
    WhatsappService,
    { provide: WA_TRANSPORT, useExisting: WhatsappService },
  ],
  exports: [WhatsappService, WA_TRANSPORT],
})
export class WhatsappModule {}