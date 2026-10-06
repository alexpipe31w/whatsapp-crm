// Baileys es ESM y jest no lo transforma; aquí no se usa.
jest.mock('@whiskeysockets/baileys', () => ({}));

import { AiService } from './ai.service';

// La config de la tienda tiene que CAMBIAR el prompt, no solo aparecer como texto.
const svc = new AiService(null as any, null as any, null as any) as any;

const product = { productId: 'p1', name: 'Dulce', salePrice: 8000, stock: 5, variants: [] };
const service = { serviceId: 's1', name: 'Corte', basePrice: 20000 };
const customer = { customerId: 'c1', name: 'Alex', phone: '+573001112233', cedula: null };

const prompt = (store: any, products: any[] = [product], services: any[] = []) =>
  svc.buildSystemPrompt(
    '', customer, [], [], products, services, 'lunes 6 de octubre', '10:00',
    [], 'quiero comprar', false, {}, null, store, [], '', true, null,
  ) as string;

describe('buildSystemPrompt — config de pedidos', () => {
  const base = { name: 'T', address: 'Cra 6 # 2-33', neighborhood: 'San Vicente' };

  it('sin envíos: recoge en tienda y NO pide dirección ni ciudad', () => {
    const p = prompt({ ...base, orderShipping: false });
    expect(p).toContain('NO hace envíos. Recoge en tienda: Cra 6 # 2-33, San Vicente');
    expect(p).not.toContain('Dirección completa con barrio');
    expect(p).toContain('que recoge en la tienda');
  });

  it('con envíos y zona: pide dirección + ciudad y limita la zona', () => {
    const p = prompt({ ...base, orderShipping: true, orderShippingZone: 'Huila y Caquetá' });
    expect(p).toContain('Dirección completa con barrio');
    expect(p).toContain('SOLO enviamos a: Huila y Caquetá');
  });

  it('anticipo y política de pedidos llegan al flujo', () => {
    const p = prompt({ ...base, orderShipping: true, orderRequiresDeposit: true, orderDepositAmount: '50%', orderPolicy: 'Cambios en 5 días' });
    expect(p).toContain('ANTICIPO: Se requiere un anticipo de 50% para despachar el pedido.');
    expect(p).toContain('"Cambios en 5 días"');
  });

  it('el domicilio y el anticipo de CITAS no se cuelan en una tienda de solo productos', () => {
    const p = prompt({ ...base, orderShipping: true, hasDelivery: true, requiresDeposit: true, cancellationPolicy: '2 h antes' });
    expect(p).not.toContain('atendemos a domicilio');
    expect(p).not.toContain('para confirmar la cita');
    expect(p).not.toContain('2 h antes');
  });

  it('tienda de servicios: usa la config de citas', () => {
    const p = prompt({ ...base, hasDelivery: true, deliveryZone: 'Neiva', requiresDeposit: true, depositAmount: '20000', cancellationPolicy: '2 h antes' }, [], [service]);
    expect(p).toContain('CITAS: atendemos a domicilio en: Neiva');
    expect(p).toContain('CITAS: Se requiere un anticipo de 20000 para confirmar la cita.');
    expect(p).toContain('CITAS, cancelación: 2 h antes');
  });
});
