import net from 'node:net';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
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
    const opts = (typeof first === 'object' && first !== null ? first : {}) as { host?: string; path?: string };
    const isUnixSocket = typeof opts.path === 'string';
    const host =
      typeof first === 'number' || typeof first === 'string'
        ? typeof second === 'string' ? second : 'localhost'
        : (opts.host ?? 'localhost');
    if (!isUnixSocket && !LOCAL_HOSTS.has(host)) {
      process.nextTick(() => this.destroy(new Error(`[net-guard] conexión de red no permitida en tests: ${host}`)));
      return this;
    }
    return (original as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  proto[INSTALLED] = true;
}
