import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as qrcode from 'qrcode-terminal';
import { join } from 'path';
import P from 'pino'; // 👈
import { AiService } from '../ai/ai.service';
import { ConversationsService } from '../conversations/conversations.service';
import { MessagesService } from '../messages/messages.service';
import { CustomersService } from '../customers/customers.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WhatsappService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappService.name);
  private sockets: Map<string, any> = new Map();

  constructor(
    private prisma: PrismaService,
    private aiService: AiService,
    private conversationsService: ConversationsService,
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
    const authPath = join(process.cwd(), 'sessions', storeId);
    const baileysLogger = P({ level: 'silent' }); // 👈 Pino silencioso

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger), // 👈
      },
      printQRInTerminal: false,
      logger: baileysLogger, // 👈
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

    // 👇 Filtrar newsletters, grupos y broadcasts
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
    const customer = await this.customersService.findOrCreate({ storeId, phone });

    const conversation = await this.conversationsService.findOrCreate({
      storeId,
      customerId: customer.customerId,
    });

    await this.messagesService.create({
      conversationId: conversation.conversationId,
      storeId,
      content,
      type: 'text',
      isAiResponse: false,
    });

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
      isAiResponse: true,
    });

    const jid = `${phone.replace('+', '')}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: aiReply });

    this.logger.log(`🤖 Respuesta IA enviada a ${phone}`);
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
