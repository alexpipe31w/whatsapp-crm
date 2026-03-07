import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { UpdateConversationDto } from './dto/update-conversation.dto';

@Injectable()
export class ConversationsService {
  constructor(private prisma: PrismaService) {}

  async findOrCreate(dto: CreateConversationDto) {
    const existing = await this.prisma.conversation.findFirst({
      where: {
        storeId: dto.storeId,
        customerId: dto.customerId,
        status: { not: 'closed' },
      },
      include: {
        customer: true,
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (existing) return existing;

    return this.prisma.conversation.create({
      data: {
        storeId: dto.storeId,
        customerId: dto.customerId,
      },
      include: { customer: true, messages: true },
    });
  }

  async findAllByStore(storeId: string) {
    return this.prisma.conversation.findMany({
      where: { storeId },
      include: {
        customer: true,
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { lastMessageAt: 'desc' },
    });
  }

  async findOne(conversationId: string) {
    const conv = await this.prisma.conversation.findUnique({
      where: { conversationId },
      include: {
        customer: true,
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!conv) throw new NotFoundException('Conversación no encontrada');
    return conv;
  }

  async updateStatus(conversationId: string, dto: UpdateConversationDto) {
    await this.findOne(conversationId);
    return this.prisma.conversation.update({
      where: { conversationId },
      data: dto,
    });
  }
    // Tomar control humano de una conversación
  async takeoverHuman(conversationId: string) {
    await this.findOne(conversationId);
    return this.prisma.conversation.update({
      where: { conversationId },
      data: { status: 'human' },
    });
  }

  // Devolver control a la IA
  async releaseToAI(conversationId: string) {
    await this.findOne(conversationId);
    return this.prisma.conversation.update({
      where: { conversationId },
      data: { status: 'active' },
    });
  }

  // Cerrar conversación
  async close(conversationId: string) {
    await this.findOne(conversationId);
    return this.prisma.conversation.update({
      where: { conversationId },
      data: { status: 'closed' },
    });
  }

  // Listar conversaciones que esperan humano
  async findPendingHuman(storeId: string) {
    return this.prisma.conversation.findMany({
      where: { storeId, status: { in: ['pending_human', 'human'] } },
      include: {
        customer: true,
        messages: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
      orderBy: { lastMessageAt: 'desc' },
    });
  }
}
