import { loadOutboundConfig } from './outbound-config';

describe('loadOutboundConfig', () => {
  it('valores por defecto sin variables', () => {
    expect(loadOutboundConfig({})).toEqual({
      dispatcherEnabled: true,
      pollMs: 2_000,
      maxParallel: 5,
      maxLoopsPerTick: 50,
      maxAttempts: 6,
      retryBaseMs: 2_000,
      retryMaxMs: 300_000,
      leaseMs: 300_000,
      sendTimeoutMs: 30_000,
      disconnectedDelayMs: 30_000,
      campaignGapMinMs: 8_000,
      campaignGapMaxMs: 20_000,
      outboundRetentionDays: 30,
      inboundRetentionDays: 7,
    });
  });

  it('lee las variables', () => {
    const cfg = loadOutboundConfig({
      WA_OUTBOUND_DISPATCHER: 'off',
      WA_OUTBOUND_MAX_ATTEMPTS: '3',
      WA_CAMPAIGN_GAP_MIN_MS: '0',
      WA_CAMPAIGN_GAP_MAX_MS: '0',
    });
    expect(cfg.dispatcherEnabled).toBe(false);
    expect(cfg.maxAttempts).toBe(3);
    expect(cfg.campaignGapMinMs).toBe(0);
  });

  it('falla al arrancar con un valor inválido (mejor que un valor raro en silencio)', () => {
    expect(() => loadOutboundConfig({ WA_OUTBOUND_POLL_MS: 'abc' })).toThrow(
      /WA_OUTBOUND_POLL_MS/,
    );
    expect(() => loadOutboundConfig({ WA_OUTBOUND_MAX_ATTEMPTS: '0' })).toThrow(
      /WA_OUTBOUND_MAX_ATTEMPTS/,
    );
    expect(() =>
      loadOutboundConfig({ WA_OUTBOUND_DISPATCHER: 'quizas' }),
    ).toThrow(/WA_OUTBOUND_DISPATCHER/);
  });

  it('el hueco de campaña máximo no puede ser menor que el mínimo', () => {
    expect(() =>
      loadOutboundConfig({
        WA_CAMPAIGN_GAP_MIN_MS: '9000',
        WA_CAMPAIGN_GAP_MAX_MS: '1000',
      }),
    ).toThrow(/GAP/);
  });
});
