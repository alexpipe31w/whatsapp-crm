import net from 'node:net';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
// Puerto del túnel SSH a la BD de PRODUCCIÓN del CRM: vetado en tests aunque el host sea localhost.
const BLOCKED_LOCAL_PORTS = new Set([54 * 100 + 33]);
const INSTALLED = Symbol.for('crm.netGuardInstalled');

/**
 * Corta a nivel de socket toda conexión que no sea a localhost. Cubre fetch, axios,
 * los SDK de Groq/Gemini/Cloudinary, Baileys y cualquier https directo.
 * Postgres en localhost y los sockets unix siguen funcionando.
 */
export function installNetworkGuard(): void {
  const proto = net.Socket.prototype as net.Socket & { [INSTALLED]?: boolean };
  if (proto[INSTALLED]) return;
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    // Node puede llamar a connect() con los argumentos ya normalizados: [options, cb] en un array.
    const normalized = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
    const [first, second] = normalized;
    const opts = (typeof first === 'object' && first !== null ? first : {}) as { host?: string; path?: string; port?: number | string };
    const isUnixSocket = typeof opts.path === 'string';
    const host =
      typeof first === 'number' || typeof first === 'string'
        ? typeof second === 'string' ? second : 'localhost'
        : (opts.host ?? 'localhost');
    const port = Number(typeof first === 'number' || typeof first === 'string' ? first : opts.port);
    if (!isUnixSocket && BLOCKED_LOCAL_PORTS.has(port)) {
      process.nextTick(() => this.destroy(new Error('[net-guard] puerto del túnel a producción vetado en tests')));
      return this;
    }
    if (!isUnixSocket && !LOCAL_HOSTS.has(host)) {
      process.nextTick(() => this.destroy(new Error(`[net-guard] conexión de red no permitida en tests: ${host}`)));
      return this;
    }
    return (original as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  proto[INSTALLED] = true;
}
