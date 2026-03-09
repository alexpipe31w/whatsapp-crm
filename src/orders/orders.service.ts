import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';

// Transiciones de estado válidas
const VALID_TRANSITIONS: Record<string, string[]> = {
  pending:   ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready:     ['delivered', 'cancelled'],
  delivered: [],   // estado final
  cancelled: [],   // estado final
};

@Injectable()
export class OrdersService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateOrderDto) {
    if (!dto.items || dto.items.length === 0)
      throw new BadRequestException('El pedido debe tener al menos un item');

    // Verificar que el cliente pertenece a la misma tienda
    const customer = await this.prisma.customer.findUnique({
      where: { customerId: dto.customerId },
    });
    if (!customer) throw new NotFoundException('Cliente no encontrado');
    if (customer.storeId !== dto.storeId)
      throw new ForbiddenException('El cliente no pertenece a esta tienda');

    const total = dto.items.reduce(
      (sum, item) => sum + item.unitPrice * item.quantity, 0,
    );

    return this.prisma.order.create({
      data: {
        storeId: dto.storeId,
        customerId: dto.customerId,
        type: dto.type ?? 'product',
        notes: dto.notes,
        total,
        estimatedTime: dto.estimatedTime ?? null,
        deliveryAddress: dto.deliveryAddress ?? null,
        orderItems: {
          create: dto.items.map((item) => ({
            productId: item.productId ?? null,
            serviceId: item.serviceId ?? null,
            description: item.description ?? null,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          })),
        },
      },
      include: {
        orderItems: { include: { product: true, service: true } },
        customer: true,
      },
    });
  }

  async findAllByStore(storeId: string) {
    return this.prisma.order.findMany({
      where: { storeId },
      include: {
        customer: true,
        orderItems: { include: { product: true, service: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(orderId: string, storeId?: string) {
    const order = await this.prisma.order.findUnique({
      where: { orderId },
      include: {
        customer: true,
        orderItems: { include: { product: true, service: true } },
      },
    });
    if (!order) throw new NotFoundException('Pedido no encontrado');
    if (storeId && order.storeId !== storeId)
      throw new ForbiddenException('No tienes acceso a este pedido');
    return order;
  }

  async updateStatus(orderId: string, dto: UpdateOrderDto, storeId?: string) {
    const order = await this.findOne(orderId, storeId);

    // Validar transición de estado si se está cambiando
    if (dto.status && dto.status !== order.status) {
      const allowed = VALID_TRANSITIONS[order.status] ?? [];
      if (!allowed.includes(dto.status)) {
        throw new BadRequestException(
          `No se puede cambiar de "${order.status}" a "${dto.status}". ` +
          `Transiciones válidas: ${allowed.length ? allowed.join(', ') : 'ninguna (estado final)'}`,
        );
      }
    }

    return this.prisma.order.update({
      where: { orderId },
      data: dto,
      include: {
        customer: true,
        orderItems: { include: { product: true, service: true } },
      },
    });
  }

  async getSummaryForAI(orderId: string): Promise<string> {
    const order = await this.findOne(orderId);
    const statusMap: Record<string, string> = {
      pending:   'pendiente de confirmación',
      confirmed: 'confirmado',
      preparing: 'en preparación',
      ready:     'listo para entrega',
      delivered: 'entregado',
      cancelled: 'cancelado',
    };
    const items = order.orderItems.map((i) => {
      const name = i.product?.name ?? i.service?.name ?? i.description ?? 'ítem';
      return `  - ${name} x${i.quantity} @ $${i.unitPrice}`;
    }).join('\n');

    return [
      `Pedido #${order.orderId.slice(0, 8).toUpperCase()}`,
      `Cliente: ${order.customer.name ?? order.customer.phone}`,
      `Estado: ${statusMap[order.status] ?? order.status}`,
      `Tipo: ${order.type}`,
      `Items:\n${items}`,
      `Total: $${order.total}`,
      order.estimatedTime ? `Tiempo estimado: ${order.estimatedTime} min` : null,
      order.deliveryAddress ? `Dirección: ${order.deliveryAddress}` : null,
      order.notes ? `Notas: ${order.notes}` : null,
      `Fecha: ${order.createdAt.toLocaleString('es-CO')}`,
    ].filter(Boolean).join('\n');
  }
}