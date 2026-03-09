import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';

@Injectable()
export class CustomersService {
  constructor(private prisma: PrismaService) {}

  async findOrCreate(dto: CreateCustomerDto) {
    const storeId = dto.storeId!; // siempre inyectado por el controller desde JWT
    return this.prisma.customer.upsert({
      where: { storeId_phone: { storeId, phone: dto.phone } },
      update: {},
      create: { storeId, phone: dto.phone },
    });
  }

  async findAllByStore(storeId: string) {
    return this.prisma.customer.findMany({
      where: { storeId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(customerId: string, storeId?: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { customerId },
    });
    if (!customer) throw new NotFoundException('Cliente no encontrado');
    if (storeId && customer.storeId !== storeId) {
      throw new ForbiddenException('No tienes acceso a este cliente');
    }
    return customer;
  }

  async update(customerId: string, data: { name?: string; city?: string }, storeId?: string) {
    await this.findOne(customerId, storeId);
    return this.prisma.customer.update({
      where: { customerId },
      data,
    });
  }
}