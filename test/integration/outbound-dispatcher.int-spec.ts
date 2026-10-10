import { createTestApp, TestApp } from '../support/app';
import { closeTestPrisma, resetDb, testPrisma } from '../support/db';
import {
  createConversation,
  createCustomer,
  createStoreWithAdmin,
} from '../support/factories';
import {
  EnqueueInput,
  OutboundService,
} from '../../src/outbound/outbound.service';
import { OUTBOUND_CONFIG } from '../../src/outbound/outbound.module';
import { loadOutboundConfig } from '../../src/outbound/outbound-config';
import { OutboundDispatcher } from '../../src/whatsapp/outbound-dispatcher';

const boom = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { output: { statusCode } });

describe('OutboundDispatcher (BD real)', () => {
  let t: TestApp;
  let outbound: OutboundService;
  let dispatcher: OutboundDispatcher;
  const prisma = () => testPrisma();

  beforeAll(async () => {
    const cfg = {
      ...loadOutboundConfig({ WA_OUTBOUND_DISPATCHER: 'off' }),
      retryBaseMs: 60_000,
      retryMaxMs: 60_000,
      campaignGapMinMs: 60_000,
      campaignGapMaxMs: 60_000,
    };
    t = await createTestApp({ overrides: [[OUTBOUND_CONFIG, cfg]] });
    outbound = t.app.get(OutboundService);
    dispatcher = t.app.get(OutboundDispatcher);
  });
  afterAll(async () => {
    await t.close();
    await closeTestPrisma();
  });
  beforeEach(async () => {
    await resetDb();
    t.wa.reset();
    jest.restoreAllMocks();
  });

  const input = (
    storeId: string,
    key: string,
    over: Partial<EnqueueInput> = {},
  ): EnqueueInput => ({
    storeId,
    to: '573001112233',
    text: `texto ${key}`,
    kind: 'reply',
    key,
    ...over,
  });
  /** Deja listas ya las pendientes (los reintentos ponen not_before en el futuro). */
  const dueNow = () =>
    prisma()
      .$executeRaw`UPDATE wa_outbound SET not_before = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE status = 'pending'`;
  const row = (key: string) =>
    prisma().waOutbound.findUniqueOrThrow({ where: { idempotencyKey: key } });

  it('envía, guarda el id de WhatsApp y marca sent', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'k1'));
    await dispatcher.tick();
    expect(t.wa.sent).toEqual([
      { storeId, jid: '573001112233@s.whatsapp.net', message: 'texto k1' },
    ]);
    const r = await row('k1');
    expect(r).toMatchObject({
      status: 'sent',
      attempts: 0,
      providerMessageIds: ['FAKE-1'],
      claimToken: null,
    });
    expect(r.sentAt).not.toBeNull();
  });

  it('otra pasada no reenvía lo ya enviado', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'k1'));
    await dispatcher.tick();
    await dispatcher.tick();
    expect(t.wa.sent).toHaveLength(1);
  });

  it('un mensaje largo sale en trozos y un fallo a mitad reanuda en el trozo siguiente', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'largo', { text: 'a'.repeat(5000) }));
    t.wa.failNext(null, boom('Timed Out', 408)); // 1.er trozo pasa, el 2.º falla
    await dispatcher.tick();
    expect(await row('largo')).toMatchObject({
      status: 'pending',
      attempts: 1,
      providerMessageIds: ['FAKE-1'],
    });
    await dueNow();
    await dispatcher.tick();
    expect(t.wa.sent.map((s) => s.message.length)).toEqual([4096, 904]);
    expect(await row('largo')).toMatchObject({
      status: 'sent',
      providerMessageIds: ['FAKE-1', 'FAKE-2'],
    });
  });

  it('error permanente: failed al primero, sin reintentar', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'k1'));
    t.wa.failNext(boom('bad-request', 400));
    await dispatcher.tick();
    const r = await row('k1');
    expect(r).toMatchObject({ status: 'failed', attempts: 1 });
    expect(r.lastError).toContain('bad-request');
  });

  it('error temporal: reintenta hasta el tope y queda failed', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'k1'));
    for (let i = 0; i < 6; i++)
      t.wa.failNext(boom('Internal Server Error', 500));
    for (let i = 0; i < 6; i++) {
      await dueNow();
      await dispatcher.tick();
    }
    expect(await row('k1')).toMatchObject({ status: 'failed', attempts: 6 });
    expect(t.wa.sent).toHaveLength(0);
  });

  it('desconectado: no gasta intentos, aplaza toda la tienda y sale al volver', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'k1'));
    await outbound.enqueue(input(storeId, 'k2', { to: '573009998877' }));
    t.wa.disconnect(storeId);
    await dispatcher.tick();
    const rows = await prisma().waOutbound.findMany();
    expect(rows.every((r) => r.status === 'pending' && r.attempts === 0)).toBe(
      true,
    );
    expect(rows.every((r) => r.notBefore.getTime() > Date.now() + 10_000)).toBe(
      true,
    );
    t.wa.reconnect(storeId);
    await dueNow();
    await dispatcher.tick();
    expect(t.wa.sent).toHaveLength(2);
  });

  it('caducada: pasa a skipped sin enviarse', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(
      input(storeId, 'k1', {
        notBefore: new Date(Date.now() - 2000),
        expiresAt: new Date(Date.now() - 1000),
      }),
    );
    await dispatcher.tick();
    expect(await row('k1')).toMatchObject({
      status: 'skipped',
      lastError: 'caducado',
    });
    expect(t.wa.sent).toHaveLength(0);
  });

  it('huérfana (arriendo vencido): vuelve a pending gastando un intento y luego sale', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'k1'));
    await prisma()
      .$executeRaw`UPDATE wa_outbound SET status = 'sending', claim_token = 'muerto', locked_until = (now() AT TIME ZONE 'UTC') - interval '1 minute'`;
    await dispatcher.tick();
    expect(await row('k1')).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('respuestas antes que campañas en la misma tienda', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(
      input(storeId, 'camp', { kind: 'campaign', to: '573001110000' }),
    );
    await outbound.enqueue(input(storeId, 'resp'));
    await dispatcher.tick();
    expect(t.wa.sent[0].message).toBe('texto resp');
  });

  it('hueco de campaña: tras un envío de campaña, el resto de la campaña espera', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueueMany([
      input(storeId, 'c1', { kind: 'campaign', to: '573001110001' }),
      input(storeId, 'c2', { kind: 'campaign', to: '573001110002' }),
    ]);
    await outbound.enqueue(input(storeId, 'resp'));
    await dispatcher.tick();
    expect(t.wa.sent.map((s) => s.message).sort()).toEqual([
      'texto c1',
      'texto resp',
    ]);
    const c2 = await row('c2');
    expect(c2.status).toBe('pending');
    expect(c2.notBefore.getTime()).toBeGreaterThan(Date.now() + 50_000);
  });

  it('orden por destinatario: si una anterior al mismo número falló y espera, la nueva no se adelanta', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'turno1'));
    t.wa.failNext(boom('Timed Out', 408));
    await dispatcher.tick(); // turno1 → pending, attempts=1, not_before futuro
    await outbound.enqueue(input(storeId, 'turno2'));
    await dispatcher.tick();
    expect(t.wa.sent).toHaveLength(0);
    await dueNow();
    await dispatcher.tick();
    expect(t.wa.sent.map((s) => s.message)).toEqual([
      'texto turno1',
      'texto turno2',
    ]);
  });

  it('carrera: si otro proceso ya envía para la tienda, reclamar devuelve null sin lanzar', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'a'));
    await outbound.enqueue(input(storeId, 'b', { to: '573009998877' }));
    await prisma().waOutbound.update({
      where: { idempotencyKey: 'a' },
      data: {
        status: 'sending',
        claimToken: 'otro',
        lockedUntil: new Date(Date.now() + 60_000),
      },
    });
    const b = await row('b');
    const internals = dispatcher as unknown as {
      claim: (id: string) => Promise<unknown>;
    };
    await expect(internals.claim(b.id)).resolves.toBeNull();
    expect((await row('b')).status).toBe('pending');
  });

  it('dos tiendas se atienden en la misma pasada', async () => {
    const a = await createStoreWithAdmin('A');
    const b = await createStoreWithAdmin('B');
    await outbound.enqueue(input(a.storeId, 'ka'));
    await outbound.enqueue(input(b.storeId, 'kb'));
    await dispatcher.tick();
    expect(t.wa.sent).toHaveLength(2);
  });

  it('ticks a la vez no envían dos veces la misma fila', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'k1'));
    await Promise.all([
      dispatcher.tick(),
      dispatcher.tick(),
      dispatcher.tick(),
    ]);
    expect(t.wa.sent).toHaveLength(1);
  });

  it('record: al enviarse guarda el texto en messages de la conversación', async () => {
    const { storeId } = await createStoreWithAdmin();
    const customer = await createCustomer(storeId);
    const conv = await createConversation(storeId, customer.customerId);
    await outbound.enqueue(
      input(storeId, 'k1', { record: { conversationId: conv.conversationId } }),
    );
    await dispatcher.tick();
    const msgs = await prisma().message.findMany({
      where: { conversationId: conv.conversationId },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      content: 'texto k1',
      sender: 'store',
      isAiResponse: true,
    });
  });

  it('record con la conversación ya purgada: el envío queda sent igual', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(
      input(storeId, 'k1', {
        record: { conversationId: '00000000-0000-4000-8000-000000000000' },
      }),
    );
    await dispatcher.tick();
    expect(await row('k1')).toMatchObject({ status: 'sent' });
  });
});
