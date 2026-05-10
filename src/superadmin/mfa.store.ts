import { randomUUID } from 'crypto';

interface MfaSession {
  userId: string;
  email: string;
  code: string;
  expiresAt: number;
}

interface ResetSession {
  email: string;
  code: string;
  expiresAt: number;
}

// In-memory — suficiente para un solo proceso en Render Starter
const mfaSessions = new Map<string, MfaSession>();
const resetSessions = new Map<string, ResetSession>();

const MFA_TTL_MS = 10 * 60 * 1000;    // 10 minutos
const RESET_TTL_MS = 15 * 60 * 1000;  // 15 minutos

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export const MfaStore = {
  createSession(userId: string, email: string): { sessionId: string; code: string } {
    const sessionId = randomUUID();
    const code = generateCode();
    mfaSessions.set(sessionId, { userId, email, code, expiresAt: Date.now() + MFA_TTL_MS });
    return { sessionId, code };
  },

  validateSession(sessionId: string, code: string): string | null {
    const session = mfaSessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt < Date.now()) { mfaSessions.delete(sessionId); return null; }
    if (session.code !== code) return null;
    mfaSessions.delete(sessionId);
    return session.userId;
  },
};

export const ResetStore = {
  createCode(email: string): string {
    const code = generateCode();
    resetSessions.set(email, { email, code, expiresAt: Date.now() + RESET_TTL_MS });
    return code;
  },

  validateCode(email: string, code: string): boolean {
    const session = resetSessions.get(email);
    if (!session) return false;
    if (session.expiresAt < Date.now()) { resetSessions.delete(email); return false; }
    if (session.code !== code) return false;
    resetSessions.delete(email);
    return true;
  },
};
