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

const MSG_DEBOUNCE_MS        = 1_500;
const MSG_DEDUP_TTL_MS       = 10 * 60 * 1000;
const HISTORY_SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_CONTENT_LENGTH     = 4_000; // caracteres máximos que se pasan a la IA
const SEND_RETRY_ATTEMPTS    = 3;
const SEND_RETRY_DELAY_MS    = 1_500;

const RECONNECT_DELAYS: Record<number, number> = {
  408: 5_000,
  440: 8_000,
};
const DEFAULT_RECONNECT_DELAY = 3_000;

// ─── Tipos de mensajes que se ignoran silenciosamente ────────────────────────
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
  'keepInChatMessage',
  'requestPaymentMessage',
  'sendPaymentMessage',
  'receiptMessage',
]);

// ─── Tipos de media ───────────────────────────────────────────────────────────
const MEDIA_TYPES = new Set([
  'imageMessage',
  'audioMessage',
  'videoMessage',
  'documentMessage',
  'stickerMessage',
]);

// ─── Palabras clave para detectar solicitud de humano ────────────────────────
// Genéricas — aplican para cualquier negocio de la plataforma.
const HUMAN_KEYWORDS = [
  // Pedir asesor / persona directamente
  'hablar con una persona', 'hablar con alguien', 'hablar con un asesor',
  'quiero un asesor', 'necesito un asesor', 'comunícame con un asesor',
  'conectame con un asesor', 'conéctame con un asesor',
  'persona real', 'persona humana', 'humano real', 'agente humano',
  'asesor humano', 'operador humano',
  'ayuda humana', 'ayuda de verdad',
  // Una sola palabra que claramente pide humano
  'asesor', 'asesora', 'operador', 'operadora',
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
  // Frases informales colombianas
  'pásamelo con alguien', 'pasame con alguien',
  'pásamelo con una persona', 'paseme con alguien',
  'contactarme con alguien', 'comunicarme con alguien',
  'me pueden comunicar', 'me puedes comunicar',
  'hay alguien', 'hay una persona', 'me colaboran',
];

// ─── useDBAuthState ───────────────────────────────────────────────────────────
async function useDBAuthState(prisma: PrismaService, storeId: string) {
  const { BufferJSON, initAuthCreds } = await import('@whiskeysockets/baileys');

  function serialize(obj: any): any {
    return JSON.parse(JSON.stringify(obj, BufferJSON.replacer));
  }
  function deserialize(obj: any): any {
    return JSON.parse(JSON.stringify(obj), BufferJSON.reviver);
  }

  async function loadFromDB(): Promise<Record<string, any>> {
    try {
      const row = await prisma.whatsappSession.findUnique({ where: { storeId } });
      if (!row?.data) return {};
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
        const parsed     = JSON.parse(serialized);
        await prisma.whatsappSession.upsert({
          where:  { storeId },
          update: { data: parsed },
          create: { storeId, data: parsed },
        });
      } catch { /* se reintentará en el próximo cambio */ }
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

function resolveJid(key: { remoteJid?: string; remoteJidAlt?: string }): string {
  const rawJid = key.remoteJid ?? '';
  if (rawJid.endsWith('@lid') && key.remoteJidAlt) return key.remoteJidAlt;
  return rawJid;
}

function phoneFromJid(jid: string): string | null {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
  const raw = jid.replace('@s.whatsapp.net', '');
  return raw ? `+${raw}` : null;
}

function jidFromPhone(phone: string): string {
  return `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
}

/**
 * Extrae el texto de un mensaje de WhatsApp cubriendo TODOS los tipos
 * que Baileys puede entregar, incluyendo botones, listas, templates,
 * mensajes de vista única, mensajes citados, etc.
 */
function extractTextContent(message: any): string | null {
  if (!message) return null;

  // Texto plano
  if (message.conversation)                           return message.conversation;

  // Texto extendido (con preview de link, menciones, etc.)
  if (message.extendedTextMessage?.text)              return message.extendedTextMessage.text;

  // Respuesta a botón interactivo
  if (message.buttonsResponseMessage?.selectedDisplayText)
    return message.buttonsResponseMessage.selectedDisplayText;
  if (message.buttonsResponseMessage?.selectedButtonId)
    return message.buttonsResponseMessage.selectedButtonId;

  // Respuesta a lista interactiva
  if (message.listResponseMessage?.title)             return message.listResponseMessage.title;
  if (message.listResponseMessage?.singleSelectReply?.selectedRowId)
    return message.listResponseMessage.singleSelectReply.selectedRowId;

  // Template de botón
  if (message.templateButtonReplyMessage?.selectedDisplayText)
    return message.templateButtonReplyMessage.selectedDisplayText;

  // Mensaje interactivo (nativeFlowResponseMessage, etc.)
  if (message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
    try {
      const params = JSON.parse(message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
      if (params?.id || params?.title) return params.title ?? params.id;
    } catch { /* ignorar */ }
  }

  // Vista única (viewOnce) — imagen o video con caption
  const viewOnce = message.viewOnceMessage?.message ?? message.viewOnceMessageV2?.message;
  if (viewOnce) {
    const caption =
      viewOnce.imageMessage?.caption ||
      viewOnce.videoMessage?.caption;
    if (caption) return caption;
  }

  // Imagen/video con caption
  if (message.imageMessage?.caption)                  return message.imageMessage.caption;
  if (message.videoMessage?.caption)                  return message.videoMessage.caption;

  // Mensaje de contacto (nombre del contacto compartido)
  if (message.contactMessage?.displayName)
    return `[Contacto compartido: ${message.contactMessage.displayName}]`;

  // Mensaje de ubicación
  if (message.locationMessage != null) {
    const { degreesLatitude, degreesLongitude, name } = message.locationMessage;
    const loc = name ? `${name}` : `${degreesLatitude}, ${degreesLongitude}`;
    return `[Ubicación: ${loc}]`;
  }

  // Mensaje de producto (order)
  if (message.orderMessage?.title)
    return `[Pedido: ${message.orderMessage.title}]`;

  // Mensaje de evento
  if (message.eventMessage?.name)
    return `[Evento: ${message.eventMessage.name}]`;

  // Mensaje efímero — puede contener texto
  const ephemeral = message.ephemeralMessage?.message;
  if (ephemeral) return extractTextContent(ephemeral);

  // Mensaje de documento con caption
  if (message.documentMessage?.caption)               return message.documentMessage.caption;
  if (message.documentMessage?.fileName)
    return `[Documento: ${message.documentMessage.fileName}]`;

  return null;
}

/**
 * Limpia el contenido antes de pasarlo a la IA:
 * - Elimina URLs largas
 * - Limita longitud
 * - Elimina caracteres de control
 */
function sanitizeContent(content: string): string {
  return content
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '') // control chars
    .replace(/https?:\/\/\S{80,}/g, '[URL]')             // URLs largas
    .trim()
    .slice(0, MAX_CONTENT_LENGTH);
}

/**
 * Pausa con retry — espera delay ms entre intentos.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  delayMs: number,
  label: string,
  logger: Logger,
): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (i < attempts - 1) {
        logger.warn(`${label} — intento ${i + 1}/${attempts} falló: ${err.message}. Reintentando en ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class WhatsappService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappService.name);

  private readonly sockets         = new Map<string, any>();
  private readonly qrCodes         = new Map<string, string>();
  private readonly reconnecting    = new Set<string>();
  private readonly processedMsgIds = new Set<string>();
  private readonly messageQueues   = new Map<string, Promise<void>>();
  private readonly messageBuffers  = new Map<string, {
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
    try {
      const sessions = await this.prisma.whatsappSession.findMany({
        include: { store: { select: { isActive: true, name: true } } },
      });

      const active = sessions.filter(s => s.store?.isActive);
      this.logger.log(`Reconectando ${active.length} store(s) con sesión guardada`);

      await Promise.allSettled(
        active.map(s =>
          this.connectStore(s.storeId).catch(err =>
            this.logger.error(`Error al reconectar store ${s.storeId}: ${err.message}`)
          )
        ),
      );
    } catch (err: any) {
      this.logger.error(`Error en onModuleInit: ${err.message}`);
    }
  }

  // ─── Conexión ───────────────────────────────────────────────────────────────

  async connectStore(storeId: string): Promise<any> {
    if (this.reconnecting.has(storeId)) {
      this.logger.warn(`Reconexión ya en progreso para ${storeId}, ignorando`);
      return;
    }

    // Cerrar socket previo limpiamente
    const existing = this.sockets.get(storeId);
    if (existing) {
      this.sockets.delete(storeId);
      try { existing.end(undefined); } catch { /* ignorar */ }
    }

    const {
      default: makeWASocket,
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
    } = await import('@whiskeysockets/baileys');

    const baileysLogger    = P({ level: 'silent' });
    const { version }      = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useDBAuthState(this.prisma, storeId);

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys:  makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal:   false,
      logger:              baileysLogger,
      keepAliveIntervalMs: 30_000,
      connectTimeoutMs:    60_000,
      retryRequestDelayMs: 2_000,
      getMessage: async (_key) => ({ conversation: '' }),
    });

    this.sockets.set(storeId, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update: any) => {
      try {
        await this.handleConnectionUpdate(update, storeId, DisconnectReason);
      } catch (err: any) {
        this.logger.error(`[${storeId}] Error en connection.update: ${err.message}`);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
      if (type !== 'notify' && type !== 'append') return;
      const cutoffMs = type === 'append' ? Date.now() - HISTORY_SYNC_WINDOW_MS : 0;

      for (const msg of messages) {
        try {
          const msgTimestampMs = (Number(msg.messageTimestamp) || 0) * 1000;
          if (cutoffMs > 0 && msgTimestampMs < cutoffMs) continue;
          await this.processMessage(msg, storeId, sock);
        } catch (err: any) {
          this.logger.error(`[${storeId}] Error procesando mensaje: ${err.message}`);
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
        data:  { waSessionId: storeId },
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
    // Ignorar mensajes propios
    if (msg.key?.fromMe) return;
    if (!msg.message)    return;

    // Deduplicación
    const msgId = msg.key?.id;
    if (msgId) {
      if (this.processedMsgIds.has(msgId)) {
        this.logger.debug(`Mensaje duplicado ignorado: ${msgId}`);
        return;
      }
      this.processedMsgIds.add(msgId);
      setTimeout(() => this.processedMsgIds.delete(msgId), MSG_DEDUP_TTL_MS);
    }

    const jid = resolveJid(msg.key);
    if (!jid) return;

    const phone = phoneFromJid(jid);
    if (!phone) return; // grupos, status broadcasts, etc.

    // Ignorar grupos
    if (jid.endsWith('@g.us'))   return;
    if (jid.endsWith('@broadcast')) return;

    const messageType = Object.keys(msg.message)[0];

    if (IGNORED_TYPES.has(messageType)) {
      this.logger.debug(`Ignorando tipo interno (${messageType}) de ${phone}`);
      return;
    }

    // Verificar si está bloqueado
    const blocked = await this.blockedService.isBlocked(storeId, phone).catch(() => false);
    if (blocked) {
      this.logger.log(`🚫 Número bloqueado ignorado: ${phone}`);
      return;
    }

    // Media (audio, imagen, video, doc, sticker)
    if (MEDIA_TYPES.has(messageType)) {
      await this.handleMediaMessage(storeId, phone, messageType, sock);
      return;
    }

    // Extraer texto con cobertura total de tipos
    const rawContent = extractTextContent(msg.message);
    if (!rawContent) return;

    const content = sanitizeContent(rawContent);
    if (!content) return;

    // Ignorar mensajes que son solo emojis de reacción o muy cortos sin sentido
    // (pero sí procesar "si", "ok", "dale", etc. que son confirmaciones válidas)
    if (content.length === 1 && !/[a-záéíóúñA-ZÁÉÍÓÚÑ0-9]/u.test(content)) return;

    this.logger.log(`📩 Mensaje de ${phone}: ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}`);

    this.bufferAndProcess(storeId, phone, content, sock);
  }

  // ─── Debounce + cola secuencial ──────────────────────────────────────────────

  private bufferAndProcess(
    storeId: string,
    phone: string,
    content: string,
    sock: any,
  ): void {
    const key      = `${storeId}:${phone}`;
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
      .catch(err => this.logger.error(`Error en cola [${key}]: ${err.message}`));

    this.messageQueues.set(key, next);
    next.finally(() => {
      if (this.messageQueues.get(key) === next) this.messageQueues.delete(key);
    });
  }

  // ─── Mensajes de media ──────────────────────────────────────────────────────

  private async handleMediaMessage(
    storeId: string,
    phone: string,
    messageType: string,
    sock: any,
  ): Promise<void> {
    try {
      const jid          = jidFromPhone(phone);
      const customer     = await this.customersService.findOrCreate({ storeId, phone });
      const conversation = await this.conversationsService.findOrCreate(
        customer.customerId, storeId,
      );

      if (conversation.status === 'human' || conversation.status === 'closed') return;

      const reply = this.getMediaReply(messageType);

      await this.prisma.conversation.update({
        where: { conversationId: conversation.conversationId },
        data:  { status: 'pending_human' },
      });

      await this.messagesService.create({
        conversationId: conversation.conversationId,
        storeId,
        content:      `[${messageType.replace('Message', '')}]`,
        type:         messageType.replace('Message', ''),
        sender:       'customer',
        isAiResponse: false,
      });

      await this.safeSend(sock, jid, reply, phone);

      await this.messagesService.create({
        conversationId: conversation.conversationId,
        storeId,
        content:      reply,
        type:         'text',
        sender:       'store',
        isAiResponse: true,
      });

      this.logger.log(`🎙️ Media de ${phone} (${messageType}) → transferido a asesor`);
    } catch (err: any) {
      this.logger.error(`[handleMediaMessage] ${phone}: ${err.message}`);
    }
  }

  private getMediaReply(messageType: string): string {
    if (messageType === 'audioMessage') {
      return `¡Hola! 😊 Por el momento no puedo escuchar audios. ¿Puedes contarme en texto qué necesitas? Si prefieres hablar con un asesor, dímelo y te conecto ahora mismo.`;
    }
    if (messageType === 'imageMessage') {
      return `¡Gracias por escribirnos! 😊 No puedo ver imágenes por este canal automático, pero un asesor puede ayudarte de inmediato. ¿Te conecto?`;
    }
    if (messageType === 'videoMessage') {
      return `¡Hola! 😊 No puedo ver videos por este canal, pero con gusto te atiendo por texto o te conecto con un asesor. ¿Qué prefieres?`;
    }
    if (messageType === 'documentMessage') {
      return `¡Gracias! 😊 No puedo abrir documentos por este canal automático. Un asesor puede revisarlo de inmediato. ¿Te conecto?`;
    }
    if (messageType === 'stickerMessage') {
      return null as any; // Ignorar stickers completamente
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
    const jid = jidFromPhone(phone);

    try {
      // Obtener/crear cliente y conversación
      const customer = await this.customersService.findOrCreate({ storeId, phone });
      const conversation = await this.conversationsService.findOrCreate(
        customer.customerId, storeId,
      );

      // Guardar mensaje del cliente
      await this.messagesService.create({
        conversationId: conversation.conversationId,
        storeId,
        content,
        type:         'text',
        sender:       'customer',
        isAiResponse: false,
      }).catch(err => this.logger.warn(`No se pudo guardar mensaje cliente: ${err.message}`));

      // Si ya está en manos de un humano o cerrada — bot silenciado
      if (conversation.status === 'human' || conversation.status === 'closed') {
        this.logger.log(
          `👤 Conv ${conversation.conversationId} en modo ${conversation.status} — bot silenciado`,
        );
        return;
      }

      // Comando interno para forzar modo humano
      if (content.trim().toLowerCase() === '!stop') {
        await this.prisma.conversation.update({
          where: { conversationId: conversation.conversationId },
          data:  { status: 'human' },
        });
        this.logger.log(`🛑 !stop de ${phone} — bot silenciado`);
        return;
      }

      const contentLower = content.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

      // ── Detección de solicitud de asesor humano ────────────────────────────
      const wantsHuman = HUMAN_KEYWORDS.some(kw => {
        // Normalizar keyword también
        const kwNorm = kw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return contentLower.includes(kwNorm);
      });

      if (wantsHuman) {
        await this.prisma.conversation.update({
          where: { conversationId: conversation.conversationId },
          data:  { status: 'human' },
        });

        const handoffReply =
          `Entendido, ahora mismo te conecto con un asesor. ` +
          `Por favor espera un momento, pronto alguien te atenderá. 😊`;

        await this.safeSend(sock, jid, handoffReply, phone);

        await this.messagesService.create({
          conversationId: conversation.conversationId,
          storeId,
          content:      handoffReply,
          type:         'text',
          sender:       'store',
          isAiResponse: false,
        }).catch(() => {});

        this.logger.log(
          `🚨 ${phone} solicitó asesor → conv ${conversation.conversationId} HUMAN`,
        );
        return;
      }

      // ── Respuesta de la IA ─────────────────────────────────────────────────
      let aiReply: string | null = null;
      try {
        aiReply = await this.aiService.generateReply(
          storeId, content, conversation.conversationId,
        );
      } catch (err: any) {
        this.logger.error(`[IA] Error generando respuesta: ${err.message}`);
        // No enviar nada — mejor silencio que error visible al cliente
        return;
      }

      if (!aiReply || !aiReply.trim()) return;

      // Guardar respuesta de la IA ANTES de enviar (si el envío falla, queda el registro)
      await this.messagesService.create({
        conversationId: conversation.conversationId,
        storeId,
        content:      aiReply,
        type:         'text',
        sender:       'store',
        isAiResponse: true,
      }).catch(err => this.logger.warn(`No se pudo guardar respuesta IA: ${err.message}`));

      // Enviar al cliente con retry
      await this.safeSend(sock, jid, aiReply, phone);
      this.logger.log(`🤖 IA respondió a ${phone}`);

    } catch (err: any) {
      this.logger.error(`[handleIncomingMessage] ${phone}: ${err.message}`);
      // No propagar — no queremos que un error de un cliente rompa los demás
    }
  }

  // ─── Envío seguro con retry ───────────────────────────────────────────────────

  private async safeSend(
    sock: any,
    jid: string,
    text: string,
    phoneLabel: string,
  ): Promise<void> {
    if (!text?.trim()) return;

    // WhatsApp tiene límite de ~65536 caracteres por mensaje
    // Si es muy largo, partir en chunks
    const MAX_WA_LENGTH = 4096;
    const chunks: string[] = [];

    if (text.length > MAX_WA_LENGTH) {
      let remaining = text;
      while (remaining.length > 0) {
        // Intentar cortar en salto de línea para no partir palabras
        let cut = MAX_WA_LENGTH;
        if (remaining.length > MAX_WA_LENGTH) {
          const lastNewline = remaining.lastIndexOf('\n', MAX_WA_LENGTH);
          if (lastNewline > MAX_WA_LENGTH * 0.7) cut = lastNewline + 1;
        }
        chunks.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut);
      }
    } else {
      chunks.push(text);
    }

    for (const chunk of chunks) {
      await withRetry(
        () => sock.sendMessage(jid, { text: chunk }),
        SEND_RETRY_ATTEMPTS,
        SEND_RETRY_DELAY_MS,
        `sendMessage a ${phoneLabel}`,
        this.logger,
      );
    }
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
    await this.safeSend(sock, jid, content, phone);
    this.logger.log(`📤 Mensaje enviado a ${phone}`);
  }
}