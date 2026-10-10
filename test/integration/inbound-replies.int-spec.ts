import { createTestApp, TestApp } from '../support/app';
import { closeTestPrisma, resetDb, testPrisma } from '../support/db';
import { createStoreWithAdmin } from '../support/factories';
import { sleep, waitFor } from '../support/wait-for';
import { WhatsappService } from '../../src/whatsapp/whatsapp.service';
import { AiService } from '../../src/ai/ai.service';

const CLIENT = '573001112233';
export const textMsg = (id: string, text: string) => ({
  key: { id, remoteJid: `${CLIENT}@s.whatsapp.net`, fromMe: false },
  message: { conversation: text },
  pushName: 'Ana',
});

describe('respuestas a lo entrante por la cola (BD real)', () => {
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

  const outboundRows = () =>
    testPrisma().waOutbound.findMany({ orderBy: { createdAt: 'asc' } });
  const someRows = () =>
    waitFor(async () => {
      const r = await outboundRows();
      return r.length ? r : null;
    });

  it('la respuesta de la IA se encola con la clave del último mensaje del lote', async () => {
    const { storeId } = await createStoreWithAdmin();
    const spy = jest.spyOn(ai, 'generateReply').mockResolvedValue('¡Hola Ana!');
    await receive(textMsg('WA-1', 'hola'), storeId);
    await receive(textMsg('WA-2', 'precio?'), storeId);
    const rows = await someRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'reply',
      idempotencyKey: `reply:${storeId}:WA-2`,
      payload: { text: '¡Hola Ana!' },
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('aviso de asesor: UNA fila (antes salía dos veces) y se guarda una vez', async () => {
    const { storeId } = await createStoreWithAdmin();
    await receive(textMsg('WA-9', 'quiero hablar con un asesor'), storeId);
    const rows = await someRows();
    await sleep(300);
    expect(await outboundRows()).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBe(`handoff:${storeId}:WA-9`);
    expect(
      await testPrisma().message.count({ where: { storeId, sender: 'store' } }),
    ).toBe(1);
  });

  it('acuse de imagen por la cola', async () => {
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
    const rows = await outboundRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBe(`media-ack:${storeId}:WA-IMG`);
  });

  it('un sticker no responde, no cambia la conversación ni registra error', async () => {
    const { storeId } = await createStoreWithAdmin();
    await receive(
      {
        key: {
          id: 'WA-ST',
          remoteJid: `${CLIENT}@s.whatsapp.net`,
          fromMe: false,
        },
        message: { stickerMessage: {} },
      },
      storeId,
    );
    expect(await outboundRows()).toHaveLength(0);
    expect(
      await testPrisma().conversation.count({
        where: { storeId, status: 'pending_human' },
      }),
    ).toBe(0);
  });

  it('IA que decide no responder ([IGNORAR] → null): no se encola nada', async () => {
    const { storeId } = await createStoreWithAdmin();
    const spy = jest.spyOn(ai, 'generateReply').mockResolvedValue(null);
    await receive(textMsg('WA-3', 'ok'), storeId);
    await waitFor(() => spy.mock.calls.length > 0);
    await sleep(200);
    expect(await outboundRows()).toHaveLength(0);
  });
});
