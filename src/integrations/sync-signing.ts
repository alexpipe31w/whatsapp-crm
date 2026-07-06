import * as crypto from 'crypto';

const WINDOW_MS = 5 * 60 * 1000;

export function signSyncRequest(secret: string, rawBody: string, timestamp?: string) {
  const ts = timestamp ?? String(Date.now());
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${ts}.${rawBody}`)
    .digest('hex');
  return { timestamp: ts, signature };
}

export function verifySyncRequest(
  secret: string,
  rawBody: string,
  timestamp: string,
  signature: string,
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > WINDOW_MS) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}
