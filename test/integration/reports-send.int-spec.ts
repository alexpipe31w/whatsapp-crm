import request from 'supertest';
import { createTestApp, TestApp } from '../support/app';
import { bearer } from '../support/auth';
import { closeTestPrisma, resetDb, testPrisma } from '../support/db';
import {
  createAppointment,
  createCustomer,
  createStoreWithAdmin,
} from '../support/factories';
import { waitFor } from '../support/wait-for';
import { ReportsService } from '../../src/reports/reports.service';

/** Fecha de hoy en Bogotá (UTC-5), como la calculan los reportes. */
function bogotaToday(): { date: string; noonUtc: Date } {
  const local = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const date = local.toISOString().slice(0, 10);
  return { date, noonUtc: new Date(`${date}T17:00:00.000Z`) }; // 12:00 en Bogotá
}

describe('reportes al dueño por la cola (BD real)', () => {
  let t: TestApp;
  let reports: ReportsService;
  const prisma = () => testPrisma();

  beforeAll(async () => {
    t = await createTestApp();
    reports = t.app.get(ReportsService);
  });
  afterAll(async () => {
    await t.close();
    await closeTestPrisma();
  });
  beforeEach(async () => {
    await resetDb();
    t.wa.reset();
  });

  async function storeWithOwnerPhone() {
    const store = await createStoreWithAdmin();
    await prisma().store.update({
      where: { storeId: store.storeId },
      data: {
        adminPhone: '573009990000',
        subscriptionStatus: 'active',
        isActive: true,
      },
    });
    return store;
  }

  it('el reporte diario sale una vez por día aunque el cron corra dos veces', async () => {
    const { storeId } = await storeWithOwnerPhone();
    await reports.generateAndSendReport(storeId);
    await reports.generateAndSendReport(storeId);
    const rows = await prisma().waOutbound.findMany();
    expect(rows.map((r) => r.idempotencyKey)).toEqual([
      `report:${storeId}:${bogotaToday().date}`,
    ]);
    expect(rows[0]).toMatchObject({
      kind: 'notification',
      toJid: '573009990000@s.whatsapp.net',
    });
  });

  it('cada "generar reporte" manual es una petición distinta', async () => {
    const { storeId, admin } = await storeWithOwnerPhone();
    const http = () => request(t.app.getHttpServer());
    await http().post('/api/reports/generate').set(bearer(admin)).expect(202);
    await http().post('/api/reports/generate').set(bearer(admin)).expect(202);
    const rows = await waitFor(async () => {
      const r = await prisma().waOutbound.findMany();
      return r.length === 2 ? r : null;
    });
    for (const r of rows)
      expect(r.idempotencyKey).toMatch(
        new RegExp(`^report:${storeId}:manual:`),
      );
  });

  it('el resumen matutino sale una vez por día', async () => {
    const { storeId } = await storeWithOwnerPhone();
    const customer = await createCustomer(storeId);
    await createAppointment(storeId, customer.customerId, {
      scheduledAt: bogotaToday().noonUtc,
    });
    await reports.runMorningBriefings();
    await reports.runMorningBriefings();
    const rows = await prisma().waOutbound.findMany();
    expect(rows.map((r) => r.idempotencyKey)).toEqual([
      `briefing:${storeId}:${bogotaToday().date}`,
    ]);
  });
});
