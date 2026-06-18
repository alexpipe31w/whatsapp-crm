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
    // Nombre por defecto: el que venga explícito, si no el pushName de WhatsApp,
    // y si tampoco hay → "Cliente {últimos 4 del teléfono}".
    const digits = (dto.phone ?? '').replace(/\D/g, '');
    const fallbackName = `Cliente ${digits.slice(-4) || '0000'}`;
    const defaultName = (dto.name?.trim() || dto.pushName?.trim() || fallbackName).slice(0, 100);
    try {
      const customer = await this.prisma.customer.upsert({
        where:  { storeId_phone: { storeId, phone: dto.phone } },
        update: {},
        create: { storeId, phone: dto.phone, name: defaultName },
      });
      // Backfill: si el cliente existía sin nombre y ahora tenemos pushName/nombre, lo guardamos.
      if (!customer.name && (dto.name?.trim() || dto.pushName?.trim())) {
        return await this.prisma.customer.update({
          where: { customerId: customer.customerId },
          data:  { name: defaultName },
        });
      }
      return customer;
    } catch (err: any) {
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
      include: {
        _count: { select: { orders: true, conversations: true } },
      },
      orderBy: { totalSpent: 'desc' },
    });
  }

  async findOne(customerId: string, storeId?: string) {
    const customer = await this.prisma.customer.findUnique({
      where:   { customerId },
      include: {
        orders: {
          orderBy: { createdAt: 'desc' },
          take:    5,
          include: { orderItems: { include: { product: true, service: true } } },
        },
        _count: { select: { orders: true, conversations: true } },
      },
    });
    if (!customer) throw new NotFoundException('Cliente no encontrado');
    if (storeId && customer.storeId !== storeId)
      throw new ForbiddenException('No tienes acceso a este cliente');
    return customer;
  }

  async update(
    customerId: string,
    data: { name?: string; city?: string; cedula?: string; phone?: string; acceptsMarketing?: boolean },
    storeId?: string,
  ) {
    await this.findOne(customerId, storeId);
    return this.prisma.customer.update({ where: { customerId }, data });
  }

  // Recalcula métricas desde las órdenes — útil para sincronizar datos históricos
  async recalcMetrics(customerId: string, storeId?: string) {
    const customer = await this.findOne(customerId, storeId);
    const orders = await this.prisma.order.findMany({
      where:   { customerId, storeId: customer.storeId, status: { not: 'cancelled' } },
      orderBy: { createdAt: 'asc' },
      select:  { total: true, createdAt: true },
    });
    const totalSpent  = orders.reduce((s, o) => s + Number(o.total), 0);
    const firstOrder  = orders[0]?.createdAt ?? null;
    const lastOrder   = orders[orders.length - 1]?.createdAt ?? null;
    return this.prisma.customer.update({
      where: { customerId },
      data: {
        totalOrders:    orders.length,
        totalSpent,
        firstOrderDate: firstOrder,
        lastOrderDate:  lastOrder,
      },
    });
  }
}