import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface SlotResult {
  staffId: string | null;
  name: string;
  slots: string[];
}

type DayKey = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

@Injectable()
export class PublicService {
  constructor(private readonly prisma: PrismaService) {}

  async getStoreBySlug(slug: string) {
    const store = await this.prisma.store.findUnique({
      where:  { slug },
      select: { storeId: true, name: true, staffLabel: true, businessHours: true },
    });
    if (!store) throw new NotFoundException('Negocio no encontrado');

    const staffCount = await this.prisma.staff.count({
      where: { storeId: store.storeId, isActive: true },
    });

    return {
      name:          store.name,
      staffLabel:    store.staffLabel ?? 'Profesional',
      hasStaff:      staffCount > 0,
      businessHours: store.businessHours,
    };
  }

  async getAvailability(slug: string, dateStr: string): Promise<{ date: string; dayName: string; staff: SlotResult[] }> {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new BadRequestException('Parámetro date requerido en formato YYYY-MM-DD');
    }

    const store = await this.prisma.store.findUnique({
      where:  { slug },
      select: { storeId: true, name: true, businessHours: true },
    });
    if (!store) throw new NotFoundException('Negocio no encontrado');

    // Parse date in Colombia TZ (UTC-5)
    const date     = new Date(`${dateStr}T05:00:00.000Z`);
    const dayNames = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
    const dayName  = dayNames[date.getDay()];

    const activeStaff = await this.prisma.staff.findMany({
      where:   { storeId: store.storeId, isActive: true },
      orderBy: { createdAt: 'asc' },
      select:  { staffId: true, name: true, schedule: true },
    });

    const results: SlotResult[] = [];
    const startOfDay = new Date(`${dateStr}T05:00:00.000Z`);
    const endOfDay   = new Date(`${dateStr}T28:59:59.000Z`); // +24h

    if (activeStaff.length === 0) {
      const hours = store.businessHours as Record<string, any> | null;
      if (!hours) return { date: dateStr, dayName, staff: [] };

      const appts = await this.prisma.appointment.findMany({
        where: {
          storeId:     store.storeId,
          staffId:     null,
          status:      { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
          scheduledAt: { gte: startOfDay, lt: endOfDay },
        },
        select: { scheduledAt: true, endsAt: true },
      });

      results.push({ staffId: null, name: store.name, slots: this.computeSlots(date, hours, appts) });
    } else {
      for (const member of activeStaff) {
        const hours = (member.schedule ?? store.businessHours) as Record<string, any> | null;
        const appts = await this.prisma.appointment.findMany({
          where: {
            storeId:     store.storeId,
            staffId:     member.staffId,
            status:      { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
            scheduledAt: { gte: startOfDay, lt: endOfDay },
          },
          select: { scheduledAt: true, endsAt: true },
        });

        results.push({
          staffId: member.staffId,
          name:    member.name,
          slots:   hours ? this.computeSlots(date, hours, appts) : [],
        });
      }
    }

    return { date: dateStr, dayName, staff: results };
  }

  private computeSlots(
    date: Date,
    hours: Record<string, any>,
    appointments: { scheduledAt: Date; endsAt: Date | null }[],
    slotMinutes = 30,
  ): string[] {
    const DAY_KEYS: DayKey[] = ['sun','mon','tue','wed','thu','fri','sat'];
    const dayKey    = DAY_KEYS[date.getDay()];
    const daySchedule = hours[dayKey];

    if (!daySchedule?.isOpen) return [];

    const shifts: { open: string; close: string }[] =
      [daySchedule.shift1, daySchedule.shift2].filter(Boolean);

    const allSlots: string[] = [];

    for (const shift of shifts) {
      const [openH, openM]   = shift.open.split(':').map(Number);
      const [closeH, closeM] = shift.close.split(':').map(Number);
      let cur = openH * 60 + openM;
      const end = closeH * 60 + closeM;
      while (cur + slotMinutes <= end) {
        const hh = String(Math.floor(cur / 60)).padStart(2, '0');
        const mm = String(cur % 60).padStart(2, '0');
        allSlots.push(`${hh}:${mm}`);
        cur += slotMinutes;
      }
    }

    return allSlots.filter(slot => {
      const [h, m]    = slot.split(':').map(Number);
      const slotStart = new Date(date);
      slotStart.setUTCHours(h + 5, m, 0, 0); // Colombia UTC-5 → UTC
      const slotEnd   = new Date(slotStart.getTime() + slotMinutes * 60_000);

      return !appointments.some(appt => {
        const s = new Date(appt.scheduledAt);
        const e = appt.endsAt ? new Date(appt.endsAt) : new Date(s.getTime() + 30 * 60_000);
        return s < slotEnd && e > slotStart;
      });
    });
  }
}
