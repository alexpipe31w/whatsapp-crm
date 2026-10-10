import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AppointmentsService } from '../appointments/appointments.service';
import { AppointmentStatus } from '../generated/prisma/enums';

// Margen tras crearse la cita antes de autoconfirmarla. Muchas veces el barbero/admin
// no alcanza a confirmar manualmente, y sin confirmación al cliente no le llega el
// mensaje de WhatsApp ("¡Tu cita está confirmada!") ni los recordatorios. Pasado este
// lapso, se confirma sola para que el cliente sí reciba el aviso.
const GRACE_MINUTES = 15;
const BATCH_SIZE    = 50;

@Injectable()
export class AutoConfirmService {
  private readonly logger = new Logger(AutoConfirmService.name);

  constructor(
    private readonly prisma:        PrismaService,
    private readonly appointments:  AppointmentsService,
  ) {}

  @Cron('*/5 * * * *', { name: 'auto-confirm-appointments', timeZone: 'UTC' })
  async runAutoConfirm(): Promise<void> {
    const now    = new Date();
    const cutoff = new Date(now.getTime() - GRACE_MINUTES * 60 * 1000);

    const pending = await this.prisma.appointment.findMany({
      where: {
        status:        AppointmentStatus.PENDING,
        pendingAction: null,                          // no tocar las que esperan cancelar/reprogramar
        createdAt:     { lte: cutoff },               // +15 min desde que se creó
        scheduledAt:   { gt: now },                   // solo citas futuras (confirmar una pasada no sirve)
        store:         { subscriptionStatus: 'active', autoConfirmAppointments: true },
      },
      select: { appointmentId: true, storeId: true },
      take:   BATCH_SIZE,
    });

    if (pending.length === 0) return;
    this.logger.log(`🤖 Auto-confirmando ${pending.length} cita(s) (+${GRACE_MINUTES}min sin confirmar)...`);

    for (const p of pending) {
      try {
        // expectStatus: si el dueño la canceló/confirmó en este instante, no se pisa.
        // El aviso al cliente lo encola update() en la misma transacción.
        await this.appointments.update(
          p.appointmentId,
          p.storeId,
          { status: AppointmentStatus.CONFIRMED },
          undefined,
          { expectStatus: AppointmentStatus.PENDING },
        );
        this.logger.log(`✅ Cita ${p.appointmentId} autoconfirmada`);
      } catch (err: any) {
        if (err instanceof ConflictException) {
          this.logger.log(`Cita ${p.appointmentId} cambió de estado antes de autoconfirmar: se deja`);
        } else {
          this.logger.error(`Error autoconfirmando cita ${p.appointmentId}: ${err.message}`);
        }
      }
    }
  }
}
