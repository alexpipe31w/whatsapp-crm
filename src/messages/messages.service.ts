import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { OutboundService } from '../outbound/outbound.service';
import { outboundKeys } from '../outbound/outbound-keys';

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private prisma: PrismaService,
    private outbound: OutboundService,
  ) {}

  /** Guarda un mensaje en el historial. NUNCA envía por WhatsApp (lo usa el flujo de entrada). */
  async record(dto: CreateMessageDto) {
    const conv = await this.prisma.conversation.findUnique({
      where: { conversationId: dto.conversationId },
    });
    if (!conv) throw new NotFoundException('Conversación no encontrada');
    if (conv.storeId !== dto.storeId) {
      throw new ForbiddenException('El mensaje no pertenece a esta tienda');
    }
    if (!dto.content?.trim()) {
      throw new BadRequestException('El contenido del mensaje no puede estar vacío');
    }
    const content = dto.content.length > 65_536 ? dto.content.slice(0, 65_536) : dto.content;
    const sender = dto.sender ?? (dto.isAiResponse ? 'store' : 'customer');

    const message = await this.prisma.message.create({
      data: {
        conversationId: dto.conversationId,
        storeId:        conv.storeId,
        content,
        type:           dto.type ?? 'text',
        isAiResponse:   dto.isAiResponse ?? false,
        sender,
      },
    });

    await this.prisma.conversation.update({
      where: { conversationId: dto.conversationId },
      data:  { lastMessageAt: new Date() },
    }).catch(err => this.logger.warn(
      `lastMessageAt no actualizado (conv ${dto.conversationId}): ${err.message}`,
    ));

    return message;
  }

  /**
   * Entrada del panel. Si es del asesor (store, no IA), el mensaje, lastMessageAt y el
   * encolado en wa_outbound van en UNA transacción: o queda todo o nada. Antes un fallo
   * de WhatsApp devolvía 200 y el mensaje constaba como enviado sin haber salido.
   */
  async create(dto: CreateMessageDto) {
    const sender = dto.sender ?? (dto.isAiResponse ? 'store' : 'customer');
    if (dto.isAiResponse || sender !== 'store') return this.record(dto);

    const conv = await this.prisma.conversation.findUnique({
      where:   { conversationId: dto.conversationId },
      include: { customer: true },
    });
    if (!conv) throw new NotFoundException('Conversación no encontrada');
    if (conv.storeId !== dto.storeId) {
      throw new ForbiddenException('El mensaje no pertenece a esta tienda');
    }
    if (!dto.content?.trim()) {
      throw new BadRequestException('El contenido del mensaje no puede estar vacío');
    }

    const message = await this.prisma.$transaction(async (tx) => {
      const m = await tx.message.create({
        data: {
          conversationId: dto.conversationId,
          storeId:        conv.storeId,
          content:        dto.content,
          type:           dto.type ?? 'text',
          isAiResponse:   false,
          sender,
        },
      });
      await tx.conversation.update({
        where: { conversationId: dto.conversationId },
        data:  { lastMessageAt: new Date() },
      });
      const result = await this.outbound.enqueue(
        {
          storeId: conv.storeId,
          to:      conv.customer.phone,
          text:    dto.content,
          kind:    'reply',
          key:     outboundKeys.agentMessage(m.messageId),
        },
        tx,
      );
      if (result === 'invalid') {
        throw new BadRequestException('Este cliente no tiene un número de WhatsApp al que escribir');
      }
      return m;
    });
    this.outbound.wake();
    return message;
  }

  async findByConversation(conversationId: string, storeId?: string) {
    if (storeId) {
      const conv = await this.prisma.conversation.findUnique({
        where: { conversationId },
      });
      if (!conv) throw new NotFoundException('Conversación no encontrada');
      if (conv.storeId !== storeId) {
        throw new ForbiddenException('No tienes acceso a esta conversación');
      }
    }

    return this.prisma.message.findMany({
      where:   { conversationId },
      orderBy: { createdAt: 'asc' },
    });
  }
}