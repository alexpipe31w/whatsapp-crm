import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';

@Injectable()
export class ServicesService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateServiceDto) {
    const storeId = dto.storeId!; // siempre inyectado por el controller desde JWT
    // Campos explícitos — nunca pasar dto directo a Prisma
    return this.prisma.service.create({
      data: {
        storeId,
        name:        dto.name,
        description: dto.description ?? null,
        price:       dto.price ?? null,
        duration:    dto.duration ?? null,
      },
    });
  }

  async findAllByStore(storeId: string) {
    return this.prisma.service.findMany({
      where: { storeId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(serviceId: string, storeId?: string) {
    const service = await this.prisma.service.findUnique({
      where: { serviceId },
    });
    if (!service) throw new NotFoundException('Servicio no encontrado');
    if (storeId && service.storeId !== storeId)
      throw new ForbiddenException('No tienes acceso a este servicio');
    return service;
  }

  async update(serviceId: string, dto: UpdateServiceDto, storeId?: string) {
    await this.findOne(serviceId, storeId);
    // Excluir storeId del update — no se puede mover un servicio a otra tienda
    const { storeId: _ignored, ...safeData } = dto as any;
    return this.prisma.service.update({
      where: { serviceId },
      data: safeData,
    });
  }

  async remove(serviceId: string, storeId?: string) {
    await this.findOne(serviceId, storeId);
    return this.prisma.service.update({
      where: { serviceId },
      data: { isActive: false },
    });
  }
}
