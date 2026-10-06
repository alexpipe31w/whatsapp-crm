import {
  Cartridge, ensurePool, getNextCartridge, isBrokenCartridgeError, isRateLimitError,
  quarantineCartridge,
} from './key-pool';

const gemini: Cartridge = { provider: 'gemini', apiKey: 'gem-key-1111', model: 'gemini-2.5-flash' };
const groqA:  Cartridge = { provider: 'groq',   apiKey: 'groq-key-aaaa', model: 'openai/gpt-oss-120b' };
const groqB:  Cartridge = { provider: 'groq',   apiKey: 'groq-key-bbbb', model: 'openai/gpt-oss-120b' };

describe('isBrokenCartridgeError', () => {
  it('trata como roto el 404 de modelo inexistente (caso Frutatza: gemini "404 status code (no body)")', () => {
    expect(isBrokenCartridgeError({ status: 404, message: '404 status code (no body)' })).toBe(true);
  });

  it('trata como roto un modelo retirado o una key inválida', () => {
    expect(isBrokenCartridgeError({ status: 400, code: 'model_decommissioned', message: 'x' })).toBe(true);
    expect(isBrokenCartridgeError({ status: 400, message: 'The model `llama3-70b-8192` has been decommissioned' })).toBe(true);
    expect(isBrokenCartridgeError({ message: 'The model `foo` does not exist or you do not have access to it.' })).toBe(true);
    expect(isBrokenCartridgeError({ status: 401, message: 'Invalid API Key' })).toBe(true);
  });

  it('NO trata como roto un 429 ni un error transitorio', () => {
    const rate = { status: 429, message: 'Rate limit reached' };
    expect(isRateLimitError(rate)).toBe(true);
    expect(isBrokenCartridgeError(rate)).toBe(false);
    expect(isBrokenCartridgeError({ status: 403, message: 'quota exceeded' })).toBe(false);
    expect(isBrokenCartridgeError({ status: 500, message: 'Internal error' })).toBe(false);
    expect(isBrokenCartridgeError(new Error('AI timeout'))).toBe(false);
  });
});

describe('quarantineCartridge', () => {
  afterEach(() => jest.useRealTimers());

  const drain = (storeId: string, n: number) =>
    Array.from({ length: n }, () => getNextCartridge(storeId)?.provider);

  it('saca el cartucho roto del turno y lo mantiene fuera tras el reinicio del pool (2 min)', () => {
    jest.useFakeTimers({ now: new Date('2026-10-06T18:00:00Z') });
    const store = 'store-q1';
    ensurePool(store, [gemini, groqA, groqB]);
    quarantineCartridge(store, gemini);
    expect(drain(store, 6)).not.toContain('gemini');

    jest.setSystemTime(new Date('2026-10-06T18:05:00Z')); // pool ya reiniciado
    ensurePool(store, [gemini, groqA, groqB]);
    expect(drain(store, 6)).not.toContain('gemini');
  });

  it('lo devuelve al turno cuando vence la cuarentena (30 min)', () => {
    jest.useFakeTimers({ now: new Date('2026-10-06T18:00:00Z') });
    const store = 'store-q2';
    ensurePool(store, [gemini, groqA]);
    quarantineCartridge(store, gemini);

    jest.setSystemTime(new Date('2026-10-06T18:31:00Z'));
    ensurePool(store, [gemini, groqA]);
    expect(drain(store, 4)).toContain('gemini');
  });

  it('si TODOS están en cuarentena los usa igual (mejor intentar que callar)', () => {
    jest.useFakeTimers({ now: new Date('2026-10-06T18:00:00Z') });
    const store = 'store-q3';
    ensurePool(store, [gemini]);
    quarantineCartridge(store, gemini);

    jest.setSystemTime(new Date('2026-10-06T18:03:00Z'));
    ensurePool(store, [gemini]);
    expect(getNextCartridge(store)?.provider).toBe('gemini');
  });

  it('la cuarentena es por tienda: no afecta la misma key en otra tienda', () => {
    jest.useFakeTimers({ now: new Date('2026-10-06T18:00:00Z') });
    quarantineCartridge('store-q4', gemini);
    ensurePool('store-q5', [gemini]);
    expect(getNextCartridge('store-q5')?.provider).toBe('gemini');
  });
});
