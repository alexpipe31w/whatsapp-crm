import {
  Injectable, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';

@Injectable()
export class CustomersService {
  constructor(private prisma: PrismaService) {}

  // FIX: race condition — si dos mensajes llegan al mismo tiempo para un cliente
  // nuevo, el upsert puede fallar con P2002 en versiones antiguas de Prisma.
  async findOrCreate(dto: CreateCustomerDto) {
    const storeId = dto.storeId!;
    try {
      return await this.prisma.customer.upsert({
        where:  { storeId_phone: { storeId, phone: dto.phone } },
        update: {},
        create: { storeId, phone: dto.phone },
      });
    } catch (err: any) {
      // P2002 = unique constraint — otro proceso creó el cliente primero
      if (err?.code === 'P2002') {
        const existing = await this.prisma.customer.findUnique({
          where: { storeId_phone: { storeId, phone: dto.phone } },
        });
        if (existing) return existing;
      }
      throw err;
    }
  }

  async findAllByStore(storeId: string) {
    return this.prisma.customer.findMany({
      where:   { storeId },
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

  // FIX: incluir cedula y phone en los campos actualizables
  async update(
    customerId: string,
    data: { name?: string; city?: string; cedula?: string; phone?: string },
    storeId?: string,
  ) {
    await this.findOne(customerId, storeId);
    return this.prisma.customer.update({
      where: { customerId },
      data,
    });
  }
}