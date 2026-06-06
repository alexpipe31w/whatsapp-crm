import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createCompletion, AIProvider } from '../ai/providers';

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

  constructor(private readonly prisma: PrismaService) {
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

      // Build ordered candidate list: primary key first, then cartridges
      const extras: Array<{ provider: string; apiKey: string; model?: string }> =
        Array.isArray((aiConfig as any).cartridges)
          ? (aiConfig as any).cartridges
          : [];
      const candidates = [
        { provider: aiConfig.aiProvider as string, apiKey: aiConfig.apiKey, model: aiConfig.model },
        ...extras.map(c => ({ provider: c.provider, apiKey: c.apiKey, model: c.model ?? aiConfig.model })),
      ].filter(c => c.apiKey?.trim());

      let reply = '';
      let lastErr: unknown;
      for (const cand of candidates) {
        try {
          reply = await createCompletion(
            cand.provider as AIProvider,
            cand.apiKey,
            cand.model,
            messages,
            0.4,
            1200,
          );
          break;
        } catch (err: any) {
          lastErr = err;
          this.logger.warn(`[AdminAssistant] ${storeId}: proveedor ${cand.provider} falló (${err?.status ?? err?.message ?? err}), probando siguiente cartridge...`);
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

    const [store, apptToday, apptUpcoming, recentOrders, monthOrders, services, customers] =
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
${serviceLines}

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

Para crear una venta/orden:
⚡ACTION⚡CREATE_ORDER⚡{"customerId":"<id>","customerPhone":"<telefono>","items":[{"description":"<nombre>","serviceId":"<id_opcional>","quantity":1,"unitPrice":<precio>}],"notes":"<opcional>","paymentMethod":"efectivo"}⚡END⚡

Para crear una cita:
⚡ACTION⚡CREATE_APPOINTMENT⚡{"customerPhone":"<telefono>","serviceId":"<id>","scheduledAt":"<ISO8601 Colombia>","notes":"<opcional>"}⚡END⚡

Para cancelar una cita:
⚡ACTION⚡CANCEL_APPOINTMENT⚡{"appointmentId":"<id>","reason":"<motivo>"}⚡END⚡

Para confirmar una cita:
⚡ACTION⚡CONFIRM_APPOINTMENT⚡{"appointmentId":"<id>"}⚡END⚡

Para completar una cita (marcar como realizada):
⚡ACTION⚡COMPLETE_APPOINTMENT⚡{"appointmentId":"<id>","paymentAmount":<monto>,"paymentMethod":"efectivo"}⚡END⚡

Para reporte del día:
⚡ACTION⚡DAILY_REPORT⚡{}⚡END⚡

REGLAS:
- Si no tienes el ID de algo, búscalo en el contexto o pide confirmación al admin
- Para crear citas, la fecha/hora SIEMPRE en ISO8601 con offset Colombia (-05:00)
- Si el admin pide algo que no está en el contexto, dile que no encuentras esa información
- Nunca inventes datos — solo usa lo que está en el contexto
- Si el admin pregunta algo que puedes responder con el contexto, hazlo SIN usar acción`;
  }

  // ─── Ejecutar acciones ────────────────────────────────────────────────────

  private async executeAction(storeId: string, actionType: string, params: any): Promise<string> {
    this.logger.log(`[AdminAssistant] Ejecutando acción ${actionType} para ${storeId}`);

    try {
      switch (actionType) {

        case 'CREATE_ORDER': {
          // Resolver customerId desde phone si no viene
          let customerId = params.customerId;
          if (!customerId && params.customerPhone) {
            const phone    = params.customerPhone.replace(/\D/g, '');
            const customer = await this.prisma.customer.findFirst({
              where: { storeId, phone: { contains: phone.slice(-9) } },
            });
            if (!customer) return `❌ No encontré cliente con teléfono ${params.customerPhone}. Regístralo primero.`;
            customerId = customer.customerId;
          }
          if (!customerId) return '❌ Necesito el teléfono o ID del cliente para crear la venta.';

          const items = params.items ?? [];
          if (!items.length) return '❌ La venta necesita al menos un ítem.';

          const subtotal = items.reduce((s: number, i: any) => s + (Number(i.unitPrice) * (i.quantity ?? 1)), 0);

          const order = await this.prisma.order.create({
            data: {
              storeId,
              customerId,
              type:       'service',
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
          const phone    = params.customerPhone.replace(/\D/g, '');
          const customer = await this.prisma.customer.findFirst({
            where: { storeId, phone: { contains: phone.slice(-9) } },
          });
          if (!customer) return `❌ No encontré cliente con teléfono ${params.customerPhone}.`;

          const service = await this.prisma.service.findUnique({ where: { serviceId: params.serviceId } });
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
          if (!params.appointmentId) return '❌ Necesito el ID de la cita.';
          const appt = await this.prisma.appointment.findFirst({
            where:   { storeId, appointmentId: { endsWith: params.appointmentId.toLowerCase() } },
            include: { customer: { select: { name: true } } },
          });
          if (!appt) return '❌ Cita no encontrada.';
          await this.prisma.appointment.update({
            where: { appointmentId: appt.appointmentId },
            data:  { status: 'CANCELLED', cancelReason: params.reason ?? 'Cancelada por admin' },
          });
          return `✅ Cita de ${appt.customer?.name ?? 'cliente'} cancelada correctamente.`;
        }

        case 'CONFIRM_APPOINTMENT': {
          if (!params.appointmentId) return '❌ Necesito el ID de la cita.';
          const appt = await this.prisma.appointment.findFirst({
            where:   { storeId, appointmentId: { endsWith: params.appointmentId.toLowerCase() } },
            include: { customer: { select: { name: true } } },
          });
          if (!appt) return '❌ Cita no encontrada.';
          await this.prisma.appointment.update({
            where: { appointmentId: appt.appointmentId },
            data:  { status: 'CONFIRMED' },
          });
          return `✅ Cita de ${appt.customer?.name ?? 'cliente'} confirmada.`;
        }

        case 'COMPLETE_APPOINTMENT': {
          if (!params.appointmentId) return '❌ Necesito el ID de la cita.';
          const appt = await this.prisma.appointment.findFirst({
            where:   { storeId, appointmentId: { endsWith: params.appointmentId.toLowerCase() } },
            include: { customer: { select: { name: true } } },
          });
          if (!appt) return '❌ Cita no encontrada.';
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
