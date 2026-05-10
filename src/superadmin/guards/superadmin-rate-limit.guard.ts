import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';

// In-memory store — suficiente para una sola instancia en Render Starter
const requests = new Map<string, { count: number; resetAt: number }>();

const MAX_REQUESTS = 20;
const WINDOW_MS = 60_000;

@Injectable()
export class SuperAdminRateLimitGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const ip: string = req.ip ?? req.connection?.remoteAddress ?? 'unknown';
    const now = Date.now();

    const entry = requests.get(ip);
    if (!entry || entry.resetAt < now) {
      requests.set(ip, { count: 1, resetAt: now + WINDOW_MS });
      return true;
    }

    entry.count++;
    if (entry.count > MAX_REQUESTS) {
      throw new HttpException('Demasiadas solicitudes, intenta en un momento', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
