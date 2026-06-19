import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createCompletion, PROVIDER_CONFIG, AIProvider } from '../ai/providers';
import { PrismaService } from '../prisma/prisma.service';

// Conversaciones con +24h de VIDA (desde su creación) se borran SIEMPRE — tengan o no
// actividad reciente — conservando solo el resumen IA del contexto.
// (Antes: 24h SIN actividad → las conversaciones activas nunca se borraban.)
const CLEANUP_AFTER_HOURS   = 24;
// Tamaño de lote para no saturar la BD
const BATCH_SIZE            = 20;
const SUMMARY_MAX_TOKENS = 200;
const SUMMARY_TIMEOUT_MS    = 15_000;

@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Cron: medianoche Colombia (UTC-5 = 05:00 UTC) ──────────────────────────
  // "0 5 * * *" = 05:00 UTC = medianoche hora Colombia. Corre 1 vez al día en la
  // madrugada (hora muerta) para no borrar chats activos durante el día.
  @Cron('0 5 * * *', { name: 'daily-cleanup', timeZone: 'UTC' })
  async runDailyCleanup(): Promise<void> {
    this.logger.log('🧹 Limpieza nocturna: borrando conversaciones con +24h de vida...');
    const start = Date.now();

    const cutoff = new Date(Date.now() - CLEANUP_AFTER_HOURS * 60 * 60 * 1000);

    // Cargar todas las configuraciones de IA (para generar resúmenes)
    const aiConfigs = await this.prisma.aIConfiguration.findMany({
      select: { storeId: true, aiProvider: true, apiKey: true },
    });
    const aiConfigMap = new Map(
      aiConfigs.map(c => [c.storeId, { provider: c.aiProvider as AIProvider, apiKey: c.apiKey }])
    );

    let totalDeleted = 0;
    let totalMsgs    = 0;
    // IDs que fallaron: se excluyen del query para no reprocesarlos en bucle
    // (ya no se usa `skip` porque cada lote se BORRA — el siguiente findMany trae los siguientes)
    const failedIds: string[] = [];

    while (true) {
      const conversations = await this.prisma.conversation.findMany({
        where: {
          createdAt: { lt: cutoff },
          // Cualquier estado (incluidos closed/human) y CON o SIN actividad reciente:
          // solo importa que la conversación tenga +24h de vida desde su creación.
          messages: { some: {} },
          ...(failedIds.length ? { conversationId: { notIn: failedIds } } : {}),
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
      });

      if (conversations.length === 0) break;

      for (const conv of conversations) {
        try {
          const n = await this.purgeConversation(conv, aiConfigMap);
          totalDeleted++;
          totalMsgs += n;
        } catch (err: any) {
          failedIds.push(conv.conversationId);
          this.logger.error(`Error borrando conv ${conv.conversationId}: ${err.message}`);
        }
      }

      // Pequeña pausa entre lotes para no saturar la BD con escrituras
      await new Promise(r => setTimeout(r, 200));
    }

    // Legado: drenar lo que dejó el antiguo archivado (tabla archived_messages + conversaciones marcadas 'archived' sin mensajes)
    const { count: purgedArchived } = await this.prisma.archivedMessage.deleteMany({});
    const { count: purgedLegacyConvs } = await this.prisma.conversation.deleteMany({
      where: { status: 'archived', messages: { none: {} } },
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    this.logger.log(
      `✅ Limpieza completada en ${elapsed}s — ` +
      `${totalDeleted} conversaciones y ${totalMsgs} mensajes borrados` +
      (purgedArchived || purgedLegacyConvs
        ? ` (legado: ${purgedArchived} archived_messages + ${purgedLegacyConvs} conv archivadas)`
        : '')
    );
  }

  /**
   * Genera el resumen IA de la conversación (lo guarda en el cliente) y luego
   * BORRA definitivamente sus mensajes y la conversación. Nunca toca clientes
   * (salvo el resumen) ni ventas. Devuelve cuántos mensajes se borraron.
   */
  private async purgeConversation(
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
    aiConfigMap: Map<string, { provider: AIProvider; apiKey: string }>,
  ): Promise<number> {
    const { conversationId, storeId, customerId, messages } = conv;

    // 1. Generar y guardar el resumen del cliente (se conserva tras borrar la conversación)
    const aiInfo = aiConfigMap.get(storeId);
    if (aiInfo && messages.length >= 2) {
      try {
        const summary = await this.generateSummary(aiInfo.provider, aiInfo.apiKey, messages);
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

    // 2. Borrado definitivo: mensajes primero (FK), luego la conversación (transacción atómica)
    await this.prisma.$transaction(async (tx) => {
      await tx.message.deleteMany({ where: { conversationId } });
      await tx.conversation.delete({ where: { conversationId } });
    });

    this.logger.debug(`🗑️ Conv ${conversationId} borrada (${messages.length} msgs)`);
    return messages.length;
  }

  private async generateSummary(
    provider: AIProvider,
    apiKey: string,
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
      const text = await Promise.race([
        createCompletion(provider, apiKey, PROVIDER_CONFIG[provider].defaultFastModel,
          [{ role: 'user', content: prompt }], 0.3, SUMMARY_MAX_TOKENS),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Summary timeout')), SUMMARY_TIMEOUT_MS)
        ),
      ]);
      return text.trim() || null;
    } catch {
      return null;
    }
  }

  // ─── Endpoint manual para forzar cleanup (útil para testing) ─────────────────
  async runManual(): Promise<{ message: string }> {
    this.runDailyCleanup().catch(err =>
      this.logger.error(`Error en cleanup manual: ${err.message}`)
    );
    return { message: 'Cleanup iniciado en segundo plano' };
  }
}
