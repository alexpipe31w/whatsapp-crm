import { createTestApp, TestApp } from '../support/app';
import { closeTestPrisma, resetDb, testPrisma } from '../support/db';
import { createStoreWithAdmin } from '../support/factories';
import {
  EnqueueInput,
  OutboundService,
} from '../../src/outbound/outbound.service';

describe('OutboundService (BD real)', () => {
  let t: TestApp;
  let outbound: OutboundService;

  beforeAll(async () => {
    t = await createTestApp();
    outbound = t.app.get(OutboundService);
  });
  afterAll(async () => {
    await t.close();
    await closeTestPrisma();
  });
  beforeEach(async () => {
    await resetDb();
    t.wa.reset();
  });

  const input = (
    storeId: string,
    over: Partial<EnqueueInput> = {},
  ): EnqueueInput => ({
    storeId,
    to: '+57 300 111 2233',
    text: 'Hola',
    kind: 'reply',
    key: `test:${storeId}:1`,
    ...over,
  });

  it('dos encolados con la misma clave dejan una sola fila', async () => {
    const { storeId } = await createStoreWithAdmin();
    expect(await outbound.enqueue(input(storeId))).toBe('queued');
    expect(await outbound.enqueue(input(storeId))).toBe('duplicate');
    expect(await testPrisma().waOutbound.count()).toBe(1);
  });

  it('dos encolados simultáneos con la misma clave dejan una sola fila', async () => {
    const { storeId } = await createStoreWithAdmin();
    const results = await Promise.all([
      outbound.enqueue(input(storeId)),
      outbound.enqueue(input(storeId)),
    ]);
    expect(results.sort()).toEqual(['duplicate', 'queued']);
    expect(await testPrisma().waOutbound.count()).toBe(1);
  });

  it('si la transacción de negocio se revierte, no queda fila', async () => {
    const { storeId } = await createStoreWithAdmin();
    await expect(
      testPrisma().$transaction(async (tx) => {
        await outbound.enqueue(input(storeId), tx);
        throw new Error('fallo de negocio');
      }),
    ).rejects.toThrow('fallo de negocio');
    expect(await testPrisma().waOutbound.count()).toBe(0);
  });

  it('resuelve el destino a jid y fija prioridad, estado y caducidad por tipo', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId));
    await outbound.enqueue(
      input(storeId, { to: 'lid:123456789', key: 'k-lid' }),
    );
    await outbound.enqueue(input(storeId, { kind: 'campaign', key: 'k-camp' }));

    const reply = await testPrisma().waOutbound.findUniqueOrThrow({
      where: { idempotencyKey: `test:${storeId}:1` },
    });
    expect(reply).toMatchObject({
      toJid: '573001112233@s.whatsapp.net',
      kind: 'reply',
      priority: 0,
      status: 'pending',
      attempts: 0,
      payload: { text: 'Hola' },
    });
    expect(reply.expiresAt!.getTime() - reply.notBefore.getTime()).toBe(
      6 * 60 * 60 * 1000,
    );

    const lid = await testPrisma().waOutbound.findUniqueOrThrow({
      where: { idempotencyKey: 'k-lid' },
    });
    expect(lid.toJid).toBe('123456789@lid');

    const camp = await testPrisma().waOutbound.findUniqueOrThrow({
      where: { idempotencyKey: 'k-camp' },
    });
    expect(camp.priority).toBe(20);
  });

  it('respeta not_before, expires_at, grupo y record', async () => {
    const { storeId } = await createStoreWithAdmin();
    const notBefore = new Date(Date.now() + 5 * 60_000);
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    await outbound.enqueue(
      input(storeId, {
        notBefore,
        expiresAt,
        groupKey: 'g1',
        record: { conversationId: 'c1' },
      }),
    );
    const r = await testPrisma().waOutbound.findFirstOrThrow();
    expect(r.notBefore.getTime()).toBe(notBefore.getTime());
    expect(r.expiresAt!.getTime()).toBe(expiresAt.getTime());
    expect(r.groupKey).toBe('g1');
    expect(r.payload).toEqual({
      text: 'Hola',
      record: { conversationId: 'c1' },
    });
  });

  it('no encola texto vacío ni destinatarios sin número', async () => {
    const { storeId } = await createStoreWithAdmin();
    expect(await outbound.enqueue(input(storeId, { text: '   ' }))).toBe(
      'invalid',
    );
    expect(
      await outbound.enqueue(input(storeId, { to: 'venta-rapida', key: 'k2' })),
    ).toBe('invalid');
    expect(await testPrisma().waOutbound.count()).toBe(0);
  });

  it('rechaza una clave de más de 200 caracteres', async () => {
    const { storeId } = await createStoreWithAdmin();
    await expect(
      outbound.enqueue(input(storeId, { key: 'x'.repeat(201) })),
    ).rejects.toThrow(/200/);
  });

  it('enqueueMany inserta en bloque e ignora las claves repetidas', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, { key: 'k1' }));
    const n = await outbound.enqueueMany([
      input(storeId, { key: 'k1' }),
      input(storeId, { key: 'k2' }),
      input(storeId, { key: 'k3' }),
    ]);
    expect(n).toBe(2);
    expect(await testPrisma().waOutbound.count()).toBe(3);
  });

  it('cancelGroup marca como skipped solo las pendientes de ese grupo', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, { key: 'a', groupKey: 'g1' }));
    await outbound.enqueue(input(storeId, { key: 'b', groupKey: 'g1' }));
    await outbound.enqueue(input(storeId, { key: 'c', groupKey: 'g2' }));
    await testPrisma().waOutbound.update({
      where: { idempotencyKey: 'b' },
      data: { status: 'sent' },
    });

    expect(await outbound.cancelGroup('g1', 'prueba')).toBe(1);
    const rows = await testPrisma().waOutbound.findMany({
      orderBy: { idempotencyKey: 'asc' },
    });
    expect(rows.map((r) => [r.idempotencyKey, r.status])).toEqual([
      ['a', 'skipped'],
      ['b', 'sent'],
      ['c', 'pending'],
    ]);
    expect(rows[0].lastError).toBe('prueba');
  });
  it('cancelGroupsByPrefix cancela las pendientes de todos los grupos con ese prefijo', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(
      input(storeId, { key: 'n1', groupKey: 'confirm-nudge:a' }),
    );
    await outbound.enqueue(
      input(storeId, { key: 'n2', groupKey: 'confirm-nudge:b' }),
    );
    await outbound.enqueue(
      input(storeId, { key: 'c1', groupKey: 'campaign:c' }),
    );
    expect(
      await outbound.cancelGroupsByPrefix('confirm-nudge:', 'reinicio'),
    ).toBe(2);
    const rows = await testPrisma().waOutbound.findMany({
      orderBy: { idempotencyKey: 'asc' },
    });
    expect(rows.map((r) => [r.idempotencyKey, r.status])).toEqual([
      ['c1', 'pending'],
      ['n1', 'skipped'],
      ['n2', 'skipped'],
    ]);
  });
});
