import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { Boom } from '@hapi/boom';
import * as qrcode from 'qrcode-terminal';
import { join } from 'path';
import P from 'pino';
import { AiService } from '../ai/ai.service';
import { ConversationsService } from '../conversations/conversations.service';
import { MessagesService } from '../messages/messages.service';
import { CustomersService } from '../customers/customers.service';
import { PrismaService } from '../prisma/prisma.service';

// Marcadores internos — se guardan en BD para rastrear estado del onboarding
// NO se envían al cliente (se separan antes de enviar por WhatsApp)
const ASK_NAME_MARKER = '__ASK_NAME__';
const ASK_CITY_MARKER = '__ASK_CITY__';

@Injectable()
export class WhatsappService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappService.name);
  private sockets: Map<string, any> = new Map();

  constructor(
    private prisma: PrismaService,
    private aiService: AiService,
    private conversationsService: ConversationsService,
    @Inject(forwardRef(() => MessagesService))
    private messagesService: MessagesService,
    private customersService: CustomersService,
  ) {}

  async onModuleInit() {
    const stores = await this.prisma.store.findMany({
      where: { isActive: true, waSessionId: { not: null } },
    });
    for (const store of stores) {
      this.logger.log(`Reconectando store: ${store.name}`);
      await this.connectStore(store.storeId);
    }
  }

  async connectStore(storeId: string) {
    // Dynamic import para compatibilidad ESM con CommonJS
    const {
      default: makeWASocket,
      DisconnectReason,
      useMultiFileAuthState,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
    } = await import('@whiskeysockets/baileys');

    const authPath = join(process.cwd(), 'sessions', storeId);
    const baileysLogger = P({ level: 'silent' });

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,
      logger: baileysLogger,
    });

    this.sockets.set(storeId, sock);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.logger.log(`QR para store ${storeId}:`);
        qrcode.generate(qr, { small: true });
        this.sockets.set(`${storeId}_qr`, qr);
      }

      if (connection === 'open') {
        this.logger.log(`✅ WhatsApp conectado para store: ${storeId}`);
        this.sockets.delete(`${storeId}_qr`);
        await this.prisma.store.update({
          where: { storeId },
          data: { waSessionId: storeId },
        });
      }

      if (connection === 'close') {
        const shouldReconnect =
          (lastDisconnect?.error as Boom)?.output?.statusCode !==
          DisconnectReason.loggedOut;

        if (shouldReconnect) {
          this.logger.log(`Reconectando store: ${storeId}`);
          await this.connectStore(storeId);
        } else {
          this.logger.warn(`Store ${storeId} desconectada (logged out)`);
          this.sockets.delete(storeId);
          await this.prisma.store.update({
            where: { storeId },
            data: { waSessionId: null },
          });
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;

        const jid = msg.key.remoteJid ?? '';
        if (!jid.endsWith('@s.whatsapp.net')) continue;

        const phoneRaw = jid.replace('@s.whatsapp.net', '');
        if (!phoneRaw) continue;

        const phone = `+${phoneRaw}`;
        const content =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          '';

        if (!content) continue;

        this.logger.log(`📩 Mensaje de ${phone}: ${content}`);

        try {
          await this.handleIncomingMessage(storeId, phone, content, sock);
        } catch (err) {
          this.logger.error(`Error procesando mensaje: ${err.message}`);
        }
      }
    });

    return sock;
  }

  private async handleIncomingMessage(
    storeId: string,
    phone: string,
    content: string,
    sock: any,
  ) {
    // Cargar customer fresco cada vez para tener name/city actualizados
    const customer = await this.customersService.findOrCreate({ storeId, phone });
    const conversation = await this.conversationsService.findOrCreate(
      customer.customerId,
      storeId,
    );

    // Guardar mensaje entrante del cliente
    await this.messagesService.create({
      conversationId: conversation.conversationId,
      storeId,
      content,
      type: 'text',
      sender: 'customer',
      isAiResponse: false,
    });

    // Modo humano o cerrada → bot silenciado
    if (conversation.status === 'human' || conversation.status === 'closed') {
      this.logger.log(`👤 Conversación ${conversation.conversationId} en modo humano — bot silenciado`);
      return;
    }

    // ── ONBOARDING: recopilar nombre y ciudad antes de pasar a IA ──
    const onboardingHandled = await this.handleOnboarding(
      customer,
      conversation,
      content,
      sock,
      phone,
      storeId,
    );
    if (onboardingHandled) return;

    // ── DETECCIÓN DE NECESIDAD DE HUMANO ──
    const humanKeywords = [
      'hablar con una persona', 'hablar con alguien',
      'quiero pagar', 'voy a pagar', 'hacer el pago',
      'persona real', 'asesor', 'operador',
      'no quiero el bot', 'ayuda humana',
    ];

    const needsHuman = humanKeywords.some((kw) =>
      content.toLowerCase().includes(kw),
    );

    if (needsHuman) {
      await this.prisma.conversation.update({
        where: { conversationId: conversation.conversationId },
        data: { status: 'pending_human' },
      });
      const jid = `${phone.replace('+', '')}@s.whatsapp.net`;
      await sock.sendMessage(jid, {
        text: '👤 Entendido! Te voy a conectar con un asesor. Por favor espera un momento...',
      });
      this.logger.log(`🚨 Cliente ${phone} necesita atención humana`);
      return;
    }

    // ── RESPUESTA NORMAL DE IA ──
    const aiReply = await this.aiService.generateReply(
      storeId,
      content,
      conversation.conversationId,
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
    this.logger.log(`🤖 Respuesta IA enviada a ${phone}`);
  }

  /**
   * Máquina de estados del onboarding.
   * Estado se determina leyendo: customer.name, customer.city + último mensaje del bot.
   * Los marcadores (__ASK_NAME__, __ASK_CITY__) se guardan en BD pero NO se envían al cliente.
   * Retorna true si el onboarding manejó el mensaje (no pasar a IA).
   */
  private async handleOnboarding(
    customer: any,
    conversation: any,
    content: string,
    sock: any,
    phone: string,
    storeId: string,
  ): Promise<boolean> {
    const jid = `${phone.replace('+', '')}@s.whatsapp.net`;

    // Último mensaje del bot para saber qué estábamos esperando
    const lastBotMsg = await this.prisma.message.findFirst({
      where: { conversationId: conversation.conversationId, sender: 'store' },
      orderBy: { createdAt: 'desc' },
    });
    const lastBotContent = lastBotMsg?.content ?? '';

    // ── PASO 1: sin nombre ──
    if (!customer.name) {
      if (lastBotContent.includes(ASK_NAME_MARKER)) {
        // Este mensaje ES el nombre del cliente
        const name = content.trim();
        await this.customersService.update(customer.customerId, { name });
        this.logger.log(`✅ Nombre guardado: ${name} (${phone})`);

        // Pedir ciudad
        const visibleMsg = `¡Gracias, ${name}! 😊 ¿De qué ciudad nos escribes? 🏙️`;
        await sock.sendMessage(jid, { text: visibleMsg });
        await this.saveOnboardingMessage(
          conversation.conversationId, storeId,
          `${visibleMsg} ${ASK_CITY_MARKER}`,
        );
        return true;
      }

      // Primera vez → saludar y pedir nombre
      const visibleMsg = `¡Hola! Bienvenido/a 👋 Soy el asistente virtual. Para atenderte mejor, ¿cuál es tu nombre?`;
      await sock.sendMessage(jid, { text: visibleMsg });
      await this.saveOnboardingMessage(
        conversation.conversationId, storeId,
        `${visibleMsg} ${ASK_NAME_MARKER}`,
      );
      return true;
    }

    // ── PASO 2: tiene nombre pero no ciudad ──
    if (!customer.city) {
      if (lastBotContent.includes(ASK_CITY_MARKER)) {
        // Este mensaje ES la ciudad del cliente
        const city = content.trim();
        await this.customersService.update(customer.customerId, { city });
        this.logger.log(`✅ Ciudad guardada: ${city} (${phone})`);
        // Dejar que la IA responda normalmente con el contexto completo
        return false;
      }

      // Cliente registrado antes de esta feature → pedirle ciudad en nueva conversación
      if (!lastBotContent) {
        const visibleMsg = `¡Hola de nuevo, ${customer.name}! 👋 ¿De qué ciudad nos escribes? 🏙️`;
        await sock.sendMessage(jid, { text: visibleMsg });
        await this.saveOnboardingMessage(
          conversation.conversationId, storeId,
          `${visibleMsg} ${ASK_CITY_MARKER}`,
        );
        return true;
      }
    }

    // Cliente con nombre y ciudad → flujo normal de IA
    return false;
  }

  /** Guarda mensaje de onboarding con marcador interno en BD */
  private async saveOnboardingMessage(
    conversationId: string,
    storeId: string,
    contentWithMarker: string,
  ) {
    await this.messagesService.create({
      conversationId,
      storeId,
      content: contentWithMarker,
      type: 'text',
      sender: 'store',
      isAiResponse: true,
    });
  }

  getQR(storeId: string): string | null {
    return this.sockets.get(`${storeId}_qr`) ?? null;
  }

  isConnected(storeId: string): boolean {
    const sock = this.sockets.get(storeId);
    return sock?.user != null;
  }

  async disconnectStore(storeId: string) {
    const sock = this.sockets.get(storeId);
    if (sock) {
      await sock.logout();
      this.sockets.delete(storeId);
    }
  }

  async sendMessage(storeId: string, phone: string, content: string) {
    const sock = this.sockets.get(storeId);
    if (!sock) throw new Error(`No hay socket activo para store: ${storeId}`);

    const jid = `${phone.replace('+', '')}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: content });
    this.logger.log(`📤 Mensaje enviado a ${phone}`);
  }
}