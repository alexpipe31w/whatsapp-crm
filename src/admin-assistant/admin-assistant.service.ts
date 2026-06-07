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
const ACTION_RE         = /⚡ACTION⚡([A-Z_]+)⚡({[\s\S]*?})⚡END⚡/;

// ── Formato de número ─────────────────────────────────────────────────────────
const normalizePhone = (p: string) => p.replace(/\D/g, '');

@Injectable()
export class AdminAssistantService implements OnModuleDestroy {
  private readonly logger   = new Logger(AdminAssistantService.name);
  private readonly sessions = new Map<string, Session>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

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

      // ── Detectar y ejecutar acción ─────────────────────────────────────────
      const actionMatch = ACTION_RE.exec(reply);
      if (actionMatch) {
        const actionType   = actionMatch[1];
        let   actionParams: any = {};
        try { actionParams = JSON.parse(actionMatch[2]); } catch { /* ignore */ }

        const visibleText  = reply.replace(ACTION_RE, '').trim();
        const actionResult = await this.executeAction(storeId, actionType, actionParams);

        reply = [visibleText, actionResult].filter(Boolean).join('\n\n');
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

Para crear una venta/orden (usa "serviceId" si el ítem es del CATÁLOGO DE SERVICIOS, o "productId" si es del CATÁLOGO DE PRODUCTOS — nunca mezcles ambos catálogos):
⚡ACTION⚡CREATE_ORDER⚡{"customerId":"<id_opcional>","customerPhone":"<telefono>","customerName":"<nombre_opcional_si_es_cliente_nuevo>","items":[{"description":"<nombre>","serviceId":"<id_si_es_servicio>","productId":"<id_si_es_producto>","quantity":1,"unitPrice":<precio>}],"notes":"<opcional>","paymentMethod":"efectivo"}⚡END⚡

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

REGLAS:
- PRODUCTOS y SERVICIOS son catálogos DISTINTOS — revisa el correcto antes de decir "no lo encuentro". Un producto NO aparece en el catálogo de servicios ni viceversa; eso es normal, no es un error.
- Si no tienes el ID de algo, búscalo en el contexto correspondiente. Si aun así no aparece, dile al admin que no lo encuentras EN ESE catálogo y pregunta si es un producto o un servicio.
- Para crear citas, la fecha/hora SIEMPRE en ISO8601 con offset Colombia (-05:00)
- Para crear una cita o venta NO necesitas que el cliente ya exista — si el admin te da el teléfono (y opcionalmente el nombre), el sistema lo crea automáticamente. NUNCA te detengas a "registrar primero al cliente": ejecuta la acción directamente con el teléfono que te dieron.
- Si ya tienes teléfono + servicio/producto + fecha/hora (para citas) o ítems (para ventas), EJECUTA la acción de una vez — no sigas pidiendo confirmación de datos que ya tienes.
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
      return { reply: `❌ No encontré ninguna cita de "${nameOrPhone}" en un estado válido para ${actionLabel}.` };
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
          // Resolver customerId desde phone si no viene: primero busca por coincidencia
          // parcial (tolera formatos distintos al guardado), y si es cliente nuevo lo
          // crea al vuelo (upsert atómico — ver CustomersService.findOrCreate, evita
          // duplicados por condición de carrera).
          let customerId = params.customerId;
          if (!customerId && params.customerPhone) {
            customerId = (await this.findOrCreateCustomerByPhone(storeId, params.customerPhone, params.customerName)).customerId;
          }
          if (!customerId) return '❌ Necesito el teléfono o ID del cliente para crear la venta.';

          const items = params.items ?? [];
          if (!items.length) return '❌ La venta necesita al menos un ítem.';

          // Igual que en CREATE_APPOINTMENT (ver más abajo): nunca confiar en que un
          // serviceId/productId que la IA extrajo del mensaje del admin pertenece a
          // esta tienda — sin esto, el `connect` de abajo aceptaba igual un ID de
          // OTRA tienda (Prisma solo valida que el registro EXISTA, no el dueño) y la
          // venta quedaba con storeId de esta tienda pero apuntando al servicio o
          // producto (nombre, precio, stock) de otra.
          for (const i of items) {
            if (i.serviceId) {
              const service = await this.prisma.service.findFirst({
                where: { serviceId: i.serviceId, storeId }, select: { serviceId: true },
              });
              if (!service) return `❌ El servicio "${i.description ?? i.serviceId}" no existe en tu catálogo.`;
            }
            if (i.productId) {
              const product = await this.prisma.product.findFirst({
                where: { productId: i.productId, storeId }, select: { productId: true },
              });
              if (!product) return `❌ El producto "${i.description ?? i.productId}" no existe en tu catálogo.`;
            }
          }

          const subtotal = items.reduce((s: number, i: any) => s + (Number(i.unitPrice) * (i.quantity ?? 1)), 0);

          // El tipo de la orden depende de qué cataloga: si TODOS los ítems son
          // servicios → 'service', si hay algún producto (o ítems libres) → 'product'.
          // Esto evita que ventas de productos queden mal clasificadas como servicios
          // (y viceversa) en los reportes y en el contexto del asistente.
          const hasService  = items.some((i: any) => !!i.serviceId);
          const hasProduct  = items.some((i: any) => !!i.productId);
          const orderType   = hasService && !hasProduct ? 'service' : 'product';

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
              orderItems: {
                create: items.map((i: any) => ({
                  description: i.description,
                  quantity:    i.quantity ?? 1,
                  unitPrice:   Number(i.unitPrice),
                  ...(i.serviceId ? { service: { connect: { serviceId: i.serviceId } } } : {}),
                  ...(i.productId ? { product: { connect: { productId: i.productId } } } : {}),
                })),
              },
            },
            include: { customer: { select: { name: true } } },
          });

          const fmt = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
          return `✅ *Venta registrada exitosamente*\nCliente: ${order.customer?.name ?? 'desconocido'}\nTotal: ${fmt(subtotal)}\nID: ${order.orderId.slice(-8).toUpperCase()}`;
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
