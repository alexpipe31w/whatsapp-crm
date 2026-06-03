import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

const BATCH_SIZE = 50;

@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  constructor(
    private readonly prisma:        PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron('0,30 * * * *', { name: 'appointment-reminders', timeZone: 'UTC' })
  async runReminders(): Promise<void> {
    const now     = new Date();
    const in9h    = new Date(now.getTime() + 9   * 60 * 60 * 1000);
    const in8h30m = new Date(now.getTime() + 8.5 * 60 * 60 * 1000);
    const in2h30m = new Date(now.getTime() + 2.5 * 60 * 60 * 1000);
    const in1h30m = new Date(now.getTime() + 1.5 * 60 * 60 * 1000);

    const appointments = await this.prisma.appointment.findMany({
      where: {
        status:      { in: ['CONFIRMED', 'IN_PROGRESS'] },
        scheduledAt: { gt: now, lte: in9h },
        store:       { subscriptionStatus: 'active' },
        OR: [
          { reminder8hSentAt: null, scheduledAt: { lte: in8h30m } },
          { reminder2hSentAt: null, scheduledAt: { lte: in2h30m } },
          { reminder1hSentAt: null, scheduledAt: { lte: in1h30m } },
        ],
      },
      include: {
        customer:       { select: { name: true, phone: true } },
        service:        { select: { name: true } },
        serviceVariant: { select: { name: true } },
      },
      take: BATCH_SIZE,
    });

    if (appointments.length === 0) return;
    this.logger.log(`🔔 Procesando ${appointments.length} recordatorios...`);

    for (const appt of appointments) {
      try {
        await this.processReminders(appt, now, in8h30m, in2h30m, in1h30m);
      } catch (err: any) {
        this.logger.error(`Error recordatorio cita ${appt.appointmentId}: ${err.message}`);
      }
    }
  }

  private async processReminders(
    appt: any,
    now: Date,
    in8h30m: Date,
    in2h30m: Date,
    in1h30m: Date,
  ): Promise<void> {
    const windows: Array<{
      field: '8h' | '2h' | '1h';
      dbField: string;
      limit: Date;
      sentAt: Date | null;
    }> = [
      { field: '8h', dbField: 'reminder8hSentAt', limit: in8h30m, sentAt: appt.reminder8hSentAt },
      { field: '2h', dbField: 'reminder2hSentAt', limit: in2h30m, sentAt: appt.reminder2hSentAt },
      { field: '1h', dbField: 'reminder1hSentAt', limit: in1h30m, sentAt: appt.reminder1hSentAt },
    ];

    for (const w of windows) {
      if (w.sentAt !== null) continue;
      if (appt.scheduledAt > w.limit) continue;

      const updated = await this.prisma.appointment.updateMany({
        where: { appointmentId: appt.appointmentId, [w.dbField]: null },
        data:  { [w.dbField]: now },
      });

      if (updated.count === 0) continue;

      await this.notifications.notifyReminder(appt, w.field);
      this.logger.log(`✅ Recordatorio ${w.field} enviado — cita ${appt.appointmentId}`);
    }
  }

  async runManual(): Promise<{ message: string }> {
    this.runReminders().catch(err =>
      this.logger.error(`Error en reminders manual: ${err.message}`)
    );
    return { message: 'Recordatorios iniciados en segundo plano' };
  }
}
