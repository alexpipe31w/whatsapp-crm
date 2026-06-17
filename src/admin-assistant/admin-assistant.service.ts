import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CustomersService } from '../customers/customers.service';
import { AppointmentStatus } from '../generated/prisma/enums';
import { createCompletion } from '../ai/providers';
import {
  buildCartridgeList, ensurePool, getNextCartridge,
  markExhausted, isRateLimitError, Cartridge,
} from '../ai/key-pool';

// ── Historial en memoria (TTL 2h por tienda) ──────────────────────────────────
interface SessionMessage { role: 'user' | 'assistant'; content: string }
interface Session { messages: SessionMessage[]; lastActivity: number }

const SESSION_TTL_MS    = 2 * 60 * 60 * 1000; // 2h
const MAX_HISTORY       = 16;
const ACTION_RE         = /⚡ACTION⚡([A-Z_]+)⚡({[\s\S]*?})⚡END⚡/g;

function fmtApptDate(scheduledAt: Date): string {
  return scheduledAt.toLocaleDateString('es-CO', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Bogota',
  });
}
function fmtApptTime(scheduledAt: Date): string {
  return scheduledAt.toLocaleTimeString('es-CO', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
  });
}

const APPT_STATUS_LABEL: Record<string, string> = {
  PENDING:     'pendiente',
  CONFIRMED:   'confirmada',
  IN_PROGRESS: 'en curso',
  COMPLETED:   'completada',
  CANCELLED:   'cancelada',
  NO_SHOW:     'marcada como no-show',
  RESCHEDULED: 'reagendada',
};

// ── Formato de número ─────────────────────────────────────────────────────────
const normalizePhone = (p: string) => p.replace(/\D/g, '');

// Cliente genérico para "ventas rápidas" sin cliente identificado (uno por tienda).
// El teléfono es un centinela sin dígitos → nunca colisiona ni matchea búsquedas por número real.
const QUICK_SALE_PHONE = 'venta-rapida';
const QUICK_SALE_NAME  = 'Venta rápida';

@Injectable()
export class AdminAssistantService implements OnModuleDestroy {
  private readonly logger   = new Logger(AdminAssistantService.name);
  private readonly sessions = new Map<string, Session>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private notifyFn?: (storeId: string, phone: string, message: string) => Promise<void>;

  setNotifyFn(fn: (storeId: string, phone: string, message: string) => Promise<void>): void {
    this.notifyFn = fn;
  }

  constructor(
    private readonly prisma:    PrismaService,
    private readonly customers: CustomersService,
  ) {
    this.cleanupTimer = setInterval(() => this.cleanSessions(), 30 * 60 * 1000);
  }

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
  }

  // ─── Punto de entrada principal ───────────────────────────────────────────

  async handle(storeId: string, adminPhone: string, content: string): Promise<string> {
    try {
      const [context, aiConfig] = await Promise.all([
        this.buildContext(storeId),
        this.getAiConfig(storeId),
      ]);

      if (!aiConfig) {
        return '⚠️ No tienes configurada la IA. Ve a Configuración → Asistente IA y guarda tu API key para activar el asistente personal.';
      }

      const session  = this.getSession(storeId);
      const history  = session.messages.slice(-MAX_HISTORY);

      const systemPrompt = this.buildSystemPrompt(context);

      const messages = [
        { role: 'system' as const,    content: systemPrompt },
        ...history,
        { role: 'user' as const,      content },
      ];

      // Pool de cartuchos COMPARTIDO con el asistente conversacional (misma key
      // por storeId): así ambos ven qué llaves ya están agotadas/limitadas y no
      // las martillan por separado — ahorra tokens y evita la cascada de 401/429.
      const allCartridges = buildCartridgeList(aiConfig as any);
      ensurePool(storeId, allCartridges);

      let reply = '';
      let lastErr: unknown;
      const triedKeys = new Set<string>();
      let cur: Cartridge | null = getNextCartridge(storeId) ?? allCartridges[0] ?? null;

      while (cur) {
        const key = `${cur.provider}:${cur.apiKey}`;
        if (triedKeys.has(key)) break;
        triedKeys.add(key);
        const thisCur = cur;

        try {
          reply = await createCompletion(thisCur.provider, thisCur.apiKey, thisCur.model, messages, 0.4, 1200);
          break;
        } catch (err: any) {
          lastErr = err;
          const status       = err?.status ?? err?.statusCode ?? err?.response?.status;
          const isAuthError  = status === 401 || status === 403;
          this.logger.warn(`[AdminAssistant] ${storeId}: proveedor ${thisCur.provider} falló (${status ?? err?.message ?? err}), probando siguiente cartridge...`);
          // Solo se exilia del pool compartido si la llave está agotada/limitada o
          // inválida — un error transitorio no debe condenarla por la próxima hora.
          if (isRateLimitError(err) || isAuthError) markExhausted(storeId, thisCur);
          const next = getNextCartridge(storeId);
          cur = (next && !triedKeys.has(`${next.provider}:${next.apiKey}`)) ? next : null;
        }
      }
      if (!reply) throw lastErr ?? new Error('Todos los cartridges fallaron');

      // ── Detectar y ejecutar acción(es) ─────────────────────────────────────
      // El LLM puede emitir varias acciones en una sola respuesta (ej: confirmar
      // una cita y cancelar otra), así que hay que procesar TODAS las coincidencias
      // — no solo la primera — y quitarlas todas del texto visible.
      const actionMatches = [...reply.matchAll(ACTION_RE)];
      if (actionMatches.length > 0) {
        const visibleText = reply.replace(ACTION_RE, '').trim();

        const actionResults: string[] = [];
        for (const match of actionMatches) {
          const actionType = match[1];
          let   actionParams: any = {};
          try { actionParams = JSON.parse(match[2]); } catch { /* ignore */ }
          actionResults.push(await this.executeAction(storeId, actionType, actionParams));
        }

        reply = [visibleText, ...actionResults].filter(Boolean).join('\n\n');
      }

      // Guardar en historial
      session.messages.push({ role: 'user',      content });
      session.messages.push({ role: 'assistant', content: reply });
      session.lastActivity = Date.now();
      if (session.messages.length > MAX_HISTORY * 2) {
        session.messages = session.messages.slice(-MAX_HISTORY * 2);
      }

      return reply;
    } catch (err: any) {
      this.logger.error(`[AdminAssistant] ${storeId}: ${err.message}`);
      return '❌ Ocurrió un error procesando tu solicitud. Intenta de nuevo.';
    }
  }

  // ─── Contexto en tiempo real ──────────────────────────────────────────────

  private async buildContext(storeId: string): Promise<string> {
    const now          = new Date();
    const tzOffset     = -5 * 60;
    const localNow     = new Date(now.getTime() + tzOffset * 60 * 1000);
    const todayStart   = new Date(Date.UTC(
      localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), 5, 0, 0, 0,
    ));
    const todayEnd     = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
    const weekStart    = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthStart   = new Date(Date.UTC(
      localNow.getUTCFullYear(), localNow.getUTCMonth(), 1, 5, 0, 0, 0,
    ));

    const [store, apptToday, apptUpcoming, recentOrders, monthOrders, services, products, customers] =
      await Promise.all([
        this.prisma.store.findUnique({
          where:  { storeId },
          select: { name: true, phone: true, adminPhone: true },
        }),
        this.prisma.appointment.findMany({
          where:   { storeId, scheduledAt: { gte: todayStart, lt: todayEnd } },
          include: { customer: { select: { name: true, phone: true } }, service: { select: { name: true } } },
          orderBy: { scheduledAt: 'asc' },
        }),
        this.prisma.appointment.findMany({
          where:   { storeId, scheduledAt: { gte: todayEnd }, status: { in: ['PENDING', 'CONFIRMED'] } },
          include: { customer: { select: { name: true, phone: true } }, service: { select: { name: true } } },
          orderBy: { scheduledAt: 'asc' },
          take:    10,
        }),
        this.prisma.order.findMany({
          where:   { storeId, createdAt: { gte: weekStart } },
          include: { customer: { select: { name: true, phone: true } }, orderItems: { include: { product: true, service: true } } },
          orderBy: { createdAt: 'desc' },
          take:    20,
        }),
        this.prisma.order.findMany({
          where:   { storeId, createdAt: { gte: monthStart }, status: { not: 'cancelled' } },
          select:  { total: true, status: true },
        }),
        this.prisma.service.findMany({
          where:   { storeId, isActive: true },
          select:  { serviceId: true, name: true, basePrice: true, priceType: true, estimatedMinutes: true },
        }),
        this.prisma.product.findMany({
          where:   { storeId, isActive: true },
          select:  { productId: true, name: true, salePrice: true, stock: true },
          orderBy: { name: 'asc' },
          take:    50,
        }),
        this.prisma.customer.findMany({
          where:   { storeId },
          select:  { customerId: true, name: true, phone: true, totalOrders: true, totalSpent: true },
          orderBy: { totalSpent: 'desc' },
          take:    20,
        }),
      ]);

    const fmtMoney  = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
    const fmtTime   = (d: Date)   => {
      const local = new Date(d.getTime() + tzOffset * 60 * 1000);
      return local.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    };
    const fmtDate   = (d: Date)   => {
      const local = new Date(d.getTime() + tzOffset * 60 * 1000);
      return local.toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' });
    };

    const monthRevenue = monthOrders.reduce((s, o) => s + Number(o.total ?? 0), 0);
    const todayOrders  = recentOrders.filter(o => new Date(o.createdAt) >= todayStart);
    const todayRevenue = todayOrders
      .filter(o => o.status !== 'cancelled')
      .reduce((s, o) => s + Number(o.total ?? 0), 0);

    const apptTodayLines = apptToday.length
      ? apptToday.map(a =>
          `  • ${fmtTime(a.scheduledAt)} — ${a.customer?.name ?? a.customer?.phone ?? '?'} | ${a.service?.name ?? 'Servicio'} | ${a.status}`
        ).join('\n')
      : '  (sin citas hoy)';

    const apptUpcomingLines = apptUpcoming.length
      ? apptUpcoming.slice(0, 5).map(a =>
          `  • ${fmtDate(a.scheduledAt)} ${fmtTime(a.scheduledAt)} — ${a.customer?.name ?? a.customer?.phone ?? '?'} | ${a.service?.name ?? '?'}`
        ).join('\n')
      : '  (ninguna)';

    const productOrdersToday  = todayOrders.filter(o => o.type !== 'service');
    const serviceOrdersToday  = todayOrders.filter(o => o.type === 'service');

    const productOrderLines = productOrdersToday.length
      ? productOrdersToday.slice(0, 5).map(o => {
          const items = o.orderItems.map(i => i.product?.name ?? i.service?.name ?? 'Item').join(', ');
          return `  • ${o.customer?.name ?? o.customer?.phone ?? '?'} | ${items} | ${fmtMoney(Number(o.total))} | ${o.status}`;
        }).join('\n')
      : '  (ninguna)';

    const serviceOrderLines = serviceOrdersToday.length
      ? serviceOrdersToday.slice(0, 5).map(o => {
          const svc = o.orderItems[0]?.service?.name ?? o.notes ?? 'Servicio';
          const method = o.manualPaymentMethod ?? 'efectivo';
          return `  • ${o.customer?.name ?? o.customer?.phone ?? '?'} | ${svc} | ${fmtMoney(Number(o.total))} | ${method}`;
        }).join('\n')
      : '  (ninguna)';

    const serviceLines = services.map(s => {
      const price = s.basePrice ? fmtMoney(Number(s.basePrice)) : 'variable';
      return `  • ${s.name} | ${price} | ID: ${s.serviceId}`;
    }).join('\n');

    const productLines = products.length
      ? products.map(p =>
          `  • ${p.name} | ${fmtMoney(Number(p.salePrice))} | Stock: ${p.stock} | ID: ${p.productId}`
        ).join('\n')
      : '  (sin productos activos)';

    const customerLines = customers.slice(0, 10).map(c =>
      `  • ${c.name ?? 'Sin nombre'} | ${c.phone} | ${c.totalOrders} pedidos | ${fmtMoney(Number(c.totalSpent))} | ID: ${c.customerId}`
    ).join('\n');

    const today = localNow.toLocaleDateString('es-CO', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const serviceRevToday  = serviceOrdersToday.reduce((s, o) => s + Number(o.total), 0);
    const productRevToday  = productOrdersToday.filter(o => o.status !== 'cancelled').reduce((s, o) => s + Number(o.total), 0);

    return `TIENDA: ${store?.name ?? storeId}
FECHA Y HORA ACTUAL: ${today} — ${fmtTime(now)}

━━ CITAS DE HOY (${apptToday.length}) ━━
${apptTodayLines}

━━ PRÓXIMAS CITAS ━━
${apptUpcomingLines}

━━ VENTAS DE PRODUCTOS HOY (${productOrdersToday.length}) ━━
${productOrderLines}
Subtotal productos: ${fmtMoney(productRevToday)}

━━ VENTAS DE SERVICIOS HOY (${serviceOrdersToday.length}) ━━
(Generadas automáticamente al confirmar pago de citas)
${serviceOrderLines}
Subtotal servicios: ${fmtMoney(serviceRevToday)}

━━ REVENUE TOTAL HOY ━━
${fmtMoney(todayRevenue)}

━━ FINANZAS DEL MES ━━
Revenue mes: ${fmtMoney(monthRevenue)} | ${monthOrders.length} pedidos

━━ CATÁLOGO DE SERVICIOS ACTIVOS ━━
(Esto son SERVICIOS — citas, cortes, reparaciones, trabajos con cita previa)
${serviceLines}

━━ CATÁLOGO DE PRODUCTOS ACTIVOS ━━
(Esto son PRODUCTOS — artículos físicos que se venden y entregan, NO requieren cita)
${productLines}

━━ TOP CLIENTES ━━
${customerLines}`;
  }

  // ─── System prompt ────────────────────────────────────────────────────────

  private buildSystemPrompt(context: string): string {
    return `Eres el asistente personal de administración de la tienda. Solo el dueño/admin tiene acceso a ti.
Tienes acceso TOTAL a los datos del negocio en tiempo real. Responde en español colombiano, sé directo y conciso.
Usa emojis con moderación. Formatea listas con •. NO uses asteriscos para negritas.

${context}

━━ ACCIONES QUE PUEDES EJECUTAR ━━
Cuando el admin te pida crear o modificar algo, incluye al FINAL de tu respuesta el bloque de acción exactamente así:

Para crear una venta/orden — el CLIENTE es OPCIONAL: si el admin NO menciona cliente, NO lo pidas; omite customerPhone/customerName y se registra como "Venta rápida". Para cada ítem: si reconoces el producto/servicio en el catálogo manda su "serviceId" (CATÁLOGO DE SERVICIOS) o "productId" (CATÁLOGO DE PRODUCTOS) — nunca mezcles ambos. Si NO estás seguro del ID, manda solo "description" (y "unitPrice" si lo sabes): el sistema busca el más parecido o te sugiere opciones, no inventes IDs:
⚡ACTION⚡CREATE_ORDER⚡{"customerPhone":"<telefono_opcional>","customerName":"<nombre_opcional>","items":[{"description":"<nombre>","serviceId":"<id_si_lo_sabes>","productId":"<id_si_lo_sabes>","quantity":1,"unitPrice":<precio>}],"notes":"<opcional>","paymentMethod":"efectivo"}⚡END⚡

Para crear una cita (si el cliente no existe aún, se crea automáticamente con el teléfono — incluye "customerName" si el admin lo menciona):
⚡ACTION⚡CREATE_APPOINTMENT⚡{"customerPhone":"<telefono>","customerName":"<nombre_opcional_si_es_cliente_nuevo>","serviceId":"<id_del_catalogo_de_servicios>","scheduledAt":"<ISO8601 Colombia>","notes":"<opcional>"}⚡END⚡

Para cancelar una cita (usa "appointmentId" SOLO si el admin te lo dio explícitamente; si solo mencionó el nombre o teléfono del cliente, manda "customerName"/"customerPhone" y el sistema la busca y la encuentra — si hay varias coincidencias te las lista para que el admin elija):
⚡ACTION⚡CANCEL_APPOINTMENT⚡{"appointmentId":"<id_opcional>","customerName":"<nombre_opcional>","customerPhone":"<telefono_opcional>","reason":"<motivo>"}⚡END⚡

Para confirmar una cita (mismo criterio de búsqueda que cancelar — ID o nombre/teléfono):
⚡ACTION⚡CONFIRM_APPOINTMENT⚡{"appointmentId":"<id_opcional>","customerName":"<nombre_opcional>","customerPhone":"<telefono_opcional>"}⚡END⚡

Para completar una cita — marcar como realizada (mismo criterio de búsqueda que cancelar):
⚡ACTION⚡COMPLETE_APPOINTMENT⚡{"appointmentId":"<id_opcional>","customerName":"<nombre_opcional>","customerPhone":"<telefono_opcional>","paymentAmount":<monto>,"paymentMethod":"efectivo"}⚡END⚡

Para reporte del día:
⚡ACTION⚡DAILY_REPORT⚡{}⚡END⚡

Para enviar un mensaje de WhatsApp directo a un cliente (mensaje libre, NO generado por IA sin aprobación):
⚡ACTION⚡SEND_CUSTOMER_MESSAGE⚡{"customerName":"<nombre_del_cliente>","customerPhone":"<telefono_si_lo_tienes>","message":"<texto_exacto_que_recibirá_el_cliente>"}⚡END⚡

REGLAS para SEND_CUSTOMER_MESSAGE:
- El campo "message" es el texto EXACTO que recibirá el cliente en su WhatsApp — redáctalo como un mensaje natural y amable de la tienda.
- En tu respuesta VISIBLE al admin, muestra siempre el mensaje que vas a mandar antes de enviarlo: "Le enviaré esto a [nombre]: '[mensaje]'"
- Si el admin NO especificó qué decir (ej: solo dijo "escríbele a Felipe"), pregúntale primero: "¿Qué quieres que le diga exactamente?" — nunca inventes ni asumas el contenido del mensaje.
- Si el admin sí especificó el texto (entre comillas, o después de "dile:", "escríbele:", "mándale:"), úsalo tal cual sin modificar.
- No incluyas en el mensaje datos inventados (citas, precios, fechas) que no estén en el contexto real.

REGLAS:
- PRODUCTOS y SERVICIOS son catálogos DISTINTOS — revisa el correcto antes de decir "no lo encuentro". Un producto NO aparece en el catálogo de servicios ni viceversa; eso es normal, no es un error.
- Si no tienes el ID de algo, búscalo en el contexto correspondiente. Si aun así no aparece, dile al admin que no lo encuentras EN ESE catálogo y pregunta si es un producto o un servicio.
- Para crear citas, la fecha/hora SIEMPRE en ISO8601 con offset Colombia (-05:00)
- VENTA RÁPIDA (productos/servicios): registra de inmediato. El cliente es OPCIONAL — si el admin no lo menciona, NO preguntes por nombre ni teléfono; ejecuta CREATE_ORDER sin cliente y queda como "Venta rápida". Si el admin manda un audio o un mensaje corto tipo "registra venta de corte 20mil" o "vendí 2 ceras a 15 mil", ejecuta YA con lo que tienes; solo pregunta si falta el PRECIO o si de plano no se entiende qué producto/servicio es.
- Si NO reconoces con certeza el producto/servicio, NO inventes el ID: manda solo "description" (y "unitPrice" si lo sabes) y deja que el sistema busque el más parecido. Si el sistema te devuelve opciones para elegir, muéstraselas al admin tal cual y espera que elija — no asumas.
- Para CITAS sí necesitas identificar al cliente: si el admin te da el teléfono (y opcionalmente el nombre) el sistema lo crea solo. NUNCA te detengas a "registrar primero al cliente".
- Si ya tienes lo necesario (ítems + precio para ventas; o teléfono + servicio + fecha/hora para citas), EJECUTA de una vez — no repreguntes datos que ya tienes.
- NUNCA reutilices el cliente de una venta/cita anterior de esta conversación para una nueva. Para CITAS, si el admin pide "otra cita" sin decir de quién es, pregúntale. Para VENTAS, si no menciona cliente, simplemente usa "Venta rápida" (no preguntes).
- Para confirmar/cancelar/completar citas: NUNCA inventes ni adivines un appointmentId. Si el admin solo dijo el nombre del cliente ("confirma la cita de Juan"), manda "customerName" — el sistema la busca por ti y, si hay varias, te las muestra para que el admin elija. Solo manda "appointmentId" si el admin te dio ese ID explícitamente (por ejemplo, copiado de una respuesta anterior tuya).
- Si el admin pide algo que claramente no está en el contexto (ni en productos ni en servicios), dile que no encuentras esa información
- Nunca inventes datos — solo usa lo que está en el contexto
- Si el admin pregunta algo que puedes responder con el contexto, hazlo SIN usar acción`;
  }

  // ─── Resolver/crear cliente por teléfono (atómico, tolera formatos) ──────
  //
  // Primero busca por coincidencia parcial de los últimos 9 dígitos — tolera que
  // el admin escriba el número con o sin "+57", espacios, guiones, etc. Si no
  // existe, lo crea al vuelo vía CustomersService.findOrCreate (upsert atómico,
  // protegido contra condiciones de carrera) en formato canónico E.164 colombiano,
  // igual al que produce el flujo de WhatsApp — así no queda duplicado cuando ese
  // mismo cliente escriba luego al negocio.
  private async findOrCreateCustomerByPhone(storeId: string, rawPhone: string, name?: string) {
    const digits   = normalizePhone(rawPhone);
    const existing = await this.prisma.customer.findFirst({
      where: { storeId, phone: { contains: digits.slice(-9) } },
    });
    if (existing) return existing;

    const canonicalPhone = digits.length === 10 && digits.startsWith('3') ? `+57${digits}` : `+${digits}`;
    return this.customers.findOrCreate({ storeId, phone: canonicalPhone, name });
  }

  // ─── Cliente genérico "Venta rápida" (uno por tienda, idempotente) ───────────
  private async getOrCreateQuickSaleCustomer(storeId: string) {
    return this.customers.findOrCreate({ storeId, phone: QUICK_SALE_PHONE, name: QUICK_SALE_NAME });
  }

  // ─── Matching difuso contra el catálogo (productos + servicios) ──────────────
  // Normaliza (minúsculas, sin tildes ni signos) y puntúa por: igualdad > inclusión
  // > solapamiento de palabras (Jaccard). Sirve cuando la IA manda solo la
  // descripción del ítem (o un ID que no existe) — recupera el más parecido o
  // devuelve opciones para sugerir, en vez de fallar en seco.
  private normalizeText(s: string): string {
    return (s ?? '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async findCatalogMatches(
    storeId: string,
    query: string,
  ): Promise<Array<{ type: 'product' | 'service'; id: string; name: string; price: number; score: number }>> {
    const q = this.normalizeText(query);
    if (!q) return [];
    const qWords = new Set(q.split(' ').filter(w => w.length > 1));

    const [products, services] = await Promise.all([
      this.prisma.product.findMany({ where: { storeId, isActive: true }, select: { productId: true, name: true, salePrice: true } }),
      this.prisma.service.findMany({ where: { storeId, isActive: true }, select: { serviceId: true, name: true, basePrice: true } }),
    ]);

    const score = (name: string): number => {
      const n = this.normalizeText(name);
      if (!n) return 0;
      if (n === q) return 1;
      if (n.includes(q) || q.includes(n)) return 0.85;
      const nWords = new Set(n.split(' ').filter(w => w.length > 1));
      let inter = 0;
      qWords.forEach(w => { if (nWords.has(w)) inter++; });
      const union = new Set([...qWords, ...nWords]).size || 1;
      return inter / union;
    };

    const items = [
      ...products.map(p => ({ type: 'product' as const, id: p.productId, name: p.name, price: Number(p.salePrice ?? 0), score: score(p.name) })),
      ...services.map(s => ({ type: 'service' as const, id: s.serviceId, name: s.name, price: Number(s.basePrice ?? 0), score: score(s.name) })),
    ];
    return items.filter(i => i.score >= 0.34).sort((a, b) => b.score - a.score).slice(0, 3);
  }

  // ─── Resolver la cita objetivo de confirmar/cancelar/completar ───────────
  //
  // El admin casi nunca conoce el appointmentId (UUID) — normalmente dice
  // "confirma la cita de Juan Pérez". Si no viene un ID explícito, buscamos por
  // coincidencia parcial (insensible a mayúsculas/tildes vía índice Postgres) del
  // nombre o teléfono, restringido al estado relevante para esa acción. Con una
  // sola coincidencia la usamos directo; con varias, devolvemos una lista numerada
  // (con ID corto) para que el admin desambigüe — JAMÁS adivinamos cuál cita es,
  // mismo principio anti-alucinación que el resto del sistema: más vale preguntar
  // que ejecutar la acción equivocada sobre la cita de otro cliente.
  private async resolveTargetAppointment(
    storeId: string,
    params: { appointmentId?: string; customerName?: string; customerPhone?: string },
    statuses: AppointmentStatus[],
    actionLabel: string,
  ): Promise<{ appt: any } | { reply: string }> {
    if (params.appointmentId) {
      const appt = await this.prisma.appointment.findFirst({
        where:   { storeId, appointmentId: { endsWith: params.appointmentId.toLowerCase() }, status: { in: statuses } },
        include: { customer: { select: { name: true, phone: true } }, service: { select: { name: true } } },
      });
      if (!appt) return { reply: `❌ No encontré una cita con ese ID en un estado válido para ${actionLabel}.` };
      return { appt };
    }

    const nameOrPhone = params.customerName?.trim() || params.customerPhone?.trim();
    if (!nameOrPhone) {
      return { reply: `❌ Necesito el nombre o teléfono del cliente (o el ID de la cita) para ${actionLabel}.` };
    }

    const matches = await this.prisma.appointment.findMany({
      where: {
        storeId,
        status: { in: statuses },
        customer: params.customerPhone
          ? { phone: { contains: normalizePhone(params.customerPhone).slice(-9) } }
          : { name: { contains: nameOrPhone, mode: 'insensitive' } },
      },
      orderBy: { scheduledAt: 'asc' },
      include: { customer: { select: { name: true, phone: true } }, service: { select: { name: true } } },
      take: 6,
    });

    if (matches.length === 0) {
      // La cita puede existir pero ya estar en el estado al que se quería llevar
      // (ej: "confirma la cita de Rosal" cuando ya está CONFIRMED) — en ese caso
      // "no encontré ninguna cita" confunde al admin; le avisamos del estado real.
      const anyMatch = await this.prisma.appointment.findFirst({
        where: {
          storeId,
          customer: params.customerPhone
            ? { phone: { contains: normalizePhone(params.customerPhone).slice(-9) } }
            : { name: { contains: nameOrPhone, mode: 'insensitive' } },
        },
        orderBy: { scheduledAt: 'desc' },
        include: { customer: { select: { name: true } } },
      });
      if (anyMatch) {
        const label = APPT_STATUS_LABEL[anyMatch.status] ?? anyMatch.status.toLowerCase();
        return { reply: `ℹ️ La cita de ${anyMatch.customer?.name ?? nameOrPhone} ya está ${label} — no hay nada que ${actionLabel}.` };
      }
      return { reply: `❌ No encontré ninguna cita de "${nameOrPhone}".` };
    }
    if (matches.length > 1) {
      const lines = matches.map((a, i) => {
        const fecha = a.scheduledAt.toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'America/Bogota' });
        const hora  = a.scheduledAt.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' });
        return `  ${i + 1}. ${a.customer?.name ?? 'Cliente'} — ${a.service?.name ?? 'Sin servicio'} — ${fecha} ${hora} (ID: ...${a.appointmentId.slice(-8)})`;
      });
      return {
        reply: `Encontré ${matches.length} citas que coinciden con "${nameOrPhone}":\n${lines.join('\n')}\n\nDime el ID (los últimos caracteres bastan) para ${actionLabel} la correcta.`,
      };
    }

    return { appt: matches[0] };
  }

  // ─── Ejecutar acciones ────────────────────────────────────────────────────

  private async executeAction(storeId: string, actionType: string, params: any): Promise<string> {
    this.logger.log(`[AdminAssistant] Ejecutando acción ${actionType} para ${storeId}`);

    try {
      switch (actionType) {

        case 'CREATE_ORDER': {
          // ── Cliente: OPCIONAL. Venta rápida sin fricción ───────────────────────
          // Si el admin no identifica cliente, la venta se registra a un cliente
          // genérico "Venta rápida" (uno por tienda). Nunca confiar en un customerId
          // que la IA extrajo: validarlo contra el storeId (evita FK roto / cross-tenant).
          let customerId: string | undefined;
          if (params.customerId) {
            const owned = await this.prisma.customer.findFirst({
              where: { customerId: params.customerId, storeId }, select: { customerId: true },
            });
            if (owned) customerId = owned.customerId;
          }
          if (!customerId && params.customerPhone) {
            customerId = (await this.findOrCreateCustomerByPhone(storeId, params.customerPhone, params.customerName)).customerId;
          }
          if (!customerId) {
            customerId = (await this.getOrCreateQuickSaleCustomer(storeId)).customerId;
          }

          const rawItems = params.items ?? [];
          if (!rawItems.length) return '❌ ¿Qué se vendió? Dime el producto o servicio y el precio.';

          // ── Resolver cada ítem contra el catálogo (multi-tenant: siempre validar
          // por storeId). Si la IA no mandó un ID válido, se busca el más parecido por
          // nombre: match fuerte → se usa y se autocompleta el precio; ambiguo → se
          // sugieren opciones al admin; sin coincidencia → se registra como ítem libre.
          const resolvedItems: Array<{ serviceId?: string; productId?: string; description: string; quantity: number; unitPrice: number }> = [];
          for (const i of rawItems) {
            let serviceId: string | undefined = i.serviceId || undefined;
            let productId: string | undefined = i.productId || undefined;
            let description: string = (i.description ?? '').trim();
            let unitPrice: number | undefined = i.unitPrice != null ? Number(i.unitPrice) : undefined;
            const quantity = Number(i.quantity) > 0 ? Number(i.quantity) : 1;

            if (serviceId) {
              const svc = await this.prisma.service.findFirst({
                where: { serviceId, storeId }, select: { serviceId: true, name: true, basePrice: true },
              });
              if (!svc) { serviceId = undefined; }
              else { if (!description) description = svc.name; if (unitPrice == null) unitPrice = Number(svc.basePrice ?? 0); }
            }
            if (productId) {
              const prod = await this.prisma.product.findFirst({
                where: { productId, storeId }, select: { productId: true, name: true, salePrice: true },
              });
              if (!prod) { productId = undefined; }
              else { if (!description) description = prod.name; if (unitPrice == null) unitPrice = Number(prod.salePrice ?? 0); }
            }

            // Sin ID válido todavía → buscar por nombre en el catálogo
            if (!serviceId && !productId) {
              if (!description) return '❌ ¿Qué producto o servicio se vendió?';
              const matches = await this.findCatalogMatches(storeId, description);
              const top = matches[0];
              const confident = !!top && top.score >= 0.6 && (matches.length === 1 || top.score - matches[1].score >= 0.2);
              if (confident) {
                if (top.type === 'service') serviceId = top.id; else productId = top.id;
                description = top.name;
                if (unitPrice == null || unitPrice <= 0) unitPrice = top.price;
              } else if (matches.length) {
                const opts = matches.map(m =>
                  `• ${m.name} (${m.type === 'service' ? 'servicio' : 'producto'}) — $${Math.round(m.price).toLocaleString('es-CO')}`
                ).join('\n');
                return `🤔 No encontré exactamente "${description}". ¿Cuál de estos es?\n${opts}\n\nDime cuál (o el precio si es uno nuevo) y lo registro.`;
              }
              // sin coincidencias → se registra como ítem libre (description + precio)
            }

            if (unitPrice == null || unitPrice <= 0) {
              return `❌ ¿A qué precio registro "${description || 'el ítem'}"? Dime el valor y lo guardo.`;
            }
            resolvedItems.push({ serviceId, productId, description: description || 'Ítem', quantity, unitPrice });
          }

          const subtotal = resolvedItems.reduce((s, i) => s + i.unitPrice * i.quantity, 0);

          // Tipo de orden: 'service' solo si TODOS los ítems son servicios del catálogo;
          // cualquier producto o ítem libre la marca como 'product' (igual que antes).
          const allServices = resolvedItems.every(i => !!i.serviceId);
          const orderType   = allServices ? 'service' : 'product';

          const order = await this.prisma.order.create({
            data: {
              storeId,
              customerId,
              type:       orderType,
              notes:      params.notes ?? 'Creado por asistente admin WA',
              subtotal,
              total:      subtotal,
              isManual:   true,
              status:     'delivered',
              manualPaymentMethod: params.paymentMethod ?? 'efectivo',
              orderItems: {
                create: resolvedItems.map(i => ({
                  description: i.description,
                  quantity:    i.quantity,
                  unitPrice:   i.unitPrice,
                  ...(i.serviceId ? { service: { connect: { serviceId: i.serviceId } } } : {}),
                  ...(i.productId ? { product: { connect: { productId: i.productId } } } : {}),
                })),
              },
            },
            include: { customer: { select: { name: true } } },
          });

          const fmt = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
          const itemsTxt = resolvedItems.map(i =>
            `• ${i.description}${i.quantity > 1 ? ` x${i.quantity}` : ''} — ${fmt(i.unitPrice * i.quantity)}`
          ).join('\n');
          return `✅ *Venta registrada*\n${itemsTxt}\nTotal: ${fmt(subtotal)}\nCliente: ${order.customer?.name ?? QUICK_SALE_NAME}\nPago: ${params.paymentMethod ?? 'efectivo'}\nID: ${order.orderId.slice(-8).toUpperCase()}`;
        }

        case 'CREATE_APPOINTMENT': {
          if (!params.customerPhone || !params.serviceId || !params.scheduledAt) {
            return '❌ Faltan datos: necesito teléfono del cliente, ID del servicio y fecha/hora.';
          }
          const customer = await this.findOrCreateCustomerByPhone(storeId, params.customerPhone, params.customerName);

          // storeId en el filtro: igual que en el resto de la plataforma, nunca se
          // confía en que un serviceId (acá viene de lo que extrajo la IA del mensaje
          // del admin) pertenezca a esta tienda — sin esto, un serviceId de OTRA
          // tienda pasaría el findUnique y la cita quedaría creada con storeId de
          // esta tienda pero apuntando al servicio (y precio) de otra.
          const service = await this.prisma.service.findFirst({ where: { serviceId: params.serviceId, storeId } });
          if (!service) return '❌ Servicio no encontrado.';

          const appt = await this.prisma.appointment.create({
            data: {
              storeId,
              customerId: customer.customerId,
              serviceId:  params.serviceId,
              scheduledAt: new Date(params.scheduledAt),
              status:      'CONFIRMED',
              source:      'MANUAL',
              agreedPrice: service.basePrice ?? undefined,
              notes:       params.notes,
            },
          });

          const fmtDt = new Date(appt.scheduledAt).toLocaleString('es-CO', {
            weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
          });
          return `✅ *Cita creada exitosamente*\nCliente: ${customer.name ?? customer.phone}\nServicio: ${service.name}\nFecha: ${fmtDt}\nID: ${appt.appointmentId.slice(-8).toUpperCase()}`;
        }

        case 'CANCEL_APPOINTMENT': {
          const resolved = await this.resolveTargetAppointment(storeId, params, [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED], 'cancelar');
          if ('reply' in resolved) return resolved.reply;
          const appt = resolved.appt;
          await this.prisma.appointment.update({
            where: { appointmentId: appt.appointmentId },
            data:  { status: 'CANCELLED', cancelReason: params.reason ?? 'Cancelada por admin' },
          });
          if (this.notifyFn && appt.customer?.phone) {
            const msg = `❌ *Tu cita fue cancelada*\n\n` +
              `📆 ${fmtApptDate(appt.scheduledAt)}\n` +
              `🕐 ${fmtApptTime(appt.scheduledAt)}` +
              (params.reason ? `\n\n📝 Motivo: ${params.reason}` : '') +
              `\n\nSi quieres reagendar, escríbenos cuando gustes.`;
            this.notifyFn(storeId, appt.customer.phone, msg).catch(() => {});
          }
          return `✅ Cita de ${appt.customer?.name ?? 'cliente'} cancelada correctamente.`;
        }

        case 'CONFIRM_APPOINTMENT': {
          const resolved = await this.resolveTargetAppointment(storeId, params, [AppointmentStatus.PENDING], 'confirmar');
          if ('reply' in resolved) return resolved.reply;
          const appt = resolved.appt;
          await this.prisma.appointment.update({
            where: { appointmentId: appt.appointmentId },
            data:  { status: 'CONFIRMED' },
          });
          if (this.notifyFn && appt.customer?.phone) {
            const msg = `✅ *¡Tu cita está confirmada!*\n\n` +
              (appt.service?.name ? `✂️ ${appt.service.name}\n` : '') +
              `📆 ${fmtApptDate(appt.scheduledAt)}\n` +
              `🕐 ${fmtApptTime(appt.scheduledAt)}` +
              (appt.agreedPrice ? `\n💰 Precio: $${Math.round(Number(appt.agreedPrice)).toLocaleString('es-CO')}` : '') +
              `\n\n¡Te esperamos! 😊`;
            this.notifyFn(storeId, appt.customer.phone, msg).catch(() => {});
          }
          return `✅ Cita de ${appt.customer?.name ?? 'cliente'} confirmada.`;
        }

        case 'COMPLETE_APPOINTMENT': {
          const resolved = await this.resolveTargetAppointment(storeId, params, [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED, AppointmentStatus.IN_PROGRESS], 'completar');
          if ('reply' in resolved) return resolved.reply;
          const appt = resolved.appt;
          await this.prisma.appointment.update({
            where: { appointmentId: appt.appointmentId },
            data:  {
              status:        'COMPLETED',
              paymentStatus: 'PAID',
              paymentAmount: params.paymentAmount ? String(params.paymentAmount) : undefined,
              paymentMethod: params.paymentMethod ?? 'efectivo',
            },
          });
          const fmt = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
          return `✅ Cita de ${appt.customer?.name ?? 'cliente'} marcada como completada.${params.paymentAmount ? ` Pago registrado: ${fmt(params.paymentAmount)}` : ''}`;
        }

        case 'DAILY_REPORT': {
          return await this.buildDailyReportText(storeId);
        }

        case 'SEND_CUSTOMER_MESSAGE': {
          const { customerName, customerPhone, message } = params as {
            customerName?: string;
            customerPhone?: string;
            message?: string;
          };

          if (!message?.trim()) {
            return '❌ No hay texto para enviar. Dime qué quieres que le diga al cliente.';
          }

          // Resolver teléfono destino
          let targetPhone: string | null = customerPhone?.trim() ?? null;

          if (!targetPhone && customerName?.trim()) {
            const matches = await this.prisma.customer.findMany({
              where:  { storeId, name: { contains: customerName.trim(), mode: 'insensitive' } },
              select: { name: true, phone: true },
              take:   5,
            });

            if (matches.length === 0) {
              return `❌ No encontré ningún cliente llamado "${customerName}". ¿Tienes su número de teléfono?`;
            }
            if (matches.length > 1) {
              const lines = matches
                .map((c, i) => `  ${i + 1}. ${c.name ?? 'Sin nombre'} — ${c.phone}`)
                .join('\n');
              return `Encontré ${matches.length} clientes con nombre similar a "${customerName}":\n${lines}\n\nDime el teléfono del que quieres para enviárselo.`;
            }
            targetPhone = matches[0].phone;
          }

          if (!targetPhone) {
            return '❌ Necesito el nombre o el teléfono del cliente para enviar el mensaje.';
          }

          if (!this.notifyFn) {
            return '❌ El servicio de mensajería no está disponible ahora mismo.';
          }

          await this.notifyFn(storeId, targetPhone, message.trim());

          const displayName = customerName?.trim() ?? targetPhone;
          return `✅ Mensaje enviado a *${displayName}*:\n_"${message.trim()}"_`;
        }

        default:
          return `⚠️ Acción desconocida: ${actionType}`;
      }
    } catch (err: any) {
      this.logger.error(`[AdminAssistant] Action ${actionType} failed: ${err.message}`);
      return `❌ Error ejecutando la acción: ${err.message}`;
    }
  }

  // ─── Reporte del día en texto ────────────────────────────────────────────

  private async buildDailyReportText(storeId: string): Promise<string> {
    const now        = new Date();
    const tzOffset   = -5 * 60;
    const localNow   = new Date(now.getTime() + tzOffset * 60 * 1000);
    const todayStart = new Date(Date.UTC(
      localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), 5, 0, 0, 0,
    ));
    const todayEnd   = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    const [appts, orders, newCustomers] = await Promise.all([
      this.prisma.appointment.findMany({
        where: { storeId, scheduledAt: { gte: todayStart, lt: todayEnd } },
        select: { status: true, paymentAmount: true, paymentMethod: true, paymentStatus: true },
      }),
      this.prisma.order.findMany({
        where: { storeId, createdAt: { gte: todayStart, lt: todayEnd }, status: { not: 'cancelled' } },
        select: { total: true, status: true },
      }),
      this.prisma.customer.count({ where: { storeId, createdAt: { gte: todayStart, lt: todayEnd } } }),
    ]);

    const fmt = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
    const completed  = appts.filter(a => a.status === 'COMPLETED').length;
    const cancelled  = appts.filter(a => a.status === 'CANCELLED').length;
    const noShow     = appts.filter(a => a.status === 'NO_SHOW').length;
    const pending    = appts.filter(a => ['PENDING','CONFIRMED'].includes(a.status)).length;
    const revenue    = orders.reduce((s, o) => s + Number(o.total ?? 0), 0);
    const apptRevenue= appts.filter(a => a.paymentStatus === 'PAID')
                            .reduce((s, a) => s + Number(a.paymentAmount ?? 0), 0);

    const dateStr = localNow.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });

    return `📊 *REPORTE DEL DÍA — ${dateStr.toUpperCase()}*\n\n` +
      `📅 *Citas*\n` +
      `  • Total: ${appts.length} | ✅ Completadas: ${completed}\n` +
      `  • ❌ Canceladas: ${cancelled} | 👻 No show: ${noShow}\n` +
      `  • 🕐 Pendientes/Confirmadas: ${pending}\n\n` +
      `💰 *Ingresos*\n` +
      `  • Ventas/Órdenes: ${fmt(revenue)} (${orders.length} pedidos)\n` +
      `  • Citas pagadas: ${fmt(apptRevenue)}\n` +
      `  • TOTAL: ${fmt(revenue + apptRevenue)}\n\n` +
      `👥 *Clientes nuevos hoy: ${newCustomers}*`;
  }

  // ─── AI Config ────────────────────────────────────────────────────────────

  private async getAiConfig(storeId: string) {
    const cfg = await this.prisma.aIConfiguration.findUnique({ where: { storeId } });
    if (!cfg?.apiKey) return null;
    return cfg;
  }

  // ─── Gestión de sesiones ─────────────────────────────────────────────────

  private getSession(storeId: string): Session {
    const existing = this.sessions.get(storeId);
    if (existing) {
      existing.lastActivity = Date.now();
      return existing;
    }
    const session: Session = { messages: [], lastActivity: Date.now() };
    this.sessions.set(storeId, session);
    return session;
  }

  private cleanSessions() {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        this.sessions.delete(key);
      }
    }
  }

  // ─── Check si un número es el adminPhone ─────────────────────────────────

  async isAdminPhone(storeId: string, phone: string): Promise<boolean> {
    const store = await this.prisma.store.findUnique({
      where:  { storeId },
      select: { adminPhone: true },
    });
    if (!store?.adminPhone) return false;
    return normalizePhone(store.adminPhone).slice(-9) === normalizePhone(phone).slice(-9);
  }
}
