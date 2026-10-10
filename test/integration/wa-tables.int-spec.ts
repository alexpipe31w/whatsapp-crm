import { closeTestPrisma, resetDb, testPrisma } from '../support/db';
import { createCustomer, createStoreWithAdmin } from '../support/factories';

describe('tablas de la cola de WhatsApp (migración 1a)', () => {
  afterAll(async () => {
    await closeTestPrisma();
  });
  beforeEach(async () => {
    await resetDb();
  });

  const row = (storeId: string, key: string) => ({
    storeId,
    toJid: '573001112233@s.whatsapp.net',
    payload: { text: 'hola' },
    kind: 'reply',
    priority: 0,
    idempotencyKey: key,
    notBefore: new Date(),
  });

  it('idempotency_key es única', async () => {
    const { storeId } = await createStoreWithAdmin();
    await testPrisma().waOutbound.create({ data: row(storeId, 'k1') });
    await expect(
      testPrisma().waOutbound.create({ data: row(storeId, 'k1') }),
    ).rejects.toThrow();
  });

  it('solo una fila en sending por tienda (índice único parcial)', async () => {
    const { storeId } = await createStoreWithAdmin();
    const a = await testPrisma().waOutbound.create({
      data: row(storeId, 'k1'),
    });
    const b = await testPrisma().waOutbound.create({
      data: row(storeId, 'k2'),
    });
    await testPrisma().waOutbound.update({
      where: { id: a.id },
      data: { status: 'sending' },
    });
    await expect(
      testPrisma().waOutbound.update({
        where: { id: b.id },
        data: { status: 'sending' },
      }),
    ).rejects.toThrow();
  });

  it('otra tienda sí puede tener su propio envío en curso', async () => {
    const a = await createStoreWithAdmin('A');
    const b = await createStoreWithAdmin('B');
    const ra = await testPrisma().waOutbound.create({
      data: row(a.storeId, 'ka'),
    });
    const rb = await testPrisma().waOutbound.create({
      data: row(b.storeId, 'kb'),
    });
    await testPrisma().waOutbound.update({
      where: { id: ra.id },
      data: { status: 'sending' },
    });
    await expect(
      testPrisma().waOutbound.update({
        where: { id: rb.id },
        data: { status: 'sending' },
      }),
    ).resolves.toBeTruthy();
  });

  it('valores por defecto de una fila nueva', async () => {
    const { storeId } = await createStoreWithAdmin();
    const r = await testPrisma().waOutbound.create({
      data: row(storeId, 'k1'),
    });
    expect(r).toMatchObject({
      status: 'pending',
      attempts: 0,
      providerMessageIds: [],
      claimToken: null,
      sentAt: null,
    });
  });

  it('wa_inbound deduplica por tienda e id de WhatsApp', async () => {
    const a = await createStoreWithAdmin('A');
    const b = await createStoreWithAdmin('B');
    const ins = (storeId: string) =>
      testPrisma().waInbound.createMany({
        data: [{ storeId, providerMessageId: 'WA1' }],
        skipDuplicates: true,
      });
    expect((await ins(a.storeId)).count).toBe(1);
    expect((await ins(a.storeId)).count).toBe(0);
    expect((await ins(b.storeId)).count).toBe(1);
  });

  it('customers.last_inbound_at existe y empieza vacío', async () => {
    const { storeId } = await createStoreWithAdmin();
    const c = await createCustomer(storeId);
    expect(c.lastInboundAt).toBeNull();
  });
});
