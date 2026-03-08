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

const ASK_NAME_MARKER = '__ASK_NAME__';
const ASK_CITY_MARKER = '__ASK_CITY__';

// Tipos de mensaje que requieren atención humana
const MEDIA_TYPES = ['imageMessage', 'audioMessage', 'videoMessage', 'documentMessage', 'stickerMessage'];

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

        // ── Detectar tipo de mensaje ──────────────────────────────────────
        const messageType = Object.keys(msg.message)[0];
        const isMedia = MEDIA_TYPES.includes(messageType);

        const content =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          '';

        // Si es media o no tiene texto, manejarlo aparte
        if (isMedia || !content) {
          try {
            await this.handleMediaMessage(storeId, phone, messageType, sock);
          } catch (err) {
            this.logger.error(`Error procesando media: ${err.message}`);
          }
          continue;
        }

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

  /**
   * Maneja mensajes de audio, imagen, video, documento, sticker.
   * Avisa al cliente y transfiere al asesor humano.
   */
  private async handleMediaMessage(
    storeId: string,
    phone: string,
    messageType: string,
    sock: any,
  ) {
    const jid = `${phone.replace('+', '')}@s.whatsapp.net`;

    const customer = await this.customersService.findOrCreate({ storeId, phone });
    const conversation = await this.conversationsService.findOrCreate(
      customer.customerId,
      storeId,
    );

    // Si ya está en modo humano o cerrada, no hacer nada
    if (conversation.status === 'human' || conversation.status === 'closed') return;

    let reply: string;

    if (messageType === 'audioMessage') {
      reply = `¡Hola! 😊 Por el momento no puedo escuchar audios, pero con gusto te atiendo. ¿Puedes contarme en texto qué necesitas? Si prefieres hablar con un asesor, dímelo y te conecto ahora mismo 🍯`;
    } else if (messageType === 'imageMessage') {
      reply = `¡Gracias por escribirnos! 😊 No puedo ver imágenes por este canal automático, pero un asesor puede ayudarte de inmediato. ¿Te conecto con él ahora?`;
    } else {
      reply = `¡Hola! 😊 Recibí tu archivo pero no puedo procesarlo aquí. ¿Te conecto con un asesor para ayudarte mejor?`;
    }

    // Transferir a pending_human
    await this.prisma.conversation.update({
      where: { conversationId: conversation.conversationId },
      data: { status: 'pending_human' },
    });

    // Guardar mensaje entrante como "[media]"
    await this.messagesService.create({
      conversationId: conversation.conversationId,
      storeId,
      content: `[${messageType.replace('Message', '')}]`,
      type: messageType.replace('Message', ''),
      sender: 'customer',
      isAiResponse: false,
    });

    // Enviar respuesta y guardarla
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
      customer.customerId,
      storeId,
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
      this.logger.log(`👤 Conversación ${conversation.conversationId} en modo humano — bot silenciado`);
      return;
    }

    const onboardingHandled = await this.handleOnboarding(
      customer,
      conversation,
      content,
      sock,
      phone,
      storeId,
    );
    if (onboardingHandled) return;

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

  private async handleOnboarding(
    customer: any,
    conversation: any,
    content: string,
    sock: any,
    phone: string,
    storeId: string,
  ): Promise<boolean> {
    const jid = `${phone.replace('+', '')}@s.whatsapp.net`;

    const lastBotMsg = await this.prisma.message.findFirst({
      where: { conversationId: conversation.conversationId, sender: 'store' },
      orderBy: { createdAt: 'desc' },
    });
    const lastBotContent = lastBotMsg?.content ?? '';

    if (!customer.name) {
      if (lastBotContent.includes(ASK_NAME_MARKER)) {
        const name = content.trim();
        await this.customersService.update(customer.customerId, { name });
        this.logger.log(`✅ Nombre guardado: ${name} (${phone})`);

        const visibleMsg = `¡Gracias, ${name}! 😊 ¿De qué ciudad nos escribes? 🏙️`;
        await sock.sendMessage(jid, { text: visibleMsg });
        await this.saveOnboardingMessage(
          conversation.conversationId, storeId,
          `${visibleMsg} ${ASK_CITY_MARKER}`,
        );
        return true;
      }

      const visibleMsg = `¡Hola! Bienvenido/a 👋 Soy el asistente virtual. Para atenderte mejor, ¿cuál es tu nombre?`;
      await sock.sendMessage(jid, { text: visibleMsg });
      await this.saveOnboardingMessage(
        conversation.conversationId, storeId,
        `${visibleMsg} ${ASK_NAME_MARKER}`,
      );
      return true;
    }

    if (!customer.city) {
      if (lastBotContent.includes(ASK_CITY_MARKER)) {
        const city = content.trim();
        await this.customersService.update(customer.customerId, { city });
        this.logger.log(`✅ Ciudad guardada: ${city} (${phone})`);
        return false;
      }

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

    return false;
  }

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