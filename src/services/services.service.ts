import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';

@Injectable()
export class ServicesService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateServiceDto) {
    return this.prisma.service.create({ data: dto });
  }

  async findAllByStore(storeId: string) {
    return this.prisma.service.findMany({
      where: { storeId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(serviceId: string) {
    const service = await this.prisma.service.findUnique({
      where: { serviceId },
    });
    if (!service) throw new NotFoundException('Servicio no encontrado');
    return service;
  }

  async update(serviceId: string, dto: UpdateServiceDto) {
    await this.findOne(serviceId);
    return this.prisma.service.update({
      where: { serviceId },
      data: dto,
    });
  }

  async remove(serviceId: string) {
    await this.findOne(serviceId);
    return this.prisma.service.update({
      where: { serviceId },
      data: { isActive: false },
    });
  }
}
