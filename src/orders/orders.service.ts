import {
  Injectable, NotFoundException, BadRequestException, ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';

// FIX: agregar set de estados válidos para bloquear estados inválidos
const VALID_TRANSITIONS: Record<string, string[]> = {
  pending:   ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready:     ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

const VALID_ORDER_STATUSES = new Set(Object.keys(VALID_TRANSITIONS));

@Injectable()
export class OrdersService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateOrderDto) {
    if (!dto.items || dto.items.length === 0)
      throw new BadRequestException('El pedido debe tener al menos un item');

    const customer = await this.prisma.customer.findUnique({
      where: { customerId: dto.customerId },
    });
    if (!customer) throw new NotFoundException('Cliente no encontrado');
    if (customer.storeId !== dto.storeId)
      throw new ForbiddenException('El cliente no pertenece a esta tienda');

    // Idempotencia: si ya existe una orden con esta clave, devolver la existente
    if (dto.idempotencyKey) {
      const existing = await this.prisma.order.findUnique({
        where:   { idempotencyKey: dto.idempotencyKey },
        include: { orderItems: { include: { product: true, service: true } }, customer: true },
      });
      if (existing) return existing;
    }

    const subtotal = dto.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    const discountAmount = dto.discountPercent ? Math.round(subtotal * (dto.discountPercent / 100) * 100) / 100 : 0;
    const total = subtotal - discountAmount;

    const orderItemsData = dto.items.map((item) => ({
      ...(item.productId ? { product: { connect: { productId: item.productId } } } : {}),
      ...(item.serviceId ? { service: { connect: { serviceId: item.serviceId } } } : {}),
      ...(item.variantId ? { variant: { connect: { variantId: item.variantId } } } : {}),
      description: item.description ?? null,
      quantity:    item.quantity,
      unitPrice:   item.unitPrice,
    }));

    // Transacción atómica: validar+descontar stock, crear orden y actualizar métricas del cliente.
    // El descuento se hace con updateMany + condición stock >= quantity para que la verificación
    // y la resta ocurran en una sola operación atómica de la BD (evita condiciones de carrera
    // TOCTOU entre dos pedidos simultáneos por el mismo producto).
    const order = await this.prisma.$transaction(async (tx) => {
      for (const item of dto.items) {
        if (item.variantId) {
          const result = await tx.productVariant.updateMany({
            where: { variantId: item.variantId, stock: { gte: item.quantity } },
            data:  { stock: { decrement: item.quantity } },
          });
          if (result.count === 0) {
            const variant = await tx.productVariant.findUnique({ where: { variantId: item.variantId } });
            throw new BadRequestException(
              `Stock insuficiente para la variante (disponible: ${variant?.stock ?? 0})`,
            );
          }
        } else if (item.productId) {
          const result = await tx.product.updateMany({
            where: { productId: item.productId, stock: { gte: item.quantity } },
            data:  { stock: { decrement: item.quantity } },
          });
          if (result.count === 0) {
            const product = await tx.product.findUnique({ where: { productId: item.productId } });
            throw new BadRequestException(
              `Stock insuficiente para "${product?.name ?? 'producto'}" (disponible: ${product?.stock ?? 0})`,
            );
          }
        }
      }

      const created = await tx.order.create({
        data: {
          storeId:              dto.storeId!,
          customerId:           dto.customerId,
          type:                 dto.type ?? 'product',
          notes:                dto.notes,
          subtotal,
          discountPercent:      dto.discountPercent ?? null,
          discountAmount,
          total,
          estimatedTime:        dto.estimatedTime ?? null,
          deliveryAddress:      dto.deliveryAddress ?? null,
          isManual:             dto.isManual ?? false,
          manualPaymentMethod:  dto.manualPaymentMethod ?? null,
          idempotencyKey:       dto.idempotencyKey ?? null,
          orderItems: { create: orderItemsData },
        },
        include: {
          orderItems: { include: { product: true, service: true } },
          customer:   true,
        },
      });

      // Actualizar métricas del cliente
      const now = new Date();
      await tx.customer.update({
        where: { customerId: dto.customerId },
        data: {
          totalOrders:    { increment: 1 },
          totalSpent:     { increment: total },
          lastOrderDate:  now,
          firstOrderDate: customer.firstOrderDate ?? now,
        },
      });

      return created;
    });

    return order;
  }

  async findAllByStore(storeId: string, type?: string) {
    return this.prisma.order.findMany({
      where:   { storeId, ...(type ? { type } : {}) },
      include: {
        customer:   true,
        orderItems: { include: { product: true, service: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(orderId: string, storeId?: string) {
    const order = await this.prisma.order.findUnique({
      where:   { orderId },
      include: {
        customer:   true,
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

    if (dto.status && dto.status !== order.status) {
      // FIX: bloquear estados que no existen en órdenes
      if (!VALID_ORDER_STATUSES.has(dto.status)) {
        throw new BadRequestException(
          `Estado "${dto.status}" no válido para órdenes`,
        );
      }

      const allowed = VALID_TRANSITIONS[order.status] ?? [];
      if (!allowed.includes(dto.status)) {
        throw new BadRequestException(
          `No se puede cambiar de "${order.status}" a "${dto.status}". ` +
          `Transiciones válidas: ${allowed.length ? allowed.join(', ') : 'ninguna (estado final)'}`,
        );
      }
    }

    // FIX: solo actualizar status — no pasar el DTO completo a Prisma
    return this.prisma.order.update({
      where: { orderId },
      data:  { status: dto.status },
      include: {
        customer:   true,
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
      const name = (i.product as any)?.name ?? (i.service as any)?.name ?? i.description ?? 'ítem';
      return `  - ${name} x${i.quantity} @ $${i.unitPrice}`;
    }).join('\n');

    return [
      `Pedido #${order.orderId.slice(0, 8).toUpperCase()}`,
      `Cliente: ${order.customer.name ?? order.customer.phone}`,
      `Estado: ${statusMap[order.status] ?? order.status}`,
      `Tipo: ${order.type}`,
      `Items:\n${items}`,
      `Total: $${order.total}`,
      (order as any).estimatedTime   ? `Tiempo estimado: ${(order as any).estimatedTime} min` : null,
      order.deliveryAddress ? `Dirección: ${order.deliveryAddress}` : null,
      order.notes           ? `Notas: ${order.notes}` : null,
      `Fecha: ${order.createdAt.toLocaleString('es-CO')}`,
    ].filter(Boolean).join('\n');
  }
}