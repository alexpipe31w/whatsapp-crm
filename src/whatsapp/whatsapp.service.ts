import {
  Injectable, Logger, OnModuleInit, Inject, forwardRef,
} from '@nestjs/common';
import { Boom } from '@hapi/boom';
import * as qrcode from 'qrcode-terminal';
import P from 'pino';
import { AiService } from '../ai/ai.service';
import { ConversationsService } from '../conversations/conversations.service';
import { MessagesService } from '../messages/messages.service';
import { CustomersService } from '../customers/customers.service';
import { PrismaService } from '../prisma/prisma.service';
import { BlockedService } from '../blocked/blocked.service';

// ─── Constantes ──────────────────────────────────────────────────────────────

/**
 * Tiempo de debounce por cliente.
 * Si el cliente manda 3 mensajes en < 1.5s se agrupan en uno solo
 * antes de llamar a la IA → elimina race conditions de mensajes paralelos.
 */
const MSG_DEBOUNCE_MS = 1_500;

const MEDIA_TYPES = new Set([
  'imageMessage', 'audioMessage', 'videoMessage',
  'documentMessage', 'stickerMessage',
]);

const IGNORED_TYPES = new Set([
  'protocolMessage',
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'ephemeralMessage',
  'reactionMessage',
  'pollCreationMessage',
  'pollUpdateMessage',
  'groupInviteMessage',
  'callLogMessage',
  'ptvMessage',
  'editedMessage',
]);

/**
 * Palabras clave para detectar que el cliente quiere hablar con un humano.
 * Genéricas — aplican para cualquier negocio en la plataforma.
 */
const HUMAN_KEYWORDS = [
  // Pedir asesor / persona directamente
  'hablar con una persona', 'hablar con alguien', 'hablar con un asesor',
  'quiero un asesor', 'necesito un asesor', 'comunícame con un asesor',
  'conectame con un asesor', 'conéctame con un asesor',
  'persona real', 'persona humana', 'humano', 'agente',
  'asesor', 'asesora', 'operador', 'operadora',
  'ayuda humana', 'ayuda de verdad',
  // Rechazar el bot explícitamente
  'no quiero el bot', 'no quiero hablar con el bot',
  'no quiero hablar con una ia', 'no quiero ia',
  'no eres una persona', 'eres un bot', 'eres una ia',
  'quiero hablar con alguien de verdad', 'alguien de verdad',
  'quiero hablar con alguien real', 'alguien real',
  'hablar con una persona de verdad', 'hablar con una persona real',
  // Pedir dueño / encargado
  'quiero hablar con el dueño', 'quiero hablar con la dueña',
  'quiero hablar con el encargado', 'quiero hablar con la encargada',
  'quiero hablar con el administrador', 'quiero hablar con la administradora',
  // Frases informales
  'pásamelo con alguien', 'pasame con alguien',
  'pásamelo con una persona', 'paseme con alguien',
  'contactarme con alguien', 'comunicarme con alguien',
  'me pueden comunicar', 'me puedes comunicar',
  'hay alguien', 'hay una persona',
];

const MSG_DEDUP_TTL_MS       = 10 * 60 * 1000;
const HISTORY_SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;

const RECONNECT_DELAYS: Record<number, number> = {
  408: 5_000,
  440: 8_000,
};
const DEFAULT_RECONNECT_DELAY = 3_000;

// ─── useDBAuthState ───────────────────────────────────────────────────────────
//
// Persiste la sesión de Baileys en PostgreSQL en lugar del filesystem.
// Sobrevive reinicios de Render/Railway sin perder la sesión.
//
// CRÍTICO: los Signal keys contienen Buffers. Se serializan con BufferJSON.replacer
// antes de guardar y se deserializan con BufferJSON.reviver al leer.
// ─────────────────────────────────────────────────────────────────────────────
async function useDBAuthState(prisma: PrismaService, storeId: string) {
  const { BufferJSON, initAuthCreds } = await import('@whiskeysockets/baileys');

  function serialize(obj: any): any {
    return JSON.parse(JSON.stringify(obj, BufferJSON.replacer));
  }

  function deserialize(obj: any): any {
    return JSON.parse(JSON.stringify(obj), BufferJSON.reviver);
  }

  async function loadFromDB(): Promise<Record<string, any>> {
    const row = await prisma.whatsappSession.findUnique({ where: { storeId } });
    if (!row?.data) return {};
    try {
      const raw = typeof row.data === 'string' ? row.data : JSON.stringify(row.data);
      return JSON.parse(raw, BufferJSON.reviver);
    } catch {
      return {};
    }
  }

  const cache: Record<string, any> = await loadFromDB();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const serialized = JSON.stringify(cache, BufferJSON.replacer);
        const parsed = JSON.parse(serialized);
        await prisma.whatsappSession.upsert({
          where: { storeId },
          update: { data: parsed },
          create: { storeId, data: parsed },
        });
      } catch {
        // Se reintentará en el próximo cambio de estado
      }
      saveTimer = null;
    }, 300);
  }

  if (!cache['creds']) {
    cache['creds'] = initAuthCreds();
    scheduleSave();
  }

  const state = {
    creds: cache['creds'],
    keys: {
      get: async (type: string, ids: string[]) => {
        const result: Record<string, any> = {};
        for (const id of ids) {
          const raw = cache[`key-${type}-${id}`];
          if (raw != null) {
            try { result[id] = deserialize(raw); } catch { result[id] = raw; }
          }
        }
        return result;
      },
      set: async (data: Record<string, Record<string, any>>) => {
        for (const [type, typeData] of Object.entries(data)) {
          for (const [id, value] of Object.entries(typeData)) {
            const key = `key-${type}-${id}`;
            if (value != null) {
              try { cache[key] = deserialize(serialize(value)); } catch { cache[key] = value; }
            } else {
              delete cache[key];
            }
          }
        }
        scheduleSave();
      },
    },
  };

  const saveCreds = () => {
    cache['creds'] = state.creds;
    scheduleSave();
  };

  return { state, saveCreds };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resuelve el JID real de un mensaje.
 * WhatsApp está migrando cuentas nuevas al sistema LID (Linked Identity).
 */
function resolveJid(key: { remoteJid?: string; remoteJidAlt?: string }): string {
  const rawJid = key.remoteJid ?? '';
  if (rawJid.endsWith('@lid') && key.remoteJidAlt) return key.remoteJidAlt;
  return rawJid;
}

function phoneFromJid(jid: string): string | null {
  if (!jid.endsWith('@s.whatsapp.net')) return null;
  const raw = jid.replace('@s.whatsapp.net', '');
  return raw ? `+${raw}` : null;
}

function jidFromPhone(phone: string): string {
  return `${phone.replace('+', '')}@s.whatsapp.net`;
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class WhatsappService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappService.name);

  // Sockets activos por storeId
  private readonly sockets      = new Map<string, any>();
  // QR codes pendientes
  private readonly qrCodes      = new Map<string, string>();
  // Stores con reconexión en progreso (evita storms)
  private readonly reconnecting = new Set<string>();
  // Deduplicación de mensajes por messageId
  private readonly processedMsgIds = new Set<string>();

  /**
   * Cola de procesamiento por cliente (storeId:phone).
   * Garantiza que los mensajes de un mismo cliente se procesen de forma
   * estrictamente secuencial aunque lleguen en paralelo.
   */
  private readonly messageQueues = new Map<string, Promise<void>>();

  /**
   * Buffer de debounce por cliente.
   * Agrupa mensajes enviados en menos de MSG_DEBOUNCE_MS en un solo texto
   * antes de pasarlos a la IA, eliminando respuestas parciales/duplicadas.
   */
  private readonly messageBuffers = new Map<string, {
    contents: string[];
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
    private readonly conversationsService: ConversationsService,
    @Inject(forwardRef(() => MessagesService))
    private readonly messagesService: MessagesService,
    private readonly customersService: CustomersService,
    private readonly blockedService: BlockedService,
  ) {}

  // ─── Ciclo de vida ──────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    const sessions = await this.prisma.whatsappSession.findMany({
      include: { store: { select: { isActive: true, name: true } } },
    });

    const active = sessions.filter(s => s.store.isActive);
    this.logger.log(`Reconectando ${active.length} store(s) con sesión guardada`);

    await Promise.allSettled(
      active.map(s => this.connectStore(s.storeId).catch(err =>
        this.logger.error(`Error al reconectar store ${s.storeId}: ${err.message}`)
      )),
    );
  }

  // ─── Conexión ───────────────────────────────────────────────────────────────

  async connectStore(storeId: string): Promise<any> {
    if (this.reconnecting.has(storeId)) {
      this.logger.warn(`Reconexión ya en progreso para ${storeId}, ignorando`);
      return;
    }

    const existingSock = this.sockets.get(storeId);
    if (existingSock) {
      this.sockets.delete(storeId);
      try { existingSock.end(undefined); } catch { /* ignorar */ }
    }

    const {
      default: makeWASocket,
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
    } = await import('@whiskeysockets/baileys');

    const baileysLogger = P({ level: 'silent' });
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useDBAuthState(this.prisma, storeId);

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,
      logger: baileysLogger,
      keepAliveIntervalMs: 30_000,
      connectTimeoutMs: 60_000,
      retryRequestDelayMs: 2_000,
      getMessage: async (_key) => ({ conversation: '' }),
    });

    this.sockets.set(storeId, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      await this.handleConnectionUpdate(update, storeId, DisconnectReason);
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;

      const cutoffMs = type === 'append' ? Date.now() - HISTORY_SYNC_WINDOW_MS : 0;

      for (const msg of messages) {
        try {
          const msgTimestampMs = (Number(msg.messageTimestamp) || 0) * 1000;
          if (cutoffMs > 0 && msgTimestampMs < cutoffMs) continue;
          await this.processMessage(msg, storeId, sock);
        } catch (err: any) {
          this.logger.error(`Error procesando mensaje: ${err.message}`);
        }
      }
    });

    return sock;
  }

  // ─── Handlers de conexión ───────────────────────────────────────────────────

  private async handleConnectionUpdate(
    update: any,
    storeId: string,
    DisconnectReason: any,
  ): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.logger.log(`QR generado para store: ${storeId}`);
      qrcode.generate(qr, { small: true });
      this.qrCodes.set(storeId, qr);
    }

    if (connection === 'open') {
      this.logger.log(`✅ WhatsApp conectado: ${storeId}`);
      this.qrCodes.delete(storeId);
      this.reconnecting.delete(storeId);
      await this.prisma.store.update({
        where: { storeId },
        data: { waSessionId: storeId },
      }).catch(() => {});
    }

    if (connection === 'close') {
      await this.handleDisconnect(storeId, lastDisconnect, DisconnectReason);
    }
  }

  private async handleDisconnect(
    storeId: string,
    lastDisconnect: any,
    DisconnectReason: any,
  ): Promise<void> {
    const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
    const loggedOut  = statusCode === DisconnectReason.loggedOut;

    this.logger.warn(`Conexión cerrada para ${storeId} — código: ${statusCode}`);

    if (loggedOut) {
      this.logger.warn(`Store ${storeId} hizo logout — limpiando sesión`);
      this.sockets.delete(storeId);
      this.qrCodes.delete(storeId);
      this.reconnecting.delete(storeId);

      await Promise.allSettled([
        this.prisma.whatsappSession.deleteMany({ where: { storeId } }),
        this.prisma.store.update({ where: { storeId }, data: { waSessionId: null } }),
      ]);

      this.logger.log(`🗑️ Sesión borrada de BD: ${storeId}`);
      return;
    }

    if (this.reconnecting.has(storeId)) return;

    this.reconnecting.add(storeId);
    const delay = RECONNECT_DELAYS[statusCode] ?? DEFAULT_RECONNECT_DELAY;
    this.logger.log(`Reconectando ${storeId} en ${delay}ms...`);

    setTimeout(() => {
      this.reconnecting.delete(storeId);
      this.connectStore(storeId).catch(err =>
        this.logger.error(`Error reconectando ${storeId}: ${err.message}`)
      );
    }, delay);
  }

  // ─── Procesamiento de mensajes ──────────────────────────────────────────────

  private async processMessage(msg: any, storeId: string, sock: any): Promise<void> {
    if (msg.key.fromMe) return;
    if (!msg.message) return;

    // Deduplicación por messageId
    const msgId = msg.key.id;
    if (msgId) {
      if (this.processedMsgIds.has(msgId)) {
        this.logger.debug(`Mensaje duplicado ignorado: ${msgId}`);
        return;
      }
      this.processedMsgIds.add(msgId);
      setTimeout(() => this.processedMsgIds.delete(msgId), MSG_DEDUP_TTL_MS);
    }

    const jid   = resolveJid(msg.key);
    const phone = phoneFromJid(jid);
    if (!phone) return; // grupos, status, etc.

    const messageType = Object.keys(msg.message)[0];

    if (IGNORED_TYPES.has(messageType)) {
      this.logger.debug(`Ignorando tipo interno (${messageType}) de ${phone}`);
      return;
    }

    const blocked = await this.blockedService.isBlocked(storeId, phone);
    if (blocked) {
      this.logger.log(`🚫 Número bloqueado ignorado: ${phone}`);
      return;
    }

    const isMedia = MEDIA_TYPES.has(messageType);
    const content =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      '';

    if (isMedia) {
      await this.handleMediaMessage(storeId, phone, messageType, sock);
      return;
    }

    if (!content) return;

    this.logger.log(`📩 Mensaje de ${phone}: ${content}`);

    this.bufferAndProcess(storeId, phone, content, sock);
  }

  // ─── Debounce + cola secuencial ──────────────────────────────────────────────

  private bufferAndProcess(
    storeId: string,
    phone: string,
    content: string,
    sock: any,
  ): void {
    const key = `${storeId}:${phone}`;
    const existing = this.messageBuffers.get(key);

    if (existing) {
      clearTimeout(existing.timer);
      existing.contents.push(content);
      this.logger.debug(`📥 Buffer [${key}] — ${existing.contents.length} msgs acumulados`);
    } else {
      this.messageBuffers.set(key, { contents: [content], timer: null! });
    }

    const buffer = this.messageBuffers.get(key)!;

    buffer.timer = setTimeout(() => {
      this.messageBuffers.delete(key);
      const combined = buffer.contents.join('\n');

      if (buffer.contents.length > 1) {
        this.logger.log(
          `🔗 ${buffer.contents.length} msgs agrupados de ${phone}: "${combined.slice(0, 80)}..."`,
        );
      }

      this.enqueueMessage(key, () =>
        this.handleIncomingMessage(storeId, phone, combined, sock),
      );
    }, MSG_DEBOUNCE_MS);
  }

  private enqueueMessage(key: string, fn: () => Promise<void>): void {
    const prev = this.messageQueues.get(key) ?? Promise.resolve();

    const next = prev
      .then(fn)
      .catch(err =>
        this.logger.error(`Error en cola [${key}]: ${err.message}`)
      );

    this.messageQueues.set(key, next);

    next.finally(() => {
      if (this.messageQueues.get(key) === next) {
        this.messageQueues.delete(key);
      }
    });
  }

  // ─── Mensajes de media ──────────────────────────────────────────────────────

  private async handleMediaMessage(
    storeId: string,
    phone: string,
    messageType: string,
    sock: any,
  ): Promise<void> {
    const jid          = jidFromPhone(phone);
    const customer     = await this.customersService.findOrCreate({ storeId, phone });
    const conversation = await this.conversationsService.findOrCreate(
      customer.customerId, storeId,
    );

    if (conversation.status === 'human' || conversation.status === 'closed') return;

    const reply = this.getMediaReply(messageType);

    await this.prisma.conversation.update({
      where: { conversationId: conversation.conversationId },
      data: { status: 'pending_human' },
    });

    await this.messagesService.create({
      conversationId: conversation.conversationId,
      storeId,
      content: `[${messageType.replace('Message', '')}]`,
      type: messageType.replace('Message', ''),
      sender: 'customer',
      isAiResponse: false,
    });

    await sock.sendMessage(jid, { text: reply });

    await this.messagesService.create({
      conversationId: conversation.conversationId,
      storeId,
      content: reply,
      type: 'text',
      sender: 'store',
      isAiResponse: true,
    });

    this.logger.log(`🎙️ Media de ${phone} (${messageType}) → transferido a asesor`);
  }

  private getMediaReply(messageType: string): string {
    if (messageType === 'audioMessage') {
      return `¡Hola! 😊 Por el momento no puedo escuchar audios. ¿Puedes contarme en texto qué necesitas? Si prefieres hablar con un asesor, dímelo y te conecto ahora mismo.`;
    }
    if (messageType === 'imageMessage') {
      return `¡Gracias por escribirnos! 😊 No puedo ver imágenes por este canal automático, pero un asesor puede ayudarte de inmediato. ¿Te conecto?`;
    }
    return `¡Hola! 😊 Recibí tu archivo pero no puedo procesarlo por este canal. ¿Te conecto con un asesor?`;
  }

  // ─── Mensajes de texto ──────────────────────────────────────────────────────

  private async handleIncomingMessage(
    storeId: string,
    phone: string,
    content: string,
    sock: any,
  ): Promise<void> {
    const customer     = await this.customersService.findOrCreate({ storeId, phone });
    const conversation = await this.conversationsService.findOrCreate(
      customer.customerId, storeId,
    );

    await this.messagesService.create({
      conversationId: conversation.conversationId,
      storeId,
      content,
      type: 'text',
      sender: 'customer',
      isAiResponse: false,
    });

    // Si ya está en manos de un humano o cerrada, el bot no interviene
    if (conversation.status === 'human' || conversation.status === 'closed') {
      this.logger.log(`👤 Conv ${conversation.conversationId} en modo humano — bot silenciado`);
      return;
    }

    // Comando de override interno para forzar modo humano
    if (content.trim().toLowerCase() === '!stop') {
      await this.prisma.conversation.update({
        where: { conversationId: conversation.conversationId },
        data: { status: 'human' },
      });
      this.logger.log(`🛑 !stop de ${phone} — bot silenciado`);
      return;
    }

    const jid          = jidFromPhone(phone);
    const contentLower = content.toLowerCase();

    // ── Detección de solicitud de asesor humano ──────────────────────────────
    // Status 'human' directo — el bot queda silenciado de inmediato para
    // cualquier mensaje siguiente, sin esperar intervención manual.
    if (HUMAN_KEYWORDS.some(kw => contentLower.includes(kw))) {
      await this.prisma.conversation.update({
        where: { conversationId: conversation.conversationId },
        data: { status: 'human' },
      });

      const handoffReply =
        `Entendido, ahora mismo te conecto con un asesor. ` +
        `Por favor espera un momento, pronto alguien te atenderá. 😊`;

      await sock.sendMessage(jid, { text: handoffReply });

      await this.messagesService.create({
        conversationId: conversation.conversationId,
        storeId,
        content: handoffReply,
        type: 'text',
        sender: 'store',
        isAiResponse: false,
      });

      this.logger.log(
        `🚨 ${phone} solicitó asesor → conv ${conversation.conversationId} en modo HUMAN`,
      );
      return;
    }

    // ── Respuesta de la IA ───────────────────────────────────────────────────
    const aiReply = await this.aiService.generateReply(
      storeId, content, conversation.conversationId,
    );
    if (!aiReply) return;

    await this.messagesService.create({
      conversationId: conversation.conversationId,
      storeId,
      content: aiReply,
      type: 'text',
      sender: 'store',
      isAiResponse: true,
    });

    await sock.sendMessage(jid, { text: aiReply });
    this.logger.log(`🤖 IA respondió a ${phone}`);
  }

  // ─── API pública ─────────────────────────────────────────────────────────────

  getQR(storeId: string): string | null {
    return this.qrCodes.get(storeId) ?? null;
  }

  isConnected(storeId: string): boolean {
    return this.sockets.get(storeId)?.user != null;
  }

  async disconnectStore(storeId: string): Promise<void> {
    const sock = this.sockets.get(storeId);
    this.sockets.delete(storeId);
    this.qrCodes.delete(storeId);
    this.reconnecting.delete(storeId);

    if (sock) {
      try { await sock.logout(); } catch {
        try { sock.end(undefined); } catch { /* ignorar */ }
      }
    }

    await Promise.allSettled([
      this.prisma.whatsappSession.deleteMany({ where: { storeId } }),
      this.prisma.store.update({ where: { storeId }, data: { waSessionId: null } }),
    ]);
  }

  async sendMessage(storeId: string, phone: string, content: string): Promise<void> {
    const sock = this.sockets.get(storeId);
    if (!sock) throw new Error(`No hay socket activo para store: ${storeId}`);
    const jid = jidFromPhone(phone);
    await sock.sendMessage(jid, { text: content });
    this.logger.log(`📤 Mensaje enviado a ${phone}`);
  }
}