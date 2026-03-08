import { Injectable, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { WhatsappService } from '../whatsapp/whatsapp.service';

@Injectable()
export class MessagesService {
  constructor(
    private prisma: PrismaService,
    // ✅ forwardRef en el constructor para que NestJS resuelva el ciclo en runtime
    @Inject(forwardRef(() => WhatsappService))
    private whatsapp: WhatsappService,
  ) {}

  async create(dto: CreateMessageDto) {
    const conv = await this.prisma.conversation.findUnique({
      where: { conversationId: dto.conversationId },
      include: { customer: true },
    });
    if (!conv) throw new NotFoundException('Conversación no encontrada');

    const message = await this.prisma.message.create({
      data: {
        conversationId: dto.conversationId,
        storeId: dto.storeId,
        content: dto.content,
        type: dto.type ?? 'text',
        isAiResponse: dto.isAiResponse ?? false,
        sender: dto.sender ?? (dto.isAiResponse ? 'store' : 'store'),
      },
    });

    await this.prisma.conversation.update({
      where: { conversationId: dto.conversationId },
      data: { lastMessageAt: new Date() },
    });

    // Solo enviar por WhatsApp si es mensaje del asesor humano (no IA, no entrante)
    if (!dto.isAiResponse && dto.sender === 'store') {
      try {
        await this.whatsapp.sendMessage(
          dto.storeId,
          conv.customer.phone,
          dto.content,
        );
      } catch (err) {
        console.error('Error enviando por WhatsApp:', err);
      }
    }

    return message;
  }

  async findByConversation(conversationId: string) {
    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });
  }
}