import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';

@Injectable()
export class OrdersService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateOrderDto) {
    if (!dto.items || dto.items.length === 0)
      throw new BadRequestException('El pedido debe tener al menos un item');

    const total = dto.items.reduce(
      (sum, item) => sum + item.unitPrice * item.quantity,
      0,
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

  async findOne(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { orderId },
      include: {
        customer: true,
        orderItems: { include: { product: true, service: true } },
      },
    });
    if (!order) throw new NotFoundException('Pedido no encontrado');
    return order;
  }

  async updateStatus(orderId: string, dto: UpdateOrderDto) {
    await this.findOne(orderId);
    return this.prisma.order.update({
      where: { orderId },
      data: dto,
      include: {
        customer: true,
        orderItems: { include: { product: true, service: true } },
      },
    });
  }

  /**
   * Resumen legible para la IA — se llama cuando un cliente pregunta por su pedido.
   * Retorna texto plano listo para incluir en el system prompt o en una respuesta.
   */
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
      order.estimatedTime ? `Tiempo estimado: ${order.estimatedTime} minutos` : null,
      order.deliveryAddress ? `Dirección: ${order.deliveryAddress}` : null,
      order.notes ? `Notas: ${order.notes}` : null,
      `Fecha: ${order.createdAt.toLocaleString('es-CO')}`,
    ].filter(Boolean).join('\n');
  }
}