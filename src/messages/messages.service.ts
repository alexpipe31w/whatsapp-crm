import {
  Injectable, NotFoundException, ForbiddenException,
  Inject, forwardRef, Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { WhatsappService } from '../whatsapp/whatsapp.service';

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => WhatsappService))
    private whatsapp: WhatsappService,
  ) {}

  async create(dto: CreateMessageDto) {
    const conv = await this.prisma.conversation.findUnique({
      where:   { conversationId: dto.conversationId },
      include: { customer: true },
    });
    if (!conv) throw new NotFoundException('Conversación no encontrada');

    if (conv.storeId !== dto.storeId) {
      throw new ForbiddenException('El mensaje no pertenece a esta tienda');
    }

    const sender = dto.sender ?? (dto.isAiResponse ? 'store' : 'customer');

    // FIX: validar contenido — no guardar mensajes vacíos ni demasiado largos
    if (!dto.content?.trim()) {
      throw new Error('El contenido del mensaje no puede estar vacío');
    }
    if (dto.content.length > 65_536) {
      dto.content = dto.content.slice(0, 65_536);
    }

    const message = await this.prisma.message.create({
      data: {
        conversationId: dto.conversationId,
        storeId:        dto.storeId,
        content:        dto.content,
        type:           dto.type        ?? 'text',
        isAiResponse:   dto.isAiResponse ?? false,
        sender,
      },
    });

    // FIX: actualizar lastMessageAt con catch para no romper el flujo si falla
    await this.prisma.conversation.update({
      where: { conversationId: dto.conversationId },
      data:  { lastMessageAt: new Date() },
    }).catch(() => {});

    // Enviar por WhatsApp solo si es mensaje manual del asesor humano (no IA, no entrante)
    if (!dto.isAiResponse && sender === 'store') {
      try {
        await this.whatsapp.sendMessage(
          dto.storeId,
          conv.customer.phone,
          dto.content,
        );
      } catch (err: any) {
        // FIX: usar Logger de NestJS en lugar de console.error
        this.logger.warn(
          `Error enviando por WhatsApp a ${conv.customer.phone}: ${err.message}`,
        );
      }
    }

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