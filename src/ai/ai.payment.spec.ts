// Baileys es ESM y jest no lo transforma; aquí no se usa.
jest.mock('@whiskeysockets/baileys', () => ({}));

import { AiService } from './ai.service';

// buildPaymentBlock es privado: se prueba a través de la instancia, sin dependencias
// (no toca Prisma ni notificaciones).
const svc = new AiService(null as any, null as any, null as any) as any;

describe('buildPaymentBlock — la config de pago de la tienda llega al cliente', () => {
  it('usa los métodos y la cuenta del perfil de la tienda cuando la config de IA no trae lista (caso Frutatza)', () => {
    const block: string = svc.buildPaymentBlock({}, {
      paymentMethods: ['nequi', 'daviplata', 'efectivo', 'transferencia'],
      paymentAccount: '3197536298 / llave: @nirofi',
    });
    expect(block).toContain('• Nequi: 3197536298 / llave: @nirofi');
    expect(block).toContain('• Efectivo');
    expect(block).not.toContain('Efectivo: 3197536298');
    expect(block).toContain('comprobante');
  });

  it('la lista estructurada de la config de IA tiene prioridad', () => {
    const block: string = svc.buildPaymentBlock(
      { paymentMethods: [{ label: 'Bancolombia', value: '123-456' }] },
      { paymentMethods: ['nequi'], paymentAccount: '300' },
    );
    expect(block).toContain('• Bancolombia: 123-456');
    expect(block).not.toContain('Nequi');
  });

  it('solo cuenta, sin métodos: la muestra igual', () => {
    expect(svc.buildPaymentBlock({}, { paymentMethods: [], paymentAccount: '300 111' })).toContain('• Cuenta: 300 111');
  });

  it('tienda sin nada de pago configurado → null (el mensaje cae al "un asesor te contactará")', () => {
    expect(svc.buildPaymentBlock({}, { paymentMethods: [], paymentAccount: null })).toBeNull();
    expect(svc.buildPaymentBlock({}, null)).toBeNull();
  });
});
