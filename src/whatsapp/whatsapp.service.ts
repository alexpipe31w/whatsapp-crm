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

const ASK_NAME_MARKER = '__ASK_NAME__';
const ASK_CITY_MARKER = '__ASK_CITY__';

const MEDIA_TYPES = [
  'imageMessage', 'audioMessage', 'videoMessage',
  'documentMessage', 'stickerMessage',
];

const IGNORED_TYPES = [
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
];

const NAME_BLACKLIST = new Set([
  'hola', 'hello', 'hi', 'hey', 'buenas', 'buenos', 'buen', 'dias', 'tardes',
  'noches', 'ok', 'okas', 'oka', 'okay', 'dale', 'listo', 'si', 'sí', 'no',
  'jaja', 'jajaja', 'jajajaja', 'jajjajaja', 'jeje', 'xd', 'lol', 'omg',
  'amen', 'amén', 'test', 'prueba', 'info', 'precio', 'precios', 'holi',
  'que', 'qué', 'como', 'cómo', 'bien', 'mal', 'nada', 'todo', 'algo',
  'gracias', 'claro', 'perfecto', 'genial', 'excelente', 'chévere', 'chevere',
]);

// ─────────────────────────────────────────────────────────────────────────────
// useDBAuthState: reemplaza useMultiFileAuthState — guarda la sesión en Neon
// en lugar del filesystem de Render (que es efímero y se borra en cada deploy).
// ─────────────────────────────────────────────────────────────────────────────
async function useDBAuthState(prisma: PrismaService, storeId: string) {
  const { BufferJSON, initAuthCreds } = await import('@whiskeysockets/baileys');

  // Cargar datos guardados de la BD
  async function readData(): Promise<Record<string, any>> {
    const row = await prisma.whatsappSession.findUnique({
      where: { storeId },
    });
    if (!row || !row.data) return {};
    try {
      // row.data es un Json de Prisma — puede ser objeto o string
      const raw = typeof row.data === 'string' ? row.data : JSON.stringify(row.data);
      return JSON.parse(raw, BufferJSON.reviver);
    } catch {
      return {};
    }
  }

  // Guardar datos en la BD (upsert)
  async function writeData(data: Record<string, any>): Promise<void> {
    const serialized = JSON.stringify(data, BufferJSON.replacer);
    await prisma.whatsappSession.upsert({
      where: { storeId },
      update: { data: JSON.parse(serialized) },
      create: { storeId, data: JSON.parse(serialized) },
    });
  }

  // Borrar un archivo específico de la sesión
  async function removeData(key: string): Promise<void> {
    const current = await readData();
    delete current[key];
    await writeData(current);
  }

  const stored = await readData();

  // Credenciales principales (creds)
  const creds = stored['creds']
    ? stored['creds']
    : initAuthCreds();

  // Guardar creds inmediatamente si son nuevas
  if (!stored['creds']) {
    await writeData({ ...stored, creds });
  }

  return {
    state: {
      creds,
      // Signal keys (pre-keys, sessions, sender-keys, etc.)
      keys: {
        get: async (type: string, ids: string[]) => {
          const current = await readData();
          const data: Record<string, any> = {};
          for (const id of ids) {
            const key = `key-${type}-${id}`;
            const val = current[key];
            if (val !== undefined) data[id] = val;
          }
          return data;
        },
        set: async (data: Record<string, Record<string, any>>) => {
          const current = await readData();
          for (const [type, typeData] of Object.entries(data)) {
            for (const [id, value] of Object.entries(typeData)) {
              const key = `key-${type}-${id}`;
              if (value) {
                current[key] = value;
              } else {
                delete current[key];
              }
            }
          }
          await writeData(current);
        },
      },
    },
    saveCreds: async () => {
      const current = await readData();
      await writeData({ ...current, creds: state.creds });
    },
  };

  // Necesario para que saveCreds acceda al creds actualizado
  var state = { creds } as any;
}

@Injectable()
export class WhatsappService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappService.name);
  private sockets: Map<string, any> = new Map();
  private qrCodes: Map<string, string> = new Map();
  private reconnecting: Set<string> = new Set();
  // Deduplicación de mensajes (evita procesar el mismo msg múltiples veces)
  private processedMsgIds: Set<string> = new Set();

  constructor(
    private prisma: PrismaService,
    private aiService: AiService,
    private conversationsService: ConversationsService,
    @Inject(forwardRef(() => MessagesService))
    private messagesService: MessagesService,
    private customersService: CustomersService,
    private blockedService: BlockedService,
  ) {}

  async onModuleInit() {
    // Reconectar stores que tienen sesión guardada en BD
    const sessions = await this.prisma.whatsappSession.findMany({
      include: { store: { select: { isActive: true, name: true } } },
    });

    for (const session of sessions) {
      if (!session.store.isActive) continue;
      this.logger.log(`Reconectando store: ${session.store.name}`);
      await this.connectStore(session.storeId);
    }
  }

  async connectStore(storeId: string) {
    if (this.reconnecting.has(storeId)) {
      this.logger.warn(`Ya hay una reconexión en progreso para ${storeId}`);
      return;
    }

    const {
      default: makeWASocket,
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
    } = await import('@whiskeysockets/baileys');

    const baileysLogger = P({ level: 'silent' });
    const { version } = await fetchLatestBaileysVersion();

    // Usar sesión en BD en lugar de filesystem
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

    // Persistir creds cada vez que Baileys las actualiza
    sock.ev.on('creds.update', async () => {
      // Actualizar el creds en el state antes de guardar
      Object.assign(state.creds, sock.authState?.creds ?? {});
      await saveCreds();
    });

    sock.ev.on('connection.update', async (update) => {
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
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        this.logger.warn(`Conexión cerrada para ${storeId} — código: ${statusCode}`);

        if (loggedOut) {
          this.logger.warn(`Store ${storeId} hizo logout — limpiando sesión`);
          this.sockets.delete(storeId);
          this.qrCodes.delete(storeId);
          this.reconnecting.delete(storeId);

          // Borrar sesión de la BD y limpiar waSessionId
          await this.prisma.whatsappSession.deleteMany({
            where: { storeId },
          }).catch(() => {});
          await this.prisma.store.update({
            where: { storeId },
            data: { waSessionId: null },
          }).catch(() => {});

          this.logger.log(`🗑️ Sesión borrada de BD: ${storeId}`);

        } else if (!this.reconnecting.has(storeId)) {
          this.reconnecting.add(storeId);
          const delay = statusCode === 408 ? 5000 : 3000;
          this.logger.log(`Reconectando ${storeId} en ${delay}ms...`);
          setTimeout(() => {
            this.reconnecting.delete(storeId);
            this.connectStore(storeId).catch(e =>
              this.logger.error(`Error reconectando: ${e.message}`)
            );
          }, delay);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // 'notify' = mensaje nuevo en vivo
      // 'append' = mensajes perdidos durante desconexión (history sync)
      if (type !== 'notify' && type !== 'append') return;

      // Para history sync solo procesar mensajes de las últimas 24h
      const cutoffMs = type === 'append' ? Date.now() - 24 * 60 * 60 * 1000 : 0;

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

  private async processMessage(msg: any, storeId: string, sock: any) {
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
      setTimeout(() => this.processedMsgIds.delete(msgId), 10 * 60 * 1000);
    }

    const jid = msg.key.remoteJid ?? '';
    if (!jid.endsWith('@s.whatsapp.net')) return;

    const phoneRaw = jid.replace('@s.whatsapp.net', '');
    if (!phoneRaw) return;
    const phone = `+${phoneRaw}`;

    const messageType = Object.keys(msg.message)[0];

    if (IGNORED_TYPES.includes(messageType)) {
      this.logger.debug(`Ignorando mensaje interno (${messageType}) de ${phone}`);
      return;
    }

    const blocked = await this.blockedService.isBlocked(storeId, phone);
    if (blocked) {
      this.logger.log(`🚫 Número bloqueado ignorado: ${phone}`);
      return;
    }

    const isMedia = MEDIA_TYPES.includes(messageType);
    const content =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      '';

    if (isMedia || (!content && !MEDIA_TYPES.includes(messageType))) {
      if (isMedia) {
        await this.handleMediaMessage(storeId, phone, messageType, sock);
      }
      return;
    }

    this.logger.log(`📩 Mensaje de ${phone}: ${content}`);
    await this.handleIncomingMessage(storeId, phone, content, sock);
  }

  private async handleMediaMessage(
    storeId: string,
    phone: string,
    messageType: string,
    sock: any,
  ) {
    const jid = `${phone.replace('+', '')}@s.whatsapp.net`;
    const customer = await this.customersService.findOrCreate({ storeId, phone });
    const conversation = await this.conversationsService.findOrCreate(
      customer.customerId, storeId,
    );

    if (conversation.status === 'human' || conversation.status === 'closed') return;

    let reply: string;
    if (messageType === 'audioMessage') {
      reply = `¡Hola! 😊 Por el momento no puedo escuchar audios. ¿Puedes contarme en texto qué necesitas? Si prefieres un asesor, dímelo y te conecto ahora mismo.`;
    } else if (messageType === 'imageMessage') {
      reply = `¡Gracias por escribirnos! 😊 No puedo ver imágenes por este canal automático, pero un asesor puede ayudarte. ¿Te conecto?`;
    } else {
      reply = `¡Hola! 😊 Recibí tu archivo pero no puedo procesarlo. ¿Te conecto con un asesor?`;
    }

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

  private async handleIncomingMessage(
    storeId: string,
    phone: string,
    content: string,
    sock: any,
  ) {
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

    const onboardingHandled = await this.handleOnboarding(
      customer, conversation, content, sock, phone, storeId,
    );
    if (onboardingHandled) return;

    const humanKeywords = [
      'hablar con una persona', 'hablar con alguien',
      'quiero pagar', 'voy a pagar', 'hacer el pago',
      'persona real', 'asesor', 'operador',
      'no quiero el bot', 'ayuda humana',
    ];

    if (humanKeywords.some(kw => content.toLowerCase().includes(kw))) {
      await this.prisma.conversation.update({
        where: { conversationId: conversation.conversationId },
        data: { status: 'pending_human' },
      });
      const jid = `${phone.replace('+', '')}@s.whatsapp.net`;
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

    const jid = `${phone.replace('+', '')}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: aiReply });
    this.logger.log(`🤖 IA respondió a ${phone}`);
  }

  private extractName(input: string): string {
    const cleaned = input.trim();
    const patterns = [
      /^(?:mi nombre es|me llamo|soy|mi nombre:|nombre:)\s+(.+)/i,
    ];
    for (const pattern of patterns) {
      const match = cleaned.match(pattern);
      if (match) return match[1].trim();
    }
    return cleaned;
  }

  private extractCity(input: string): string {
    const cleaned = input.trim();
    const patterns = [
      /^(?:soy de|estoy en|vivo en|desde|de|en)\s+(.+)/i,
    ];
    for (const pattern of patterns) {
      const match = cleaned.match(pattern);
      if (match) return match[1].trim();
    }
    return cleaned;
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

  private async handleOnboarding(
    customer: any, conversation: any, content: string,
    sock: any, phone: string, storeId: string,
  ): Promise<boolean> {
    const jid = `${phone.replace('+', '')}@s.whatsapp.net`;

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

  private async saveOnboardingMessage(conversationId: string, storeId: string, content: string) {
    await this.messagesService.create({
      conversationId, storeId, content,
      type: 'text', sender: 'store', isAiResponse: true,
    });
  }

  // ── API pública ─────────────────────────────────────────────────────────────

  getQR(storeId: string): string | null {
    return this.qrCodes.get(storeId) ?? null;
  }

  isConnected(storeId: string): boolean {
    return this.sockets.get(storeId)?.user != null;
  }

  async disconnectStore(storeId: string) {
    const sock = this.sockets.get(storeId);
    this.sockets.delete(storeId);
    this.qrCodes.delete(storeId);
    this.reconnecting.delete(storeId);

    if (sock) {
      try {
        await sock.logout();
      } catch {
        try { sock.end(undefined); } catch {}
      }
    }

    await this.prisma.whatsappSession.deleteMany({ where: { storeId } }).catch(() => {});
    await this.prisma.store.update({
      where: { storeId },
      data: { waSessionId: null },
    }).catch(() => {});
  }

  async sendMessage(storeId: string, phone: string, content: string) {
    const sock = this.sockets.get(storeId);
    if (!sock) throw new Error(`No hay socket activo para store: ${storeId}`);
    const jid = `${phone.replace('+', '')}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: content });
    this.logger.log(`📤 Mensaje enviado a ${phone}`);
  }
}