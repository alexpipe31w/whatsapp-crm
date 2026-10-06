// Lectura ÚNICA de la config de la tienda que cambia el flujo de la IA.
// Pedidos usan SOLO los campos order*; citas usan SOLO los campos históricos
// (hasDelivery, requiresDeposit, cancellationPolicy, requiresCustomer*).
// Regla: un ajuste que la IA ignora es un bug (plan 2026-10-06-config-productos-servicios).

const clean = (s: unknown): string | null => {
  const t = typeof s === 'string' ? s.trim() : '';
  return t ? t : null;
};

export interface OrderConfig {
  ships:   boolean;        // hace envíos de productos
  zone:    string | null;  // zona/ciudades de envío (null = sin restricción)
  pickup:  string | null;  // texto de recogida cuando NO envía
  deposit: string | null;  // frase del anticipo de pedidos
  policy:  string | null;  // cambios/devoluciones/cancelación de pedidos
  cedula:  boolean;        // pedir cédula para la guía
}

export function orderConfig(store: any): OrderConfig {
  const ships = !!store?.orderShipping;
  const dir   = [clean(store?.address), clean(store?.neighborhood)].filter(Boolean).join(', ');
  return {
    ships,
    zone:    ships ? clean(store?.orderShippingZone) : null,
    pickup:  ships ? null : (dir ? `Recoge en tienda: ${dir}` : 'Recoge en tienda'),
    deposit: store?.orderRequiresDeposit
      ? `Se requiere un anticipo de ${clean(store?.orderDepositAmount) ?? 'un monto a convenir'} para despachar el pedido.`
      : null,
    policy:  clean(store?.orderPolicy),
    cedula:  !!store?.orderRequiresCedula,
  };
}

/** Regla de prompt para cambios/devoluciones/cancelación de pedidos. */
export function orderPolicyRule(store: any): string {
  const p = clean(store?.orderPolicy);
  return p
    ? `- CAMBIOS, DEVOLUCIONES O CANCELACIÓN DE UN PEDIDO: aplica EXACTAMENTE esta política del negocio: "${p}". No inventes plazos ni condiciones.`
    : `- CAMBIOS, DEVOLUCIONES O CANCELACIÓN DE UN PEDIDO: el negocio no tiene política escrita; di que un asesor lo revisa. NO inventes plazos ni condiciones.`;
}

export function apptDepositText(store: any): string | null {
  if (!store?.requiresDeposit) return null;
  return `Se requiere un anticipo de ${clean(store?.depositAmount) ?? 'un monto a convenir'} para confirmar la cita.`;
}

/** Cola para la respuesta de "cancelar mi cita": la política, si la tienda la tiene. */
export function apptCancelNote(store: any): string {
  const p = clean(store?.cancellationPolicy);
  return p ? `\n\n📋 Recuerda nuestra política: ${p}` : '';
}
