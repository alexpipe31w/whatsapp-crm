import {
  Injectable, Logger, OnModuleInit, Inject, forwardRef,
} from '@nestjs/common';
import { Boom } from '@hapi/boom';
import P from 'pino';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { AiService } from '../ai/ai.service';
import { ConversationsService } from '../conversations/conversations.service';
import { MessagesService } from '../messages/messages.service';
import { CustomersService } from '../customers/customers.service';
import { PrismaService } from '../prisma/prisma.service';
import { BlockedService } from '../blocked/blocked.service';
import { AdminAssistantService } from '../admin-assistant/admin-assistant.service';
import {
  isLidIdentity, lidIdentity, resolveJid, phoneFromJid, lidUserFromJid, jidFromPhone,
} from '../utils/wa-identity.util';

const WHISPER_TIMEOUT_MS    = 25_000;
const WHISPER_MODEL         = 'whisper-large-v3-turbo';
const AUDIO_MAX_SECONDS     = 180;           // audios > 3 min se rechazan sin descargar
const AUDIO_MAX_BYTES       = 10_485_760;    // 10 MB tope de descarga
const AUDIO_RATE_WINDOW_MS  = 60_000;        // ventana de 1 minuto
const AUDIO_RATE_MAX        = 5;             // máx 5 audios por minuto por número

// ─── Constantes ──────────────────────────────────────────────────────────────

const MSG_DEBOUNCE_MS        = 3_000;
const MSG_DEDUP_TTL_MS       = 10 * 60 * 1000;
const HISTORY_SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_CONTENT_LENGTH     = 4_000; // caracteres máximos que se pasan a la IA
const SEND_RETRY_ATTEMPTS          = 4;
const SEND_RETRY_DELAY_MS          = 1_500;
const SEND_NOT_ACCEPTABLE_DELAY_MS = 6_000; // sesión Signal en renegociación, esperar más

const RECONNECT_DELAYS: Record<number, number> = {
  408: 5_000,
  440: 8_000,
};
const DEFAULT_RECONNECT_DELAY = 3_000;
// Código 408 = QR timeout (nadie escaneó). Tras MAX_QR_ATTEMPTS el loop se detiene.
const MAX_QR_ATTEMPTS = 3;
// Código 401 = loggedOut. Reintentos con los mismos creds antes de borrar la sesión:
// un 401 transitorio se recupera; un logout real agota el presupuesto y recién ahí
// se limpia. Evita que cerrar la app de WhatsApp un momento destruya la sesión.
const MAX_LOGGED_OUT_RETRIES   = 2;
const LOGGED_OUT_RETRY_DELAY_MS = 5_000;

// Precarga del mapa LID↔teléfono al conectar. Acotada a los clientes más recientes:
// cada lote es una consulta USYNC al servidor de WhatsApp, no una query local.
const LID_PRELOAD_MAX_CUSTOMERS = 500;
const LID_PRELOAD_BATCH         = 50;
const LID_PRELOAD_TIMEOUT_MS    = 20_000;

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

  // Mensaje de producto (order) — cliente seleccionó del catálogo de WhatsApp
  if (message.orderMessage?.title) {
    const titulo  = message.orderMessage.title;
    const qty     = message.orderMessage.itemCount ?? 1;
    const precioRaw = message.orderMessage.priceAmount1000 ?? message.orderMessage.totalAmount1000;
    const precio  = precioRaw ? `$${Math.round(precioRaw / 1000).toLocaleString('es-CO')}` : null;
    const partes  = [`[Pedido del catálogo: ${titulo}`, `cantidad: ${qty}`];
    if (precio) partes.push(`precio: ${precio}`);
    return partes.join(' | ') + ']';
  }

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
  private readonly qrAttempts      = new Map<string, number>();
  // Reintentos ante código 401 (loggedOut) antes de declarar logout real y borrar
  // la sesión. Un 401 transitorio (el dueño cerró un momento la app de WhatsApp,
  // pérdida de red del teléfono) se recupera reconectando con los MISMOS creds; solo
  // si el 401 persiste tras MAX_LOGGED_OUT_RETRIES se trata como logout definitivo.
  private readonly loggedOutAttempts = new Map<string, number>();
  private readonly processedMsgIds  = new Set<string>();
  // Pares "<storeId>:<waLid>" cuya ficha de cliente ya se cruzó en esta ejecución.
  // Evita repetir la transacción de fusión en cada mensaje del mismo cliente.
  private readonly reconciledLids   = new Set<string>();
  private readonly messageQueues    = new Map<string, Promise<void>>();
  private readonly audioRateLimiter = new Map<string, { count: number; resetAt: number }>();
  private readonly messageBuffers  = new Map<string, {
    contents: string[];
    timer: ReturnType<typeof setTimeout>;
    pushName?: string;
  }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
    private readonly conversationsService: ConversationsService,
    @Inject(forwardRef(() => MessagesService))
    private readonly messagesService: MessagesService,
    private readonly customersService: CustomersService,
    private readonly blockedService: BlockedService,
    private readonly adminAssistant: AdminAssistantService,
  ) {}

  // ─── Ciclo de vida ──────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    // Registrar callback para que AiService pueda enviar recordatorios proactivos
    this.aiService.setSendFn((storeId, phone, message) =>
      this.sendMessage(storeId, phone, message),
    );
    this.adminAssistant.setNotifyFn((storeId, phone, message) =>
      this.sendMessage(storeId, phone, message),
    );

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

    // WhatsApp solo manda el par LID↔teléfono en contadas ocasiones (sync de contactos,
    // migración LID). Guardarlos cuando pasan es la única forma de atribuir después un
    // mensaje direccionado por LID: no existe consulta inversa LID→PN en el protocolo.
    sock.ev.on('contacts.upsert', (c: any) => { void this.learnLidMappings(c, sock); });
    sock.ev.on('contacts.update', (c: any) => { void this.learnLidMappings(c, sock); });

    sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
      // Traza de entrada: si un mensaje no aparece luego en el log, aquí se ve si
      // WhatsApp llegó a entregarlo o si el problema es anterior a nosotros.
      this.logger.debug(`[upsert] type=${type} n=${messages?.length ?? 0}`);
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
      this.logger.debug(`QR generado para store: ${storeId}`);
      this.qrCodes.set(storeId, qr);
    }

    if (connection === 'open') {
      this.logger.log(`✅ WhatsApp conectado: ${storeId}`);
      this.qrCodes.delete(storeId);
      this.reconnecting.delete(storeId);
      this.qrAttempts.delete(storeId);
      this.loggedOutAttempts.delete(storeId);
      await this.prisma.store.update({
        where: { storeId },
        data:  { waSessionId: storeId },
      }).catch(() => {});

      // En segundo plano: la precarga son consultas al servidor de WhatsApp y no puede
      // retrasar la conexión ni tumbarla si falla. Los mensajes entran igual mientras.
      void this.preloadLidMappings(storeId).catch((err: any) =>
        this.logger.warn(`[LID] Precarga falló para ${storeId}: ${err.message}`),
      );
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
    const discError  = lastDisconnect?.error as Boom | undefined;
    const statusCode = discError?.output?.statusCode;
    const loggedOut  = statusCode === DisconnectReason.loggedOut;

    // El motivo real del cierre (device_removed, conflict, replaced...) viene en el
    // error crudo de Baileys, no en el statusCode — loguearlo para diagnóstico.
    let discDetail = discError?.message ?? 'sin detalle';
    try {
      const data = (discError as any)?.data;
      if (data) discDetail += ` | data: ${JSON.stringify(data)}`;
      if (discError?.output?.payload) discDetail += ` | payload: ${JSON.stringify(discError.output.payload)}`;
    } catch { /* JSON circular — dejar solo el message */ }

    this.logger.warn(`Conexión cerrada para ${storeId} — código: ${statusCode} — motivo: ${discDetail}`);

    if (loggedOut) {
      const loAttempts = (this.loggedOutAttempts.get(storeId) ?? 0) + 1;

      // Reintento tolerante: un 401 transitorio (app cerrada un momento, red caída del
      // teléfono) se recupera reconectando con los mismos creds. NO borrar la sesión aún.
      if (loAttempts <= MAX_LOGGED_OUT_RETRIES) {
        this.loggedOutAttempts.set(storeId, loAttempts);
        this.logger.warn(`Store ${storeId} recibió 401 (loggedOut) — reintento ${loAttempts}/${MAX_LOGGED_OUT_RETRIES} con los mismos creds (sin borrar sesión)`);
        if (this.reconnecting.has(storeId)) return;
        this.reconnecting.add(storeId);
        setTimeout(() => {
          this.reconnecting.delete(storeId);
          this.connectStore(storeId).catch(err =>
            this.logger.error(`Error reconectando ${storeId} tras 401: ${err.message}`),
          );
        }, LOGGED_OUT_RETRY_DELAY_MS);
        return;
      }

      // El 401 persiste tras agotar el presupuesto → logout real, limpiar sesión.
      this.logger.warn(`Store ${storeId} hizo logout definitivo (401 tras ${MAX_LOGGED_OUT_RETRIES} reintentos) — limpiando sesión`);
      this.sockets.delete(storeId);
      this.qrCodes.delete(storeId);
      this.reconnecting.delete(storeId);
      this.qrAttempts.delete(storeId);
      this.loggedOutAttempts.delete(storeId);
      await Promise.allSettled([
        this.prisma.whatsappSession.deleteMany({ where: { storeId } }),
        this.prisma.store.update({ where: { storeId }, data: { waSessionId: null } }),
      ]);
      this.logger.log(`🗑️ Sesión borrada de BD: ${storeId}`);
      return;
    }

    if (this.reconnecting.has(storeId)) return;

    // Código 408 = QR expiró. Código undefined = WS cerrado sin frame (sesión corrupta / protocolo desactualizado).
    // Ambos casos cuentan como QR attempt fallido para evitar loop eterno.
    if (statusCode === 408 || statusCode === undefined) {
      const attempts = (this.qrAttempts.get(storeId) ?? 0) + 1;
      this.qrAttempts.set(storeId, attempts);
      if (attempts >= MAX_QR_ATTEMPTS) {
        this.logger.warn(`Store ${storeId}: QR sin conexión ${attempts} veces (código: ${statusCode}) — deteniendo reconexión automática. Usa /connect para reintentar.`);
        this.qrAttempts.delete(storeId);
        this.sockets.delete(storeId);
        this.qrCodes.delete(storeId);
        return;
      }
    }

    this.reconnecting.add(storeId);
    const delay = RECONNECT_DELAYS[statusCode ?? -1] ?? DEFAULT_RECONNECT_DELAY;
    this.logger.log(`Reconectando ${storeId} en ${delay}ms... (intento QR: ${this.qrAttempts.get(storeId) ?? 1}/${MAX_QR_ATTEMPTS})`);

    setTimeout(() => {
      this.reconnecting.delete(storeId);
      this.connectStore(storeId).catch(err =>
        this.logger.error(`Error reconectando ${storeId}: ${err.message}`)
      );
    }, delay);
  }

  // ─── Procesamiento de mensajes ──────────────────────────────────────────────

  /**
   * Identifica al remitente con lo que WhatsApp deje ver, sin exigir teléfono.
   *
   * WhatsApp está migrando el direccionamiento a LID: el mensaje llega con remoteJid
   * "<lid>@lid" y el número solo viaja en participant_pn/sender_pn. Si no los manda,
   * Baileys deja remoteJidAlt vacío y no hay número — y no existe consulta inversa
   * LID→PN (getPNForLID solo lee caché local; pnFromLIDUSync va PN→LID). Antes eso
   * significaba tirar el mensaje; ahora el LID pasa a ser la identidad del cliente.
   *
   * Devuelve la identidad para customers.phone y, cuando se conoce, el LID por separado
   * — se guarda también en los clientes que SÍ tienen teléfono, para poder fusionar.
   */
  private async resolveSenderIdentity(
    msg: any,
    sock: any,
  ): Promise<{ identity: string; waLid: string | null } | null> {
    const jid = resolveJid(msg.key);
    if (!jid) return null;
    if (jid.endsWith('@g.us') || jid.endsWith('@broadcast')) return null;

    // resolveJid prefiere el jid con número; si lo devolvió, el LID original sigue
    // en la key y nos lo quedamos igual para poder cruzar las dos identidades.
    const waLid = lidUserFromJid(jid) ?? lidUserFromJid(msg.key?.remoteJid ?? '');

    const direct = phoneFromJid(jid);
    if (direct) return { identity: direct, waLid };

    if (jid.endsWith('@lid')) {
      try {
        const pn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(jid);
        if (pn) {
          const asJid = String(pn).includes('@') ? String(pn) : `${pn}@s.whatsapp.net`;
          const phone = phoneFromJid(asJid);
          if (phone) {
            this.logger.debug(`[LID] ${jid} → ${phone} (vía lidMapping)`);
            return { identity: phone, waLid };
          }
        }
      } catch (err: any) {
        this.logger.warn(`[LID] No se pudo resolver ${jid}: ${err.message}`);
      }
    }

    // Sin número: el cliente entra identificado por su LID y la IA le responde igual.
    if (waLid) return { identity: lidIdentity(waLid), waLid };

    return null;
  }

  /**
   * Guarda los pares LID↔teléfono que aparezcan en los eventos de contactos. Sin esto,
   * un contacto que escribe por primera vez direccionado por LID es inatribuible.
   */
  private async learnLidMappings(contacts: any, sock: any): Promise<void> {
    const list  = Array.isArray(contacts) ? contacts : [contacts];
    const pairs = list
      .filter((c: any) => c?.id && c?.lid)
      .map((c: any) => ({
        lid: String(c.lid).includes('@') ? String(c.lid) : `${c.lid}@lid`,
        pn:  String(c.id),
      }));
    if (pairs.length === 0) return;
    try {
      await sock?.signalRepository?.lidMapping?.storeLIDPNMappings?.(pairs);
      this.logger.debug(`[LID] aprendidos ${pairs.length} mapeo(s) desde contactos`);
    } catch (err: any) {
      this.logger.warn(`[LID] No se pudieron guardar mapeos: ${err.message}`);
    }
  }

  /**
   * Precarga el mapa LID↔teléfono con los clientes que ya conocemos. WhatsApp NO permite
   * consultar el teléfono de un LID (`getPNForLID` solo lee caché local; `pnFromLIDUSync`
   * va en sentido contrario), pero sí el LID de un teléfono vía USYNC — y el store de
   * Baileys guarda los dos sentidos, así que preguntando por nuestros clientes dejamos
   * listo el camino inverso. Sin esto solo se atribuyen los contactos que estén en la
   * agenda del teléfono vinculado, que es justo lo que un cliente nunca es.
   */
  private async preloadLidMappings(storeId: string): Promise<void> {
    const mapping = this.sockets.get(storeId)?.signalRepository?.lidMapping;
    if (!mapping?.getLIDsForPNs) {
      this.logger.warn(`[LID] Precarga omitida para ${storeId}: la sesión no expone lidMapping`);
      return;
    }

    const customers = await this.prisma.customer.findMany({
      where:   { storeId },
      select:  { phone: true },
      orderBy: { updatedAt: 'desc' },
      take:    LID_PRELOAD_MAX_CUSTOMERS,
    });

    // Los clientes identificados solo por LID (sin teléfono real) no se pueden consultar.
    const jids = customers
      .map(c => c.phone.replace(/\D/g, ''))
      .filter(digits => digits.length >= 7 && digits.length <= 15)
      .map(digits => `${digits}@s.whatsapp.net`);
    if (jids.length === 0) return;

    let resolved = 0;
    for (let i = 0; i < jids.length; i += LID_PRELOAD_BATCH) {
      const batch = jids.slice(i, i + LID_PRELOAD_BATCH);
      try {
        const pairs = await Promise.race([
          mapping.getLIDsForPNs(batch),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('USYNC timeout')), LID_PRELOAD_TIMEOUT_MS),
          ),
        ]);
        resolved += Array.isArray(pairs) ? pairs.length : 0;
      } catch (err: any) {
        // Un lote fallido no puede impedir los siguientes: seguimos con el resto.
        this.logger.warn(`[LID] Precarga ${storeId}: lote ${i / LID_PRELOAD_BATCH + 1} falló: ${err.message}`);
      }
    }
    this.logger.log(`[LID] Precarga ${storeId}: ${resolved}/${jids.length} pares resueltos`);
  }

  private async processMessage(msg: any, storeId: string, sock: any): Promise<void> {
    if (!msg.message) {
      // Sobre suele ser un mensaje que no se pudo descifrar; sin este log desaparece.
      this.logger.warn(`Mensaje sin contenido (¿fallo de descifrado?) — key: ${JSON.stringify(msg.key ?? {})}`);
      return;
    }

    // Mensajes propios: el bot los ignora, salvo el comando interno "!stop" que
    // el dueño escribe dentro del chat del cliente para silenciar al bot ahí.
    // Baileys reporta esos mensajes como fromMe, así que hay que revisarlos
    // ANTES de descartarlos (de lo contrario el comando nunca llega a procesarse).
    if (msg.key?.fromMe) {
      await this.handleOwnerStopCommand(msg, storeId, sock);
      return;
    }

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
    if (!jid) {
      this.logger.warn(`Mensaje descartado sin jid — key: ${JSON.stringify(msg.key ?? {})}`);
      return;
    }

    // Grupos y difusiones: fuera, y sin ruido en el log.
    if (jid.endsWith('@g.us') || jid.endsWith('@broadcast')) return;

    const identity = await this.resolveSenderIdentity(msg, sock);
    if (!identity) {
      // Ya ni teléfono ni LID: sin identidad de ningún tipo no hay a quién responder.
      // Nunca en silencio — volcado completo para saber qué mandó WhatsApp esta vez.
      const ctxInfo = (msg.message as any)?.[Object.keys(msg.message)[0]]?.contextInfo ?? {};
      this.logger.warn(
        `Mensaje SIN identidad resoluble — jid=${jid} | key=${JSON.stringify(msg.key ?? {})} | ` +
        `campos=${JSON.stringify({
          tipo:           Object.keys(msg.message)[0],
          pushName:       msg.pushName,
          senderPn:       (msg.key as any)?.senderPn,
          participantAlt: (msg.key as any)?.participantAlt,
          remoteJidAlt:   (msg.key as any)?.remoteJidAlt,
          ctxParticipant: ctxInfo?.participant,
          ctxRemoteJid:   ctxInfo?.remoteJid,
          topLevel:       Object.keys(msg),
        })}`,
      );
      return;
    }

    const { identity: phone, waLid } = identity;
    if (isLidIdentity(phone)) {
      this.logger.log(`[LID] Cliente sin teléfono: ${phone} (${msg.pushName ?? 'sin nombre'}) — se atiende igual`);
    } else if (waLid) {
      // Conocemos sus dos identidades: si antes había escrito sin número, su ficha está
      // duplicada y hay que unificarla. Una vez cruzada no hay que repetirlo por mensaje.
      const key = `${storeId}:${waLid}`;
      if (!this.reconciledLids.has(key)) {
        this.reconciledLids.add(key);
        await this.customersService.linkLidIdentity(storeId, phone, waLid).catch((err: any) => {
          this.reconciledLids.delete(key); // que lo reintente el próximo mensaje
          this.logger.warn(`[LID] No se pudo cruzar ${waLid} con ${phone}: ${err.message}`);
        });
      }
    }

    const pushName: string | undefined =
      typeof msg.pushName === 'string' && msg.pushName.trim() ? msg.pushName.trim() : undefined;

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

    // Audio/PTT → intentar transcribir con Groq Whisper antes de caer al handler genérico
    if (messageType === 'audioMessage') {
      await this.handleAudioMessage(storeId, phone, sock, msg);
      return;
    }

    // Resto de media (imagen, video, doc, sticker)
    if (MEDIA_TYPES.has(messageType)) {
      await this.handleMediaMessage(storeId, phone, messageType, sock, pushName);
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

    this.bufferAndProcess(storeId, phone, content, sock, pushName);
  }

  // ─── Comando interno del dueño: !stop dentro del chat del cliente ───────────

  private async handleOwnerStopCommand(msg: any, storeId: string, sock: any): Promise<void> {
    const messageType = Object.keys(msg.message ?? {})[0];
    if (!messageType || IGNORED_TYPES.has(messageType) || MEDIA_TYPES.has(messageType)) return;

    const rawContent = extractTextContent(msg.message);
    if (!rawContent) return;
    if (sanitizeContent(rawContent).trim().toLowerCase() !== '!stop') return;

    const jid = resolveJid(msg.key);
    if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) return;

    // Misma identidad que en processMessage: el chat puede ser de un cliente sin
    // número, y ahí "!stop" tiene que silenciar el bot igual que en cualquier otro.
    const identity = await this.resolveSenderIdentity(msg, sock);
    const phone    = identity?.identity;
    if (!phone) return;

    const conversation = await this.prisma.conversation.findFirst({
      where:   { storeId, customer: { phone } },
      orderBy: { lastMessageAt: 'desc' },
    });
    if (!conversation || conversation.status === 'human' || conversation.status === 'closed') return;

    await this.prisma.conversation.update({
      where: { conversationId: conversation.conversationId },
      data:  { status: 'human' },
    });
    this.logger.log(`🛑 !stop del dueño en chat de ${phone} — bot silenciado`);
  }

  // ─── Debounce + cola secuencial ──────────────────────────────────────────────

  private bufferAndProcess(
    storeId: string,
    phone: string,
    content: string,
    sock: any,
    pushName?: string,
  ): void {
    const key      = `${storeId}:${phone}`;
    const existing = this.messageBuffers.get(key);

    if (existing) {
      clearTimeout(existing.timer);
      existing.contents.push(content);
      if (pushName) existing.pushName = pushName;
      this.logger.debug(`📥 Buffer [${key}] — ${existing.contents.length} msgs acumulados`);
    } else {
      this.messageBuffers.set(key, { contents: [content], timer: null!, pushName });
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
        this.handleIncomingMessage(storeId, phone, combined, sock, buffer.pushName),
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

  // ─── Audio → Texto (Groq Whisper) ───────────────────────────────────────────

  private checkAudioRateLimit(phone: string): boolean {
    const now   = Date.now();
    const entry = this.audioRateLimiter.get(phone);
    if (!entry || entry.resetAt < now) {
      this.audioRateLimiter.set(phone, { count: 1, resetAt: now + AUDIO_RATE_WINDOW_MS });
      return true;
    }
    if (entry.count >= AUDIO_RATE_MAX) return false;
    entry.count++;
    return true;
  }

  private async handleAudioMessage(
    storeId: string,
    phone:   string,
    sock:    any,
    msg:     any,
  ): Promise<void> {
    const pushName: string | undefined =
      typeof msg.pushName === 'string' && msg.pushName.trim() ? msg.pushName.trim() : undefined;
    const fallback = () => this.handleMediaMessage(storeId, phone, 'audioMessage', sock, pushName);

    try {
      // ── 1. Rate limit — máx AUDIO_RATE_MAX audios/min por número ──────────
      if (!this.checkAudioRateLimit(phone)) {
        this.logger.warn(`[Audio] Rate limit alcanzado para ${phone} — descartado silenciosamente`);
        return; // no respondemos para no recompensar el spam
      }

      // ── 2. Resolver key de Whisper ────────────────────────────────────────
      // Whisper solo disponible en Groq y OpenAI. Si el provider principal no lo
      // soporta (ej: Gemini), se busca automáticamente en los cartuchos adicionales.
      const aiConfig = await this.prisma.aIConfiguration.findUnique({ where: { storeId } });
      if (!aiConfig?.apiKey) {
        this.logger.debug(`[Audio] ${phone}: sin API key → fallback`);
        return fallback();
      }

      const supportsWhisper = (p: string) => p === 'groq' || p === 'openai';
      const extras = Array.isArray(aiConfig.cartridges) ? aiConfig.cartridges as any[] : [];

      // Construir lista ordenada de candidatos Whisper: primary primero, luego cartuchos
      const whisperCandidates: Array<{ provider: string; apiKey: string }> = [
        { provider: aiConfig.aiProvider ?? 'groq', apiKey: aiConfig.apiKey ?? '' },
        ...extras.map((c: any) => ({ provider: c.provider ?? '', apiKey: c.apiKey ?? '' })),
      ].filter(c => supportsWhisper(c.provider) && c.apiKey.trim());

      if (whisperCandidates.length === 0) {
        this.logger.debug(`[Audio] ${phone}: sin clave Groq/OpenAI disponible → fallback`);
        return fallback();
      }

      const audioMsg  = msg.message?.audioMessage;
      const isPtt     = audioMsg?.ptt ?? false;
      const durationS = audioMsg?.seconds ?? 0;
      const fileBytes = Number(audioMsg?.fileLength ?? 0);

      // ── 3. Validar duración y tamaño ANTES de descargar ───────────────────
      if (durationS > AUDIO_MAX_SECONDS) {
        this.logger.warn(`[Audio] ${phone}: audio de ${durationS}s excede límite de ${AUDIO_MAX_SECONDS}s`);
        const jid = jidFromPhone(phone);
        await this.safeSend(
          sock, jid,
          `El audio es demasiado largo (máximo ${Math.floor(AUDIO_MAX_SECONDS / 60)} min). ¿Puedes contarme en texto qué necesitas?`,
          phone,
          storeId,
        );
        return;
      }
      if (fileBytes > AUDIO_MAX_BYTES) {
        this.logger.warn(`[Audio] ${phone}: archivo de ${fileBytes} bytes excede límite de ${AUDIO_MAX_BYTES}`);
        return fallback();
      }

      const mimeType = audioMsg?.mimetype ?? 'audio/ogg; codecs=opus';
      const ext      = (mimeType.includes('mp4') || mimeType.includes('m4a')) ? 'm4a' : 'ogg';

      this.logger.log(`🎙️ Audio de ${phone} (${isPtt ? 'nota de voz' : 'archivo'}, ${durationS}s) — transcribiendo...`);

      // ── 4. Descargar buffer en memoria (nunca se persiste en BD) ──────────
      const buffer = await downloadMediaMessage(
        msg, 'buffer', {},
        { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage },
      ) as Buffer;

      if (!buffer?.length) {
        this.logger.warn(`[Audio] ${phone}: buffer vacío → fallback`);
        return fallback();
      }

      // Doble check de tamaño real tras descarga
      if (buffer.length > AUDIO_MAX_BYTES) {
        this.logger.warn(`[Audio] ${phone}: buffer real ${buffer.length} bytes > límite → fallback`);
        return fallback();
      }

      // ── 5. Transcribir con Whisper — intentar candidatos en orden ───────
      const whisperPrompt = await this.buildWhisperPrompt(storeId);
      let rawTranscription: string | null = null;
      for (const cand of whisperCandidates) {
        rawTranscription = await this.transcribeAudio(buffer, ext, cand.apiKey, cand.provider, whisperPrompt);
        if (rawTranscription !== null) break;
        this.logger.debug(`[Audio] ${phone}: clave ${cand.provider} falló, probando siguiente...`);
      }

      // Sanitizar transcripción igual que cualquier mensaje de texto
      const transcription = rawTranscription ? sanitizeContent(rawTranscription) : null;

      if (!transcription) {
        this.logger.warn(`[Audio] ${phone}: transcripción vacía → fallback`);
        return fallback();
      }

      this.logger.log(`✅ [Audio] ${phone}: "${transcription.slice(0, 100)}${transcription.length > 100 ? '...' : ''}"`);

      // ── 6. Procesar la transcripción como mensaje de texto normal ─────────
      // El buffer ya no se referencia aquí — puede ser GC'd inmediatamente
      this.bufferAndProcess(storeId, phone, transcription, sock, pushName);

    } catch (err: any) {
      this.logger.error(`[Audio] Error procesando audio de ${phone}: ${err.message}`);
      return fallback();
    }
  }

  // Caché del prompt de vocabulario por tienda (10 min) — evita consultar el catálogo en cada audio
  private readonly whisperPromptCache = new Map<string, { prompt: string; expiresAt: number }>();

  // Construye un "prompt" para Whisper con el vocabulario del negocio (nombres de
  // productos/servicios + términos colombianos). Whisper lo usa para sesgar la
  // transcripción hacia esas palabras → agarra mucho mejor nombres propios, marcas
  // y jerga local que de otro modo confunde.
  private async buildWhisperPrompt(storeId: string): Promise<string> {
    const cached = this.whisperPromptCache.get(storeId);
    if (cached && cached.expiresAt > Date.now()) return cached.prompt;

    let names: string[] = [];
    let storeName = '';
    try {
      const [store, products, services] = await Promise.all([
        this.prisma.store.findUnique({ where: { storeId }, select: { name: true } }),
        this.prisma.product.findMany({ where: { storeId, isActive: true }, select: { name: true }, take: 30, orderBy: { name: 'asc' } }),
        this.prisma.service.findMany({ where: { storeId, isActive: true }, select: { name: true }, take: 30, orderBy: { name: 'asc' } }),
      ]);
      storeName = store?.name ?? '';
      names = [...products, ...services].map(x => x.name).filter(Boolean);
    } catch {
      /* si falla la consulta, igual devolvemos el prompt base */
    }

    const base = 'Mensaje de voz en español de Colombia. Términos: Nequi, Daviplata, Bancolombia, transferencia, efectivo, cita, agendar, pedido, domicilio, factura.';
    let prompt = (storeName ? `${storeName}. ` : '') + base;
    if (names.length) prompt += ` Catálogo: ${names.join(', ')}.`;
    // Whisper acota el prompt (~224 tokens) — recortamos para no desperdiciar ni que lo ignore
    if (prompt.length > 800) prompt = prompt.slice(0, 800);

    this.whisperPromptCache.set(storeId, { prompt, expiresAt: Date.now() + 10 * 60 * 1000 });
    return prompt;
  }

  private async transcribeAudio(
    buffer:   Buffer,
    ext:      string,
    apiKey:   string,
    provider: string,
    prompt?:  string,
  ): Promise<string | null> {
    // Whisper solo disponible en Groq y OpenAI
    const whisperBaseURL = provider === 'openai'
      ? 'https://api.openai.com/v1'
      : 'https://api.groq.com/openai/v1';
    if (provider !== 'groq' && provider !== 'openai') {
      this.logger.debug(`[Audio] Provider "${provider}" no soporta Whisper → fallback`);
      return null;
    }
    try {
      const mimeMap: Record<string, string> = {
        ogg: 'audio/ogg',
        m4a: 'audio/mp4',
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
      };

      const formData  = new FormData();
      // Convertir Buffer a ArrayBuffer para compatibilidad con Blob en Node 18+
      const arrayBuf  = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
      const blob      = new Blob([arrayBuf], { type: mimeMap[ext] ?? 'audio/ogg' });
      formData.append('file',            blob, `audio.${ext}`);
      formData.append('model',           WHISPER_MODEL);
      formData.append('language',        'es');
      formData.append('response_format', 'text');
      formData.append('temperature',     '0');
      if (prompt) formData.append('prompt', prompt);

      const res = await Promise.race([
        fetch(`${whisperBaseURL}/audio/transcriptions`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body:    formData,
        }),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('Whisper timeout')), WHISPER_TIMEOUT_MS),
        ),
      ]);

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        this.logger.warn(`[Whisper] HTTP ${res.status}: ${JSON.stringify(errBody)}`);
        return null;
      }

      const text = (await res.text()).trim();
      return text || null;

    } catch (err: any) {
      this.logger.error(`[Whisper] ${err.message}`);
      return null;
    }
  }

  // ─── Mensajes de media ──────────────────────────────────────────────────────

  private async handleMediaMessage(
    storeId: string,
    phone: string,
    messageType: string,
    sock: any,
    pushName?: string,
  ): Promise<void> {
    try {
      const jid          = jidFromPhone(phone);
      const customer     = await this.customersService.findOrCreate({ storeId, phone, pushName });
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

      await this.safeSend(sock, jid, reply, phone, storeId);

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
      return `¡Gracias por tu foto! 😊 En un momento un asesor te responde personalmente para revisar tu caso. 🙌`;
    }
    if (messageType === 'videoMessage') {
      return `¡Gracias por tu video! 😊 En un momento un asesor te responde personalmente. 🙌`;
    }
    if (messageType === 'documentMessage') {
      return `¡Gracias! 😊 En un momento un asesor revisa tu documento y te responde personalmente. 🙌`;
    }
    if (messageType === 'stickerMessage') {
      return null as any; // Ignorar stickers completamente
    }
    return `¡Gracias por tu mensaje! 😊 En un momento un asesor te responde personalmente. 🙌`;
  }

  // ─── Mensajes de texto ──────────────────────────────────────────────────────

  private async handleIncomingMessage(
    storeId: string,
    phone: string,
    content: string,
    sock: any,
    pushName?: string,
  ): Promise<void> {
    const jid = jidFromPhone(phone);

    try {
      // ── Admin Personal Assistant ───────────────────────────────────────────
      const isAdmin = await this.adminAssistant.isAdminPhone(storeId, phone);
      if (isAdmin) {
        this.logger.log(`🔑 Mensaje del admin (${phone}) → Admin Assistant`);
        const reply = await this.adminAssistant.handle(storeId, phone, content);
        await this.safeSend(sock, jid, reply, phone, storeId);
        return;
      }

      // Obtener/crear cliente y conversación
      const customer = await this.customersService.findOrCreate({ storeId, phone, pushName });
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

        await this.safeSend(sock, jid, handoffReply, phone, storeId);

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
      await this.safeSend(sock, jid, aiReply, phone, storeId);
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
    storeId?: string,
  ): Promise<void> {
    if (!text?.trim()) return;

    const MAX_WA_LENGTH = 4096;
    const chunks: string[] = [];

    if (text.length > MAX_WA_LENGTH) {
      let remaining = text;
      while (remaining.length > 0) {
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
      let lastErr: any;
      for (let i = 0; i < SEND_RETRY_ATTEMPTS; i++) {
        try {
          // En reintentos, buscar socket fresco en caso de reconexión
          const currentSock = (storeId && i > 0) ? (this.sockets.get(storeId) ?? sock) : sock;
          await currentSock.sendMessage(jid, { text: chunk });
          lastErr = null;
          break;
        } catch (err: any) {
          lastErr = err;
          if (i < SEND_RETRY_ATTEMPTS - 1) {
            const isNotAcceptable = String(err?.message ?? '').includes('not-acceptable');
            const delay = isNotAcceptable ? SEND_NOT_ACCEPTABLE_DELAY_MS : SEND_RETRY_DELAY_MS;
            if (isNotAcceptable) {
              this.logger.warn(
                `sendMessage a ${phoneLabel} — not-acceptable (sesión renegociando), ` +
                `reintentando en ${delay}ms... (${i + 1}/${SEND_RETRY_ATTEMPTS})`,
              );
            } else {
              this.logger.warn(
                `sendMessage a ${phoneLabel} — intento ${i + 1}/${SEND_RETRY_ATTEMPTS} ` +
                `falló: ${err.message}. Reintentando en ${delay}ms...`,
              );
            }
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }
      if (lastErr) throw lastErr;
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
    this.qrAttempts.delete(storeId);
    this.loggedOutAttempts.delete(storeId);

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
    await this.safeSend(sock, jid, content, phone, storeId);
    this.logger.log(`📤 Mensaje enviado a ${phone}`);
  }
}