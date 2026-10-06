import { orderConfig, apptDepositText, orderPolicyRule, apptCancelNote } from './store-config.util';

describe('orderConfig', () => {
  const base = { address: 'Cra. 6 # 2-33', neighborhood: 'San Vicente del Caguán' };

  it('envío activado: pide dirección y ciudad, sin recogida', () => {
    const c = orderConfig({ ...base, orderShipping: true, orderShippingZone: ' Toda Colombia ' });
    expect(c.ships).toBe(true);
    expect(c.zone).toBe('Toda Colombia');
    expect(c.pickup).toBeNull();
  });

  it('envío apagado: recoge en la dirección de la tienda', () => {
    const c = orderConfig({ ...base, orderShipping: false });
    expect(c.ships).toBe(false);
    expect(c.pickup).toBe('Recoge en tienda: Cra. 6 # 2-33, San Vicente del Caguán');
  });

  it('el domicilio de CITAS no activa envíos de pedidos', () => {
    expect(orderConfig({ hasDelivery: true }).ships).toBe(false);
  });

  it('anticipo de pedidos: solo con el toggle de pedidos, nunca con el de citas', () => {
    expect(orderConfig({ requiresDeposit: true, depositAmount: '50%' }).deposit).toBeNull();
    expect(orderConfig({ orderRequiresDeposit: true, orderDepositAmount: '50%' }).deposit)
      .toBe('Se requiere un anticipo de 50% para despachar el pedido.');
    expect(orderConfig({ orderRequiresDeposit: true }).deposit)
      .toBe('Se requiere un anticipo de un monto a convenir para despachar el pedido.');
  });

  it('cédula de pedidos independiente de la de citas', () => {
    expect(orderConfig({ requiresCustomerCedula: true }).cedula).toBe(false);
    expect(orderConfig({ orderRequiresCedula: true }).cedula).toBe(true);
  });

  it('tienda null no revienta', () => {
    expect(orderConfig(null)).toEqual({
      ships: false, zone: null, pickup: 'Recoge en tienda', deposit: null, policy: null, cedula: false,
    });
  });
});

describe('textos de política y anticipo', () => {
  it('política de pedidos: usa la de pedidos, nunca la de citas', () => {
    expect(orderPolicyRule({ cancellationPolicy: '2 h antes' })).toContain('asesor');
    expect(orderPolicyRule({ cancellationPolicy: '2 h antes' })).not.toContain('2 h antes');
    expect(orderPolicyRule({ orderPolicy: 'Cambios en 5 días' })).toContain('"Cambios en 5 días"');
  });

  it('anticipo de citas: solo con el toggle de citas', () => {
    expect(apptDepositText({ orderRequiresDeposit: true })).toBeNull();
    expect(apptDepositText({ requiresDeposit: true, depositAmount: '20000' }))
      .toBe('Se requiere un anticipo de 20000 para confirmar la cita.');
  });

  it('nota de cancelación de cita: solo si hay política', () => {
    expect(apptCancelNote({})).toBe('');
    expect(apptCancelNote(null)).toBe('');
    expect(apptCancelNote({ cancellationPolicy: 'Cancelar con 2 h' }))
      .toBe('\n\n📋 Recuerda nuestra política: Cancelar con 2 h');
  });
});
