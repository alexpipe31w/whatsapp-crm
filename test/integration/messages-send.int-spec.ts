import request from 'supertest';
import { createTestApp, TestApp } from '../support/app';
import { bearer } from '../support/auth';
import { closeTestPrisma, resetDb, testPrisma } from '../support/db';
import {
  createConversation,
  createCustomer,
  createStoreWithAdmin,
} from '../support/factories';

describe('POST /messages (asesor)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
    await closeTestPrisma();
  });
  beforeEach(async () => {
    await resetDb();
    t.wa.reset();
  });

  it('guarda el mensaje y encola UNA fila con clave msg:{messageId}', async () => {
    const { storeId, admin } = await createStoreWithAdmin();
    const c = await createCustomer(storeId);
    const conv = await createConversation(storeId, c.customerId, 'human');
    const res = await request(t.app.getHttpServer())
      .post('/api/messages')
      .set(bearer(admin))
      .send({
        conversationId: conv.conversationId,
        content: 'Hola, soy Laura',
        sender: 'store',
      })
      .expect(201);
    const rows = await testPrisma().waOutbound.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      idempotencyKey: `msg:${(res.body as { messageId: string }).messageId}`,
      kind: 'reply',
      storeId,
    });
  });

  it('un mensaje con sender=customer no se envía', async () => {
    const { storeId, admin } = await createStoreWithAdmin();
    const c = await createCustomer(storeId);
    const conv = await createConversation(storeId, c.customerId);
    await request(t.app.getHttpServer())
      .post('/api/messages')
      .set(bearer(admin))
      .send({
        conversationId: conv.conversationId,
        content: 'x',
        sender: 'customer',
      })
      .expect(201);
    expect(await testPrisma().waOutbound.count()).toBe(0);
  });

  it('conversación de otra tienda: 403 y ni mensaje ni fila', async () => {
    const a = await createStoreWithAdmin('A');
    const b = await createStoreWithAdmin('B');
    const c = await createCustomer(b.storeId);
    const conv = await createConversation(b.storeId, c.customerId);
    await request(t.app.getHttpServer())
      .post('/api/messages')
      .set(bearer(a.admin))
      .send({
        conversationId: conv.conversationId,
        content: 'x',
        sender: 'store',
      })
      .expect(403);
    expect(await testPrisma().message.count()).toBe(0);
    expect(await testPrisma().waOutbound.count()).toBe(0);
  });
});
