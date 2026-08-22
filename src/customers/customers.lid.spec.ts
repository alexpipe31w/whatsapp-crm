// Cruce de las dos identidades de un mismo cliente (teléfono y LID) con Prisma
// mockeado: solo los métodos que linkLidIdentity toca.
import { CustomersService } from './customers.service';

const STORE = 'store-1';
const LID   = '118442917159121';
const PHONE = '+573152408317';

function decimal(n: number) {
  return { add: (other: any) => decimal(n + Number(other?.value ?? other ?? 0)), value: n } as any;
}

function makeHarness(rows: { lidCustomer?: any; phoneCustomer?: any }) {
  const tx = {
    customer: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(
          where.storeId_phone.phone === `lid:${LID}` ? rows.lidCustomer ?? null : rows.phoneCustomer ?? null,
        ),
      ),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    conversation: { updateMany: jest.fn().mockResolvedValue({}) },
    order:        { updateMany: jest.fn().mockResolvedValue({}) },
    appointment:  { updateMany: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: (fn: any) => fn(tx) } as any;
  return { tx, service: new CustomersService(prisma) };
}

describe('CustomersService.linkLidIdentity', () => {
  it('no toca nada si aún no se conoce el teléfono', async () => {
    const { tx, service } = makeHarness({});
    await service.linkLidIdentity(STORE, `lid:${LID}`, LID);
    expect(tx.customer.findUnique).not.toHaveBeenCalled();
  });

  it('anota el LID en el cliente telefónico cuando nunca escribió sin número', async () => {
    const phoneCustomer = { customerId: 'c-phone', waLid: null };
    const { tx, service } = makeHarness({ phoneCustomer });

    await service.linkLidIdentity(STORE, PHONE, LID);

    expect(tx.customer.update).toHaveBeenCalledWith({
      where: { customerId: 'c-phone' },
      data:  { waLid: LID },
    });
    expect(tx.customer.delete).not.toHaveBeenCalled();
  });

  it('no reescribe el LID si ya estaba anotado', async () => {
    const phoneCustomer = { customerId: 'c-phone', waLid: LID };
    const { tx, service } = makeHarness({ phoneCustomer });

    await service.linkLidIdentity(STORE, PHONE, LID);

    expect(tx.customer.update).not.toHaveBeenCalled();
  });

  it('completa la ficha en sitio cuando el cliente solo existía por LID', async () => {
    const lidCustomer = { customerId: 'c-lid', waLid: LID };
    const { tx, service } = makeHarness({ lidCustomer });

    await service.linkLidIdentity(STORE, PHONE, LID);

    expect(tx.customer.update).toHaveBeenCalledWith({
      where: { customerId: 'c-lid' },
      data:  { phone: PHONE, waLid: LID },
    });
    // Conserva su historial: no se mueve ni se borra nada.
    expect(tx.conversation.updateMany).not.toHaveBeenCalled();
    expect(tx.customer.delete).not.toHaveBeenCalled();
  });

  it('fusiona el duplicado en el cliente telefónico y borra la ficha LID', async () => {
    const lidCustomer   = { customerId: 'c-lid',   name: 'CuchareArte', totalOrders: 1, totalSpent: decimal(50) };
    const phoneCustomer = { customerId: 'c-phone', name: null,          totalOrders: 2, totalSpent: decimal(100) };
    const { tx, service } = makeHarness({ lidCustomer, phoneCustomer });

    await service.linkLidIdentity(STORE, PHONE, LID);

    const moved = { where: { customerId: 'c-lid' }, data: { customerId: 'c-phone' } };
    expect(tx.conversation.updateMany).toHaveBeenCalledWith(moved);
    expect(tx.order.updateMany).toHaveBeenCalledWith(moved);
    expect(tx.appointment.updateMany).toHaveBeenCalledWith(moved);

    const update = tx.customer.update.mock.calls[0][0];
    expect(update.where).toEqual({ customerId: 'c-phone' });
    expect(update.data.waLid).toBe(LID);
    expect(update.data.name).toBe('CuchareArte');   // hereda el nombre que faltaba
    expect(update.data.totalOrders).toBe(3);        // métricas sumadas
    expect(update.data.totalSpent.value).toBe(150);

    expect(tx.customer.delete).toHaveBeenCalledWith({ where: { customerId: 'c-lid' } });
  });
});
