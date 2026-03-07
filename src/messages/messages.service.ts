import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMessageDto } from './dto/create-message.dto';

@Injectable()
export class MessagesService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateMessageDto) {
    const conv = await this.prisma.conversation.findUnique({
      where: { conversationId: dto.conversationId },
    });
    if (!conv) throw new NotFoundException('Conversación no encontrada');

    const message = await this.prisma.message.create({
      data: {
        conversationId: dto.conversationId,
        storeId: dto.storeId,
        content: dto.content,
        type: dto.type ?? 'text',
        isAiResponse: dto.isAiResponse ?? false,
      },
    });

    // Actualizar lastMessageAt de la conversación
    await this.prisma.conversation.update({
      where: { conversationId: dto.conversationId },
      data: { lastMessageAt: new Date() },
    });

    return message;
  }

  async findByConversation(conversationId: string) {
    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
