import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
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

  async findOne(conversationId: string) {
    const conv = await this.prisma.conversation.findUnique({
      where: { conversationId },
      include: { customer: true },
    });
    if (!conv) throw new NotFoundException('Conversación no encontrada');
    return conv;
  }

  async findOrCreate(customerId: string, storeId: string) {
    const existing = await this.prisma.conversation.findFirst({
      where: { customerId, storeId, status: { not: 'closed' } },
      include: { customer: true },
    });
    if (existing) return existing;
    return this.prisma.conversation.create({
      data: { customerId, storeId, status: 'active' },
      include: { customer: true },
    });
  }

  async takeover(conversationId: string) {
    await this.findOne(conversationId);
    return this.prisma.conversation.update({
      where: { conversationId },
      data: { status: 'human' },
    });
  }

  async release(conversationId: string) {
    await this.findOne(conversationId);
    return this.prisma.conversation.update({
      where: { conversationId },
      data: { status: 'active' },
    });
  }

  async close(conversationId: string) {
    await this.findOne(conversationId);
    return this.prisma.conversation.update({
      where: { conversationId },
      data: { status: 'closed' },
    });
  }

  /**
   * Elimina la conversación y todos sus mensajes en cascada.
   * Solo se puede eliminar si está cerrada.
   * El customer y sus pedidos NO se ven afectados.
   */
  async remove(conversationId: string) {
    const conv = await this.findOne(conversationId);
    if (conv.status !== 'closed') {
      throw new BadRequestException('Solo se pueden eliminar conversaciones cerradas');
    }
    // Eliminar mensajes primero (o si tienes onDelete: Cascade en el schema ya lo hace solo)
    await this.prisma.message.deleteMany({ where: { conversationId } });
    await this.prisma.conversation.delete({ where: { conversationId } });
    return { deleted: true, conversationId };
  }
}
