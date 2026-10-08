// Política de reconexión de sockets de WhatsApp. Sin dependencias de Baileys
// para poder testearla aislada.

const RECONNECT_DELAYS: Record<number, number> = {
  408: 5_000,
  440: 8_000,
};
const DEFAULT_RECONNECT_DELAY = 3_000;
// Cierres seguidos sin llegar a 'open' → espera exponencial con jitter y techo.
// Sin esto una cuenta que WhatsApp rechaza se reintentaba cada 3 s sin fin
// (Frutatza 2026-10-07: 1240 intentos en 2 h).
const RECONNECT_BACKOFF_CAP_MS = 5 * 60_000;
// Código 403 = WhatsApp rechaza la cuenta (suspendida / en revisión). No es
// transitorio: reintentar solo suma inicios de sesión sospechosos.
export const FORBIDDEN_STATUS = 403;

/** Espera antes del reintento nº `failures` (1 = primer cierre). */
export function computeReconnectDelay(
  statusCode: number | undefined,
  failures: number,
  random: () => number = Math.random,
): number {
  const base = RECONNECT_DELAYS[statusCode ?? -1] ?? DEFAULT_RECONNECT_DELAY;
  const exp = Math.min(
    base * 2 ** Math.max(0, failures - 1),
    RECONNECT_BACKOFF_CAP_MS,
  );
  // Jitter ±20 % para que varias tiendas caídas a la vez no reconecten en bloque.
  return Math.round(exp * (0.8 + random() * 0.4));
}
