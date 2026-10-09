import net from 'node:net';
import { installNetworkGuard } from './network';

function tryConnect(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.once('connect', () => { s.destroy(); resolve('connected'); });
    s.once('error', (e) => resolve(e.message));
  });
}

describe('installNetworkGuard', () => {
  beforeAll(() => installNetworkGuard());

  it('bloquea un host externo', async () => {
    await expect(tryConnect('api.groq.com', 443)).resolves.toMatch(/net-guard/);
  });

  it('bloquea una IP externa', async () => {
    await expect(tryConnect('167.114.209.204', 2229)).resolves.toMatch(/net-guard/);
  });

  it('deja pasar localhost (puede no haber nadie escuchando, pero no es el candado)', async () => {
    const msg = await tryConnect('127.0.0.1', 1);
    expect(msg).not.toMatch(/net-guard/);
  });

  it('instalarlo dos veces no lo duplica', async () => {
    installNetworkGuard();
    await expect(tryConnect('graph.facebook.com', 443)).resolves.toMatch(/net-guard/);
  });
});
