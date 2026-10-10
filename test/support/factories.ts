import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../src/generated/prisma/client';
import { testPrisma } from './db';
import { TokenUser } from './auth';

let seq = 0;
const next = () => ++seq;

export interface StoreWithAdmin {
  storeId: string;
  admin: TokenUser;
}

/** Tienda + usuario admin de esa tienda. `label` solo sirve para leer los fallos. */
export async function createStoreWithAdmin(label = 'tienda'): Promise<StoreWithAdmin> {
  const prisma = testPrisma();
  const n = next();
  const store = await prisma.store.create({
    data: { name: `${label} ${n}`, phone: `57300000${String(n).padStart(4, '0')}` },
  });
  const user = await prisma.user.create({
    data: {
      name: `Admin ${label} ${n}`,
      email: `admin-${n}-${randomUUID().slice(0, 6)}@test.local`,
      password: 'no-se-usa-en-tests',
      role: 'admin',
      storeId: store.storeId,
    },
  });
  return {
    storeId: store.storeId,
    admin: { userId: user.userId, email: user.email, role: user.role, storeId: store.storeId },
  };
}

export async function createCustomer(
  storeId: string,
  name = 'Cliente',
  opts: { phone?: string; lastInboundAt?: Date | null; acceptsMarketing?: boolean } = {},
) {
  const n = next();
  return testPrisma().customer.create({
    data: {
      storeId,
      phone: opts.phone ?? `57310000${String(n).padStart(4, '0')}`,
      name,
      lastInboundAt: opts.lastInboundAt ?? null,
      acceptsMarketing: opts.acceptsMarketing ?? true,
    },
  });
}

export async function createConversation(storeId: string, customerId: string, status = 'active') {
  return testPrisma().conversation.create({ data: { storeId, customerId, status } });
}

/** Cita mínima. Por defecto mañana a las 15:00 UTC, PENDING. */
export async function createAppointment(
  storeId: string,
  customerId: string,
  over: Partial<Prisma.AppointmentUncheckedCreateInput> = {},
) {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  tomorrow.setUTCHours(15, 0, 0, 0);
  return testPrisma().appointment.create({
    data: { storeId, customerId, scheduledAt: tomorrow, ...over },
  });
}

export async function createProduct(storeId: string, opts: { name?: string; price?: number; stock?: number } = {}) {
  return testPrisma().product.create({
    data: {
      storeId,
      name: opts.name ?? `Producto ${next()}`,
      salePrice: opts.price ?? 10000,
      stock: opts.stock ?? 10,
    },
  });
}

export async function createProductWithVariants(
  storeId: string,
  variants: { name: string; stock: number; price?: number }[],
) {
  const prisma = testPrisma();
  const product = await prisma.product.create({
    data: { storeId, name: `Producto con variantes ${next()}`, salePrice: 10000, stock: 0, hasVariants: true },
  });
  const created: Awaited<ReturnType<typeof prisma.productVariant.create>>[] = [];
  for (const [i, v] of variants.entries()) {
    created.push(await prisma.productVariant.create({
      data: { productId: product.productId, name: v.name, stock: v.stock, salePrice: v.price ?? 10000, sortOrder: i },
    }));
  }
  return { product, variants: created };
}
