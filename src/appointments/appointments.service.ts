import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { AppointmentStatus, AppointmentSource } from '../generated/prisma/enums';

// ─── Selectores reutilizables ─────────────────────────────────────────────────

const CUSTOMER_SELECT = {
  customerId: true,
  name:       true,
  phone:      true,
  cedula:     true,
  city:       true,
} as const;

const SERVICE_SELECT = {
  serviceId:        true,
  name:             true,
  priceType:        true,
  basePrice:        true,
  unitLabel:        true,
  estimatedMinutes: true,
} as const;

const SERVICE_VARIANT_SELECT = {
  variantId:        true,
  name:             true,
  priceOverride:    true,
  estimatedMinutes: true,
} as const;

const APPOINTMENT_INCLUDE = {
  customer:       { select: CUSTOMER_SELECT },
  service:        { select: SERVICE_SELECT },
  serviceVariant: { select: SERVICE_VARIANT_SELECT },
  timeline: {
    orderBy: { createdAt: 'asc' as const },
    where:   { isPublic: true },
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class AppointmentsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Helpers privados ──────────────────────────────────────────────────────

  private async findAndVerify(appointmentId: string, storeId: string) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { appointmentId },
    });
    if (!appointment)                    throw new NotFoundException('Cita no encontrada');
    if (appointment.storeId !== storeId) throw new ForbiddenException();
    return appointment;
  }

  private computeEndsAt(
    scheduledAt: Date,
    durationMinutes?: number,
    endsAt?: string,
  ): Date | null {
    if (endsAt)          return new Date(endsAt);
    if (durationMinutes) return new Date(scheduledAt.getTime() + durationMinutes * 60_000);
    return null;
  }

  private buildTimelineEntry(params: {
    appointmentId:   string;
    action:          string;
    previousStatus?: AppointmentStatus;
    newStatus?:      AppointmentStatus;
    note?:           string;
    isPublic?:       boolean;
    performedById?:  string;
  }) {
    return this.prisma.appointmentTimeline.create({
      data: {
        appointmentId:  params.appointmentId,
        action:         params.action,
        previousStatus: params.previousStatus ?? null,
        newStatus:      params.newStatus      ?? null,
        note:           params.note           ?? null,
        isPublic:       params.isPublic       ?? true,
        performedById:  params.performedById  ?? null,
      },
    });
  }

  // ─── Listar ────────────────────────────────────────────────────────────────

  async findAll(
    storeId: string,
    filters?: {
      status?:    string;
      type?:      string;
      from?:      string;
      to?:        string;
      serviceId?: string;
      priority?:  string;
    },
  ) {
    const where: any = { storeId };

    // FIX: normalizar a mayúsculas — el enum es PENDING, CONFIRMED, etc.
    if (filters?.status)    where.status    = filters.status.toUpperCase();
    if (filters?.type)      where.type      = filters.type;
    if (filters?.serviceId) where.serviceId = filters.serviceId;
    if (filters?.priority)  where.priority  = filters.priority?.toUpperCase();

    if (filters?.from || filters?.to) {
      where.scheduledAt = {};
      if (filters.from) where.scheduledAt.gte = new Date(filters.from);
      if (filters.to)   where.scheduledAt.lte = new Date(filters.to);
    }

    return this.prisma.appointment.findMany({
      where,
      include: APPOINTMENT_INCLUDE,
      orderBy: { scheduledAt: 'asc' },
    });
  }

  // ─── Detalle ───────────────────────────────────────────────────────────────

  async findOne(appointmentId: string, storeId: string) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { appointmentId },
      include: {
        ...APPOINTMENT_INCLUDE,
        // En detalle se muestra TODO el timeline (públicos + privados)
        timeline: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!appointment)                    throw new NotFoundException('Cita no encontrada');
    if (appointment.storeId !== storeId) throw new ForbiddenException();

    return appointment;
  }

  // ─── Crear ─────────────────────────────────────────────────────────────────

  async create(storeId: string, dto: CreateAppointmentDto, performedById?: string) {
    const scheduledAt = new Date(dto.scheduledAt);
    const endsAt      = this.computeEndsAt(scheduledAt, dto.durationMinutes, dto.endsAt);

    return this.prisma.$transaction(async (tx) => {
      const appointment = await tx.appointment.create({
        data: {
          storeId,
          customerId:       dto.customerId,
          serviceId:        dto.serviceId        ?? null,
          serviceVariantId: dto.serviceVariantId ?? null,
          type:             dto.type             ?? 'cita',
          status:           AppointmentStatus.PENDING,
          priority:         dto.priority         ?? 'NORMAL',
          source:           dto.source           ?? AppointmentSource.MANUAL,
          scheduledAt,
          endsAt,
          durationMinutes:  dto.durationMinutes  ?? null,
          description:      dto.description      ?? null,
          address:          dto.address          ?? null,
          notes:            dto.notes            ?? null,
          internalNotes:    dto.internalNotes    ?? null,
          agreedPrice:      dto.agreedPrice      ?? null,
        },
        include: APPOINTMENT_INCLUDE,
      });

      await tx.appointmentTimeline.create({
        data: {
          appointmentId: appointment.appointmentId,
          action:        'CREATED',
          newStatus:     AppointmentStatus.PENDING,
          note:          `Cita creada${dto.source === 'AI' ? ' automáticamente por el asistente' : ''}`,
          isPublic:      true,
          performedById: performedById ?? null,
        },
      });

      return appointment;
    });
  }

  // ─── Actualizar ────────────────────────────────────────────────────────────

  async update(
    appointmentId: string,
    storeId: string,
    dto: UpdateAppointmentDto,
    performedById?: string,
  ) {
    const current = await this.findAndVerify(appointmentId, storeId);

    if (dto.status === AppointmentStatus.CANCELLED && !dto.cancelReason) {
      throw new BadRequestException('Se requiere cancelReason al cancelar una cita');
    }

    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : current.scheduledAt;
    const endsAt      = this.computeEndsAt(
      scheduledAt,
      dto.durationMinutes ?? current.durationMinutes ?? undefined,
      dto.endsAt,
    );

    const statusTimestamps = this.resolveStatusTimestamps(dto.status, current);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.appointment.update({
        where: { appointmentId },
        data: {
          ...(dto.status          !== undefined && { status:          dto.status }),
          ...(dto.priority        !== undefined && { priority:        dto.priority }),
          ...(dto.type            !== undefined && { type:            dto.type }),
          ...(dto.scheduledAt     !== undefined && { scheduledAt }),
          ...(dto.durationMinutes !== undefined && { durationMinutes: dto.durationMinutes }),
          endsAt,
          ...(dto.description   !== undefined && { description:   dto.description }),
          ...(dto.address       !== undefined && { address:       dto.address }),
          ...(dto.notes         !== undefined && { notes:         dto.notes }),
          ...(dto.internalNotes !== undefined && { internalNotes: dto.internalNotes }),
          ...(dto.agreedPrice   !== undefined && { agreedPrice:   dto.agreedPrice }),
          ...(dto.cancelReason  !== undefined && { cancelReason:  dto.cancelReason }),
          ...statusTimestamps,
        },
        include: APPOINTMENT_INCLUDE,
      });

      const action = this.resolveTimelineAction(dto, current.status as AppointmentStatus);
      if (action) {
        await tx.appointmentTimeline.create({
          data: {
            appointmentId,
            action,
            previousStatus: dto.status ? (current.status as AppointmentStatus) : undefined,
            newStatus:      dto.status as AppointmentStatus | undefined,
            note:           this.resolveTimelineNote(dto, current.status as AppointmentStatus),
            isPublic:       this.isPublicAction(action),
            performedById:  performedById ?? null,
          },
        });
      }

      return updated;
    });
  }

  // ─── Eliminar ──────────────────────────────────────────────────────────────

  // FIX: transacción para evitar cita sin timeline si delete falla a medias
  async remove(appointmentId: string, storeId: string) {
    await this.findAndVerify(appointmentId, storeId);
    return this.prisma.$transaction([
      this.prisma.appointmentTimeline.deleteMany({ where: { appointmentId } }),
      this.prisma.appointment.delete({ where: { appointmentId } }),
    ]);
  }

  // ─── Timeline ──────────────────────────────────────────────────────────────

  async getTimeline(appointmentId: string, storeId: string) {
    await this.findAndVerify(appointmentId, storeId);
    return this.prisma.appointmentTimeline.findMany({
      where:   { appointmentId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  async getStats(storeId: string) {
    const now        = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd   = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);

    // FIX: semana empieza el lunes (Colombia), no el domingo
    const weekStart = new Date(todayStart);
    const dayOfWeek = weekStart.getDay(); // domingo=0, lunes=1...
    const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    weekStart.setDate(weekStart.getDate() + daysToMonday);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);

    const [
      total, pending, confirmed, todayCount,
      upcomingWeek, inProgress, completedTotal, cancelledTotal, noShowTotal,
    ] = await Promise.all([
      this.prisma.appointment.count({ where: { storeId } }),
      this.prisma.appointment.count({ where: { storeId, status: 'PENDING' } }),
      this.prisma.appointment.count({ where: { storeId, status: 'CONFIRMED' } }),
      this.prisma.appointment.count({
        where: { storeId, scheduledAt: { gte: todayStart, lt: todayEnd } },
      }),
      this.prisma.appointment.count({
        where: {
          storeId,
          scheduledAt: { gte: weekStart, lt: weekEnd },
          status: { in: ['PENDING', 'CONFIRMED'] },
        },
      }),
      this.prisma.appointment.count({ where: { storeId, status: 'IN_PROGRESS' } }),
      this.prisma.appointment.count({ where: { storeId, status: 'COMPLETED' } }),
      this.prisma.appointment.count({ where: { storeId, status: 'CANCELLED' } }),
      this.prisma.appointment.count({ where: { storeId, status: 'NO_SHOW' } }),
    ]);

    return {
      total, pending, confirmed, todayCount,
      upcomingWeek, inProgress, completedTotal, cancelledTotal, noShowTotal,
    };
  }

  // ─── Helpers de lógica ────────────────────────────────────────────────────

  private resolveStatusTimestamps(
    newStatus: AppointmentStatus | undefined,
    current: any,
  ): Record<string, Date | null> {
    const now = new Date();
    switch (newStatus) {
      case AppointmentStatus.CONFIRMED:   return { confirmedAt:  now };
      case AppointmentStatus.IN_PROGRESS: return { startedAt:   now };
      case AppointmentStatus.COMPLETED:   return { completedAt: now };
      case AppointmentStatus.CANCELLED:   return { cancelledAt: now };
      default:                            return {};
    }
  }

  private resolveTimelineAction(
    dto: UpdateAppointmentDto,
    currentStatus: AppointmentStatus,
  ): string | null {
    if (dto.status && dto.status !== currentStatus) return dto.status;
    if (dto.scheduledAt)                             return 'RESCHEDULED';
    if (dto.notes !== undefined || dto.description !== undefined) return 'UPDATED';
    if (dto.internalNotes !== undefined)             return 'NOTE_ADDED';
    return null;
  }

  private resolveTimelineNote(
    dto: UpdateAppointmentDto,
    currentStatus: AppointmentStatus,
  ): string {
    if (dto.status === AppointmentStatus.CANCELLED && dto.cancelReason)
      return `Cita cancelada. Motivo: ${dto.cancelReason}`;
    if (dto.status === AppointmentStatus.CONFIRMED)  return 'Cita confirmada';
    if (dto.status === AppointmentStatus.COMPLETED)  return 'Cita completada exitosamente';
    if (dto.status === AppointmentStatus.NO_SHOW)    return 'El cliente no se presentó';
    if (dto.scheduledAt)
      return `Cita reagendada para ${new Date(dto.scheduledAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`;
    return 'Cita actualizada';
  }

  private isPublicAction(action: string): boolean {
    return !new Set(['NOTE_ADDED', 'UPDATED']).has(action);
  }
}