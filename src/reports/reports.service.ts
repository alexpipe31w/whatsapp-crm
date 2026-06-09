import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../email/email.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly prisma:        PrismaService,
    private readonly notifications: NotificationsService,
    private readonly email:         EmailService,
    @Inject(forwardRef(() => WhatsappService))
    private readonly whatsapp:      WhatsappService,
  ) {}

  // 9pm Colombia = 02:00 UTC
  @Cron('0 2 * * *', { name: 'daily-report', timeZone: 'UTC' })
  async runDailyReports(): Promise<void> {
    this.logger.log('📊 Generando reportes diarios...');

    const stores = await this.prisma.store.findMany({
      where:  { subscriptionStatus: 'active', isActive: true },
      select: { storeId: true },
    });

    await Promise.allSettled(
      stores.map(s => this.generateAndSendReport(s.storeId))
    );

    this.logger.log(`✅ Reportes enviados a ${stores.length} tiendas`);
  }

  async generateAndSendReport(storeId: string): Promise<void> {
    try {
      const now      = new Date();
      const tzOffset = -5 * 60;
      const localNow = new Date(now.getTime() + tzOffset * 60 * 1000);
      const todayStart = new Date(Date.UTC(
        localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(),
        5, 0, 0, 0,
      ));
      const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

      const [appointments, newCustomers, store, orders] = await Promise.all([
        this.prisma.appointment.findMany({
          where:  { storeId, scheduledAt: { gte: todayStart, lt: todayEnd } },
          select: { status: true },
        }),
        this.prisma.customer.findMany({
          where:  { storeId, createdAt: { gte: todayStart, lt: todayEnd } },
          select: { customerId: true },
        }),
        this.prisma.store.findUnique({
          where:  { storeId },
          select: { name: true, adminPhone: true },
        }),
        this.prisma.order.findMany({
          where: {
            storeId,
            createdAt: { gte: todayStart, lt: todayEnd },
            status:    { not: 'CANCELLED' },
            total:     { gt: 0 },
          },
          select: { type: true, total: true, manualPaymentMethod: true },
        }),
      ]);

      if (!store) return;

      const apptData = {
        total:     appointments.length,
        completed: appointments.filter(a => a.status === 'COMPLETED').length,
        confirmed: appointments.filter(a => a.status === 'CONFIRMED').length,
        cancelled: appointments.filter(a => a.status === 'CANCELLED').length,
        noShow:    appointments.filter(a => a.status === 'NO_SHOW').length,
        pending:   appointments.filter(a => a.status === 'PENDING').length,
      };

      // Revenue desde Orders (fuente de verdad: incluye ventas auto-generadas de citas + manuales)
      const serviceOrders = orders.filter(o => o.type === 'service');
      const productOrders = orders.filter(o => o.type === 'product' || o.type === 'food');
      const totalServices = serviceOrders.reduce((s, o) => s + Number(o.total ?? 0), 0);
      const totalProducts = productOrders.reduce((s, o) => s + Number(o.total ?? 0), 0);
      const totalRevenue  = totalServices + totalProducts;

      // Desglose por método de pago (solo órdenes con método registrado; el resto van a "otros")
      const byMethod: Record<string, number> = {};
      for (const o of orders) {
        const m   = (o.manualPaymentMethod ?? 'OTROS').toLowerCase();
        const amt = Number(o.total ?? 0);
        byMethod[m] = (byMethod[m] ?? 0) + amt;
      }

      const clientsData = { new: newCustomers.length };
      const paymentsData = {
        confirmed: totalRevenue,
        byMethod,
        services: { count: serviceOrders.length, total: totalServices },
        products: { count: productOrders.length, total: totalProducts },
      };

      await this.prisma.dailyReport.upsert({
        where:  { storeId_date: { storeId, date: todayStart } },
        update: { appointmentsData: apptData, paymentsData, clientsData },
        create: { storeId, date: todayStart, appointmentsData: apptData, paymentsData, clientsData },
      });

      const fmt      = (n: number) => n.toLocaleString('es-CO');
      const fmtMoney = (n: number) => `$${fmt(Math.round(n))}`;

      // Bloque de ventas — solo si hubo algo
      const methodLines = Object.entries(byMethod)
        .filter(([, v]) => v > 0)
        .sort(([, a], [, b]) => b - a)
        .map(([m, v]) => `  • ${m.charAt(0).toUpperCase() + m.slice(1)}: ${fmtMoney(v)}`)
        .join('\n');

      const ventasBlock = totalRevenue > 0
        ? `💰 *VENTAS DEL DÍA*\n` +
          (serviceOrders.length > 0 ? `🔧 Servicios: ${serviceOrders.length}  —  ${fmtMoney(totalServices)}\n` : '') +
          (productOrders.length > 0  ? `📦 Productos: ${productOrders.length}  —  ${fmtMoney(totalProducts)}\n`  : '') +
          `*Total: ${fmtMoney(totalRevenue)}*\n` +
          (methodLines ? methodLines + '\n' : '')
        : `💰 *VENTAS DEL DÍA*\nSin ventas registradas hoy.\n`;

      const apptPlural = apptData.total !== 1;
      const citasBlock = apptData.total > 0
        ? `📅 *CITAS*\n` +
          `Total: ${apptData.total}  |  ✅ ${apptData.completed} completada${apptData.completed !== 1 ? 's' : ''}  |  📅 ${apptData.confirmed} confirmada${apptData.confirmed !== 1 ? 's' : ''}\n` +
          (apptData.cancelled + apptData.noShow > 0
            ? `❌ ${apptData.cancelled} cancelada${apptData.cancelled !== 1 ? 's' : ''}  |  👻 ${apptData.noShow} no show\n`
            : ``)
        : `📅 *CITAS*\nSin citas hoy.\n`;

      const pendingAppts = apptData.pending > 0
        ? `\n⏳ ${apptData.pending} cita${apptData.pending !== 1 ? 's' : ''} sigue${apptData.pending === 1 ? '' : 'n'} pendiente${apptData.pending !== 1 ? 's' : ''} de confirmar — escríbeme "confirma la cita de [nombre]" si quieres gestionarla por aquí.`
        : '';

      const dateStr = localNow.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
      const waMsg =
        `📊 *Reporte del día — ${store.name}*\n` +
        `_${dateStr.charAt(0).toUpperCase() + dateStr.slice(1)}_\n\n` +
        ventasBlock + '\n' +
        citasBlock + '\n' +
        `👥 *CLIENTES*\nNuevos hoy: ${clientsData.new}` +
        pendingAppts;

      const htmlEmail = `<h2>Reporte del día — ${store.name}</h2>
        <p><em>${dateStr}</em></p>
        <h3>Ventas del día</h3>
        <ul>
          ${serviceOrders.length > 0 ? `<li>Servicios: ${serviceOrders.length} — ${fmtMoney(totalServices)}</li>` : ''}
          ${productOrders.length  > 0 ? `<li>Productos: ${productOrders.length} — ${fmtMoney(totalProducts)}</li>`  : ''}
          <li><strong>Total: ${fmtMoney(totalRevenue)}</strong></li>
        </ul>
        ${methodLines ? `<h4>Por método de pago</h4><ul>${Object.entries(byMethod).filter(([,v])=>v>0).map(([m,v])=>`<li>${m}: ${fmtMoney(v)}</li>`).join('')}</ul>` : ''}
        <h3>Citas</h3><ul>
          <li>Total: ${apptData.total}</li>
          <li>Completadas: ${apptData.completed}</li>
          <li>Confirmadas: ${apptData.confirmed}</li>
          <li>Canceladas: ${apptData.cancelled}</li>
          <li>No show: ${apptData.noShow}</li>
        </ul>
        <h3>Clientes nuevos hoy: ${clientsData.new}</h3>`;

      const adminEmail = await this.prisma.user
        .findFirst({ where: { storeId, role: 'admin' }, select: { email: true } })
        .then(u => u?.email ?? null);

      await Promise.allSettled([
        store.adminPhone
          ? this.whatsapp.sendMessage(storeId, store.adminPhone, waMsg).catch(() => {})
          : Promise.resolve(),
        adminEmail
          ? this.email.send(adminEmail, `Reporte del día — ${store.name}`, htmlEmail).catch(() => {})
          : Promise.resolve(),
      ]);

      this.logger.log(`📊 Reporte enviado: ${store.name}`);
    } catch (err: any) {
      this.logger.error(`Error reporte tienda ${storeId}: ${err.message}`);
    }
  }

  // ─── Briefing matutino — agenda del día para el admin ───────────────────────
  // Distinto del reporte de las 9pm (que mira hacia atrás): este mira hacia
  // adelante, para que el admin arranque el día sabiendo qué citas tiene y
  // cuáles le faltan por confirmar — sin tener que preguntarle a la IA.

  // 6:30am Colombia = 11:30 UTC
  @Cron('30 11 * * *', { name: 'admin-morning-briefing', timeZone: 'UTC' })
  async runMorningBriefings(): Promise<void> {
    this.logger.log('☀️ Generando briefing matutino para admins...');

    const stores = await this.prisma.store.findMany({
      where:  { subscriptionStatus: 'active', isActive: true, adminPhone: { not: null } },
      select: { storeId: true, name: true, adminPhone: true },
    });

    await Promise.allSettled(stores.map(s => this.sendMorningBriefing(s)));
  }

  private async sendMorningBriefing(store: { storeId: string; name: string; adminPhone: string | null }): Promise<void> {
    if (!store.adminPhone) return;

    try {
      const now        = new Date();
      const tzOffset   = -5 * 60;
      const localNow   = new Date(now.getTime() + tzOffset * 60 * 1000);
      const todayStart = new Date(Date.UTC(
        localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(),
        5, 0, 0, 0,
      ));
      const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

      const appointments = await this.prisma.appointment.findMany({
        where: {
          storeId:     store.storeId,
          scheduledAt: { gte: todayStart, lt: todayEnd },
          status:      { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
        },
        include: {
          customer: { select: { name: true } },
          service:  { select: { name: true } },
          staff:    { select: { name: true } },
        },
        orderBy: { scheduledAt: 'asc' },
      });

      // Sin citas hoy → no hay nada que avisar; evitamos saturar al admin
      // con un mensaje vacío cada mañana.
      if (appointments.length === 0) return;

      const dateStr = localNow.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
      const fmtHora = (d: Date) => d.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' });
      const estadoLabel = (status: string) =>
        status === 'PENDING' ? '⏳ Pendiente de confirmar' :
        status === 'CONFIRMED' ? '✅ Confirmada' : '🔵 En curso';

      const lines = appointments.map(a => {
        const hora   = fmtHora(new Date(a.scheduledAt));
        const nombre = a.customer?.name ?? 'Cliente';
        const srv    = a.service?.name ? ` — ${a.service.name}` : '';
        const staff  = a.staff?.name ? ` (${a.staff.name})` : '';
        return `  • ${hora} — ${nombre}${srv}${staff} — ${estadoLabel(a.status)}`;
      });

      const pending = appointments.filter(a => a.status === 'PENDING').length;
      const nudge = pending > 0
        ? `\n\n📌 Tienes ${pending} cita${pending > 1 ? 's' : ''} pendiente${pending > 1 ? 's' : ''} de confirmar. Escríbeme algo como "confirma la cita de [nombre]" y te la dejo lista.`
        : '';

      const plural = appointments.length > 1;
      const msg = `☀️ *Buenos días — ${store.name}*\n` +
        `Hoy, ${dateStr}, tienes *${appointments.length}* cita${plural ? 's' : ''} agendada${plural ? 's' : ''}:\n\n` +
        lines.join('\n') +
        nudge;

      await this.whatsapp.sendMessage(store.storeId, store.adminPhone, msg);
      this.logger.log(`☀️ Briefing matutino enviado: ${store.name} (${appointments.length} citas)`);
    } catch (err: any) {
      this.logger.error(`Error briefing matutino tienda ${store.storeId}: ${err.message}`);
    }
  }
}
