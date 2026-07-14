// src/integrations/sync.service.spec.ts
import { productToWire, wireToProductData, SyncService } from './sync.service';
import { Prisma } from '../generated/prisma/client';

describe('mapeo wire', () => {
  const crmProduct = {
    productId: 'p1', stockupProductId: null, name: 'Inositol', description: '<p>desc</p>',
    sku: 'INSO', salePrice: 60000 as any, costPrice: 25000 as any, stock: 100,
    hasVariants: false, images: ['https://img'], imageUrl: 'https://img', isActive: true,
    category: { categoryId: 'c1', stockupCategoryId: 'sc1', name: 'Vitaminas' },
    variants: [],
  };

  it('CRM → wire', () => {
    const w = productToWire(crmProduct as any);
    expect(w).toMatchObject({
      sourceId: 'p1', targetId: null, name: 'Inositol', sku: 'INSO',
      price: 60000, costPrice: 25000, stock: 100, images: ['https://img'],
      isActive: true, hasVariants: false,
      category: { sourceId: 'c1', targetId: 'sc1', name: 'Vitaminas' },
    });
  });

  it('wire → data de escritura CRM', () => {
    const d = wireToProductData({
      sourceId: 's9', targetId: null, name: 'Nuevo', description: null, sku: null,
      price: 1000, costPrice: 0, stock: 3, images: [], isActive: true,
      hasVariants: false, category: null, variants: [],
    });
    expect(d).toMatchObject({
      name: 'Nuevo', salePrice: 1000, costPrice: 0, stock: 3,
      images: [], imageUrl: null, isActive: true, stockupProductId: 's9',
    });
  });
});

// ── applyRemoteEvent — receptor de eventos StockUp → CRM (mock de Prisma) ──
// Arma un fake tx + fake prisma con solo los métodos que el receptor toca.
function makeHarness() {
  const tx = {
    product: {
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn(),
    },
    productVariant: {
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({}),
    },
    category: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    stockupConnection: { update: jest.fn() },
    syncInbox: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma: any = {
    syncInbox: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (cb: any) => cb(tx)),
    product: { findFirst: jest.fn().mockResolvedValue(null) },
    category: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const service = new SyncService(prisma);
  return { service, prisma, tx };
}

describe('applyRemoteEvent — orden evento-contra-evento (no updatedAt local)', () => {
  it('un backlog fuera de orden skipea el evento viejo y aplica el más nuevo', async () => {
    const { service, tx } = makeHarness();
    const syncedAt = new Date('2026-01-01T12:00:00Z');
    tx.product.findFirst.mockResolvedValue({ productId: 'p1', stockupSyncedAt: syncedAt });

    // el evento "viejo" llega DESPUÉS del que ya se aplicó (occurredAt <= stockupSyncedAt)
    const oldEvent = {
      eventId: 'e-old', type: 'stock.changed', occurredAt: '2026-01-01T11:00:00Z',
      payload: { productSourceId: 'sp1', variantSourceId: null, stock: 5 },
    };
    const oldResult = await service.applyRemoteEvent('store1', oldEvent);
    expect(oldResult).toEqual({ ok: true, skipped: true });
    expect(tx.product.update).not.toHaveBeenCalled();

    const newEvent = {
      eventId: 'e-new', type: 'stock.changed', occurredAt: '2026-01-01T13:00:00Z',
      payload: { productSourceId: 'sp1', variantSourceId: null, stock: 8 },
    };
    const newResult = await service.applyRemoteEvent('store1', newEvent);
    expect(newResult.ok).toBe(true);
    expect(newResult.skipped).toBeFalsy();
    expect(tx.product.update).toHaveBeenCalledWith({
      where: { productId: 'p1' },
      data: { stock: 8, stockupSyncedAt: new Date('2026-01-01T13:00:00Z') },
    });
  });
});

describe('applyRemoteEvent — fast-path de dedupe', () => {
  it('evento ya en el inbox: skip sin abrir transacción', async () => {
    const { service, prisma } = makeHarness();
    prisma.syncInbox.findUnique.mockResolvedValue({ eventId: 'e1', processedAt: new Date() });

    const event = {
      eventId: 'e1', type: 'stock.changed', occurredAt: new Date().toISOString(),
      payload: { productSourceId: 'sp1', variantSourceId: null, stock: 1 },
    };
    const result = await service.applyRemoteEvent('store1', event);
    expect(result).toEqual({ ok: true, skipped: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('applyRemoteEvent — tipo desconocido', () => {
  it('no toca el inbox ni abre transacción', async () => {
    const { service, prisma } = makeHarness();
    const result = await service.applyRemoteEvent('store1', {
      eventId: 'e1', type: 'foo.bar', occurredAt: new Date().toISOString(), payload: {},
    });
    expect(result).toEqual({ ok: false });
    expect(prisma.syncInbox.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('applyRemoteEvent — atomicidad apply+inbox', () => {
  it('si el apply falla, el inbox no queda commiteado', async () => {
    const { service, tx } = makeHarness();
    tx.category.findFirst.mockResolvedValue(null);
    tx.category.findUnique.mockResolvedValue(null);
    tx.category.create.mockRejectedValue(new Error('boom'));

    const event = {
      eventId: 'e1', type: 'category.upserted', occurredAt: new Date().toISOString(),
      payload: { category: { sourceId: 'sc1', name: 'Vitaminas' } },
    };
    await expect(service.applyRemoteEvent('store1', event)).rejects.toThrow('boom');
    expect(tx.syncInbox.create).not.toHaveBeenCalled();
  });

  it('la carrera P2002 del inbox entre dos instancias se trata como skipped, no error', async () => {
    const { service, prisma } = makeHarness();
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002', clientVersion: '6.19.2', meta: { target: ['eventId'] },
      }),
    );
    const event = {
      eventId: 'e1', type: 'stock.changed', occurredAt: new Date().toISOString(),
      payload: { productSourceId: 'sp1', variantSourceId: null, stock: 1 },
    };
    const result = await service.applyRemoteEvent('store1', event);
    expect(result).toEqual({ ok: true, skipped: true });
  });
});
