/**
 * Configuración de la cola de salida. Todo por entorno: ampliar el pod o ajustar
 * ritmos = cambiar variables y reiniciar, sin tocar código (spec).
 */
export interface OutboundConfig {
  /** WA_OUTBOUND_DISPATCHER=on|off. off en tests: se mueve a mano con tick(). */
  dispatcherEnabled: boolean;
  /** Sondeo de respaldo (además del aviso inmediato al encolar). */
  pollMs: number;
  /** Tiendas atendidas en paralelo por pasada (siempre una fila por tienda). */
  maxParallel: number;
  /** Vueltas máximas por pasada antes de ceder. */
  maxLoopsPerTick: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /** Arriendo de una fila en `sending`; vencido, se considera huérfana. */
  leaseMs: number;
  /** Tiempo máximo por trozo enviado. */
  sendTimeoutMs: number;
  /** Espera antes de volver a probar una tienda sin socket. */
  disconnectedDelayMs: number;
  campaignGapMinMs: number;
  campaignGapMaxMs: number;
  outboundRetentionDays: number;
  inboundRetentionDays: number;
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, def: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`[outbound] ${name}="${raw}" no es un entero >= ${min}`);
  }
  return n;
}

export function loadOutboundConfig(env: Env = process.env): OutboundConfig {
  const flag = (env.WA_OUTBOUND_DISPATCHER ?? 'on').trim().toLowerCase();
  if (flag !== 'on' && flag !== 'off') {
    throw new Error(
      `[outbound] WA_OUTBOUND_DISPATCHER="${flag}": usa on u off`,
    );
  }
  const cfg: OutboundConfig = {
    dispatcherEnabled: flag === 'on',
    pollMs: int(env, 'WA_OUTBOUND_POLL_MS', 2_000, 100),
    maxParallel: int(env, 'WA_OUTBOUND_MAX_PARALLEL', 5, 1),
    maxLoopsPerTick: int(env, 'WA_OUTBOUND_MAX_LOOPS', 50, 1),
    maxAttempts: int(env, 'WA_OUTBOUND_MAX_ATTEMPTS', 6, 1),
    retryBaseMs: int(env, 'WA_OUTBOUND_RETRY_BASE_MS', 2_000, 1),
    retryMaxMs: int(env, 'WA_OUTBOUND_RETRY_MAX_MS', 300_000, 1),
    leaseMs: int(env, 'WA_OUTBOUND_LEASE_MS', 300_000, 1_000),
    sendTimeoutMs: int(env, 'WA_SEND_TIMEOUT_MS', 30_000, 1),
    disconnectedDelayMs: int(
      env,
      'WA_OUTBOUND_DISCONNECTED_DELAY_MS',
      30_000,
      1,
    ),
    campaignGapMinMs: int(env, 'WA_CAMPAIGN_GAP_MIN_MS', 8_000, 0),
    campaignGapMaxMs: int(env, 'WA_CAMPAIGN_GAP_MAX_MS', 20_000, 0),
    outboundRetentionDays: int(env, 'WA_OUTBOUND_RETENTION_DAYS', 30, 1),
    inboundRetentionDays: int(env, 'WA_INBOUND_RETENTION_DAYS', 7, 1),
  };
  if (cfg.campaignGapMaxMs < cfg.campaignGapMinMs) {
    throw new Error(
      '[outbound] WA_CAMPAIGN_GAP_MAX_MS no puede ser menor que WA_CAMPAIGN_GAP_MIN_MS',
    );
  }
  if (cfg.retryMaxMs < cfg.retryBaseMs) {
    throw new Error(
      '[outbound] WA_OUTBOUND_RETRY_MAX_MS no puede ser menor que WA_OUTBOUND_RETRY_BASE_MS',
    );
  }
  return cfg;
}
