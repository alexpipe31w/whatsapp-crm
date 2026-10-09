// src/orders/orders.service.spec.ts
import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrdersService } from './orders.service';

function makeHarness(order: Record<string, any> = {}) {
  const current = { orderId: 'o1', storeId: 's1', status: 'pending', orderItems: [], customer: {}, ...order };
  const tx = {
    order: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ ...current, status: 'cancelled' }),
      create: jest.fn().mockResolvedValue({ orderId: 'o1' }),
    },
    orderItem: { findMany: jest.fn().mockResolvedValue([]) },
    productVariant: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn() },
    product: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn().mockResolvedValue(null) },
    service: { findFirst: jest.fn() },
    customer: { update: jest.fn() },
  };
  const prisma = {
    order: { findUnique: jest.fn().mockResolvedValue(current) },
    customer: { findUnique: jest.fn().mockResolvedValue({ customerId: 'c1', storeId: 's1', firstOrderDate: null }) },
    $transaction: jest.fn((fn: any) => fn(tx)),
  };
  const sync = { emitStockChanged: jest.fn(), kick: jest.fn() };
  const service = new OrdersService(prisma as any, sync as any);
  return { service, tx, prisma, sync };
}

describe('OrdersService.updateStatus — cancelar devuelve stock', () => {
  it('devuelve el stock de la variante y avisa a StockUp con delta positivo', async () => {
    const { service, tx, sync } = makeHarness();
    tx.orderItem.findMany.mockResolvedValue([{ productId: 'p1', variantId: 'v1', quantity: 2 }]);

    await service.updateStatus('o1', { status: 'cancelled' }, 's1');

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'o1', storeId: 's1', status: 'pending' },
      data:  { status: 'cancelled' },
    });
    expect(tx.productVariant.updateMany).toHaveBeenCalledWith({
      where: { variantId: 'v1', product: { storeId: 's1' } },
      data:  { stock: { increment: 2 } },
    });
    expect(tx.product.updateMany).not.toHaveBeenCalled();
    expect(sync.emitStockChanged).toHaveBeenCalledWith(tx, 's1', { variantId: 'v1' }, 2);
    expect(sync.kick).toHaveBeenCalled();
  });

  it('sin variante devuelve el stock del producto', async () => {
    const { service, tx, sync } = makeHarness({ status: 'confirmed' });
    tx.orderItem.findMany.mockResolvedValue([{ productId: 'p1', variantId: null, quantity: 1 }]);

    await service.updateStatus('o1', { status: 'cancelled' }, 's1');

    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { productId: 'p1', storeId: 's1' },
      data:  { stock: { increment: 1 } },
    });
    expect(sync.emitStockChanged).toHaveBeenCalledWith(tx, 's1', { productId: 'p1' }, 1);
  });

  it('los items de servicio no tocan inventario', async () => {
    const { service, tx, sync } = makeHarness();
    tx.orderItem.findMany.mockResolvedValue([{ productId: null, variantId: null, quantity: 1 }]);

    await service.updateStatus('o1', { status: 'cancelled' }, 's1');

    expect(tx.product.updateMany).not.toHaveBeenCalled();
    expect(tx.productVariant.updateMany).not.toHaveBeenCalled();
    expect(sync.emitStockChanged).not.toHaveBeenCalled();
  });

  it('si otra petición ya cambió el estado, no devuelve stock (sin doble devolución)', async () => {
    const { service, tx, sync } = makeHarness();
    tx.order.updateMany.mockResolvedValue({ count: 0 });
    tx.orderItem.findMany.mockResolvedValue([{ productId: 'p1', variantId: 'v1', quantity: 2 }]);

    await expect(service.updateStatus('o1', { status: 'cancelled' }, 's1')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.productVariant.updateMany).not.toHaveBeenCalled();
    expect(sync.emitStockChanged).not.toHaveBeenCalled();
    expect(sync.kick).not.toHaveBeenCalled();
  });

  it('otras transiciones no tocan el stock', async () => {
    const { service, tx, sync } = makeHarness();

    await service.updateStatus('o1', { status: 'confirmed' }, 's1');

    expect(tx.order.updateMany).toHaveBeenCalled();
    expect(tx.orderItem.findMany).not.toHaveBeenCalled();
    expect(sync.emitStockChanged).not.toHaveBeenCalled();
    expect(sync.kick).not.toHaveBeenCalled();
  });

  it('un pedido ya cancelado no se puede volver a cancelar', async () => {
    const { service, tx } = makeHarness({ status: 'cancelled' });

    await expect(service.updateStatus('o1', { status: 'pending' }, 's1')).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });
});

describe('OrdersService.create — variante obligatoria', () => {
  const dto = {
    storeId: 's1', customerId: 'c1',
    items: [{ productId: 'p1', quantity: 1, unitPrice: 3500 }],
  } as any;

  it('rechaza un producto con variantes activas si no llega variantId', async () => {
    const { service, tx, sync } = makeHarness();
    tx.product.findFirst.mockResolvedValue({ name: 'Pulpas' });

    await expect(service.create(dto)).rejects.toThrow('"Pulpas" tiene variantes');
    expect(tx.product.findFirst).toHaveBeenCalledWith({
      where:  { productId: 'p1', storeId: 's1', variants: { some: { isActive: true } } },
      select: { name: true },
    });
    expect(tx.product.updateMany).not.toHaveBeenCalled();
    expect(sync.emitStockChanged).not.toHaveBeenCalled();
  });

  it('un producto sin variantes se descuenta como antes', async () => {
    const { service, tx, sync } = makeHarness();

    await service.create(dto);

    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { productId: 'p1', stock: { gte: 1 }, storeId: 's1' },
      data:  { stock: { decrement: 1 } },
    });
    expect(sync.emitStockChanged).toHaveBeenCalledWith(tx, 's1', { productId: 'p1' }, -1);
  });
});
