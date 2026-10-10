jest.mock('@whiskeysockets/baileys', () => ({}));

import { WhatsappService } from './whatsapp.service';
import { WaNotConnectedError } from './send-errors';

type Ctor = new (...deps: unknown[]) => WhatsappService;

function build() {
  // Los parámetros del constructor no se usan en sendPart: basta con objetos vacíos.
  const deps = Array.from({ length: WhatsappService.length }, () => ({}));
  const svc = new (WhatsappService as unknown as Ctor)(...deps);
  const sockets = (svc as unknown as { sockets: Map<string, unknown> }).sockets;
  return { svc, sockets };
}

describe('WhatsappService.sendPart', () => {
  it('sin socket lanza WaNotConnectedError', async () => {
    const { svc } = build();
    await expect(
      svc.sendPart('s1', '573001112233@s.whatsapp.net', 'hola'),
    ).rejects.toBeInstanceOf(WaNotConnectedError);
  });

  it('hace UN intento y devuelve el id de WhatsApp', async () => {
    const { svc, sockets } = build();
    const sendMessage = jest.fn().mockResolvedValue({ key: { id: '3EB0XYZ' } });
    sockets.set('s1', { user: { id: 'me' }, sendMessage });
    await expect(svc.sendPart('s1', 'j@s.whatsapp.net', 'hola')).resolves.toBe(
      '3EB0XYZ',
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('j@s.whatsapp.net', {
      text: 'hola',
    });
  });

  it('si falla, propaga el error sin reintentar (los reintentos son del despachador)', async () => {
    const { svc, sockets } = build();
    const sendMessage = jest
      .fn()
      .mockRejectedValue(new Error('not-acceptable'));
    sockets.set('s1', { user: { id: 'me' }, sendMessage });
    await expect(
      svc.sendPart('s1', 'j@s.whatsapp.net', 'hola'),
    ).rejects.toThrow('not-acceptable');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('WhatsApp aceptó pero no devolvió id: no lanza (reintentar duplicaría) y da un id local', async () => {
    const { svc, sockets } = build();
    sockets.set('s1', {
      user: { id: 'me' },
      sendMessage: jest.fn().mockResolvedValue(undefined),
    });
    await expect(
      svc.sendPart('s1', 'j@s.whatsapp.net', 'hola'),
    ).resolves.toMatch(/^sin-id-/);
  });
});
