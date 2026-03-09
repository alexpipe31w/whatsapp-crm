import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ConversationsService {
  constructor(private prisma: PrismaService) {}

  async findAllByStore(storeId: string) {
    return this.prisma.conversation.findMany({
      where: { storeId },
      include: { customer: true },
      orderBy: { lastMessageAt: 'desc' },
    });
  }

  async findOne(conversationId: string, storeId?: string) {
    const conv = await this.prisma.conversation.findUnique({
      where: { conversationId },
      include: { customer: true },
    });
    if (!conv) throw new NotFoundException('Conversación no encontrada');
    // Si se pasa storeId, verificar que la conversación pertenece a esa tienda
    if (storeId && conv.storeId !== storeId) {
      throw new ForbiddenException('No tienes acceso a esta conversación');
    }
    return conv;
  }

  async findOrCreate(customerId: string, storeId: string) {
    // Upsert manual con transacción para evitar race condition
    // si dos mensajes llegan al mismo tiempo para el mismo cliente
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.conversation.findFirst({
        where: { customerId, storeId, status: { not: 'closed' } },
        include: { customer: true },
      });
      if (existing) return existing;

      return tx.conversation.create({
        data: { customerId, storeId, status: 'active' },
        include: { customer: true },
      });
    });
  }

  async takeover(conversationId: string, storeId?: string) {
    const conv = await this.findOne(conversationId, storeId);
    if (conv.status === 'closed') {
      throw new BadRequestException('No se puede tomar una conversación cerrada');
    }
    return this.prisma.conversation.update({
      where: { conversationId },
      data: { status: 'human' },
    });
  }

  async release(conversationId: string, storeId?: string) {
    const conv = await this.findOne(conversationId, storeId);
    if (!['human', 'pending_human'].includes(conv.status)) {
      throw new BadRequestException('La conversación ya está activa o cerrada');
    }
    return this.prisma.conversation.update({
      where: { conversationId },
      data: { status: 'active' },
    });
  }

  async close(conversationId: string, storeId?: string) {
    await this.findOne(conversationId, storeId);
    return this.prisma.conversation.update({
      where: { conversationId },
      data: { status: 'closed' },
    });
  }

  async remove(conversationId: string, storeId?: string) {
    const conv = await this.findOne(conversationId, storeId);
    if (conv.status !== 'closed') {
      throw new BadRequestException('Solo se pueden eliminar conversaciones cerradas');
    }
    await this.prisma.message.deleteMany({ where: { conversationId } });
    await this.prisma.conversation.delete({ where: { conversationId } });
    return { deleted: true, conversationId };
  }
}
