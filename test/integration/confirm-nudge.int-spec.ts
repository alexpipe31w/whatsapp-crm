import { createTestApp, TestApp } from '../support/app';
import { closeTestPrisma, resetDb, testPrisma } from '../support/db';
import {
  createConversation,
  createCustomer,
  createStoreWithAdmin,
} from '../support/factories';
import { waitFor } from '../support/wait-for';
import { AiService } from '../../src/ai/ai.service';
import { OutboundService } from '../../src/outbound/outbound.service';

/** Los dos métodos son privados: se llaman a través de esta vista tipada. */
interface NudgeInternals {
  scheduleConfirmReminder: (
    conversationId: string,
    storeId: string,
    phone: string,
  ) => void;
  cancelConfirmReminder: (conversationId: string) => void;
}

describe('"¿Confirmamos tu cita?" por la cola (BD real)', () => {
  let t: TestApp;
  let ai: AiService;
  let nudge: NudgeInternals;
  const prisma = () => testPrisma();

  beforeAll(async () => {
    t = await createTestApp();
    ai = t.app.get(AiService);
    nudge = ai as unknown as NudgeInternals;
  });
  afterAll(async () => {
    await t.close();
    await closeTestPrisma();
  });
  beforeEach(async () => {
    await resetDb();
    t.wa.reset();
  });

  async function conversation() {
    const { storeId } = await createStoreWithAdmin();
    const customer = await createCustomer(storeId);
    const conv = await createConversation(storeId, customer.customerId);
    return { storeId, customer, conv };
  }

  it('programarlo encola una fila a +5 min que se guardará en la conversación al salir', async () => {
    const { storeId, customer, conv } = await conversation();
    nudge.scheduleConfirmReminder(conv.conversationId, storeId, customer.phone);
    const [row] = await waitFor(async () => {
      const r = await prisma().waOutbound.findMany();
      return r.length ? r : null;
    });
    expect(row).toMatchObject({
      kind: 'reply',
      groupKey: `confirm-nudge:${conv.conversationId}`,
      status: 'pending',
      payload: {
        text: expect.stringContaining('¿Confirmamos tu cita?') as unknown,
        record: { conversationId: conv.conversationId },
      },
    });
    const wait = row.notBefore.getTime() - Date.now();
    expect(wait).toBeGreaterThan(4 * 60_000);
    expect(wait).toBeLessThan(6 * 60_000);
  });

  it('programarlo dos veces deja un solo pendiente por conversación', async () => {
    const { storeId, customer, conv } = await conversation();
    nudge.scheduleConfirmReminder(conv.conversationId, storeId, customer.phone);
    await waitFor(async () => (await prisma().waOutbound.count()) === 1);
    nudge.scheduleConfirmReminder(conv.conversationId, storeId, customer.phone);
    await waitFor(async () => (await prisma().waOutbound.count()) === 2);
    const statuses = (await prisma().waOutbound.findMany())
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual(['pending', 'skipped']);
  });

  it('cancelarlo lo deja skipped', async () => {
    const { storeId, customer, conv } = await conversation();
    nudge.scheduleConfirmReminder(conv.conversationId, storeId, customer.phone);
    await waitFor(async () => (await prisma().waOutbound.count()) === 1);
    nudge.cancelConfirmReminder(conv.conversationId);
    await waitFor(
      async () =>
        (await prisma().waOutbound.count({ where: { status: 'skipped' } })) ===
        1,
    );
  });

  it('programar y cancelar en el mismo turno (sin esperar) no deja ningún pendiente', async () => {
    const { storeId, customer, conv } = await conversation();
    for (let i = 0; i < 5; i++) {
      nudge.scheduleConfirmReminder(
        conv.conversationId,
        storeId,
        customer.phone,
      );
      nudge.cancelConfirmReminder(conv.conversationId);
    }
    await waitFor(async () => (await prisma().waOutbound.count()) === 5);
    await new Promise((r) => setTimeout(r, 300));
    expect(
      await prisma().waOutbound.count({ where: { status: 'pending' } }),
    ).toBe(0);
  });

  it('al arrancar se cancelan los pendientes (la IA perdió su memoria) y nada más', async () => {
    const { storeId, customer, conv } = await conversation();
    nudge.scheduleConfirmReminder(conv.conversationId, storeId, customer.phone);
    await waitFor(async () => (await prisma().waOutbound.count()) === 1);
    await t.app.get(OutboundService).enqueue({
      storeId,
      to: customer.phone,
      text: 'otra cosa',
      kind: 'reply',
      key: 'otra',
    });
    await ai.onModuleInit();
    const rows = await prisma().waOutbound.findMany({
      orderBy: { idempotencyKey: 'asc' },
    });
    expect(
      rows.find((r) => r.groupKey?.startsWith('confirm-nudge:'))?.status,
    ).toBe('skipped');
    expect(rows.find((r) => r.idempotencyKey === 'otra')?.status).toBe(
      'pending',
    );
  });
});
