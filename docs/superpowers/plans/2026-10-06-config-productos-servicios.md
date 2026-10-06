# Configuración de tienda: General / Productos / Servicios — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que cada ajuste de la tienda tenga UN significado y afecte solo a su flujo: los de Productos al flujo de pedidos de la IA, los de Servicios al de citas, y los Generales a ambos.

**Architecture:** Campos nuevos `order_*` en `stores` para pedidos (envíos, zona, anticipo, política, cédula), rellenados una sola vez desde los valores actuales por migraciones idempotentes en `STARTUP_MIGRATIONS`. Los campos existentes quedan como configuración de **citas** (`hasDelivery` = servicio a domicilio, `requiresDeposit`, `cancellationPolicy`, `requiresCustomerCedula`, `requiresCustomerAddress`…). La lógica de lectura vive en un módulo puro `src/ai/store-config.util.ts` (testeable sin Prisma ni Baileys) que usan el prompt, el extractor de pedidos y el mensaje de pedido registrado. El panel (`stockup-frontend/src/pages/Config.tsx`) agrupa las tarjetas en tres bloques.

**Tech Stack:** NestJS + Prisma 6 (Postgres) + Jest en `whatsapp-crm`; React (CRA) + Tailwind en `stockup-frontend`.

**Regla de la casa:** [[feedback-config-tienda-manda-en-ia]] — un ajuste que la IA ignora es un bug.

---

## Mapa de campos

| Bloque | Campo Prisma | Columna | Efecto en la IA |
|---|---|---|---|
| General | `paymentMethods`, `paymentAccount` | (existentes) | Pago en pedidos y citas |
| Productos | `orderShipping` Boolean | `order_shipping` | ON: pide dirección + barrio + ciudad. OFF: recoge en tienda, no pide dirección |
| Productos | `orderShippingZone` String? | `order_shipping_zone` | Si hay zona, solo envía ahí; fuera de zona lo dice y ofrece recoger |
| Productos | `orderRequiresDeposit` Boolean | `order_requires_deposit` | Anticipo en resumen y en mensaje de pedido registrado |
| Productos | `orderDepositAmount` String? | `order_deposit_amount` | Monto del anticipo de pedidos |
| Productos | `orderPolicy` String? | `order_policy` | Cambios/devoluciones/cancelación de pedidos; sin texto → "lo revisa un asesor" |
| Productos | `orderRequiresCedula` Boolean | `order_requires_cedula` | Cédula para la guía de envío |
| Servicios | `hasDelivery` / `deliveryZone` | (existentes) | Pasa a significar "servicio a domicilio" |
| Servicios | `requiresDeposit` / `depositAmount` | (existentes) | Anticipo de citas |
| Servicios | `cancellationPolicy` | (existente) | Va en la respuesta cuando piden cancelar una cita |
| Servicios | `requiresCustomerCedula` / `requiresCustomerAddress` | (existentes) | Solo al agendar citas |

Backfill (una sola vez, solo filas con la columna nueva en NULL): `order_shipping ← has_delivery`, `order_requires_deposit ← requires_deposit`, `order_requires_cedula ← requires_customer_cedula`. `order_shipping_zone`, `order_deposit_amount` y `order_policy` arrancan vacíos (ver Task 1; las políticas actuales hablan de citas).

## Archivos

- Modify `whatsapp-crm/prisma/schema.prisma` (model Store)
- Modify `whatsapp-crm/src/prisma/prisma.service.ts` (STARTUP_MIGRATIONS)
- Modify `whatsapp-crm/src/stores/dto/create-store.dto.ts`
- Create `whatsapp-crm/src/ai/store-config.util.ts` + `store-config.util.spec.ts`
- Modify `whatsapp-crm/src/ai/ai.service.ts` (helpers sueltos → util; prompt; extractor de pedidos; mensaje de pedido; cancelación de cita)
- Modify `stockup-frontend/src/pages/Config.tsx`

---

### Task 1: Esquema, migración y DTO

**Files:** `prisma/schema.prisma`, `src/prisma/prisma.service.ts`, `src/stores/dto/create-store.dto.ts`

- [ ] **Step 1:** En `model Store`, después de `requiresCustomerCedula`, añadir:

```prisma
  // ── Pedidos de productos (separado de la config de citas) ──
  orderShipping        Boolean @default(false) @map("order_shipping")
  orderShippingZone    String? @map("order_shipping_zone")
  orderRequiresDeposit Boolean @default(false) @map("order_requires_deposit")
  orderDepositAmount   String? @map("order_deposit_amount")
  orderPolicy          String? @map("order_policy")
  orderRequiresCedula  Boolean @default(false) @map("order_requires_cedula")
```

- [ ] **Step 2:** Al final de `STARTUP_MIGRATIONS` (antes del `]`), añadir. Patrón: columna nullable → backfill solo de NULL → default → NOT NULL. Re-ejecutarlo no cambia nada.

```ts
  // ── Config de pedidos separada de la de citas (2026-10-06) ──
  `ALTER TABLE stores ADD COLUMN IF NOT EXISTS order_shipping BOOLEAN`,
  `UPDATE stores SET order_shipping = has_delivery WHERE order_shipping IS NULL`,
  `ALTER TABLE stores ALTER COLUMN order_shipping SET DEFAULT false`,
  `ALTER TABLE stores ALTER COLUMN order_shipping SET NOT NULL`,
  `ALTER TABLE stores ADD COLUMN IF NOT EXISTS order_requires_deposit BOOLEAN`,
  `UPDATE stores SET order_requires_deposit = requires_deposit WHERE order_requires_deposit IS NULL`,
  `ALTER TABLE stores ALTER COLUMN order_requires_deposit SET DEFAULT false`,
  `ALTER TABLE stores ALTER COLUMN order_requires_deposit SET NOT NULL`,
  `ALTER TABLE stores ADD COLUMN IF NOT EXISTS order_requires_cedula BOOLEAN`,
  `UPDATE stores SET order_requires_cedula = requires_customer_cedula WHERE order_requires_cedula IS NULL`,
  `ALTER TABLE stores ALTER COLUMN order_requires_cedula SET DEFAULT false`,
  `ALTER TABLE stores ALTER COLUMN order_requires_cedula SET NOT NULL`,
  `ALTER TABLE stores ADD COLUMN IF NOT EXISTS order_shipping_zone TEXT`,
  `ALTER TABLE stores ADD COLUMN IF NOT EXISTS order_deposit_amount TEXT`,
  `ALTER TABLE stores ADD COLUMN IF NOT EXISTS order_policy TEXT`,
```

Los campos de texto (`order_shipping_zone`, `order_deposit_amount`) NO se copian: en ellos NULL es un valor válido, así que un `UPDATE … WHERE … IS NULL` volvería a pisarlos en cada arranque después de que el usuario los vacíe. Y hoy `delivery_zone` y `deposit_amount` están vacíos en las 8 tiendas (verificado 2026-10-06), así que no se pierde nada. Por eso el Backfill de arriba queda reducido a los tres booleanos.

- [ ] **Step 3:** En `CreateStoreDto`, bajo `requiresCustomerCedula`:

```ts
  // Pedidos de productos (los campos de arriba son de citas)
  @IsBoolean() @IsOptional() @Type(() => Boolean) orderShipping?: boolean;
  @IsString()  @IsOptional() orderShippingZone?: string;
  @IsBoolean() @IsOptional() @Type(() => Boolean) orderRequiresDeposit?: boolean;
  @IsString()  @IsOptional() orderDepositAmount?: string;
  @IsString()  @IsOptional() orderPolicy?: string;
  @IsBoolean() @IsOptional() @Type(() => Boolean) orderRequiresCedula?: boolean;
```

- [ ] **Step 4:** `npx prisma generate && npx tsc --noEmit -p tsconfig.json` → sin errores. (Ojo: `src/generated/prisma` cambia; NO commitear archivos generados que no cambien de verdad.)
- [ ] **Step 5:** Commit `feat(config): campos de pedidos separados de los de citas`.

### Task 2: Módulo puro `store-config.util.ts` (TDD)

**Files:** Create `src/ai/store-config.util.ts`, `src/ai/store-config.util.spec.ts`; en `ai.service.ts` borrar `storeShips`/`pickupLabel`/`depositText` (sin commitear, de la sesión anterior).

- [ ] **Step 1: test** `src/ai/store-config.util.spec.ts`:

```ts
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
    expect(orderConfig(null)).toEqual({ ships: false, zone: null, pickup: 'Recoge en tienda', deposit: null, policy: null, cedula: false });
  });
});

describe('textos de política y anticipo', () => {
  it('política de pedidos: usa la de pedidos, nunca la de citas', () => {
    expect(orderPolicyRule({ cancellationPolicy: '2 h antes' })).toContain('asesor');
    expect(orderPolicyRule({ orderPolicy: 'Cambios en 5 días' })).toContain('Cambios en 5 días');
  });
  it('anticipo de citas: solo con el toggle de citas', () => {
    expect(apptDepositText({ orderRequiresDeposit: true })).toBeNull();
    expect(apptDepositText({ requiresDeposit: true, depositAmount: '20000' }))
      .toBe('Se requiere un anticipo de 20000 para confirmar la cita.');
  });
  it('nota de cancelación de cita: solo si hay política', () => {
    expect(apptCancelNote({})).toBe('');
    expect(apptCancelNote({ cancellationPolicy: 'Cancelar con 2 h' })).toBe('\n\n📋 Recuerda nuestra política: Cancelar con 2 h');
  });
});
```

- [ ] **Step 2:** `npx jest src/ai/store-config.util.spec.ts` → FAIL (módulo no existe).
- [ ] **Step 3: implementación** `src/ai/store-config.util.ts`:

```ts
// Lectura ÚNICA de la config de la tienda que cambia el flujo de la IA.
// Pedidos usan SOLO campos order*; citas usan SOLO los campos históricos.
// Regla: un ajuste que la IA ignora es un bug (ver plan 2026-10-06).

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

export function apptCancelNote(store: any): string {
  const p = clean(store?.cancellationPolicy);
  return p ? `\n\n📋 Recuerda nuestra política: ${p}` : '';
}
```

- [ ] **Step 4:** test → PASS. Borrar de `ai.service.ts` las funciones `storeShips`, `pickupLabel`, `depositText` (no commiteadas) y revertir la línea de `negocioLines` que las usaba (la reescribe Task 3).
- [ ] **Step 5:** Commit `feat(ia): store-config.util — lectura única de la config de pedidos y citas`.

### Task 3: Prompt — información del negocio y flujo de pedido

**Files:** `src/ai/ai.service.ts` (`buildSystemPrompt`: bloque `negocioLines` y `flujoSection`)

- [ ] **Step 1:** Import: `import { orderConfig, orderPolicyRule, apptDepositText } from './store-config.util';`
- [ ] **Step 2:** En `negocioLines`, reemplazar las líneas de anticipo / cancelación / domicilio por:

```ts
      const oc = orderConfig(store);
      if (products.length > 0) {
        if (oc.ships) negocioLines.push(`🚚 PEDIDOS: hacemos envíos${oc.zone ? ` solo a: ${oc.zone}` : ''}.`);
        else          negocioLines.push(`🏪 PEDIDOS: NO hacemos envíos. ${oc.pickup}.`);
        if (oc.deposit) negocioLines.push(`💰 PEDIDOS: ${oc.deposit}`);
        if (oc.policy)  negocioLines.push(`🔁 PEDIDOS — cambios/devoluciones/cancelación: ${oc.policy}`);
      }
      if (services.length > 0) {
        const ad = apptDepositText(store);
        if (ad)                       negocioLines.push(`💰 CITAS: ${ad}`);
        if (store.cancellationPolicy) negocioLines.push(`❌ CITAS — cancelación: ${store.cancellationPolicy}`);
        if (store.hasDelivery)        negocioLines.push(`🏠 CITAS: atendemos a domicilio${store.deliveryZone ? ` en: ${store.deliveryZone}` : ''}.`);
      }
```

- [ ] **Step 3:** En el flujo de pedido: `requiresCedula` pasa a `oc.cedula && !customer.cedula`; `pedidoAsks`, puntos c/d del checklist y el RESUMEN dependen de `oc.ships`:

```ts
    const oc = orderConfig(store);
    const requiresCedula = oc.cedula && !customer.cedula;
    const needsPhone = isLidIdentity(customer.phone ?? '');
    const pedidoAsks = [
      'nombre completo de quien recibe',
      oc.ships ? 'dirección completa con barrio' : null,
      oc.ships ? 'ciudad o municipio' : null,
      needsPhone ? 'un número de celular de contacto' : null,
      requiresCedula ? 'número de cédula' : null,
    ].filter(Boolean).join(', ');
    const entregaLines = oc.ships
      ? `  c) Dirección completa con barrio.
  d) Ciudad o municipio.${oc.zone ? ` SOLO enviamos a: ${oc.zone}. Si la ciudad no está ahí, díselo ANTES de tomar el pedido.` : ''}`
      : `  c) ENTREGA: este negocio NO hace envíos. ${oc.pickup}. NO pidas dirección ni ciudad; díselo al cliente.`;
```

y en el texto: sustituir las líneas `c)`/`d)` por `${entregaLines}`; en el RESUMEN usar `${oc.ships ? 'dirección, ciudad' : 'que recoge en tienda'}`; añadir tras `SOBRE ENVÍO Y PAGOS:`:

```ts
${oc.deposit ? `- ANTICIPO: ${oc.deposit} Inclúyelo en el resumen.\n` : ''}${orderPolicyRule(store)}
```

- [ ] **Step 4:** `npx tsc --noEmit -p tsconfig.json` y `npx jest` → verdes.
- [ ] **Step 5:** Commit `feat(ia): el prompt usa la config de pedidos y de citas por separado`.

### Task 4: Extractor de pedidos y mensaje de pedido registrado

**Files:** `src/ai/ai.service.ts` (`tryExtractAndCreateOrder`)

- [ ] **Step 1:** Al inicio: `const oc = orderConfig(store);` y `const requiresCedula = oc.cedula;` (en lugar de `store?.requiresCustomerCedula`).
- [ ] **Step 2:** Regla b) del prompt del extractor:

```ts
   b) ${oc.ships
     ? 'Dirección con calle, carrera, barrio o similar (solo ciudad NO es suficiente) Y la ciudad o municipio (sin ciudad → false)'
     : 'No aplica: el negocio NO hace envíos, el cliente recoge en tienda (deliveryAddress = null)'}
```

- [ ] **Step 3:** Justo después de `extracted = JSON.parse(jsonMatch[0]);` y también en los caminos de caché (Caso 1 y 1.5), si `!oc.ships` forzar `extracted.deliveryAddress = oc.pickup`. Forma única: tras todo el bloque if/else de casos y antes de `if (!extracted?.complete)`:

```ts
    if (extracted && !oc.ships) extracted.deliveryAddress = oc.pickup;
```

- [ ] **Step 4:** Mensaje de pedido registrado:

```ts
          (oc.ships ? `📍 Dirección de entrega: ${extracted.deliveryAddress}` : `🏪 ${oc.pickup}`) +
          (oc.deposit ? `\n\n💰 ${oc.deposit}` : '') +
```

- [ ] **Step 5:** tsc + jest verdes. Commit `feat(ia): extractor y mensaje de pedido respetan envíos, anticipo y cédula de pedidos`.

### Task 5: Cancelación de cita con su política

**Files:** `src/ai/ai.service.ts` (`tryHandleCancelOrReschedule` y su llamada)

- [ ] **Step 1:** Añadir parámetro final `store: any = null` a `tryHandleCancelOrReschedule` y pasarlo en la llamada (`..., activeStaff, store)`; `store` ya existe en ese punto del flujo.
- [ ] **Step 2:** Mensaje de cancelación:

```ts
    return '🗑 Tu solicitud de *cancelación* fue enviada al equipo. Un asesor la procesará y te confirmará en breve ✅' + apptCancelNote(store);
```

- [ ] **Step 3:** tsc + jest. Commit `feat(ia): la cancelación de cita recuerda la política del negocio`.

### Task 6: Panel — Config.tsx en tres bloques

**Files:** `stockup-frontend/src/pages/Config.tsx`

- [ ] **Step 1:** Estado/carga/guardado: añadir `orderShipping`, `orderShippingZone`, `orderRequiresDeposit`, `orderDepositAmount`, `orderPolicy`, `orderRequiresCedula` al `useState` inicial (false/''), al objeto `loaded` (`d.orderShipping ?? false`, …) y al `updateStore` (`orderShippingZone: form.orderShippingZone || undefined`, …).
- [ ] **Step 2:** Contar productos para la nota: `getProducts().then(r => setProductCount(r.data.length)).catch(() => {})` junto al `getServices` existente; `services.length` ya existe.
- [ ] **Step 3:** Encabezado de bloque reutilizable dentro del componente:

```tsx
  const GroupTitle = ({ title, sub, empty }: { title: string; sub: string; empty?: string }) => (
    <div className="pt-4">
      <h2 className="text-base font-semibold text-txt-primary">{title}</h2>
      <p className="text-xs text-txt-tertiary">{sub}</p>
      {empty && <p className="mt-2 text-xs text-amber-500">{empty}</p>}
    </div>
  );
```

- [ ] **Step 4:** Orden del formulario:
  1. `<GroupTitle title="General" sub="Aplica a pedidos y citas" />` → Información básica, Contacto y redes, **Métodos de pago** (solo chips + cuenta; el toggle de anticipo SALE de aquí), Horarios de atención.
  2. `<GroupTitle title="Productos" sub="Cómo atiende la IA los pedidos por WhatsApp" empty={productCount === 0 ? 'Aún no tienes productos cargados; esto se aplicará cuando los tengas.' : undefined} />` → tarjeta nueva "Envíos y pedidos" con: toggle `orderShipping` ("Hacemos envíos de productos"), input `orderShippingZone` si ON (placeholder "Ciudades o zonas de envío (vacío = a todo el país)"), texto si OFF ("El cliente recoge en la dirección de la tienda"); toggle `orderRequiresDeposit` + input `orderDepositAmount`; textarea `orderPolicy` ("Política de cambios, devoluciones y cancelación de pedidos"); toggle `orderRequiresCedula` ("Pedir cédula para la guía de envío").
  3. `<GroupTitle title="Servicios" sub="Cómo agenda la IA las citas" empty={services.length === 0 ? 'Aún no tienes servicios cargados; esto se aplicará cuando los tengas.' : undefined} />` → tarjeta "Políticas de citas" (anticipación mínima, auto-confirmar, **toggle anticipo de citas + monto**, política de cancelación de citas, servicio a domicilio + zona —texto "El profesional va a la casa del cliente"—, parqueadero), "Datos del cliente al agendar" (dirección, cédula; subtítulo "¿Qué debe pedir la IA al agendar una cita?"), Tipo de personal, Servicio predeterminado.
  - Las tarjetas se MUEVEN, no se reescriben: mismo markup, mismas clases.
- [ ] **Step 5:** `npx tsc --noEmit` (o `npm run build`) → OK. NO correr `npm run lint` si tiene `--fix` global.
- [ ] **Step 6:** Commit en stockup-frontend `feat(config): separar configuración en General, Productos y Servicios`.

### Task 7: Despliegue y verificación

- [ ] **Step 1:** Push de ambos repos. Backend: Alex lanza el comando de deploy del pod (`git stash push -- src/generated; git pull && npm run build && … restart`).
- [ ] **Step 2:** Log del arranque: las 15 sentencias `[Migration] OK` nuevas, sin `FAIL`.
- [ ] **Step 3:** BD: `select name, has_delivery, order_shipping, requires_customer_cedula, order_requires_cedula from stores` → `order_shipping` = `has_delivery` en las 8 tiendas (Frutatza `t`).
- [ ] **Step 4:** Frontend: confirmar que el despliegue del panel tomó el commit; abrir Configuración y ver los tres bloques con los valores de Frutatza.
- [ ] **Step 5:** Prueba real en Frutatza: pedido → pide dirección y ciudad (envíos ON). Avisar a Alex de las tiendas con productos y envíos OFF (Vida Verde, Coffee Masfred, Glamour, Salón Glamour): ahora la IA les dirá "recoge en tienda".
