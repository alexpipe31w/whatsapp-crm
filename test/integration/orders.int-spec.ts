import request from 'supertest';
import { createTestApp, TestApp } from '../support/app';
import { bearer } from '../support/auth';
import { closeTestPrisma, resetDb, testPrisma } from '../support/db';
import { createCustomer, createProduct, createProductWithVariants, createStoreWithAdmin } from '../support/factories';

describe('pedidos (BD real)', () => {
  let t: TestApp;

  beforeAll(async () => { t = await createTestApp(); });
  afterAll(async () => { await t.close(); await closeTestPrisma(); });
  beforeEach(async () => { await resetDb(); t.wa.reset(); });

  it('la tienda B no puede leer un pedido de la tienda A', async () => {
    const a = await createStoreWithAdmin('A');
    const b = await createStoreWithAdmin('B');
    const customer = await createCustomer(a.storeId);
    const product = await createProduct(a.storeId, { stock: 5 });

    const created = await request(t.app.getHttpServer())
      .post('/api/orders/manual')
      .set(bearer(a.admin))
      .send({ customerId: customer.customerId, items: [{ productId: product.productId, quantity: 1, unitPrice: 10000 }] })
      .expect(201);

    await request(t.app.getHttpServer())
      .get(`/api/orders/${created.body.orderId}`)
      .set(bearer(b.admin))
      .expect(403);
  });

  it('la tienda B no puede cancelar un pedido de la tienda A', async () => {
    const a = await createStoreWithAdmin('A');
    const b = await createStoreWithAdmin('B');
    const customer = await createCustomer(a.storeId);
    const product = await createProduct(a.storeId, { stock: 5 });

    const created = await request(t.app.getHttpServer())
      .post('/api/orders/manual')
      .set(bearer(a.admin))
      .send({ customerId: customer.customerId, items: [{ productId: product.productId, quantity: 2, unitPrice: 10000 }] })
      .expect(201);

    await request(t.app.getHttpServer())
      .patch(`/api/orders/${created.body.orderId}/status`)
      .set(bearer(b.admin))
      .send({ status: 'cancelled' })
      .expect(403);

    const after = await testPrisma().product.findUniqueOrThrow({ where: { productId: product.productId } });
    expect(after.stock).toBe(3);
  });

  it('cancelar devuelve el stock de la variante en la BD', async () => {
    const a = await createStoreWithAdmin('A');
    const customer = await createCustomer(a.storeId);
    const { product, variants } = await createProductWithVariants(a.storeId, [{ name: 'Arazá', stock: 50 }]);

    const created = await request(t.app.getHttpServer())
      .post('/api/orders/manual')
      .set(bearer(a.admin))
      .send({
        customerId: customer.customerId,
        items: [{ productId: product.productId, variantId: variants[0].variantId, quantity: 2, unitPrice: 3500 }],
      })
      .expect(201);

    let v = await testPrisma().productVariant.findUniqueOrThrow({ where: { variantId: variants[0].variantId } });
    expect(v.stock).toBe(48);

    await request(t.app.getHttpServer())
      .patch(`/api/orders/${created.body.orderId}/status`)
      .set(bearer(a.admin))
      .send({ status: 'cancelled' })
      .expect(200);

    v = await testPrisma().productVariant.findUniqueOrThrow({ where: { variantId: variants[0].variantId } });
    expect(v.stock).toBe(50);
  });

  it('dos cancelaciones simultáneas devuelven el stock una sola vez', async () => {
    const a = await createStoreWithAdmin('A');
    const customer = await createCustomer(a.storeId);
    const product = await createProduct(a.storeId, { stock: 10 });

    const created = await request(t.app.getHttpServer())
      .post('/api/orders/manual')
      .set(bearer(a.admin))
      .send({ customerId: customer.customerId, items: [{ productId: product.productId, quantity: 3, unitPrice: 10000 }] })
      .expect(201);

    const cancel = () => request(t.app.getHttpServer())
      .patch(`/api/orders/${created.body.orderId}/status`)
      .set(bearer(a.admin))
      .send({ status: 'cancelled' });

    const [r1, r2] = await Promise.all([cancel(), cancel()]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);

    const after = await testPrisma().product.findUniqueOrThrow({ where: { productId: product.productId } });
    expect(after.stock).toBe(10);
  });

  it('ningún test sale por WhatsApp de verdad', () => {
    expect(t.wa.sent).toEqual([]);
  });
});
