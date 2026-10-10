import { createHash, randomUUID } from 'node:crypto';

/**
 * Claves de idempotencia de wa_outbound (UNIQUE). Dos encolados con la misma clave
 * dejan UNA fila: es lo que impide los envíos duplicados. Las claves salen en los
 * logs, así que teléfonos y textos del cliente van con hash, nunca en claro.
 * Ver la tabla de la auditoría del bloque 1, §4.
 */
function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * Id del "turno" de entrada: el id de WhatsApp del último mensaje del lote del
 * debounce. Si WhatsApp reentrega el mismo mensaje, el turno es el mismo y la
 * respuesta no se encola dos veces. Sin id (raro), uno local: ese turno no se
 * puede deduplicar entre reinicios.
 */
export function turnIdFor(waMessageId: string | null | undefined): string {
  const id = waMessageId?.trim();
  return id ? id : `local-${randomUUID()}`;
}

export const outboundKeys = {
  aiReply: (storeId: string, turnId: string) => `reply:${storeId}:${turnId}`,
  handoff: (storeId: string, turnId: string) => `handoff:${storeId}:${turnId}`,
  mediaAck: (storeId: string, turnId: string) => `media-ack:${storeId}:${turnId}`,
  audioTooLong: (storeId: string, turnId: string) => `audio-long:${storeId}:${turnId}`,
  adminReply: (storeId: string, turnId: string) => `admin-reply:${storeId}:${turnId}`,
  adminToCustomer: (storeId: string, turnId: string, phone: string) =>
    `admin-msg:${storeId}:${turnId}:${shortHash(phone.replace(/\D/g, '') || phone)}`,
  agentMessage: (messageId: string) => `msg:${messageId}`,
  apptConfirmed: (appointmentId: string, scheduledAt: Date) =>
    `appt:${appointmentId}:confirmed:${scheduledAt.getTime()}`,
  apptCancelledByAdmin: (appointmentId: string) => `appt:${appointmentId}:cancelled`,
  apptResolved: (appointmentId: string, action: string, approved: boolean, requestedAt: Date | null | undefined) =>
    `appt:${appointmentId}:resolved:${action}:${approved ? 'approved' : 'rejected'}:${requestedAt ? requestedAt.getTime() : 'na'}`,
  apptReminder: (appointmentId: string, window: '8h' | '2h' | '1h') => `appt:${appointmentId}:reminder:${window}`,
  apptCreatedAdmin: (appointmentId: string) => `appt:${appointmentId}:created:admin`,
  apptPendingAction: (appointmentId: string, action: 'cancel' | 'reschedule', requestKey: string) =>
    `appt:${appointmentId}:pending:${action}:${shortHash(requestKey)}`,
  apptPaymentProof: (appointmentId: string, excerpt: string) =>
    `appt:${appointmentId}:payment-proof:${shortHash(excerpt)}`,
  /** Un id por programación: la deduplicación aquí es "un pendiente por conversación" (grupo). */
  confirmNudge: (conversationId: string, scheduleId: string) => `confirm-nudge:${conversationId}:${scheduleId}`,
  dailyReport: (storeId: string, localDate: string) => `report:${storeId}:${localDate}`,
  manualReport: (storeId: string, requestId: string) => `report:${storeId}:manual:${requestId}`,
  morningBriefing: (storeId: string, localDate: string) => `briefing:${storeId}:${localDate}`,
  campaign: (campaignId: string, customerId: string) => `campaign:${campaignId}:${customerId}`,
};

/** group_key: filas que se cancelan o se cierran juntas. */
export const outboundGroups = {
  campaign: (campaignId: string) => `campaign:${campaignId}`,
  confirmNudge: (conversationId: string) => `confirm-nudge:${conversationId}`,
};
