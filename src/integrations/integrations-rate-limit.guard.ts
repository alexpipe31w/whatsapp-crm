import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';

// Protege el endpoint público de pairing (POST /integrations/stockup/link) contra
// fuerza bruta del código de vinculación. Mismo patrón in-memory por IP que
// PublicBookingRateLimitGuard, con límite propio para no compartir estado.
const requests = new Map<string, { count: number; resetAt: number }>();

const MAX_REQUESTS = 10;
const WINDOW_MS = 60_000;
const CLEANUP_MS = 30 * 60_000;

let lastCleanup = Date.now();

function pruneExpired(now: number) {
  if (now - lastCleanup < CLEANUP_MS) return;
  lastCleanup = now;
  for (const [ip, entry] of requests.entries()) {
    if (entry.resetAt < now) requests.delete(ip);
  }
}

@Injectable()
export class IntegrationsRateLimitGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const ip: string = req.ip ?? req.connection?.remoteAddress ?? 'unknown';
    const now = Date.now();

    pruneExpired(now);

    const entry = requests.get(ip);
    if (!entry || entry.resetAt < now) {
      requests.set(ip, { count: 1, resetAt: now + WINDOW_MS });
      return true;
    }

    entry.count++;
    if (entry.count > MAX_REQUESTS) {
      throw new HttpException(
        'Demasiadas solicitudes. Espera un momento antes de intentar de nuevo.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
