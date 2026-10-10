/**
 * Token de la configuración de la cola (los tests lo sustituyen con overrideProvider).
 * En su propio archivo: si viviera en outbound.module.ts, los servicios que el módulo
 * registra lo importarían en un ciclo y llegaría `undefined` al decorador @Inject.
 */
export const OUTBOUND_CONFIG = Symbol('OUTBOUND_CONFIG');
