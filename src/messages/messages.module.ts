import { Module, forwardRef } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { MessagesController } from './messages.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

// La dependencia circular Messages ↔ Whatsapp es legítima:
//   WhatsappService  → crea mensajes entrantes (MessagesService.create)
//   MessagesService  → envía por WA mensajes del asesor (WhatsappService.sendMessage)
// NestJS resuelve esto con forwardRef() en ambos lados.

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => WhatsappModule), // ✅ rompe el ciclo
  ],
  controllers: [MessagesController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}