import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';

// Protege el endpoint público de auto-agendamiento (sin autenticación) contra
// spam/abuso. Límite más estricto que AuthRateLimitGuard porque cada solicitud
// exitosa crea registros reales (cliente + cita) en la base de datos.
const requests = new Map<string, { count: number; resetAt: number }>();

const MAX_REQUESTS = 5;
const WINDOW_MS    = 10 * 60_000;
const CLEANUP_MS   = 30 * 60_000;

let lastCleanup = Date.now();

function pruneExpired(now: number) {
  if (now - lastCleanup < CLEANUP_MS) return;
  lastCleanup = now;
  for (const [ip, entry] of requests.entries()) {
    if (entry.resetAt < now) requests.delete(ip);
  }
}

@Injectable()
export class PublicBookingRateLimitGuard implements CanActivate {
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
        'Demasiadas solicitudes de agendamiento. Espera unos minutos antes de intentar de nuevo.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
