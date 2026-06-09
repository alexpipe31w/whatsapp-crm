import { AIProvider, PROVIDER_CONFIG } from './providers';

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

const POOL_RESET_MS = 60 * 60 * 1000; // 60 min — rate limit windows reset
const MAX_ACTIVE    = 2;               // cartridges used simultaneously

// ─── In-memory store ──────────────────────────────────────────────────────────

const pools = new Map<string, PoolState>();

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
    const valid  = cartridges.filter(c => c.apiKey?.trim());
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
    model:    config.model ?? PROVIDER_CONFIG[primaryProvider]?.defaultModel ?? '',
  };

  const extra: Cartridge[] = Array.isArray(config.cartridges)
    ? (config.cartridges as any[])
        .filter(c => c?.provider && typeof c.apiKey === 'string' && c.apiKey.trim())
        .map(c => ({
          provider: c.provider as AIProvider,
          apiKey:   c.apiKey.trim(),
          model:    c.model?.trim() || PROVIDER_CONFIG[c.provider as AIProvider]?.defaultModel || '',
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
