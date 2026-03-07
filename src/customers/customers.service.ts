import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';

@Injectable()
export class CustomersService {
  constructor(private prisma: PrismaService) {}

  async findOrCreate(dto: CreateCustomerDto) {
    const existing = await this.prisma.customer.findUnique({
      where: { storeId_phone: { storeId: dto.storeId, phone: dto.phone } },
    });
    if (existing) return existing;
    return this.prisma.customer.create({ data: dto });
  }

  async findAllByStore(storeId: string) {
    return this.prisma.customer.findMany({
      where: { storeId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { customerId },
    });
    if (!customer) throw new NotFoundException('Cliente no encontrado');
    return customer;
  }
}
