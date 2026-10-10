import {
  computeRetryDelay,
  decideOnFailure,
  NOT_ACCEPTABLE_MIN_DELAY_MS,
  RetryConfig,
} from './outbound-retry';

const cfg: RetryConfig = {
  maxAttempts: 6,
  retryBaseMs: 2_000,
  retryMaxMs: 300_000,
  disconnectedDelayMs: 30_000,
};
const noJitter = () => 0.5; // 0.8 + 0.5*0.4 = 1.0

describe('computeRetryDelay', () => {
  it('exponencial desde 2 s', () => {
    expect(computeRetryDelay(1, false, cfg, noJitter)).toBe(2_000);
    expect(computeRetryDelay(2, false, cfg, noJitter)).toBe(4_000);
    expect(computeRetryDelay(3, false, cfg, noJitter)).toBe(8_000);
  });

  it('con tope de 5 min', () => {
    expect(computeRetryDelay(20, false, cfg, noJitter)).toBe(300_000);
  });

  it('not-acceptable espera al menos 6 s (sesión Signal renegociando)', () => {
    expect(computeRetryDelay(1, true, cfg, noJitter)).toBe(
      NOT_ACCEPTABLE_MIN_DELAY_MS,
    );
  });

  it('jitter de ±20 %', () => {
    expect(computeRetryDelay(1, false, cfg, () => 0)).toBe(1_600);
    expect(computeRetryDelay(1, false, cfg, () => 1)).toBe(2_400);
  });
});

describe('decideOnFailure', () => {
  it('desconectado: vuelve a pendiente sin gastar intento y aplaza la tienda', () => {
    expect(decideOnFailure('disconnected', false, 2, cfg, noJitter)).toEqual({
      status: 'pending',
      attempts: 2,
      delayMs: 30_000,
      postponeStore: true,
    });
  });

  it('temporal: gasta un intento y reintenta con backoff', () => {
    expect(decideOnFailure('temporary', false, 0, cfg, noJitter)).toEqual({
      status: 'pending',
      attempts: 1,
      delayMs: 2_000,
      postponeStore: false,
    });
  });

  it('temporal en el último intento: falla', () => {
    expect(decideOnFailure('temporary', false, 5, cfg, noJitter)).toEqual({
      status: 'failed',
      attempts: 6,
      delayMs: null,
      postponeStore: false,
    });
  });

  it('permanente: falla al primero', () => {
    expect(decideOnFailure('permanent', false, 0, cfg, noJitter)).toEqual({
      status: 'failed',
      attempts: 1,
      delayMs: null,
      postponeStore: false,
    });
  });
});
