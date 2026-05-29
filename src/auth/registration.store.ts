import { randomUUID } from 'crypto';

interface PendingRegistration {
  name: string;
  email: string;
  password: string;
  storeName: string;
  storePhone: string;
  code: string;
  expiresAt: number;
}

// Registro pendiente en memoria — TTL 15 min
const store = new Map<string, PendingRegistration>();

const TTL_MS = 15 * 60 * 1000;

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Limpieza de entradas expiradas cada 5 minutos
setInterval(() => {
  const now = Date.now();
  for (const [id, reg] of store.entries()) {
    if (reg.expiresAt < now) store.delete(id);
  }
}, 5 * 60 * 1000);

export const RegistrationStore = {
  create(data: Omit<PendingRegistration, 'code' | 'expiresAt'>): { sessionId: string; code: string } {
    // Un email solo puede tener una solicitud activa
    for (const [id, reg] of store.entries()) {
      if (reg.email === data.email) store.delete(id);
    }

    const sessionId = randomUUID();
    const code = generateCode();
    store.set(sessionId, { ...data, code, expiresAt: Date.now() + TTL_MS });
    return { sessionId, code };
  },

  validate(sessionId: string, code: string): PendingRegistration | null {
    const reg = store.get(sessionId);
    if (!reg) return null;
    if (reg.expiresAt < Date.now()) { store.delete(sessionId); return null; }
    if (reg.code !== code.trim()) return null;
    store.delete(sessionId);
    return reg;
  },
};
