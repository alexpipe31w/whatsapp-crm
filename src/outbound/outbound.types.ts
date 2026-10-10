/**
 * Tipos de la cola de salida de WhatsApp (tabla wa_outbound, bloque 1a).
 * El gateway del bloque 1c leerá esta misma tabla: no cambiar los valores que se
 * guardan en BD (kind, status) sin migración.
 */
export const OUTBOUND_KINDS = ['reply', 'notification', 'reminder', 'campaign'] as const;
export type OutboundKind = (typeof OUTBOUND_KINDS)[number];

export const OUTBOUND_STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped'] as const;
export type OutboundStatus = (typeof OUTBOUND_STATUSES)[number];

/** Menor = antes. Respuestas > avisos y recordatorios > campañas (spec). */
export const KIND_PRIORITY: Record<OutboundKind, number> = {
  reply: 0,
  notification: 10,
  reminder: 10,
  campaign: 20,
};

/**
 * Caducidad por defecto (desde not_before). Pasado este tiempo sin poder enviarse
 * (p. ej. con WhatsApp desconectado) la fila pasa a `skipped`: así un número que
 * vuelve tras días no suelta de golpe respuestas viejas. Los recordatorios pasan su
 * propia caducidad (la hora de la cita).
 */
export const KIND_TTL_MS: Record<OutboundKind, number> = {
  reply: 6 * 60 * 60 * 1000,
  notification: 24 * 60 * 60 * 1000,
  reminder: 12 * 60 * 60 * 1000,
  campaign: 72 * 60 * 60 * 1000,
};

/** Lo que se guarda en wa_outbound.payload (JSONB: el bloque 8 añadirá plantillas y media). */
export interface OutboundPayload {
  text: string;
  /** Si viene, al enviarse se guarda el texto en `messages` de esa conversación. */
  record?: { conversationId: string };
}
