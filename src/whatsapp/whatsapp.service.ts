import {
  Injectable, Logger, OnModuleInit, Inject, forwardRef,
} from '@nestjs/common';
import { Boom } from '@hapi/boom';
import * as qrcode from 'qrcode-terminal';
import { join } from 'path';
import { mkdirSync } from 'fs';
import P from 'pino';
import { AiService } from '../ai/ai.service';
import { ConversationsService } from '../conversations/conversations.service';
import { MessagesService } from '../messages/messages.service';
import { CustomersService } from '../customers/customers.service';
import { PrismaService } from '../prisma/prisma.service';
import { BlockedService } from '../blocked/blocked.service';

const ASK_NAME_MARKER = '__ASK_NAME__';
const ASK_CITY_MARKER = '__ASK_CITY__';

// ── Tipos de mensaje que SÍ son del usuario ──────────────────────────────────
const MEDIA_TYPES = [
  'imageMessage', 'audioMessage', 'videoMessage',
  'documentMessage', 'stickerMessage',
];

// ── Mensajes internos de WhatsApp que se deben IGNORAR completamente ──────────
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
  'ptvMessage',           // video-nota (thumbnail interno)
  'editedMessage',
];

@Injectable()
export class WhatsappService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappService.name);
  // storeId → socket
  private sockets: Map<string, any> = new Map();
  // storeId → QR string
  private qrCodes: Map<string, string> = new Map();
  // storeId → reconexión en progreso
  private reconnecting: Set<string> = new Set();

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
    // Solo reconectar stores que tenían sesión activa (waSessionId != null)
    const stores = await this.prisma.store.findMany({
      where: { isActive: true, waSessionId: { not: null } },
    });
    for (const store of stores) {
      const sessionPath = join(process.cwd(), 'sessions', store.storeId);
      // Si no existe la carpeta de sesión, limpiar el waSessionId y no intentar reconectar
      try {
        const fs = await import('fs');
        if (!fs.existsSync(join(sessionPath, 'creds.json'))) {
          this.logger.warn(`Sesión inválida para store ${store.name} — limpiando BD`);
          await this.prisma.store.update({
            where: { storeId: store.storeId },
            data: { waSessionId: null },
          });
          continue;
        }
      } catch {}

      this.logger.log(`Reconectando store: ${store.name}`);
      await this.connectStore(store.storeId);
    }
  }

  async connectStore(storeId: string) {
    // Evitar doble conexión simultánea
    if (this.reconnecting.has(storeId)) {
      this.logger.warn(`Ya hay una reconexión en progreso para ${storeId}`);
      return;
    }

    const {
      default: makeWASocket,
      DisconnectReason,
      useMultiFileAuthState,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
    } = await import('@whiskeysockets/baileys');

    const sessionPath = join(process.cwd(), 'sessions', storeId);
    // Asegurar que la carpeta existe antes de que Baileys intente escribir
    mkdirSync(sessionPath, { recursive: true });

    const baileysLogger = P({ level: 'silent' });
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,
      logger: baileysLogger,
      // Mejoras de estabilidad
      keepAliveIntervalMs: 30_000,
      connectTimeoutMs: 60_000,
      retryRequestDelayMs: 2_000,
    });

    this.sockets.set(storeId, sock);
    sock.ev.on('creds.update', saveCreds);

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

          // Actualizar BD
          await this.prisma.store.update({
            where: { storeId },
            data: { waSessionId: null },
          }).catch(() => {});

          // Esperar a que Baileys cierre todos los file handles antes de borrar
          setTimeout(async () => {
            try {
              const fs = await import('fs');
              if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                this.logger.log(`🗑️ Sesión borrada: ${storeId}`);
              }
            } catch (e) {
              this.logger.warn(`No se pudo borrar sesión: ${e.message}`);
            }
          }, 3000); // 3s de gracia para que Baileys cierre archivos

        } else if (!this.reconnecting.has(storeId)) {
          // Reconexión automática (no logged out)
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
      if (type !== 'notify') return;

      for (const msg of messages) {
        try {
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

    const jid = msg.key.remoteJid ?? '';
    if (!jid.endsWith('@s.whatsapp.net')) return; // ignorar grupos

    const phoneRaw = jid.replace('@s.whatsapp.net', '');
    if (!phoneRaw) return;
    const phone = `+${phoneRaw}`;

    // ── Detectar tipo ────────────────────────────────────────────────────────
    const messageType = Object.keys(msg.message)[0];

    // Ignorar mensajes internos de WhatsApp
    if (IGNORED_TYPES.includes(messageType)) {
      this.logger.debug(`Ignorando mensaje interno (${messageType}) de ${phone}`);
      return;
    }

    // ── Lista negra ──────────────────────────────────────────────────────────
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

    // ── Palabra clave !stop ──────────────────────────────────────────────────
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

  /**
   * Extrae el nombre real de frases como:
   * "mi nombre es Alex" → "Alex"
   * "me llamo María José" → "María José"
   * "soy Pedro" → "Pedro"
   * "Alex" → "Alex"
   */
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

  /**
   * Extrae la ciudad de frases como:
   * "soy de Bogotá" → "Bogotá"
   * "estoy en Medellín" → "Medellín"
   * "de Cali" → "Cali"
   * "Neiva" → "Neiva"
   */
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

  /** Valida que el valor tenga al menos 2 letras (no solo símbolos/números) */
  private isValidText(value: string): boolean {
    return /[a-záéíóúüñA-ZÁÉÍÓÚÜÑ]{2,}/.test(value);
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

        // Validar que sea un nombre real
        if (!this.isValidText(name)) {
          const msg = `No entendí tu nombre 😅 ¿Me lo puedes escribir de nuevo? (solo el nombre)`;
          await sock.sendMessage(jid, { text: msg });
          await this.saveOnboardingMessage(conversation.conversationId, storeId, `${msg} ${ASK_NAME_MARKER}`);
          return true;
        }

        // Capitalizar primera letra de cada palabra
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

        // Validar que sea una ciudad real
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