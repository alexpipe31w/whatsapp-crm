import { AIProvider, PROVIDER_CONFIG, normalizeCartridgeModel } from './providers';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Cartridge {
  provider: AIProvider;
  apiKey:   string;
  model:    string;
}

interface PoolState {
  active:     Cartridge[];
  unused:     Cartridge[];
  exhausted:  Cartridge[];
  cursor:     number;
  resetAt:    number;
  configHash: string;
  useCounts:  Map<string, number>; // `${provider}:${apiKey}` → uses since last reset
}

// ─── Constants ────────────────────────────────────────────────────────────────

// 2 min — un cartucho bancado (por 429 o por error) revive en este lapso. Los límites
// por-minuto de Groq se despejan en ~60s; antes era 60 min y un bloqueo de 1 min se
// convertía en un apagón largo de la IA.
const POOL_RESET_MS = 2 * 60 * 1000;
// Cartuchos usados en simultáneo (round-robin). Antes era 2 → con 6 keys solo se usaban
// 2 y se saturaban rápido. 12 = usa TODAS las keys configuradas, máximo techo de rate-limit.
const MAX_ACTIVE    = 12;

// ─── In-memory store ──────────────────────────────────────────────────────────

const pools = new Map<string, PoolState>();

// Cuarentena de cartuchos ROTOS (modelo inexistente/retirado o key inválida). Vive
// fuera de `pools` a propósito: el pool se borra entero cada POOL_RESET_MS, y un 404
// no se arregla solo en 2 min — sin esto el cartucho volvía al turno y se comía otro
// mensaje. Incidente Frutatza 2026-10-06: gemini daba 404 y los clientes quedaban mudos.
const BROKEN_QUARANTINE_MS = 30 * 60 * 1000;
const quarantine = new Map<string, number>(); // `${storeId}|${provider}:${apiKey}` → hasta cuándo

const quarantineKey = (storeId: string, c: Cartridge) => `${storeId}|${c.provider}:${c.apiKey}`;

function isQuarantined(storeId: string, c: Cartridge): boolean {
  const k     = quarantineKey(storeId, c);
  const until = quarantine.get(k);
  if (until === undefined) return false;
  if (Date.now() >= until) { quarantine.delete(k); return false; }
  return true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cartridgeHash(cartridges: Cartridge[]): string {
  return cartridges.map(c => `${c.provider}:${c.apiKey.slice(-8)}`).join('|');
}

function resetIfExpired(storeId: string): void {
  const pool = pools.get(storeId);
  if (pool && Date.now() >= pool.resetAt) {
    pools.delete(storeId);
  }
}

const useCountKey = (c: Cartridge) => `${c.provider}:${c.apiKey}`;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Call at the start of each generateReply. Initializes (or re-initializes if
 * cartridge list changed) the pool for this store. No-op if pool is healthy.
 */
export function ensurePool(storeId: string, cartridges: Cartridge[]): void {
  resetIfExpired(storeId);
  const existing = pools.get(storeId);
  const hash     = cartridgeHash(cartridges);
  if (!existing || existing.configHash !== hash) {
    const withKey = cartridges.filter(c => c.apiKey?.trim());
    const healthy = withKey.filter(c => !isQuarantined(storeId, c));
    // Si TODOS están en cuarentena se usan igual: mejor intentar que no responder nada.
    const valid   = healthy.length > 0 ? healthy : withKey;
    const active = valid.slice(0, MAX_ACTIVE);
    const unused = valid.slice(MAX_ACTIVE);
    pools.set(storeId, {
      active,
      unused,
      exhausted:  [],
      cursor:     0,
      resetAt:    Date.now() + POOL_RESET_MS,
      configHash: hash,
      useCounts:  new Map(),
    });
  }
}

/**
 * Round-robin between active cartridges.
 * Returns null if pool is empty or store has no pool.
 */
export function getNextCartridge(storeId: string): Cartridge | null {
  const pool = pools.get(storeId);
  if (!pool?.active.length) return null;
  const cartridge = pool.active[pool.cursor % pool.active.length];
  pool.cursor++;
  const k = useCountKey(cartridge);
  pool.useCounts.set(k, (pool.useCounts.get(k) ?? 0) + 1);
  return cartridge;
}

/**
 * Mark a cartridge as rate-limited/exhausted.
 * Removes it from active, promotes next unused cartridge.
 */
export function markExhausted(storeId: string, cartridge: Cartridge): void {
  const pool = pools.get(storeId);
  if (!pool) return;
  pool.active   = pool.active.filter(c => !(c.apiKey === cartridge.apiKey && c.provider === cartridge.provider));
  pool.exhausted.push(cartridge);
  if (pool.unused.length > 0) {
    pool.active.push(pool.unused.shift()!);
  }
  pool.cursor = 0;
}

/**
 * Saca un cartucho ROTO del pool y lo deja en cuarentena BROKEN_QUARANTINE_MS, más
 * allá de los reinicios del pool. Para errores que no se curan solos (ver
 * isBrokenCartridgeError); los 429 siguen yendo por markExhausted.
 */
export function quarantineCartridge(storeId: string, cartridge: Cartridge): void {
  quarantine.set(quarantineKey(storeId, cartridge), Date.now() + BROKEN_QUARANTINE_MS);
  markExhausted(storeId, cartridge);
}

/**
 * Errores que NO se arreglan reintentando con la misma key: modelo inexistente o
 * retirado por el proveedor (404, model_not_found, model_decommissioned) o key
 * inválida/revocada (401/403). Reintentar con el "modelo rápido" del mismo proveedor
 * no sirve: o falla igual o, peor, contesta otro modelo con otro criterio.
 */
export function isBrokenCartridgeError(err: any): boolean {
  if (isRateLimitError(err)) return false;
  const status  = err?.status ?? err?.statusCode ?? err?.response?.status ?? 0;
  if (status === 401 || status === 403 || status === 404) return true;
  const code    = String(err?.code ?? err?.error?.code ?? '').toLowerCase();
  if (code === 'model_not_found' || code === 'model_decommissioned' || code === 'invalid_api_key') return true;
  const message = String(err?.message ?? err?.error?.message ?? '').toLowerCase();
  if (message.includes('decommissioned') || message.includes('model_not_found')) return true;
  if (/model .*(does not exist|not found|is not supported|no longer)/.test(message)) return true;
  return false;
}

/**
 * Detect 429 / quota errors from any provider.
 */
export function isRateLimitError(err: any): boolean {
  const status  = err?.status ?? err?.statusCode ?? err?.response?.status ?? 0;
  const message = String(err?.message ?? err?.error?.message ?? '').toLowerCase();
  if (status === 429) return true;
  if (message.includes('rate_limit') || message.includes('rate limit'))        return true;
  if (message.includes('resource_exhausted') || message.includes('quota'))     return true;
  if (message.includes('requests per') || message.includes('too many requests')) return true;
  if (message.includes('tokens per') || message.includes('tpm'))               return true;
  return false;
}

/**
 * Build full cartridge list from AIConfiguration record.
 * Primary cartridge = config.aiProvider + config.apiKey + config.model.
 * Extra cartridges = config.cartridges (JSON array).
 */
export function buildCartridgeList(config: {
  aiProvider?: string | null;
  apiKey:      string;
  model:       string;
  cartridges?: any;
}): Cartridge[] {
  const primaryProvider = (config.aiProvider ?? 'groq') as AIProvider;
  const primary: Cartridge = {
    provider: primaryProvider,
    apiKey:   config.apiKey,
    // normalizeCartridgeModel remapea modelos gemini capados (2.0-flash/1.5) al vivo;
    // cubre también cartuchos guardados antes del fix de normalización al persistir.
    model:    normalizeCartridgeModel(primaryProvider, config.model) || PROVIDER_CONFIG[primaryProvider]?.defaultModel || '',
  };

  const extra: Cartridge[] = Array.isArray(config.cartridges)
    ? (config.cartridges as any[])
        .filter(c => c?.provider && typeof c.apiKey === 'string' && c.apiKey.trim())
        .map(c => ({
          provider: c.provider as AIProvider,
          apiKey:   c.apiKey.trim(),
          model:    normalizeCartridgeModel(c.provider, c.model?.trim()) || PROVIDER_CONFIG[c.provider as AIProvider]?.defaultModel || '',
        }))
    : [];

  return [primary, ...extra].filter(c => c.apiKey?.trim());
}

/**
 * Returns a status snapshot for logging / monitoring.
 */
export function getPoolStatus(storeId: string): string {
  const pool = pools.get(storeId);
  if (!pool) return 'no pool';
  return `active=${pool.active.length} unused=${pool.unused.length} exhausted=${pool.exhausted.length}`;
}

// ── Pool snapshot for frontend monitoring ─────────────────────────────────────

export interface CartridgeSnapshot {
  provider:  string;
  maskedKey: string;
  model:     string;
  status:    'active' | 'unused' | 'exhausted';
  useCount:  number;
}

export interface PoolSnapshot {
  hasPool:    boolean;
  cartridges: CartridgeSnapshot[];
  resetAt:    number | null;
  totalUses:  number;
}

const maskKey = (key: string): string =>
  key.length > 4 ? `...${key.slice(-4)}` : '****';

export function getPoolSnapshot(storeId: string): PoolSnapshot {
  resetIfExpired(storeId);
  const pool = pools.get(storeId);
  if (!pool) return { hasPool: false, cartridges: [], resetAt: null, totalUses: 0 };

  const snap = (list: Cartridge[], status: CartridgeSnapshot['status']): CartridgeSnapshot[] =>
    list.map(c => ({
      provider:  c.provider,
      maskedKey: maskKey(c.apiKey),
      model:     c.model,
      status,
      useCount:  pool.useCounts.get(useCountKey(c)) ?? 0,
    }));

  const all = [
    ...snap(pool.active,    'active'),
    ...snap(pool.unused,    'unused'),
    ...snap(pool.exhausted, 'exhausted'),
  ];

  return {
    hasPool:    true,
    cartridges: all,
    resetAt:    pool.resetAt,
    totalUses:  all.reduce((s, c) => s + c.useCount, 0),
  };
}
