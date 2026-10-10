/** No hay socket de WhatsApp para la tienda (desconectada, pidiendo QR, reconectando). */
export class WaNotConnectedError extends Error {
  constructor(readonly storeId: string) {
    super(`WhatsApp no conectado (store ${storeId})`);
    this.name = 'WaNotConnectedError';
  }
}

/** El envío no respondió a tiempo. Puede que WhatsApp lo haya aceptado igualmente. */
export class SendTimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`Timed Out (envío > ${ms} ms)`);
    this.name = 'SendTimeoutError';
  }
}

export type SendErrorClass = 'disconnected' | 'temporary' | 'permanent';

const DISCONNECTED_STATUS = new Set([428]);
const PERMANENT_STATUS = new Set([400, 403, 404]);
const DISCONNECTED_RE =
  /connection closed|connection lost|connection terminated/i;
const PERMANENT_RE = /bad-request|item-not-found|forbidden/i;

/**
 * Clasifica un error de envío. Baileys lanza errores Boom (`output.statusCode`).
 * Lo desconocido se trata como temporal: lo acota el tope de intentos.
 */
export function classifySendError(err: unknown): SendErrorClass {
  if (err instanceof WaNotConnectedError) return 'disconnected';
  if (err instanceof SendTimeoutError) return 'temporary';
  const e = err as {
    message?: unknown;
    output?: { statusCode?: number };
    data?: { statusCode?: number };
  } | null;
  const status = e?.output?.statusCode ?? e?.data?.statusCode;
  const message = messageOf(err);
  if (
    (status !== undefined && DISCONNECTED_STATUS.has(status)) ||
    DISCONNECTED_RE.test(message)
  )
    return 'disconnected';
  if (
    (status !== undefined && PERMANENT_STATUS.has(status)) ||
    PERMANENT_RE.test(message)
  )
    return 'permanent';
  return 'temporary';
}

/** `not-acceptable`: la sesión Signal se está renegociando; hay que esperar más. */
export function isNotAcceptable(err: unknown): boolean {
  return /not-acceptable/i.test(messageOf(err));
}

function messageOf(err: unknown): string {
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : '';
}
