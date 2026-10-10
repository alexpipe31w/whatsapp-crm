import { outboundGroups, outboundKeys, turnIdFor } from './outbound-keys';
import { KIND_PRIORITY, KIND_TTL_MS, OUTBOUND_KINDS } from './outbound.types';

const STORE = '5ed677ed-0000-4000-8000-000000000001';
const UUID = '0b6a3f0e-1111-4222-8333-444455556666';

describe('outboundKeys', () => {
  it('las claves de un turno de entrada llevan la tienda y el id de WhatsApp', () => {
    expect(outboundKeys.aiReply(STORE, '3EB0ABC')).toBe(`reply:${STORE}:3EB0ABC`);
    expect(outboundKeys.handoff(STORE, '3EB0ABC')).toBe(`handoff:${STORE}:3EB0ABC`);
    expect(outboundKeys.mediaAck(STORE, '3EB0ABC')).toBe(`media-ack:${STORE}:3EB0ABC`);
    expect(outboundKeys.audioTooLong(STORE, '3EB0ABC')).toBe(`audio-long:${STORE}:3EB0ABC`);
    expect(outboundKeys.adminReply(STORE, '3EB0ABC')).toBe(`admin-reply:${STORE}:3EB0ABC`);
  });

  it('la confirmación depende de la hora de la cita: si se reprograma, vuelve a avisar', () => {
    const a = outboundKeys.apptConfirmed(UUID, new Date('2026-11-01T15:00:00Z'));
    const b = outboundKeys.apptConfirmed(UUID, new Date('2026-11-02T15:00:00Z'));
    expect(a).toBe(`appt:${UUID}:confirmed:${Date.parse('2026-11-01T15:00:00Z')}`);
    expect(a).not.toBe(b);
  });

  it('no mete teléfonos ni textos del cliente en claro (las claves salen en los logs)', () => {
    const k1 = outboundKeys.adminToCustomer(STORE, 'T1', '+57 300 111 2233');
    expect(k1).not.toContain('3001112233');
    expect(k1).toBe(outboundKeys.adminToCustomer(STORE, 'T1', '573001112233'));
    const k2 = outboundKeys.apptPaymentProof(UUID, 'Pagué por Nequi 300 111 2233');
    expect(k2).not.toContain('Nequi');
    expect(k2).toBe(outboundKeys.apptPaymentProof(UUID, 'Pagué por Nequi 300 111 2233'));
    const k3 = outboundKeys.apptPendingAction(UUID, 'reschedule', '2026-11-01T10:00');
    expect(k3).not.toBe(outboundKeys.apptPendingAction(UUID, 'reschedule', '2026-11-01T11:00'));
  });

  it('resolución de una solicitud: distinta por acción, resultado y momento de la solicitud', () => {
    const at = new Date('2026-11-01T10:00:00Z');
    const approved = outboundKeys.apptResolved(UUID, 'CANCEL_REQUESTED', true, at);
    expect(approved).toBe(`appt:${UUID}:resolved:CANCEL_REQUESTED:approved:${at.getTime()}`);
    expect(outboundKeys.apptResolved(UUID, 'CANCEL_REQUESTED', false, at)).not.toBe(approved);
    expect(outboundKeys.apptResolved(UUID, 'CANCEL_REQUESTED', true, null)).toBe(
      `appt:${UUID}:resolved:CANCEL_REQUESTED:approved:na`,
    );
  });

  it('recordatorios, avisos al admin, reportes y campañas', () => {
    expect(outboundKeys.apptReminder(UUID, '2h')).toBe(`appt:${UUID}:reminder:2h`);
    expect(outboundKeys.apptCreatedAdmin(UUID)).toBe(`appt:${UUID}:created:admin`);
    expect(outboundKeys.apptCancelledByAdmin(UUID)).toBe(`appt:${UUID}:cancelled`);
    expect(outboundKeys.agentMessage(UUID)).toBe(`msg:${UUID}`);
    expect(outboundKeys.dailyReport(STORE, '2026-10-10')).toBe(`report:${STORE}:2026-10-10`);
    expect(outboundKeys.manualReport(STORE, UUID)).toBe(`report:${STORE}:manual:${UUID}`);
    expect(outboundKeys.morningBriefing(STORE, '2026-10-10')).toBe(`briefing:${STORE}:2026-10-10`);
    expect(outboundKeys.campaign(UUID, STORE)).toBe(`campaign:${UUID}:${STORE}`);
    expect(outboundKeys.confirmNudge(UUID, 'abc')).toBe(`confirm-nudge:${UUID}:abc`);
  });

  it('todas las claves caben en la columna (200)', () => {
    const long = 'x'.repeat(40);
    const keys = [
      outboundKeys.aiReply(STORE, long),
      outboundKeys.adminToCustomer(STORE, long, '573001112233'),
      outboundKeys.apptResolved(UUID, 'RESCHEDULE_REQUESTED', false, new Date()),
      outboundKeys.apptPendingAction(UUID, 'reschedule', '2026-11-01T10:00'),
      outboundKeys.confirmNudge(UUID, UUID),
      outboundKeys.campaign(UUID, UUID),
      outboundKeys.manualReport(STORE, UUID),
    ];
    for (const k of keys) expect(k.length).toBeLessThanOrEqual(200);
  });

  it('grupos', () => {
    expect(outboundGroups.campaign(UUID)).toBe(`campaign:${UUID}`);
    expect(outboundGroups.confirmNudge(UUID)).toBe(`confirm-nudge:${UUID}`);
  });
});

describe('turnIdFor', () => {
  it('usa el id de WhatsApp si lo hay', () => {
    expect(turnIdFor(' 3EB0ABC ')).toBe('3EB0ABC');
  });

  it('sin id genera uno local distinto cada vez', () => {
    const a = turnIdFor(undefined);
    const b = turnIdFor('');
    expect(a).toMatch(/^local-[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});

describe('prioridad y caducidad por tipo', () => {
  it('respuestas antes que avisos y recordatorios, y estos antes que campañas', () => {
    expect(KIND_PRIORITY.reply).toBeLessThan(KIND_PRIORITY.notification);
    expect(KIND_PRIORITY.notification).toBe(KIND_PRIORITY.reminder);
    expect(KIND_PRIORITY.reminder).toBeLessThan(KIND_PRIORITY.campaign);
  });

  it('todos los tipos caducan', () => {
    for (const k of OUTBOUND_KINDS) expect(KIND_TTL_MS[k]).toBeGreaterThan(0);
  });
});
