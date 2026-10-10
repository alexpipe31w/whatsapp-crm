import request from 'supertest';
import { createTestApp, TestApp } from '../support/app';
import { bearer } from '../support/auth';
import { closeTestPrisma, resetDb, testPrisma } from '../support/db';
import {
  createAppointment,
  createCustomer,
  createStoreWithAdmin,
} from '../support/factories';
import { OutboundService } from '../../src/outbound/outbound.service';
import { AutoConfirmService } from '../../src/auto-confirm/auto-confirm.service';
import { RemindersService } from '../../src/reminders/reminders.service';

describe('avisos de citas por la cola (BD real)', () => {
  let t: TestApp;
  const prisma = () => testPrisma();
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
    await closeTestPrisma();
  });
  beforeEach(async () => {
    await resetDb();
    t.wa.reset();
    jest.restoreAllMocks();
  });

  async function setup(over: Parameters<typeof createAppointment>[2] = {}) {
    const store = await createStoreWithAdmin();
    const customer = await createCustomer(store.storeId);
    const appt = await createAppointment(
      store.storeId,
      customer.customerId,
      over,
    );
    return { ...store, customer, appt };
  }

  const patch = (
    admin: Awaited<ReturnType<typeof setup>>['admin'],
    id: string,
    body: object,
  ) => http().patch(`/api/appointments/${id}`).set(bearer(admin)).send(body);

  it('confirmar dos veces deja UN aviso al cliente con la hora en la clave', async () => {
    const { admin, appt } = await setup();
    await patch(admin, appt.appointmentId, { status: 'CONFIRMED' }).expect(200);
    await patch(admin, appt.appointmentId, { status: 'CONFIRMED' }).expect(200);
    const rows = await prisma().waOutbound.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      idempotencyKey: `appt:${appt.appointmentId}:confirmed:${appt.scheduledAt.getTime()}`,
      kind: 'notification',
    });
  });

  it('una cita ya confirmada solo vuelve a avisar si cambia de hora', async () => {
    const { admin, appt } = await setup({ status: 'CONFIRMED' });
    await patch(admin, appt.appointmentId, { status: 'CONFIRMED' }).expect(200);
    expect(await prisma().waOutbound.count()).toBe(0);
    const later = new Date(appt.scheduledAt.getTime() + 60 * 60 * 1000);
    await patch(admin, appt.appointmentId, {
      status: 'CONFIRMED',
      scheduledAt: later.toISOString(),
    }).expect(200);
    const rows = await prisma().waOutbound.findMany();
    expect(rows.map((r) => r.idempotencyKey)).toEqual([
      `appt:${appt.appointmentId}:confirmed:${later.getTime()}`,
    ]);
  });

  it('aprobar una reprogramación avisa de la reprogramación (antes decía cancelación)', async () => {
    const requestedAt = new Date('2026-10-01T12:00:00Z');
    const { admin, appt } = await setup({
      status: 'CONFIRMED',
      pendingAction: 'RESCHEDULE_REQUESTED',
      pendingActionAt: requestedAt,
      pendingActionData: { newDate: '2026-11-05', newTime: '10:00' },
    });
    await patch(admin, appt.appointmentId, {
      pendingActionResolution: 'approved',
    }).expect(200);
    const rows = await prisma().waOutbound.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBe(
      `appt:${appt.appointmentId}:resolved:RESCHEDULE_REQUESTED:approved:${requestedAt.getTime()}`,
    );
    expect((rows[0].payload as { text: string }).text).toContain(
      'reprogramación fue aprobada',
    );
  });

  it('si encolar falla, la cita no cambia de estado (misma transacción)', async () => {
    const { admin, appt } = await setup();
    jest
      .spyOn(t.app.get(OutboundService), 'enqueue')
      .mockRejectedValueOnce(new Error('BD caída a medias'));
    await patch(admin, appt.appointmentId, { status: 'CONFIRMED' }).expect(500);
    const after = await prisma().appointment.findUniqueOrThrow({
      where: { appointmentId: appt.appointmentId },
    });
    expect(after.status).toBe('PENDING');
  });

  it('autoconfirmación: confirma y avisa una sola vez', async () => {
    const { storeId, appt } = await setup({
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    await prisma().store.update({
      where: { storeId },
      data: { subscriptionStatus: 'active', autoConfirmAppointments: true },
    });
    const autoConfirm = t.app.get(AutoConfirmService);
    await autoConfirm.runAutoConfirm();
    await autoConfirm.runAutoConfirm();
    const after = await prisma().appointment.findUniqueOrThrow({
      where: { appointmentId: appt.appointmentId },
    });
    expect(after.status).toBe('CONFIRMED');
    expect(await prisma().waOutbound.count()).toBe(1);
  });

  it('recordatorios: reclamo y encolado juntos, caducan a la hora de la cita', async () => {
    const soon = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const { storeId, appt } = await setup({
      status: 'CONFIRMED',
      scheduledAt: soon,
    });
    await prisma().store.update({
      where: { storeId },
      data: { subscriptionStatus: 'active' },
    });
    const reminders = t.app.get(RemindersService);

    jest
      .spyOn(t.app.get(OutboundService), 'enqueue')
      .mockRejectedValueOnce(new Error('fallo al encolar'));
    await reminders.runReminders();
    const afterFail = await prisma().appointment.findUniqueOrThrow({
      where: { appointmentId: appt.appointmentId },
    });
    expect(afterFail.reminder8hSentAt).toBeNull(); // la marca no quedó puesta sin aviso
    jest.restoreAllMocks();

    await reminders.runReminders();
    await reminders.runReminders();
    const rows = await prisma().waOutbound.findMany({
      orderBy: { idempotencyKey: 'asc' },
    });
    expect(rows.map((r) => r.idempotencyKey)).toEqual([
      `appt:${appt.appointmentId}:reminder:2h`,
      `appt:${appt.appointmentId}:reminder:8h`,
    ]);
    expect(rows.every((r) => r.kind === 'reminder')).toBe(true);
    expect(rows.every((r) => r.expiresAt?.getTime() === soon.getTime())).toBe(
      true,
    );
  });
});
