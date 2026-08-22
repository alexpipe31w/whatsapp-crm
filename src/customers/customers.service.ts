import {
  Injectable, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { lidFromIdentity, lidIdentity } from '../utils/wa-identity.util';

@Injectable()
export class CustomersService {
  constructor(private prisma: PrismaService) {}

  // FIX: race condition — si dos mensajes llegan al mismo tiempo para un cliente
  // nuevo, el upsert puede fallar con P2002 en versiones antiguas de Prisma.
  async findOrCreate(dto: CreateCustomerDto) {
    const storeId = dto.storeId!;
    // Cliente que WhatsApp direcciona por LID sin dar su número: su identidad es
    // "lid:<user>", así que el LID se deriva de ella sin necesidad de pasarlo aparte.
    const derivedLid = lidFromIdentity(dto.phone ?? '');
    // Nombre por defecto: el que venga explícito, si no el pushName de WhatsApp,
    // y si tampoco hay → "Cliente {últimos 4 del teléfono}". Sin número no hay
    // últimos 4 que valgan, así que se cae a un genérico.
    const digits = (dto.phone ?? '').replace(/\D/g, '');
    const fallbackName = derivedLid
      ? 'Cliente de WhatsApp'
      : `Cliente ${digits.slice(-4) || '0000'}`;
    const defaultName = (dto.name?.trim() || dto.pushName?.trim() || fallbackName).slice(0, 100);
    try {
      const customer = await this.prisma.customer.upsert({
        where:  { storeId_phone: { storeId, phone: dto.phone } },
        update: {},
        create: { storeId, phone: dto.phone, name: defaultName, waLid: derivedLid },
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

  /**
   * Cruza las dos identidades posibles de un mismo cliente: la telefónica y la LID.
   *
   * Se llama cuando llega un mensaje del que SÍ conocemos el teléfono y además su LID.
   * Si ese cliente había escrito antes sin número, su ficha existe como "lid:<user>" y
   * hay que unificarla — si no, el mismo cliente quedaría partido en dos y el historial
   * que ve la IA saldría a medias.
   *
   * Todo va en una transacción y se apoya en el índice único (store_id, phone): dos
   * mensajes simultáneos no pueden dejar fichas duplicadas ni a medio mover.
   */
  async linkLidIdentity(storeId: string, phone: string, waLid: string): Promise<void> {
    const lidKey = lidIdentity(waLid);
    if (phone === lidKey) return; // aún no sabemos el teléfono: nada que cruzar

    await this.prisma.$transaction(async (tx) => {
      const [lidCustomer, phoneCustomer] = await Promise.all([
        tx.customer.findUnique({ where: { storeId_phone: { storeId, phone: lidKey } } }),
        tx.customer.findUnique({ where: { storeId_phone: { storeId, phone } } }),
      ]);

      // Caso 1: nunca escribió sin número. Solo anotamos su LID para poder responderle
      // por esa vía si algún día WhatsApp deja de entregar el teléfono.
      if (!lidCustomer) {
        if (phoneCustomer && phoneCustomer.waLid !== waLid) {
          await tx.customer.update({
            where: { customerId: phoneCustomer.customerId },
            data:  { waLid },
          });
        }
        return;
      }

      // Caso 2: la ficha existe solo como LID y ahora aparece el número. Se completa
      // en sitio: conserva conversaciones, pedidos y citas sin mover nada.
      if (!phoneCustomer) {
        await tx.customer.update({
          where: { customerId: lidCustomer.customerId },
          data:  { phone, waLid },
        });
        return;
      }

      // Caso 3: duplicado real. El cliente telefónico es el que manda (tiene métricas de
      // compra y datos de facturación); se le lleva todo lo del LID y esa ficha se borra.
      if (lidCustomer.customerId === phoneCustomer.customerId) return;

      const where = { customerId: lidCustomer.customerId };
      const data  = { customerId: phoneCustomer.customerId };
      await tx.conversation.updateMany({ where, data });
      await tx.order.updateMany({ where, data });
      await tx.appointment.updateMany({ where, data });

      await tx.customer.update({
        where: { customerId: phoneCustomer.customerId },
        data:  {
          waLid,
          name:        phoneCustomer.name ?? lidCustomer.name,
          totalOrders: phoneCustomer.totalOrders + lidCustomer.totalOrders,
          totalSpent:  phoneCustomer.totalSpent.add(lidCustomer.totalSpent),
        },
      });
      await tx.customer.delete({ where: { customerId: lidCustomer.customerId } });
    });
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