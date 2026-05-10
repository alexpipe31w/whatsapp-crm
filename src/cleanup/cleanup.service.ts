import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import Groq from 'groq-sdk';
import { PrismaService } from '../prisma/prisma.service';

// Conversaciones que llevan +24h sin actividad y no están en manos de un asesor
const ARCHIVE_AFTER_HOURS   = 24;
// Mensajes archivados con más de N días se eliminan definitivamente
const PURGE_ARCHIVED_DAYS   = 90;
// Tamaño de lote para no saturar la BD
const BATCH_SIZE            = 20;
// Groq model rápido y barato para resúmenes
const SUMMARY_MODEL         = 'llama-3.1-8b-instant';
const SUMMARY_MAX_TOKENS    = 200;
const SUMMARY_TIMEOUT_MS    = 15_000;

@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);
  private readonly groqClients = new Map<string, Groq>();

  constructor(private readonly prisma: PrismaService) {}

  private getGroq(apiKey: string): Groq {
    if (!this.groqClients.has(apiKey)) {
      this.groqClients.set(apiKey, new Groq({ apiKey }));
    }
    return this.groqClients.get(apiKey)!;
  }

  // ─── Cron: medianoche Colombia (UTC-5 = 05:00 UTC) ──────────────────────────
  // "0 5 * * *" = las 5:00 AM UTC = medianoche hora Colombia
  @Cron('0 5 * * *', { name: 'daily-archive', timeZone: 'UTC' })
  async runDailyArchive(): Promise<void> {
    this.logger.log('🧹 Iniciando limpieza nocturna de conversaciones...');
    const start = Date.now();

    const cutoff = new Date(Date.now() - ARCHIVE_AFTER_HOURS * 60 * 60 * 1000);

    // Cargar todas las configuraciones de IA (para generar resúmenes)
    const aiConfigs = await this.prisma.aIConfiguration.findMany({
      select: { storeId: true, groqApiKey: true },
    });
    const aiConfigMap = new Map(aiConfigs.map(c => [c.storeId, c.groqApiKey]));

    let totalArchived = 0;
    let offset = 0;

    while (true) {
      const conversations = await this.prisma.conversation.findMany({
        where: {
          lastMessageAt: { lt: cutoff },
          status: { notIn: ['closed', 'archived', 'human'] },
          // Solo archivar si tienen mensajes
          messages: { some: {} },
        },
        select: {
          conversationId: true,
          storeId: true,
          customerId: true,
          status: true,
          messages: {
            orderBy: { createdAt: 'asc' },
            select: {
              messageId: true,
              content:   true,
              type:      true,
              sender:    true,
              isAiResponse: true,
              createdAt: true,
            },
          },
        },
        take: BATCH_SIZE,
        skip: offset,
      });

      if (conversations.length === 0) break;

      for (const conv of conversations) {
        try {
          await this.archiveConversation(conv, aiConfigMap);
          totalArchived++;
        } catch (err: any) {
          this.logger.error(`Error archivando conv ${conv.conversationId}: ${err.message}`);
        }
      }

      offset += BATCH_SIZE;
      // Pequeña pausa entre lotes para no saturar Neon con escrituras
      await new Promise(r => setTimeout(r, 200));
    }

    // Purgar ArchivedMessages muy antiguos para mantener la tabla pequeña
    const purgeBefore = new Date(Date.now() - PURGE_ARCHIVED_DAYS * 24 * 60 * 60 * 1000);
    const { count: purged } = await this.prisma.archivedMessage.deleteMany({
      where: { archivedAt: { lt: purgeBefore } },
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    this.logger.log(
      `✅ Limpieza completada en ${elapsed}s — ` +
      `${totalArchived} conversaciones archivadas, ${purged} mensajes purgados`
    );
  }

  private async archiveConversation(
    conv: {
      conversationId: string;
      storeId: string;
      customerId: string;
      status: string;
      messages: Array<{
        messageId: string; content: string; type: string;
        sender: string; isAiResponse: boolean; createdAt: Date;
      }>;
    },
    aiConfigMap: Map<string, string>,
  ): Promise<void> {
    const { conversationId, storeId, customerId, messages } = conv;

    // 1. Generar resumen del cliente si hay API key disponible
    const groqApiKey = aiConfigMap.get(storeId);
    if (groqApiKey && messages.length >= 2) {
      try {
        const summary = await this.generateSummary(groqApiKey, messages);
        if (summary) {
          await this.prisma.customer.update({
            where: { customerId },
            data:  { lastConversationSummary: summary },
          });
        }
      } catch (err: any) {
        this.logger.warn(`No se pudo generar resumen para ${conversationId}: ${err.message}`);
      }
    }

    // 2. Mover mensajes a archived_messages + eliminar de messages (transacción)
    await this.prisma.$transaction(async (tx) => {
      // Insertar en archived_messages
      if (messages.length > 0) {
        await tx.archivedMessage.createMany({
          data: messages.map(m => ({
            messageId:     m.messageId,
            conversationId,
            storeId,
            content:       m.content,
            type:          m.type,
            sender:        m.sender,
            isAiResponse:  m.isAiResponse,
            createdAt:     m.createdAt,
          })),
          skipDuplicates: true,
        });

        // Eliminar de messages
        await tx.message.deleteMany({
          where: { conversationId },
        });
      }

      // Marcar conversación como archivada
      await tx.conversation.update({
        where: { conversationId },
        data:  { status: 'archived', archivedAt: new Date() },
      });
    });

    this.logger.debug(`📦 Conv ${conversationId} archivada (${messages.length} msgs)`);
  }

  private async generateSummary(
    groqApiKey: string,
    messages: Array<{ content: string; isAiResponse: boolean; sender: string }>,
  ): Promise<string | null> {
    const conversationText = messages
      .filter(m => m.content.length > 2)
      .map(m => `${m.isAiResponse ? 'Asistente' : 'Cliente'}: ${m.content.trim()}`)
      .join('\n');

    // Si la conversación es muy corta o solo saludos, no generar resumen
    const clientMessages = messages.filter(m => !m.isAiResponse);
    if (clientMessages.length < 2) return null;

    const prompt = `Eres un asistente que genera resúmenes de conversaciones de WhatsApp para dar contexto en futuras interacciones.

CONVERSACIÓN:
${conversationText.slice(0, 3000)}

Genera un resumen BREVE y útil (máximo 80 palabras) en español que incluya:
- Qué necesitaba o preguntó el cliente
- Si realizó compra o agendó cita (con detalles básicos)
- Información personal mencionada (nombre, ciudad, preferencias)
- Estado final de la conversación

Responde SOLO con el resumen, sin encabezados ni puntos.`;

    try {
      const response: any = await Promise.race([
        this.getGroq(groqApiKey).chat.completions.create({
          model:       SUMMARY_MODEL,
          messages:    [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens:  SUMMARY_MAX_TOKENS,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Summary timeout')), SUMMARY_TIMEOUT_MS)
        ),
      ]);
      return response.choices[0]?.message?.content?.trim() ?? null;
    } catch {
      return null;
    }
  }

  // ─── Endpoint manual para forzar cleanup (útil para testing) ─────────────────
  async runManual(): Promise<{ message: string }> {
    this.runDailyArchive().catch(err =>
      this.logger.error(`Error en cleanup manual: ${err.message}`)
    );
    return { message: 'Cleanup iniciado en segundo plano' };
  }
}
