import { createTestApp, TestApp } from '../support/app';
import { closeTestPrisma, resetDb, testPrisma } from '../support/db';
import { createStoreWithAdmin } from '../support/factories';
import { sleep, waitFor } from '../support/wait-for';
import { WhatsappService } from '../../src/whatsapp/whatsapp.service';
import { AiService } from '../../src/ai/ai.service';

const CLIENT = '573001112233';
const textMsg = (id: string, text: string) => ({
  key: { id, remoteJid: `${CLIENT}@s.whatsapp.net`, fromMe: false },
  message: { conversation: text },
  pushName: 'Ana',
});

describe('dedupe de entrada y last_inbound_at (BD real)', () => {
  let t: TestApp;
  let wa: WhatsappService;
  let ai: AiService;
  /** processMessage es privado: se llama a través de esta vista tipada. */
  const receive = (msg: unknown, storeId: string) =>
    (
      wa as unknown as {
        processMessage: (m: unknown, s: string, sock: unknown) => Promise<void>;
      }
    ).processMessage(msg, storeId, {});

  beforeAll(async () => {
    t = await createTestApp({ realWhatsappService: true });
    wa = t.app.get(WhatsappService);
    ai = t.app.get(AiService);
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

  it('el mismo id de WhatsApp dos veces (reentrega tras reinicio) se procesa una vez', async () => {
    const { storeId } = await createStoreWithAdmin();
    const spy = jest.spyOn(ai, 'generateReply').mockResolvedValue('respuesta');
    await receive(textMsg('WA-DUP', 'hola'), storeId);
    await receive(textMsg('WA-DUP', 'hola'), storeId);
    await waitFor(async () => (await testPrisma().waOutbound.count()) > 0);
    await sleep(300);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(
      await testPrisma().waInbound.count({
        where: { storeId, providerMessageId: 'WA-DUP' },
      }),
    ).toBe(1);
    // el dedupe en memoria (que se perdía al reiniciar) ya no existe
    expect(
      (wa as unknown as { processedMsgIds?: unknown }).processedMsgIds,
    ).toBeUndefined();
  });

  it('el mismo id en otra tienda sí se procesa', async () => {
    const a = await createStoreWithAdmin('A');
    const b = await createStoreWithAdmin('B');
    jest.spyOn(ai, 'generateReply').mockResolvedValue('r');
    await receive(textMsg('WA-X', 'hola'), a.storeId);
    await receive(textMsg('WA-X', 'hola'), b.storeId);
    await waitFor(async () => (await testPrisma().waOutbound.count()) === 2);
  });

  it('grupos y tipos internos no entran en wa_inbound', async () => {
    const { storeId } = await createStoreWithAdmin();
    await receive(
      {
        key: { id: 'G1', remoteJid: '123@g.us' },
        message: { conversation: 'x' },
      },
      storeId,
    );
    await receive(
      {
        key: { id: 'P1', remoteJid: `${CLIENT}@s.whatsapp.net` },
        message: { protocolMessage: {} },
      },
      storeId,
    );
    expect(await testPrisma().waInbound.count()).toBe(0);
  });

  it('un mensaje del cliente actualiza last_inbound_at', async () => {
    const { storeId } = await createStoreWithAdmin();
    jest.spyOn(ai, 'generateReply').mockResolvedValue('r');
    await receive(textMsg('WA-L', 'hola'), storeId);
    const c = await waitFor(() =>
      testPrisma().customer.findFirst({
        where: { storeId, lastInboundAt: { not: null } },
      }),
    );
    expect(c.lastInboundAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('una imagen también actualiza last_inbound_at', async () => {
    const { storeId } = await createStoreWithAdmin();
    await receive(
      {
        key: {
          id: 'WA-IMG',
          remoteJid: `${CLIENT}@s.whatsapp.net`,
          fromMe: false,
        },
        message: { imageMessage: {} },
      },
      storeId,
    );
    const c = await testPrisma().customer.findFirstOrThrow({
      where: { storeId },
    });
    expect(c.lastInboundAt).not.toBeNull();
  });
});
