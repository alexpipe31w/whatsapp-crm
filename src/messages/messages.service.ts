import { Injectable, NotFoundException, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { WhatsappService } from '../whatsapp/whatsapp.service';

@Injectable()
export class MessagesService {
  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => WhatsappService))
    private whatsapp: WhatsappService,
  ) {}

  async create(dto: CreateMessageDto) {
    const conv = await this.prisma.conversation.findUnique({
      where: { conversationId: dto.conversationId },
      include: { customer: true },
    });
    if (!conv) throw new NotFoundException('Conversación no encontrada');

    // Verificar que el storeId del mensaje coincide con el de la conversación
    if (conv.storeId !== dto.storeId) {
      throw new ForbiddenException('El mensaje no pertenece a esta tienda');
    }

    // Bug fix: el sender debe venir del dto, con fallback lógico correcto
    const sender = dto.sender ?? (dto.isAiResponse ? 'store' : 'customer');

    const message = await this.prisma.message.create({
      data: {
        conversationId: dto.conversationId,
        storeId: dto.storeId,
        content: dto.content,
        type: dto.type ?? 'text',
        isAiResponse: dto.isAiResponse ?? false,
        sender,
      },
    });

    // Actualizar timestamp de último mensaje
    await this.prisma.conversation.update({
      where: { conversationId: dto.conversationId },
      data: { lastMessageAt: new Date() },
    });

    // Enviar por WhatsApp solo si es mensaje manual del asesor humano (no IA, no entrante)
    if (!dto.isAiResponse && sender === 'store') {
      try {
        await this.whatsapp.sendMessage(
          dto.storeId,
          conv.customer.phone,
          dto.content,
        );
      } catch (err: any) {
        // Log pero no lanzar — el mensaje ya se guardó en BD
        console.error(`Error enviando por WhatsApp a ${conv.customer.phone}:`, err.message);
      }
    }

    return message;
  }

  async findByConversation(conversationId: string, storeId?: string) {
    // Validar que la conversación existe y pertenece a la tienda
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
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });
  }
}