import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { Prisma } from '../generated/prisma/client';
import { OutboundService } from '../outbound/outbound.service';
import { outboundKeys } from '../outbound/outbound-keys';

type Appt = {
  appointmentId: string;
  storeId: string;
  scheduledAt: Date;
  endsAt?: Date | null;
  type: string;
  description?: string | null;
  address?: string | null;
  agreedPrice?: any;
  pendingAction?: string | null;
  pendingActionReason?: string | null;
  pendingActionData?: any;
  pendingActionAt?: Date | null;
  customer: { name?: string | null; phone: string; };
  service?: { name: string } | null;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma:    PrismaService,
    private readonly email:     EmailService,
    private readonly outbound:  OutboundService,
  ) {}

  private formatDate(d: Date): string {
    return d.toLocaleDateString('es-CO', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: 'America/Bogota',
    });
  }

  private formatTime(d: Date): string {
    return d.toLocaleTimeString('es-CO', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
    });
  }

  private formatMoney(n: any): string {
    return `$${Number(n).toLocaleString('es-CO')}`;
  }

  private serviceName(appt: Appt): string {
    return appt.service?.name ?? appt.type ?? 'Cita';
  }

  private async getAdminEmail(storeId: string): Promise<string | null> {
    const user = await this.prisma.user.findFirst({
      where:  { storeId, role: 'admin' },
      select: { email: true },
    });
    return user?.email ?? null;
  }

  private async getAdminPhone(storeId: string): Promise<string | null> {
    const store = await this.prisma.store.findUnique({
      where:  { storeId },
      select: { adminPhone: true },
    });
    return store?.adminPhone ?? null;
  }

  /**
   * Encola un aviso por WhatsApp (wa_outbound): la clave lo hace idempotente y los
   * reintentos son de la cola. Con `tx`, nace dentro de la transacción del llamador.
   * Si falla encolar, el error sube: el llamador decide (rollback o log).
   */
  private async queueWA(
    input: { storeId: string; to: string; text: string; kind: 'notification' | 'reminder'; key: string; expiresAt?: Date },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const result = await this.outbound.enqueue(input, tx);
    if (result === 'invalid') this.logger.warn(`[Notif] sin destino WhatsApp: no se encola key=${input.key}`);
  }

  /** Avisar al despachador tras el commit, cuando se encoló con `tx`. */
  wake(): void {
    this.outbound.wake();
  }

  private async sendEmail(to: string, subject: string, html: string): Promise<void> {
    try {
      await this.email.send(to, subject, html);
    } catch (err: any) {
      this.logger.warn(`Email send failed to ${to}: ${err.message}`);
    }
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private async withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T | null> {
    for (let i = 0; i < attempts; i++) {
      try { return await fn(); } catch (err: any) {
        if (i < attempts - 1) await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, i), 8000)));
        else this.logger.error(`Retry exhausted: ${err.message}`);
      }
    }
    return null;
  }

  async notifyAppointmentCreated(appt: Appt, origin: 'ai' | 'public' = 'ai'): Promise<void> {
    const cliente   = appt.customer.name ?? appt.customer.phone;
    const servicio  = this.serviceName(appt);
    const fecha     = this.formatDate(appt.scheduledAt);
    const hora      = this.formatTime(appt.scheduledAt);

    const titulo = origin === 'public' ? 'Nueva cita agendada desde tu link público' : 'Nueva cita agendada por IA';
    const origenEmail = origin === 'public'
      ? 'Nueva cita agendada por el cliente desde el link público de auto-agendamiento.'
      : 'Nueva cita creada automáticamente por el asistente IA.';

    const waMsg = `📅 *${titulo}*\n\n` +
      `👤 Cliente: ${cliente}\n` +
      `✂️ Servicio: ${servicio}\n` +
      `📆 Fecha: ${fecha}\n` +
      `🕐 Hora: ${hora}` +
      (appt.address ? `\n📍 Dirección: ${appt.address}` : '') +
      (appt.agreedPrice ? `\n💰 Precio: ${this.formatMoney(appt.agreedPrice)}` : '') +
      `\n\nConfirma desde el panel.`;

    const htmlEmail = `<p>${origenEmail}</p>
      <ul>
        <li><b>Cliente:</b> ${cliente}</li>
        <li><b>Servicio:</b> ${servicio}</li>
        <li><b>Fecha:</b> ${fecha}</li>
        <li><b>Hora:</b> ${hora}</li>
        ${appt.address ? `<li><b>Dirección:</b> ${appt.address}</li>` : ''}
        ${appt.agreedPrice ? `<li><b>Precio:</b> ${this.formatMoney(appt.agreedPrice)}</li>` : ''}
      </ul>
      <p>Confirma o gestiona desde el panel de citas.</p>`;

    const [adminEmail, adminPhone] = await Promise.all([
      this.getAdminEmail(appt.storeId),
      this.getAdminPhone(appt.storeId),
    ]);

    await Promise.allSettled([
      adminPhone
        ? this.queueWA({ storeId: appt.storeId, to: adminPhone, text: waMsg, kind: 'notification', key: outboundKeys.apptCreatedAdmin(appt.appointmentId) })
        : Promise.resolve(),
      adminEmail ? this.withRetry(() => this.sendEmail(adminEmail, `Nueva cita: ${cliente} — ${fecha}`, htmlEmail)) : Promise.resolve(),
    ]);
  }

  async notifyAppointmentConfirmed(appt: Appt, tx?: Prisma.TransactionClient): Promise<void> {
    const servicio = this.serviceName(appt);
    const fecha    = this.formatDate(appt.scheduledAt);
    const hora     = this.formatTime(appt.scheduledAt);

    const waMsg = `✅ *¡Tu cita está confirmada!*\n\n` +
      `✂️ ${servicio}\n` +
      `📆 ${fecha}\n` +
      `🕐 ${hora}` +
      (appt.address ? `\n📍 ${appt.address}` : '') +
      (appt.agreedPrice ? `\n💰 Precio: ${this.formatMoney(appt.agreedPrice)}` : '') +
      `\n\n¡Te esperamos! 😊`;

    await this.queueWA({
      storeId: appt.storeId, to: appt.customer.phone, text: waMsg, kind: 'notification',
      key: outboundKeys.apptConfirmed(appt.appointmentId, appt.scheduledAt),
    }, tx);
  }

  async notifyReminder(appt: Appt, window: '8h' | '2h' | '1h', tx?: Prisma.TransactionClient): Promise<void> {
    const servicio = this.serviceName(appt);
    const fecha    = this.formatDate(appt.scheduledAt);
    const hora     = this.formatTime(appt.scheduledAt);
    const cuando   = window === '8h' ? 'en 8 horas' : window === '2h' ? 'en 2 horas' : 'en 1 hora';

    const waMsg = `⏰ *Recordatorio de cita*\n\n` +
      `Tienes una cita *${cuando}*.\n\n` +
      `✂️ ${servicio}\n` +
      `📆 ${fecha}\n` +
      `🕐 ${hora}` +
      (appt.address ? `\n📍 ${appt.address}` : '') +
      `\n\nSi necesitas cancelar o reprogramar, escríbenos con anticipación.`;

    // Caduca a la hora de la cita: un recordatorio que no salió a tiempo ya no sirve.
    await this.queueWA({
      storeId: appt.storeId, to: appt.customer.phone, text: waMsg, kind: 'reminder',
      key: outboundKeys.apptReminder(appt.appointmentId, window), expiresAt: appt.scheduledAt,
    }, tx);
  }

  async notifyPendingAction(appt: Appt, action: 'cancel' | 'reschedule'): Promise<void> {
    const cliente  = appt.customer.name ?? appt.customer.phone;
    const fecha    = this.formatDate(appt.scheduledAt);
    const tipo     = action === 'cancel' ? 'cancelar' : 'reprogramar';
    const motivo   = appt.pendingActionReason ?? 'Sin motivo especificado';
    let nuevaFecha = '';
    if (action === 'reschedule' && appt.pendingActionData) {
      const d = appt.pendingActionData as any;
      nuevaFecha = d.newDate ? ` para el ${d.newDate}${d.newTime ? ' a las ' + d.newTime : ''}` : '';
    }

    // Clave de la solicitud: reprogramar a la misma fecha/hora no vuelve a avisar.
    const d = (appt.pendingActionData ?? {}) as { newDate?: string; newTime?: string };
    const requestKey = action === 'reschedule'
      ? `${d.newDate ?? ''}T${d.newTime ?? ''}`
      : `cancel:${appt.scheduledAt.getTime()}`;

    const waMsg = `⚠️ *Solicitud de ${tipo}*\n\n` +
      `👤 ${cliente} quiere ${tipo} su cita del ${fecha}${nuevaFecha}.\n` +
      `📝 Motivo: ${motivo}\n\n` +
      `Aprueba o rechaza desde el panel de citas.`;

    const htmlEmail = `<p><b>${cliente}</b> solicita ${tipo} su cita del <b>${fecha}</b>${nuevaFecha}.</p>
      <p><b>Motivo:</b> ${motivo}</p>
      <p>Ingresa al panel para aprobar o rechazar.</p>`;

    const [adminEmail, adminPhone] = await Promise.all([
      this.getAdminEmail(appt.storeId),
      this.getAdminPhone(appt.storeId),
    ]);

    await Promise.allSettled([
      adminPhone
        ? this.queueWA({
            storeId: appt.storeId, to: adminPhone, text: waMsg, kind: 'notification',
            key: outboundKeys.apptPendingAction(appt.appointmentId, action, requestKey),
          })
        : Promise.resolve(),
      adminEmail ? this.withRetry(() => this.sendEmail(adminEmail, `Solicitud de ${tipo}: ${cliente}`, htmlEmail)) : Promise.resolve(),
    ]);
  }

  async notifyActionResolved(
    appt: Appt,
    approved: boolean,
    reason?: string,
    requestedAt?: Date | null,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const action = appt.pendingAction === 'CANCEL_REQUESTED' ? 'cancelación' : 'reprogramación';
    let waMsg: string;
    if (approved) {
      waMsg = appt.pendingAction === 'CANCEL_REQUESTED'
        ? `✅ Tu solicitud de cancelación fue aprobada. Hasta pronto.`
        : `✅ Tu reprogramación fue aprobada.\n\n📆 ${this.formatDate(appt.scheduledAt)}\n🕐 ${this.formatTime(appt.scheduledAt)}`;
    } else {
      waMsg = `❌ Tu solicitud de ${action} no pudo ser procesada.` +
        (reason ? `\n\nMotivo: ${reason}` : '') +
        `\n\nContacta directamente si necesitas ayuda.`;
    }
    await this.queueWA({
      storeId: appt.storeId, to: appt.customer.phone, text: waMsg, kind: 'notification',
      key: outboundKeys.apptResolved(appt.appointmentId, appt.pendingAction ?? 'NONE', approved, requestedAt),
    }, tx);
  }

  async notifyPaymentProofDetected(appt: Appt, proofExcerpt: string): Promise<void> {
    const cliente = appt.customer.name ?? appt.customer.phone;
    const fecha   = this.formatDate(appt.scheduledAt);

    const waMsg = `💳 *Comprobante de pago recibido*\n\n` +
      `👤 ${cliente} indica que pagó su cita del ${fecha}.\n` +
      `📝 "${proofExcerpt.slice(0, 100)}"\n\n` +
      `Verifica y confirma el pago en el panel.`;

    const htmlEmail = `<p><b>${cliente}</b> indica que realizó el pago de su cita del <b>${fecha}</b>.</p>
      <p><b>Texto del cliente:</b> ${this.escapeHtml(proofExcerpt.slice(0, 200))}</p>
      <p>Verifica el comprobante y confirma el pago desde el panel.</p>`;

    const [adminEmail, adminPhone] = await Promise.all([
      this.getAdminEmail(appt.storeId),
      this.getAdminPhone(appt.storeId),
    ]);

    await Promise.allSettled([
      adminPhone
        ? this.queueWA({
            storeId: appt.storeId, to: adminPhone, text: waMsg, kind: 'notification',
            key: outboundKeys.apptPaymentProof(appt.appointmentId, proofExcerpt),
          })
        : Promise.resolve(),
      adminEmail ? this.withRetry(() => this.sendEmail(adminEmail, `Comprobante de pago: ${cliente}`, htmlEmail)) : Promise.resolve(),
    ]);
  }
}
