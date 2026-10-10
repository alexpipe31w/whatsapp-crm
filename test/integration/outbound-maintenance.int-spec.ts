import { createTestApp, TestApp } from '../support/app';
import { closeTestPrisma, resetDb, testPrisma } from '../support/db';
import { createStoreWithAdmin } from '../support/factories';
import {
  EnqueueInput,
  OutboundService,
} from '../../src/outbound/outbound.service';
import { OutboundMaintenanceService } from '../../src/outbound/outbound-maintenance.service';

describe('mantenimiento de la cola (BD real)', () => {
  let t: TestApp;
  let outbound: OutboundService;
  let maintenance: OutboundMaintenanceService;
  const prisma = () => testPrisma();

  beforeAll(async () => {
    t = await createTestApp();
    outbound = t.app.get(OutboundService);
    maintenance = t.app.get(OutboundMaintenanceService);
  });
  afterAll(async () => {
    await t.close();
    await closeTestPrisma();
  });
  beforeEach(async () => {
    await resetDb();
  });

  const input = (
    storeId: string,
    key: string,
    over: Partial<EnqueueInput> = {},
  ): EnqueueInput => ({
    storeId,
    to: '573001112233',
    text: 't',
    kind: 'campaign',
    key,
    ...over,
  });
  const setStatus = (key: string, status: string) =>
    prisma().waOutbound.update({
      where: { idempotencyKey: key },
      data: { status },
    });

  it('cierra la campaña cuando no le quedan pendientes, con sent_count = enviadas', async () => {
    const { storeId } = await createStoreWithAdmin();
    const c = await prisma().campaign.create({
      data: { storeId, name: 'x', message: 'y', status: 'sending' },
    });
    const group = `campaign:${c.campaignId}`;
    for (const k of ['a', 'b', 'c', 'd'])
      await outbound.enqueue(input(storeId, k, { groupKey: group }));
    await setStatus('a', 'sent');
    await setStatus('b', 'sent');
    await setStatus('c', 'failed');

    await maintenance.closeFinishedCampaigns();
    expect(
      (
        await prisma().campaign.findUniqueOrThrow({
          where: { campaignId: c.campaignId },
        })
      ).status,
    ).toBe('sending');

    await setStatus('d', 'skipped');
    await maintenance.closeFinishedCampaigns();
    await maintenance.closeFinishedCampaigns();
    expect(
      await prisma().campaign.findUniqueOrThrow({
        where: { campaignId: c.campaignId },
      }),
    ).toMatchObject({
      status: 'sent',
      sentCount: 2,
    });
  });

  it('purga lo cerrado y viejo, nunca lo pendiente ni lo reciente', async () => {
    const { storeId } = await createStoreWithAdmin();
    for (const k of ['viejo-sent', 'viejo-pending', 'nuevo-sent'])
      await outbound.enqueue(input(storeId, k));
    await setStatus('viejo-sent', 'sent');
    await setStatus('nuevo-sent', 'sent');
    await prisma().$executeRaw`
      UPDATE wa_outbound SET updated_at = (now() AT TIME ZONE 'UTC') - interval '31 days'
      WHERE idempotency_key IN ('viejo-sent', 'viejo-pending')`;
    await prisma().waInbound.createMany({
      data: [
        {
          storeId,
          providerMessageId: 'viejo',
          createdAt: new Date(Date.now() - 8 * 24 * 3600_000),
        },
        { storeId, providerMessageId: 'nuevo' },
      ],
    });

    const r = await maintenance.purge();
    expect(r).toEqual({ skipped: false, outbound: 1, inbound: 1 });
    expect(
      (await prisma().waOutbound.findMany())
        .map((x) => x.idempotencyKey)
        .sort(),
    ).toEqual(['nuevo-sent', 'viejo-pending']);
    expect(
      (await prisma().waInbound.findMany()).map((x) => x.providerMessageId),
    ).toEqual(['nuevo']);
  });

  it('si otro proceso tiene el candado de la purga, esta se salta sin fallar', async () => {
    // Otra conexión (la del test) retiene el candado mientras la app intenta purgar.
    await prisma().$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('wa-outbound-purge'))`;
      await expect(maintenance.purge()).resolves.toEqual({
        skipped: true,
        outbound: 0,
        inbound: 0,
      });
    });
    await expect(maintenance.purge()).resolves.toMatchObject({
      skipped: false,
    });
  });
});
