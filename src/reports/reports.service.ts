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

      const [appointments, newCustomers, store] = await Promise.all([
        this.prisma.appointment.findMany({
          where:  { storeId, scheduledAt: { gte: todayStart, lt: todayEnd } },
          select: { status: true, paymentStatus: true, paymentMethod: true, paymentAmount: true },
        }),
        this.prisma.customer.findMany({
          where:  { storeId, createdAt: { gte: todayStart, lt: todayEnd } },
          select: { customerId: true },
        }),
        this.prisma.store.findUnique({
          where:  { storeId },
          select: { name: true, adminPhone: true },
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

      const paidAppts = appointments.filter(a => a.paymentStatus === 'PAID');
      const byMethod: Record<string, number> = {};
      let totalConfirmed = 0;
      for (const a of paidAppts) {
        const amt = Number(a.paymentAmount ?? 0);
        totalConfirmed += amt;
        const m = a.paymentMethod ?? 'otro';
        byMethod[m] = (byMethod[m] ?? 0) + amt;
      }
      const pendingPayment = appointments
        .filter(a => a.status === 'COMPLETED' && a.paymentStatus !== 'PAID')
        .reduce((sum, a) => sum + Number(a.paymentAmount ?? 0), 0);

      const paymentsData = { confirmed: totalConfirmed, pending: pendingPayment, byMethod };
      const clientsData  = { new: newCustomers.length, recurring: apptData.total - newCustomers.length };

      await this.prisma.dailyReport.upsert({
        where:  { storeId_date: { storeId, date: todayStart } },
        update: { appointmentsData: apptData, paymentsData, clientsData },
        create: { storeId, date: todayStart, appointmentsData: apptData, paymentsData, clientsData },
      });

      const fmt      = (n: number) => n.toLocaleString('es-CO');
      const fmtMoney = (n: number) => `$${fmt(n)}`;

      const waMsg = `📊 *Reporte del día — ${store.name}*\n\n` +
        `📅 *CITAS*\n` +
        `Total: ${apptData.total}  |  ✅ ${apptData.completed}  |  📅 ${apptData.confirmed}\n` +
        `❌ Canceladas: ${apptData.cancelled}  |  👻 No show: ${apptData.noShow}\n\n` +
        `💳 *PAGOS*\n` +
        `Confirmados: ${fmtMoney(totalConfirmed)}\n` +
        (byMethod['efectivo']      ? `  • Efectivo: ${fmtMoney(byMethod['efectivo'])}\n`           : '') +
        (byMethod['transferencia'] ? `  • Transferencia: ${fmtMoney(byMethod['transferencia'])}\n` : '') +
        (byMethod['nequi']         ? `  • Nequi: ${fmtMoney(byMethod['nequi'])}\n`                 : '') +
        (byMethod['daviplata']     ? `  • Daviplata: ${fmtMoney(byMethod['daviplata'])}\n`         : '') +
        `Pendientes: ${fmtMoney(pendingPayment)}\n\n` +
        `👥 *CLIENTES*\nNuevos hoy: ${clientsData.new}`;

      const htmlEmail = `<h2>Reporte del día — ${store.name}</h2>
        <h3>Citas</h3><ul>
          <li>Total: ${apptData.total}</li><li>Completadas: ${apptData.completed}</li>
          <li>Confirmadas: ${apptData.confirmed}</li><li>Canceladas: ${apptData.cancelled}</li>
          <li>No show: ${apptData.noShow}</li>
        </ul>
        <h3>Pagos confirmados: ${fmtMoney(totalConfirmed)}</h3>
        <ul>${Object.entries(byMethod).map(([m, v]) => `<li>${m}: ${fmtMoney(v)}</li>`).join('')}</ul>
        <p>Pagos pendientes: ${fmtMoney(pendingPayment)}</p>
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
