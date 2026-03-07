import { Injectable, Logger } from '@nestjs/common';
import Groq from 'groq-sdk';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(private prisma: PrismaService) {}

  async generateReply(
    storeId: string,
    userMessage: string,
    conversationId: string,
  ): Promise<string | null> {
    try {
      // Obtener configuración AI de la tienda
      const config = await this.prisma.aIConfiguration.findUnique({
        where: { storeId },
      });

      if (!config) {
        this.logger.warn(`No hay AIConfiguration para store: ${storeId}`);
        return null;
      }

      // Obtener historial de la conversación (últimos 10 mensajes)
      const history = await this.prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
        take: 10,
      });

      const groq = new Groq({ apiKey: config.groqApiKey });

      // Construir mensajes con historial
      const messages: any[] = [
        { role: 'system', content: config.systemPrompt },
        ...history.map((m) => ({
          role: m.isAiResponse ? 'assistant' : 'user',
          content: m.content,
        })),
        { role: 'user', content: userMessage },
      ];

      const response = await groq.chat.completions.create({
        model: config.model,
        messages,
        temperature: Number(config.temperature),
        max_tokens: config.maxTokens,
      });

      return response.choices[0]?.message?.content ?? null;
    } catch (err) {
      this.logger.error(`Error generando respuesta IA: ${err.message}`);
      return null;
    }
  }
}
