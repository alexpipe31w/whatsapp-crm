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
    if (storeId && conv.storeId !== storeId) {
      throw new ForbiddenException('No tienes acceso a esta conversación');
    }
    return conv;
  }

  // FIX: race condition — si dos procesos crean la conversación al mismo tiempo,
  // el P2002 se captura y se devuelve la que ganó la carrera.
  async findOrCreate(customerId: string, storeId: string) {
    const existing = await this.prisma.conversation.findFirst({
      where: { customerId, storeId, status: { not: 'closed' } },
      include: { customer: true },
    });
    if (existing) return existing;

    try {
      return await this.prisma.conversation.create({
        data: { customerId, storeId, status: 'active' },
        include: { customer: true },
      });
    } catch (err: any) {
      // P2002 = unique constraint — otro proceso creó la conversación primero
      if (err?.code === 'P2002') {
        const conv = await this.prisma.conversation.findFirst({
          where: { customerId, storeId, status: { not: 'closed' } },
          include: { customer: true },
        });
        if (conv) return conv;
      }
      throw err;
    }
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

  // FIX: borrado en transacción para evitar conversación huérfana sin mensajes
  async remove(conversationId: string, storeId?: string) {
    const conv = await this.findOne(conversationId, storeId);
    if (conv.status !== 'closed') {
      throw new BadRequestException('Solo se pueden eliminar conversaciones cerradas');
    }
    await this.prisma.$transaction([
      this.prisma.message.deleteMany({ where: { conversationId } }),
      this.prisma.conversation.delete({ where: { conversationId } }),
    ]);
    return { deleted: true, conversationId };
  }
}