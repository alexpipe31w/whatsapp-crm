import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';

@Injectable()
export class AppointmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(storeId: string, filters?: {
    status?: string;
    type?: string;
    from?: string;
    to?: string;
  }) {
    const where: any = { storeId };

    if (filters?.status) where.status = filters.status;
    if (filters?.type)   where.type   = filters.type;

    if (filters?.from || filters?.to) {
      where.scheduledAt = {};
      if (filters.from) where.scheduledAt.gte = new Date(filters.from);
      if (filters.to)   where.scheduledAt.lte = new Date(filters.to);
    }

    return this.prisma.appointment.findMany({
      where,
      include: {
        customer: {
          select: {
            customerId: true,
            name: true,
            phone: true,
            cedula: true,
            city: true,
          },
        },
      },
      orderBy: { scheduledAt: 'asc' },
    });
  }

  async findOne(appointmentId: string, storeId: string) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { appointmentId },
      include: {
        customer: {
          select: {
            customerId: true,
            name: true,
            phone: true,
            cedula: true,
            city: true,
          },
        },
      },
    });

    if (!appointment) throw new NotFoundException('Cita no encontrada');
    if (appointment.storeId !== storeId) throw new ForbiddenException();

    return appointment;
  }

  async create(storeId: string, dto: CreateAppointmentDto) {
    return this.prisma.appointment.create({
      data: {
        storeId,
        customerId:  dto.customerId,
        type:        dto.type ?? 'cita',
        scheduledAt: new Date(dto.scheduledAt),
        description: dto.description ?? null,
        address:     dto.address ?? null,
        notes:       dto.notes ?? null,
        status:      'pending',
      },
      include: {
        customer: {
          select: { customerId: true, name: true, phone: true, cedula: true },
        },
      },
    });
  }

  async update(appointmentId: string, storeId: string, dto: UpdateAppointmentDto) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { appointmentId },
    });

    if (!appointment) throw new NotFoundException('Cita no encontrada');
    if (appointment.storeId !== storeId) throw new ForbiddenException();

    return this.prisma.appointment.update({
      where: { appointmentId },
      data: {
        ...(dto.status      && { status: dto.status }),
        ...(dto.scheduledAt && { scheduledAt: new Date(dto.scheduledAt) }),
        ...(dto.type        && { type: dto.type }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.address     !== undefined && { address: dto.address }),
        ...(dto.notes       !== undefined && { notes: dto.notes }),
      },
      include: {
        customer: {
          select: { customerId: true, name: true, phone: true, cedula: true },
        },
      },
    });
  }

  async remove(appointmentId: string, storeId: string) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { appointmentId },
    });

    if (!appointment) throw new NotFoundException('Cita no encontrada');
    if (appointment.storeId !== storeId) throw new ForbiddenException();

    return this.prisma.appointment.delete({ where: { appointmentId } });
  }

  // Stats rápidas para dashboard
  async getStats(storeId: string) {
    const now   = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [total, pending, todayCount, upcoming] = await Promise.all([
      this.prisma.appointment.count({ where: { storeId } }),
      this.prisma.appointment.count({ where: { storeId, status: 'pending' } }),
      this.prisma.appointment.count({
        where: { storeId, scheduledAt: { gte: today, lt: tomorrow } },
      }),
      this.prisma.appointment.count({
        where: { storeId, scheduledAt: { gte: now }, status: { in: ['pending', 'confirmed'] } },
      }),
    ]);

    return { total, pending, todayCount, upcoming };
  }
}