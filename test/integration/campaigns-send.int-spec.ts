import request from 'supertest';
import { createTestApp, TestApp } from '../support/app';
import { bearer } from '../support/auth';
import { closeTestPrisma, resetDb, testPrisma } from '../support/db';
import { createCustomer, createStoreWithAdmin } from '../support/factories';

describe('POST /campaigns/:id/send (BD real)', () => {
  let t: TestApp;
  const prisma = () => testPrisma();
  const http = () => request(t.app.getHttpServer());

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

  async function storeWithCampaign() {
    const store = await createStoreWithAdmin();
    await t.wa.connectStore(store.storeId);
    const campaign = await prisma().campaign.create({
      data: { storeId: store.storeId, name: 'Promo', message: '2x1 hoy' },
    });
    return { ...store, campaign };
  }

  it('solo a quien escribió, acepta marketing y no está bloqueado; no envía dentro de la petición', async () => {
    const { storeId, admin, campaign } = await storeWithCampaign();
    const wrote = new Date();
    const a = await createCustomer(storeId, 'A', { lastInboundAt: wrote });
    await createCustomer(storeId, 'B (nunca escribió)');
    await createCustomer(storeId, 'C (no acepta)', {
      lastInboundAt: wrote,
      acceptsMarketing: false,
    });
    await createCustomer(storeId, 'D (bloqueado)', {
      lastInboundAt: wrote,
      phone: '573001234567',
    });
    await prisma().blockedContact.create({
      data: { storeId, phone: '+57 3001234567' },
    });

    const res = await http()
      .post(`/api/campaigns/${campaign.campaignId}/send`)
      .set(bearer(admin))
      .expect(201);
    expect((res.body as { status: string }).status).toBe('sending');
    const rows = await prisma().waOutbound.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      idempotencyKey: `campaign:${campaign.campaignId}:${a.customerId}`,
      groupKey: `campaign:${campaign.campaignId}`,
      kind: 'campaign',
    });
    expect(t.wa.sent).toHaveLength(0); // sale el despachador, no la petición
  });

  it('doble clic: un 201 y un 409, sin filas duplicadas', async () => {
    const { storeId, admin, campaign } = await storeWithCampaign();
    await createCustomer(storeId, 'A', { lastInboundAt: new Date() });
    await createCustomer(storeId, 'B', { lastInboundAt: new Date() });
    const send = () =>
      http()
        .post(`/api/campaigns/${campaign.campaignId}/send`)
        .set(bearer(admin));
    const statuses = (await Promise.all([send(), send()]))
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([201, 409]);
    expect(await prisma().waOutbound.count()).toBe(2);
  });

  it('sin destinatarios: 400 y la campaña sigue en borrador', async () => {
    const { storeId, admin, campaign } = await storeWithCampaign();
    await createCustomer(storeId, 'nunca escribió');
    await http()
      .post(`/api/campaigns/${campaign.campaignId}/send`)
      .set(bearer(admin))
      .expect(400);
    const after = await prisma().campaign.findUniqueOrThrow({
      where: { campaignId: campaign.campaignId },
    });
    expect(after.status).toBe('draft');
    expect(await prisma().waOutbound.count()).toBe(0);
  });

  it('campaña de otra tienda: 403', async () => {
    const { campaign } = await storeWithCampaign();
    const other = await createStoreWithAdmin('otra');
    await t.wa.connectStore(other.storeId);
    await http()
      .post(`/api/campaigns/${campaign.campaignId}/send`)
      .set(bearer(other.admin))
      .expect(403);
    expect(await prisma().waOutbound.count()).toBe(0);
  });
});
