import { signSyncRequest, verifySyncRequest } from './sync-signing';

describe('sync-signing', () => {
  const secret = 'a'.repeat(64);
  const body = JSON.stringify({ eventId: 'e1', type: 'stock.changed', payload: { stock: 5 } });

  it('firma y verifica ida y vuelta', () => {
    const { timestamp, signature } = signSyncRequest(secret, body);
    expect(verifySyncRequest(secret, body, timestamp, signature)).toBe(true);
  });

  it('rechaza firma alterada', () => {
    const { timestamp, signature } = signSyncRequest(secret, body);
    expect(verifySyncRequest(secret, body + 'x', timestamp, signature)).toBe(false);
    const flipped = (signature[0] === '0' ? '1' : '0') + signature.slice(1);
    expect(verifySyncRequest(secret, body, timestamp, flipped)).toBe(false);
  });

  it('rechaza timestamp fuera de la ventana de 5 min', () => {
    const old = String(Date.now() - 6 * 60 * 1000);
    const sig = signSyncRequest(secret, body, old).signature;
    expect(verifySyncRequest(secret, body, old, sig)).toBe(false);
  });

  it('rechaza secret distinto', () => {
    const { timestamp, signature } = signSyncRequest(secret, body);
    expect(verifySyncRequest('b'.repeat(64), body, timestamp, signature)).toBe(false);
  });
});
