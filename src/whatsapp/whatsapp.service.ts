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

const ASK_NAME_MARKER = '__ASK_NAME__';
const ASK_CITY_MARKER = '__ASK_CITY__';

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

const NAME_BLACKLIST = new Set([
  'hola', 'hello', 'hi', 'hey', 'buenas', 'buenos', 'buen', 'dias', 'tardes',
  'noches', 'ok', 'okas', 'oka', 'okay', 'dale', 'listo', 'si', 'sí', 'no',
  'jaja', 'jajaja', 'jajajaja', 'jajjajaja', 'jeje', 'xd', 'lol', 'omg',
  'amen', 'amén', 'test', 'prueba', 'info', 'precio', 'precios', 'holi',
  'que', 'qué', 'como', 'cómo', 'bien', 'mal', 'nada', 'todo', 'algo',
  'gracias', 'claro', 'perfecto', 'genial', 'excelente', 'chévere', 'chevere',
]);

const HUMAN_KEYWORDS = [
  'hablar con una persona', 'hablar con alguien',
  'quiero pagar', 'voy a pagar', 'hacer el pago',
  'persona real', 'asesor', 'operador',
  'no quiero el bot', 'ayuda humana',
];

// Tiempo máximo de deduplicación de mensajes en memoria
const MSG_DEDUP_TTL_MS = 10 * 60 * 1000;

// Tiempo de history sync: solo procesar mensajes de las últimas 24h
const HISTORY_SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;

// Delays de reconexión por código de error
const RECONNECT_DELAYS: Record<number, number> = {
  408: 5_000,
  440: 8_000,
};
const DEFAULT_RECONNECT_DELAY = 3_000;

// ─── useDBAuthState ───────────────────────────────────────────────────────────
//
// Persiste la sesión de Baileys en PostgreSQL (Neon) en lugar del filesystem.
// Sobrevive reinicios de Render/Railway sin perder la sesión.
//
// CRÍTICO: los Signal keys contienen Buffers. Se serializan con BufferJSON.replacer
// antes de guardar y se deserializan con BufferJSON.reviver al leer.
// Si no se hace esto, los pre-keys de nuevos contactos se corrompen y Baileys
// no puede establecer la primera sesión → mensajes perdidos.
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
            try {
              result[id] = deserialize(raw);
            } catch {
              result[id] = raw;
            }
          }
        }
        return result;
      },
      set: async (data: Record<string, Record<string, any>>) => {
        for (const [type, typeData] of Object.entries(data)) {
          for (const [id, value] of Object.entries(typeData)) {
            const key = `key-${type}-${id}`;
            if (value != null) {
              try {
                cache[key] = deserialize(serialize(value));
              } catch {
                cache[key] = value;
              }
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
 *
 * WhatsApp está migrando cuentas nuevas al sistema LID (Linked Identity).
 * En ese caso, remoteJid viene como "<id>@lid" y el número de teléfono
 * real se encuentra en remoteJidAlt como "<phone>@s.whatsapp.net".
 *
 * Sin este fallback, los mensajes de cuentas LID se descartan silenciosamente.
 */
function resolveJid(key: { remoteJid?: string; remoteJidAlt?: string }): string {
  const rawJid = key.remoteJid ?? '';
  if (rawJid.endsWith('@lid') && key.remoteJidAlt) {
    return key.remoteJidAlt;
  }
  return rawJid;
}

/**
 * Extrae el número de teléfono formateado (+<country><number>) desde un JID.
 * Retorna null si el JID no corresponde a un chat individual.
 */
function phoneFromJid(jid: string): string | null {
  if (!jid.endsWith('@s.whatsapp.net')) return null;
  const raw = jid.replace('@s.whatsapp.net', '');
  return raw ? `+${raw}` : null;
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class WhatsappService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappService.name);

  // Mapa de sockets activos por storeId
  private readonly sockets = new Map<string, any>();

  // QR codes pendientes de escanear por storeId
  private readonly qrCodes = new Map<string, string>();

  // Stores que ya tienen una reconexión en progreso (evita storms)
  private readonly reconnecting = new Set<string>();

  // IDs de mensajes ya procesados (deduplicación en memoria)
  private readonly processedMsgIds = new Set<string>();

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

    // Cerrar socket anterior antes de crear uno nuevo.
    // Sin esto, el socket viejo sigue vivo y compite → loop código 440.
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
      // Necesario para re-entrega de mensajes perdidos durante desconexiones
      getMessage: async (_key) => ({ conversation: '' }),
    });

    this.sockets.set(storeId, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      await this.handleConnectionUpdate(update, storeId, DisconnectReason);
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // 'notify' = mensaje nuevo en vivo
      // 'append' = mensajes perdidos durante desconexión (history sync)
      if (type !== 'notify' && type !== 'append') return;

      const cutoffMs = type === 'append' ? Date.now() - HISTORY_SYNC_WINDOW_MS : 0;

      for (const msg of messages) {
        try {
          const msgTimestampMs = (Number(msg.messageTimestamp) || 0) * 1000;
          if (cutoffMs > 0 && msgTimestampMs < cutoffMs) continue;
          await this.processMessage(msg, storeId, sock);
        } catch (err) {
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
    const loggedOut = statusCode === DisconnectReason.loggedOut;

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

    // ── Soporte LID ──────────────────────────────────────────────────────────
    // Cuentas nuevas de WhatsApp usan el sistema LID (Linked Identity).
    // remoteJid llega como "<id>@lid" y el teléfono real está en remoteJidAlt.
    // resolveJid() hace el fallback automáticamente.
    // ────────────────────────────────────────────────────────────────────────
    const jid = resolveJid(msg.key);
    const phone = phoneFromJid(jid);
    if (!phone) return; // Grupos, status, etc.

    const messageType = Object.keys(msg.message)[0];

    if (IGNORED_TYPES.has(messageType)) {
      this.logger.debug(`Ignorando mensaje interno (${messageType}) de ${phone}`);
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
    await this.handleIncomingMessage(storeId, phone, content, sock);
  }

  // ─── Mensajes de media ──────────────────────────────────────────────────────

  private async handleMediaMessage(
    storeId: string,
    phone: string,
    messageType: string,
    sock: any,
  ): Promise<void> {
    const jid = `${phone.replace('+', '')}@s.whatsapp.net`;
    const customer = await this.customersService.findOrCreate({ storeId, phone });
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
      return `¡Hola! 😊 Por el momento no puedo escuchar audios. ¿Puedes contarme en texto qué necesitas? Si prefieres un asesor, dímelo y te conecto ahora mismo.`;
    }
    if (messageType === 'imageMessage') {
      return `¡Gracias por escribirnos! 😊 No puedo ver imágenes por este canal automático, pero un asesor puede ayudarte. ¿Te conecto?`;
    }
    return `¡Hola! 😊 Recibí tu archivo pero no puedo procesarlo. ¿Te conecto con un asesor?`;
  }

  // ─── Mensajes de texto ──────────────────────────────────────────────────────

  private async handleIncomingMessage(
    storeId: string,
    phone: string,
    content: string,
    sock: any,
  ): Promise<void> {
    const customer = await this.customersService.findOrCreate({ storeId, phone });
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

    if (conversation.status === 'human' || conversation.status === 'closed') {
      this.logger.log(`👤 Conv ${conversation.conversationId} en modo humano — bot silenciado`);
      return;
    }

    if (content.trim().toLowerCase() === '!stop') {
      await this.prisma.conversation.update({
        where: { conversationId: conversation.conversationId },
        data: { status: 'human' },
      });
      this.logger.log(`🛑 !stop de ${phone} — bot silenciado`);
      return;
    }

    const jid = `${phone.replace('+', '')}@s.whatsapp.net`;

    const onboardingHandled = await this.handleOnboarding(
      customer, conversation, content, sock, jid, phone, storeId,
    );
    if (onboardingHandled) return;

    const contentLower = content.toLowerCase();
    if (HUMAN_KEYWORDS.some(kw => contentLower.includes(kw))) {
      await this.prisma.conversation.update({
        where: { conversationId: conversation.conversationId },
        data: { status: 'pending_human' },
      });
      await sock.sendMessage(jid, {
        text: '👤 Entendido! Te conecto con un asesor. Por favor espera un momento...',
      });
      this.logger.log(`🚨 ${phone} solicita asesor humano`);
      return;
    }

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

  // ─── Onboarding ─────────────────────────────────────────────────────────────

  private async handleOnboarding(
    customer: any,
    conversation: any,
    content: string,
    sock: any,
    jid: string,
    phone: string,
    storeId: string,
  ): Promise<boolean> {
    const lastBotMsg = await this.prisma.message.findFirst({
      where: { conversationId: conversation.conversationId, sender: 'store' },
      orderBy: { createdAt: 'desc' },
    });
    const lastBotContent = lastBotMsg?.content ?? '';

    if (!customer.name) {
      if (lastBotContent.includes(ASK_NAME_MARKER)) {
        const name = this.extractName(content);

        if (!this.isValidName(name)) {
          const msg = `No entendí tu nombre 😅 ¿Me lo puedes escribir de nuevo? (ejemplo: "María" o "Juan Pérez")`;
          await sock.sendMessage(jid, { text: msg });
          await this.saveOnboardingMessage(conversation.conversationId, storeId, `${msg} ${ASK_NAME_MARKER}`);
          return true;
        }

        const nameFormatted = name.replace(/\b\w/g, l => l.toUpperCase());
        await this.customersService.update(customer.customerId, { name: nameFormatted });
        this.logger.log(`✅ Nombre guardado: ${nameFormatted} (${phone})`);

        const msg = `¡Gracias, ${nameFormatted}! 😊 ¿De qué ciudad nos escribes? 🏙️`;
        await sock.sendMessage(jid, { text: msg });
        await this.saveOnboardingMessage(conversation.conversationId, storeId, `${msg} ${ASK_CITY_MARKER}`);
        return true;
      }

      const msg = `¡Hola! Bienvenido/a 👋 Soy el asistente virtual. Para atenderte mejor, ¿cuál es tu nombre?`;
      await sock.sendMessage(jid, { text: msg });
      await this.saveOnboardingMessage(conversation.conversationId, storeId, `${msg} ${ASK_NAME_MARKER}`);
      return true;
    }

    if (!customer.city) {
      if (lastBotContent.includes(ASK_CITY_MARKER)) {
        const city = this.extractCity(content);

        if (!this.isValidText(city)) {
          const msg = `No entendí la ciudad 😅 ¿Me la puedes escribir de nuevo?`;
          await sock.sendMessage(jid, { text: msg });
          await this.saveOnboardingMessage(conversation.conversationId, storeId, `${msg} ${ASK_CITY_MARKER}`);
          return true;
        }

        const cityFormatted = city.replace(/\b\w/g, l => l.toUpperCase());
        await this.customersService.update(customer.customerId, { city: cityFormatted });
        this.logger.log(`✅ Ciudad guardada: ${cityFormatted} (${phone})`);
        return false;
      }

      if (!lastBotContent) {
        const msg = `¡Hola de nuevo, ${customer.name}! 👋 ¿De qué ciudad nos escribes? 🏙️`;
        await sock.sendMessage(jid, { text: msg });
        await this.saveOnboardingMessage(conversation.conversationId, storeId, `${msg} ${ASK_CITY_MARKER}`);
        return true;
      }
    }

    return false;
  }

  private async saveOnboardingMessage(
    conversationId: string,
    storeId: string,
    content: string,
  ): Promise<void> {
    await this.messagesService.create({
      conversationId, storeId, content,
      type: 'text', sender: 'store', isAiResponse: true,
    });
  }

  // ─── Utilidades de texto ────────────────────────────────────────────────────

  private extractName(input: string): string {
    const cleaned = input.trim();
    const match = cleaned.match(/^(?:mi nombre es|me llamo|soy|mi nombre:|nombre:)\s+(.+)/i);
    return match ? match[1].trim() : cleaned;
  }

  private extractCity(input: string): string {
    const cleaned = input.trim();
    const match = cleaned.match(/^(?:soy de|estoy en|vivo en|desde|de|en)\s+(.+)/i);
    return match ? match[1].trim() : cleaned;
  }

  private isValidText(value: string): boolean {
    return /[a-záéíóúüñA-ZÁÉÍÓÚÜÑ]{2,}/.test(value);
  }

  private isValidName(value: string): boolean {
    const lower = value.toLowerCase().trim();
    if (/\d/.test(lower)) return false;
    if (lower.length > 30) return false;
    const words = lower.split(/\s+/);
    if (words.length > 3) return false;
    if (!this.isValidText(value)) return false;
    if (words.some(w => NAME_BLACKLIST.has(w))) return false;
    if (/^(ja|je|ji|ha|he|xd){2,}/i.test(lower)) return false;
    return true;
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
      try {
        await sock.logout();
      } catch {
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
    const jid = `${phone.replace('+', '')}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: content });
    this.logger.log(`📤 Mensaje enviado a ${phone}`);
  }
}