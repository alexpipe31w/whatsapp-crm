import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { AppointmentStatus, AppointmentSource } from '../generated/prisma/enums';
import { isWithinBusinessHours, BusinessHoursJson } from '../utils/business-hours.util';

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
  staff:          { select: { staffId: true, name: true } },
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
      status?:           string;
      type?:             string;
      from?:             string;
      to?:               string;
      serviceId?:        string;
      staffId?:          string;
      priority?:         string;
      hasPendingAction?: string;
    },
  ) {
    const where: any = { storeId };

    // FIX: normalizar a mayúsculas — el enum es PENDING, CONFIRMED, etc.
    if (filters?.status)    where.status    = filters.status.toUpperCase();
    if (filters?.type)      where.type      = filters.type;
    if (filters?.serviceId) where.serviceId = filters.serviceId;
    if (filters?.staffId)   where.staffId   = filters.staffId;
    if (filters?.priority)  where.priority  = filters.priority?.toUpperCase();
    if (filters?.hasPendingAction === 'true') where.pendingAction = { not: null };

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

    // Validate against business hours (AI can never override; admin can with forceSchedule)
    const [store, staffMember] = await Promise.all([
      this.prisma.store.findUnique({ where: { storeId } }),
      dto.staffId
        ? this.prisma.staff.findFirst({ where: { staffId: dto.staffId, storeId } })
        : Promise.resolve(null),
    ]);

    // Mismo principio multi-tenant que public.service.ts.bookAppointment: nunca confiar
    // en que un staffId del request pertenece a esta tienda. Sin este chequeo, un staffId
    // de OTRA tienda pasaba el `findUnique` (sin filtro storeId), se usaba su horario para
    // validar la cita, y la cita quedaba creada con storeId de esta tienda pero apuntando
    // al profesional de otra — referencia cruzada inválida entre tiendas.
    if (dto.staffId && !staffMember) {
      throw new BadRequestException('El profesional seleccionado no existe.');
    }

    const isAI   = dto.source === AppointmentSource.AI;
    const forced = !!dto.forceSchedule && !isAI;

    // No permitir agendar en una fecha/hora que ya pasó (incidente real en producción:
    // la IA registró una cita para "hoy 10am" pasadas las 11pm). Aplica a IA, link
    // público y staff por igual — el staff puede saltarse esto con forceSchedule para
    // registrar visitas retroactivas, igual que ya hace con el horario laboral.
    if (scheduledAt.getTime() < Date.now() && !forced) {
      throw new BadRequestException(
        'No es posible agendar una cita en una fecha y hora que ya pasó. Por favor elige un horario futuro.',
      );
    }

    const effectiveHours = (staffMember?.schedule as unknown as BusinessHoursJson | null) ?? store?.businessHours;
    if (effectiveHours && !forced) {
      if (!isWithinBusinessHours(scheduledAt, effectiveHours as unknown as BusinessHoursJson)) {
        throw new BadRequestException(
          'La hora solicitada está fuera del horario de atención.',
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // Conflict check inside the transaction to prevent double-booking race conditions
      if (dto.staffId) {
        const newEndsAt = endsAt ?? new Date(scheduledAt.getTime() + 30 * 60_000);
        const conflict  = await tx.appointment.findFirst({
          where: {
            staffId: dto.staffId,
            status:  { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED, AppointmentStatus.IN_PROGRESS] },
            AND: [
              { scheduledAt: { lt: newEndsAt } },
              {
                OR: [
                  { endsAt: { gt: scheduledAt } },
                  {
                    endsAt:      null,
                    scheduledAt: { gt: new Date(scheduledAt.getTime() - 30 * 60_000) },
                  },
                ],
              },
            ],
          },
        });
        if (conflict) {
          throw new BadRequestException(
            'El profesional ya tiene una cita en ese horario. Elige otro horario o profesional.',
          );
        }
      }

      const appointment = await tx.appointment.create({
        data: {
          storeId,
          customerId:       dto.customerId,
          serviceId:        dto.serviceId        ?? null,
          serviceVariantId: dto.serviceVariantId ?? null,
          staffId:          dto.staffId          ?? null,
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
  ): Promise<{ appointment: any; notificationTrigger?: string }> {
    const current = await this.findAndVerify(appointmentId, storeId);

    if (dto.status === AppointmentStatus.CANCELLED && !dto.cancelReason && !current.pendingAction) {
      throw new BadRequestException('Se requiere cancelReason al cancelar una cita');
    }

    // Mismo chequeo multi-tenant que en `create`: un staffId de OTRA tienda no debe
    // poder asignarse aquí (el `data` del update lo asigna directo desde el dto, sin
    // ningún fetch previo que lo hubiera filtrado).
    if (dto.staffId) {
      const staffMember = await this.prisma.staff.findFirst({ where: { staffId: dto.staffId, storeId } });
      if (!staffMember) {
        throw new BadRequestException('El profesional seleccionado no existe.');
      }
    }

    let resolvedStatus: AppointmentStatus | undefined = dto.status;
    let newScheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : current.scheduledAt;
    let notificationTrigger: string | undefined;

    if (dto.pendingActionResolution === 'approved') {
      if (current.pendingAction === 'CANCEL_REQUESTED') {
        resolvedStatus = AppointmentStatus.CANCELLED;
        notificationTrigger = 'action_approved_cancel';
      } else if (current.pendingAction === 'RESCHEDULE_REQUESTED') {
        const data = current.pendingActionData as any;
        if (data?.newDate) {
          // -05:00 explícito (mismo patrón que ai.service.ts al construir newScheduledAt
          // a partir de newDate/newTime): "new Date(year, month-1, day)" + "setHours()"
          // operan en la zona horaria DEL PROCESO, no en Colombia. En producción el
          // server corre en UTC (sin TZ configurado), así que sin el offset la cita
          // aprobada quedaba guardada 5 horas antes de lo que el cliente pidió
          // (ej.: pidió 3:00pm y se guardaba como 10:00am).
          newScheduledAt = new Date(`${data.newDate}T${data.newTime ?? '00:00'}:00-05:00`);
        }
        notificationTrigger = 'action_approved_reschedule';
      }
    } else if (dto.pendingActionResolution === 'rejected') {
      notificationTrigger = 'action_rejected';
    }

    if (!notificationTrigger && dto.status === AppointmentStatus.CONFIRMED) {
      notificationTrigger = 'confirmed';
    }

    if (dto.paymentStatus === 'PAID' && current.paymentStatus !== 'PAID') {
      notificationTrigger = notificationTrigger ?? 'payment_confirmed';
    }

    const endsAt = this.computeEndsAt(
      newScheduledAt,
      dto.durationMinutes ?? current.durationMinutes ?? undefined,
      dto.endsAt,
    );
    const statusTimestamps = this.resolveStatusTimestamps(resolvedStatus, current);

    // Re-validar conflicto de horario cuando el reagendamiento puede crear un doble-booking
    // (cambia el profesional, la hora de inicio o la de fin respecto a la cita actual).
    const effectiveStaffId = dto.staffId !== undefined ? dto.staffId : current.staffId;
    const scheduleChanged =
      newScheduledAt.getTime() !== current.scheduledAt.getTime() ||
      (endsAt?.getTime() ?? null) !== (current.endsAt?.getTime() ?? null) ||
      dto.staffId !== undefined;
    const willBeCancelled = (resolvedStatus ?? current.status) === AppointmentStatus.CANCELLED;

    const appointment = await this.prisma.$transaction(async (tx) => {
      // Conflict check inside the transaction to prevent double-booking race conditions
      if (effectiveStaffId && scheduleChanged && !willBeCancelled) {
        const newEndsAt = endsAt ?? new Date(newScheduledAt.getTime() + 30 * 60_000);
        const conflict  = await tx.appointment.findFirst({
          where: {
            appointmentId: { not: appointmentId },
            staffId: effectiveStaffId,
            status:  { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED, AppointmentStatus.IN_PROGRESS] },
            AND: [
              { scheduledAt: { lt: newEndsAt } },
              {
                OR: [
                  { endsAt: { gt: newScheduledAt } },
                  {
                    endsAt:      null,
                    scheduledAt: { gt: new Date(newScheduledAt.getTime() - 30 * 60_000) },
                  },
                ],
              },
            ],
          },
        });
        if (conflict) {
          throw new BadRequestException(
            'El profesional ya tiene una cita en ese horario. Elige otro horario o profesional.',
          );
        }
      }

      const updated = await tx.appointment.update({
        where: { appointmentId },
        data: {
          ...(resolvedStatus      !== undefined && { status:         resolvedStatus }),
          ...(dto.priority        !== undefined && { priority:       dto.priority }),
          ...(dto.type            !== undefined && { type:           dto.type }),
          scheduledAt: newScheduledAt,
          endsAt,
          ...(dto.durationMinutes !== undefined && { durationMinutes: dto.durationMinutes }),
          ...(dto.description     !== undefined && { description:    dto.description }),
          ...(dto.address         !== undefined && { address:        dto.address }),
          ...(dto.notes           !== undefined && { notes:          dto.notes }),
          ...(dto.internalNotes   !== undefined && { internalNotes:  dto.internalNotes }),
          ...(dto.agreedPrice     !== undefined && { agreedPrice:    dto.agreedPrice }),
          ...(dto.staffId         !== undefined && { staffId:        dto.staffId }),
          ...(dto.cancelReason    !== undefined && { cancelReason:   dto.cancelReason }),
          ...(dto.paymentStatus   !== undefined && { paymentStatus:  dto.paymentStatus }),
          ...(dto.paymentMethod   !== undefined && { paymentMethod:  dto.paymentMethod }),
          ...(dto.paymentAmount   !== undefined && { paymentAmount:  dto.paymentAmount }),
          ...(dto.paymentNotes    !== undefined && { paymentNotes:   dto.paymentNotes }),
          ...(dto.paymentProofUrl !== undefined && { paymentProofUrl: dto.paymentProofUrl }),
          ...(dto.paymentStatus === 'PAID' && { paymentConfirmedAt: new Date() }),
          ...(dto.pendingActionResolution !== undefined && {
            pendingAction:       null,
            pendingActionAt:     null,
            pendingActionData:   Prisma.JsonNull,
            pendingActionReason: null,
          }),
          ...statusTimestamps,
        },
        include: APPOINTMENT_INCLUDE,
      });

      const dtoForTimeline = { ...dto, status: resolvedStatus };
      const action = this.resolveTimelineAction(dtoForTimeline as any, current.status as AppointmentStatus);
      if (action) {
        await tx.appointmentTimeline.create({
          data: {
            appointmentId,
            action,
            previousStatus: resolvedStatus ? (current.status as AppointmentStatus) : undefined,
            newStatus:      resolvedStatus as AppointmentStatus | undefined,
            note:           this.resolveTimelineNote(dtoForTimeline as any, current.status as AppointmentStatus),
            isPublic:       this.isPublicAction(action),
            performedById:  performedById ?? null,
          },
        });
      }

      // ── Auto-crear orden de servicio al confirmar pago ──────────────────────
      if (dto.paymentStatus === 'PAID' && current.paymentStatus !== 'PAID') {
        const existingOrder = await tx.order.findUnique({
          where: { appointmentId: updated.appointmentId },
        });

        if (!existingOrder) {
          const amount   = Number(dto.paymentAmount ?? updated.paymentAmount ?? updated.agreedPrice ?? 0);
          const service  = updated.service;
          const itemDesc = service?.name ?? updated.description ?? updated.type ?? 'Servicio';

          await tx.order.create({
            data: {
              storeId:             updated.storeId,
              customerId:          updated.customerId,
              type:                'service',
              status:              'delivered',
              isManual:            true,
              appointmentId:       updated.appointmentId,
              manualPaymentMethod: updated.paymentMethod ?? dto.paymentMethod ?? 'efectivo',
              notes:               `Pago de cita #${updated.appointmentId.slice(-8).toUpperCase()} — ${itemDesc}`,
              subtotal:            amount,
              total:               amount,
              orderItems: {
                create: [{
                  description: itemDesc,
                  quantity:    1,
                  unitPrice:   amount,
                  ...(updated.serviceId ? { service: { connect: { serviceId: updated.serviceId } } } : {}),
                }],
              },
            },
          });

          // Actualizar métricas del cliente
          await tx.customer.update({
            where: { customerId: updated.customerId },
            data: {
              totalOrders: { increment: 1 },
              totalSpent:  { increment: amount },
              lastOrderDate: new Date(),
            },
          });
        }
      }

      return updated;
    });

    return { appointment, notificationTrigger };
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
    if (!storeId) {
      return {
        total: 0, pending: 0, confirmed: 0, todayCount: 0,
        upcomingWeek: 0, inProgress: 0, completedTotal: 0,
        cancelledTotal: 0, noShowTotal: 0,
      };
    }
    const now = new Date();
    // Anclado a medianoche Colombia (mismo patrón que reports.service.ts), no a
    // medianoche del proceso: "new Date(now.getFullYear(), now.getMonth(), ...)"
    // usa getters/constructor LOCALES — en producción (UTC, sin TZ configurado)
    // eso da medianoche UTC, corrida 5h respecto a medianoche Colombia. Entre
    // las 7pm y la medianoche en Colombia, "todayCount"/"upcomingWeek" quedaban
    // mal: se perdían citas de la mañana de hoy y se contaban citas de mañana
    // de la madrugada como si fueran de hoy.
    const tzOffset   = -5 * 60;
    const localNow   = new Date(now.getTime() + tzOffset * 60 * 1000);
    const todayStart = new Date(Date.UTC(
      localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(),
      5, 0, 0, 0,
    ));
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

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