import type { SendErrorClass } from './send-errors';

export const NOT_ACCEPTABLE_MIN_DELAY_MS = 6_000;

export interface RetryConfig {
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  disconnectedDelayMs: number;
}

export interface FailureDecision {
  status: 'pending' | 'failed';
  /** Intentos tras este fallo (los de "desconectado" no cuentan). */
  attempts: number;
  /** Espera hasta el siguiente intento; null si la fila queda en failed. */
  delayMs: number | null;
  /** true: aplazar también las demás pendientes de la tienda (socket caído). */
  postponeStore: boolean;
}

function jitter(ms: number, random: () => number): number {
  return Math.round(ms * (0.8 + random() * 0.4));
}

/** Backoff exponencial con tope y ±20 % de jitter. `attempt` empieza en 1. */
export function computeRetryDelay(
  attempt: number,
  notAcceptable: boolean,
  cfg: RetryConfig,
  random: () => number = Math.random,
): number {
  const exp = Math.min(
    cfg.retryBaseMs * 2 ** Math.max(0, attempt - 1),
    cfg.retryMaxMs,
  );
  const base = notAcceptable ? Math.max(exp, NOT_ACCEPTABLE_MIN_DELAY_MS) : exp;
  return jitter(base, random);
}

/**
 * Qué hacer con una fila cuyo envío falló.
 * - desconectado: vuelve a pending sin gastar intento (lo acota expires_at).
 * - permanente o tope alcanzado: failed.
 * - temporal: pending con backoff.
 */
export function decideOnFailure(
  errorClass: SendErrorClass,
  notAcceptable: boolean,
  attemptsBefore: number,
  cfg: RetryConfig,
  random: () => number = Math.random,
): FailureDecision {
  if (errorClass === 'disconnected') {
    return {
      status: 'pending',
      attempts: attemptsBefore,
      delayMs: jitter(cfg.disconnectedDelayMs, random),
      postponeStore: true,
    };
  }
  const attempts = attemptsBefore + 1;
  if (errorClass === 'permanent' || attempts >= cfg.maxAttempts) {
    return { status: 'failed', attempts, delayMs: null, postponeStore: false };
  }
  return {
    status: 'pending',
    attempts,
    delayMs: computeRetryDelay(attempts, notAcceptable, cfg, random),
    postponeStore: false,
  };
}
