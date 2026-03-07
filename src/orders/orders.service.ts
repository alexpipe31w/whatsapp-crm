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

    // Calcular total
    const total = dto.items.reduce(
      (sum, item) => sum + item.unitPrice * item.quantity,
      0,
    );

    return this.prisma.order.create({
      data: {
        storeId: dto.storeId,
        customerId: dto.customerId,
        notes: dto.notes,
        total,
        orderItems: {
          create: dto.items.map((item) => ({
            productId: item.productId ?? null,
            serviceId: item.serviceId ?? null,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          })),
        },
      },
      include: {
        orderItems: {
          include: {
            product: true,
            service: true,
          },
        },
        customer: true,
      },
    });
  }

  async findAllByStore(storeId: string) {
    return this.prisma.order.findMany({
      where: { storeId },
      include: {
        customer: true,
        orderItems: {
          include: { product: true, service: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { orderId },
      include: {
        customer: true,
        orderItems: {
          include: { product: true, service: true },
        },
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
    });
  }
}
