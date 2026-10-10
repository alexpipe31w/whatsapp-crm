import { createTestApp, TestApp } from '../support/app';
import { closeTestPrisma, resetDb, testPrisma } from '../support/db';
import {
  createAppointment,
  createCustomer,
  createStoreWithAdmin,
} from '../support/factories';
import { AdminAssistantService } from '../../src/admin-assistant/admin-assistant.service';

/** executeAction es privado: se llama a través de esta vista tipada. */
interface ActionInternals {
  executeAction: (
    storeId: string,
    actionType: string,
    params: Record<string, unknown>,
    ctx: { turnId: string },
  ) => Promise<string>;
}

describe('acciones del asistente del dueño por la cola (BD real)', () => {
  let t: TestApp;
  let assistant: ActionInternals;
  const prisma = () => testPrisma();

  beforeAll(async () => {
    t = await createTestApp();
    const service: AdminAssistantService = t.app.get(AdminAssistantService);
    assistant = service as unknown as ActionInternals;
  });
  afterAll(async () => {
    await t.close();
    await closeTestPrisma();
  });
  beforeEach(async () => {
    await resetDb();
    t.wa.reset();
  });

  async function setup(status: 'PENDING' | 'CONFIRMED' = 'PENDING') {
    const { storeId } = await createStoreWithAdmin();
    const customer = await createCustomer(storeId, 'Ana');
    const appt = await createAppointment(storeId, customer.customerId, {
      status,
    });
    return { storeId, customer, appt };
  }

  it('confirmar usa la MISMA clave que el panel y la autoconfirmación', async () => {
    const { storeId, appt } = await setup();
    const ctx = { turnId: 'T1' };
    await assistant.executeAction(
      storeId,
      'CONFIRM_APPOINTMENT',
      { appointmentId: appt.appointmentId },
      ctx,
    );
    const again = await assistant.executeAction(
      storeId,
      'CONFIRM_APPOINTMENT',
      { appointmentId: appt.appointmentId },
      { turnId: 'T2' },
    );
    expect(again).toContain('❌');
    const rows = await prisma().waOutbound.findMany();
    expect(rows.map((r) => r.idempotencyKey)).toEqual([
      `appt:${appt.appointmentId}:confirmed:${appt.scheduledAt.getTime()}`,
    ]);
    const after = await prisma().appointment.findUniqueOrThrow({
      where: { appointmentId: appt.appointmentId },
    });
    expect(after.status).toBe('CONFIRMED');
  });

  it('cancelar encola el aviso al cliente con clave por cita', async () => {
    const { storeId, appt } = await setup('CONFIRMED');
    await assistant.executeAction(
      storeId,
      'CANCEL_APPOINTMENT',
      { appointmentId: appt.appointmentId, reason: 'cerrado' },
      { turnId: 'T1' },
    );
    const rows = await prisma().waOutbound.findMany();
    expect(rows.map((r) => r.idempotencyKey)).toEqual([
      `appt:${appt.appointmentId}:cancelled`,
    ]);
  });

  it('mandar un mensaje a un cliente dos veces en el mismo turno deja una fila', async () => {
    const { storeId, customer } = await setup();
    const params = {
      customerPhone: customer.phone,
      message: 'Hola Ana, tu pedido está listo',
    };
    await assistant.executeAction(storeId, 'SEND_CUSTOMER_MESSAGE', params, {
      turnId: 'T1',
    });
    const second = await assistant.executeAction(
      storeId,
      'SEND_CUSTOMER_MESSAGE',
      params,
      { turnId: 'T1' },
    );
    expect(second).toContain('✅');
    const rows = await prisma().waOutbound.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toMatch(
      new RegExp(`^admin-msg:${storeId}:T1:[0-9a-f]{16}$`),
    );
  });
});
