# Tienda pública + chatbot de respaldo cuando la IA cae — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cuando la IA se cae (todos los cartuchos agotados), el bot manda UN solo mensaje útil por conversación — saludo + link de cita (`/cal/slug`) y/o link de la nueva tienda pública (`/tienda/slug`) según la intención — y luego se calla. Para soportar el link de productos se construye una página pública de tienda con su endpoint de pedido.

**Architecture:** Se calca el patrón ya existente de auto-agendamiento público (`src/public/public.controller.ts` + `public.service.ts` + `pages/PublicCalendar.tsx`). El `storeId` SIEMPRE se resuelve desde el `slug` (multi-tenant), los precios se leen de la BD (nunca del cliente) y la creación real se delega a `OrdersService.create` (que ya valida tenant y descuenta stock atómicamente). El respaldo de la IA vive en `ai.service.ts` donde hoy hay `return null` (commit `d1cfefb`), y usa detección de intención por palabras clave (no LLM, porque el LLM es justo lo que está caído) + dedup por historial para no repetirse.

**Tech Stack:** NestJS + Prisma (BE), React + Vite + react-router (FE, `stockup-frontend`), Postgres (prod vía túnel SSH `instapod@5.161.231.61:2212`).

---

## File Structure

**Backend (`whatsapp-crm`):**
- `src/public/dto/public-order.dto.ts` — **crear**. DTO del pedido público.
- `src/public/public.service.ts` — **modificar**. Añadir `getProductsBySlug(slug)` y `createOrder(slug, dto)`. Reutiliza `findOrCreateCustomerByPhone` (ya existe, privado).
- `src/public/public.controller.ts` — **modificar**. Añadir `GET :slug/products` y `POST :slug/order` (con el mismo `PublicBookingRateLimitGuard`).
- `src/public/public.module.ts` — **modificar**. Asegurar que `OrdersModule`/`OrdersService` esté disponible para inyección.
- `src/ai/ai.service.ts` — **modificar**. Reemplazar el `return null` del bloque "cartuchos agotados" (~línea 1784) por el chatbot de respaldo (un mensaje, intent-aware, dedup).

**Frontend (`stockup-frontend`):**
- `src/pages/PublicStore.tsx` — **crear**. Página pública de tienda (lista productos, carrito simple, formulario nombre+teléfono, enviar pedido).
- `src/App.tsx` — **modificar**. Añadir `<Route path="/tienda/:slug" element={<PublicStore />} />`.
- `src/lib/api.ts` (o donde estén las llamadas API) — **modificar**. Añadir `getPublicStoreProducts(slug)` y `createPublicOrder(slug, payload)`.

**No hay framework de tests unitarios activo en este repo** (los flujos se validan con `tsc` + `nest build` + verificación manual contra prod por Alex). Por eso cada task verifica con `npx tsc --noEmit`, `npm run build` y, donde aplica, un curl real contra el endpoint vía el túnel. Se conserva el estilo del repo (sin introducir Jest si no está configurado).

---

## Task 1: DTO del pedido público

**Files:**
- Create: `src/public/dto/public-order.dto.ts`

- [ ] **Step 1: Crear el DTO**

Calca el estilo de `src/public/dto/public-booking.dto.ts` (mismo proyecto, class-validator).

```typescript
import { IsString, IsNotEmpty, IsArray, ArrayMinSize, ValidateNested, IsOptional, IsInt, Min, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

class PublicOrderItemDto {
  @IsString() @IsNotEmpty()
  productId!: string;

  @IsOptional() @IsString()
  variantId?: string;

  @IsInt() @Min(1)
  quantity!: number;
}

export class PublicOrderDto {
  @IsString() @IsNotEmpty()
  customerName!: string;

  @IsString() @IsNotEmpty()
  customerPhone!: string;

  @IsArray() @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PublicOrderItemDto)
  items!: PublicOrderItemDto[];

  // Método de pago a coordinar en el local; set acotado igual que el resto de la plataforma.
  @IsOptional() @IsIn(['efectivo', 'transferencia', 'tarjeta', 'nequi', 'daviplata', 'otro'])
  paymentMethod?: string;

  @IsOptional() @IsString()
  notes?: string;
}
```

- [ ] **Step 2: Verificar que compila**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/public/dto/public-order.dto.ts
git commit -m "feat(public): DTO de pedido público (tienda)"
```

---

## Task 2: PublicService — getProductsBySlug + createOrder

**Files:**
- Modify: `src/public/public.service.ts`
- Modify: `src/public/public.module.ts`

**Contexto clave (ya verificado en el código):**
- `findOrCreateCustomerByPhone(storeId, digits, name)` ya existe como método privado en `public.service.ts` (líneas ~148-156) — reutilizarlo tal cual.
- `OrdersService.create(dto: CreateOrderDto)` valida `customer.storeId === dto.storeId`, valida que cada `productId/variantId` pertenezca a `dto.storeId`, descuenta stock atómicamente y soporta `idempotencyKey`. Firma de items: `{ productId?, serviceId?, variantId?, quantity, unitPrice, description? }`. Campos top-level usados: `storeId`, `customerId`, `items`, `discountPercent?`, `idempotencyKey?`, `paymentMethod?`, `source?`.
- El precio del item lo pone el SERVIDOR desde `product.salePrice` / `variant.priceOverride` — NUNCA del cliente.

- [ ] **Step 1: Inyectar OrdersService en PublicService**

En `public.service.ts`, añadir el import y el parámetro del constructor:

```typescript
import { OrdersService } from '../orders/orders.service';
```

En el constructor, añadir:

```typescript
    private readonly orders: OrdersService,
```

- [ ] **Step 2: Asegurar OrdersService disponible en PublicModule**

En `src/public/public.module.ts`, añadir `OrdersModule` a `imports` (revisar primero si ya está). Si `OrdersService` no se exporta desde `OrdersModule`, exportarlo allí. Ejemplo del import:

```typescript
import { OrdersModule } from '../orders/orders.module';
// ...
@Module({
  imports: [/* ...existentes..., */ OrdersModule],
  // ...
})
```

- [ ] **Step 3: Añadir getProductsBySlug**

En `public.service.ts`, método público nuevo (calca el `select` de `getStoreBySlug`):

```typescript
  async getProductsBySlug(slug: string) {
    const store = await this.prisma.store.findUnique({
      where:  { slug },
      select: { storeId: true, name: true, paymentMethods: true },
    });
    if (!store) throw new NotFoundException('Negocio no encontrado');

    const products = await this.prisma.product.findMany({
      where:   { storeId: store.storeId, isActive: true, stock: { gt: 0 } },
      orderBy: { createdAt: 'asc' },
      select: {
        productId:   true,
        name:        true,
        description: true,
        salePrice:   true,
        stock:       true,
        imageUrl:    true,
        images:      true,
        hasVariants: true,
        variants: {
          where:   { isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: { variantId: true, name: true, priceOverride: true, stock: true },
        },
      },
    });

    return { name: store.name, paymentMethods: store.paymentMethods ?? [], products };
  }
```

- [ ] **Step 4: Añadir createOrder (calca bookAppointment)**

```typescript
  // Pedido público (plan de emergencia si la IA falla). storeId desde el slug,
  // precios leídos de la BD (no del cliente), creación delegada a OrdersService.create
  // que valida tenant y descuenta stock atómicamente.
  async createOrder(slug: string, dto: PublicOrderDto) {
    const store = await this.prisma.store.findUnique({
      where:  { slug },
      select: { storeId: true },
    });
    if (!store) throw new NotFoundException('Negocio no encontrado');
    const { storeId } = store;

    const digits = normalizePhone(dto.customerPhone);
    if (digits.length < 7) throw new BadRequestException('El número de teléfono no es válido.');

    const customer = await this.findOrCreateCustomerByPhone(storeId, digits, dto.customerName.trim());

    // Resolver precio y validar pertenencia de cada item desde la BD (nunca confiar en el cliente).
    const items = [];
    for (const it of dto.items) {
      const product = await this.prisma.product.findFirst({
        where:  { productId: it.productId, storeId, isActive: true },
        select: { productId: true, name: true, salePrice: true, hasVariants: true },
      });
      if (!product) throw new BadRequestException('Un producto seleccionado no existe.');

      let unitPrice = Number(product.salePrice);
      let variantId: string | undefined;
      if (it.variantId) {
        const variant = await this.prisma.productVariant.findFirst({
          where:  { variantId: it.variantId, product: { storeId } },
          select: { variantId: true, priceOverride: true },
        });
        if (!variant) throw new BadRequestException('Una variante seleccionada no existe.');
        variantId = variant.variantId;
        if (variant.priceOverride != null) unitPrice = Number(variant.priceOverride);
      }

      items.push({
        productId:   product.productId,
        variantId,
        quantity:    it.quantity,
        unitPrice,
        description: product.name,
      });
    }

    const order = await this.orders.create({
      storeId,
      customerId:     customer.customerId,
      items,
      paymentMethod:  dto.paymentMethod,
      notes:          dto.notes,
      idempotencyKey: `pub-${storeId}-${customer.customerId}-${Date.now()}`,
      source:         'public',
    } as any);

    this.notifications.notifyOrderCreated?.(order as any, 'public').catch?.(() => {});

    return {
      orderId: (order as any).orderId,
      total:   (order as any).total,
      status:  (order as any).status,
    };
  }
```

> NOTA para el ejecutor: verificar la firma EXACTA de `CreateOrderDto` (`src/orders/dto/create-order.dto.ts`) y de `notifyOrderCreated` antes de finalizar. Si `source` no es campo válido de `CreateOrderDto`, quitarlo. Si no existe `notifyOrderCreated`, omitir la línea de notificación (no inventar métodos). El `as any` del payload es temporal: ajustarlo a los nombres reales del DTO.

- [ ] **Step 5: Importar el DTO en public.service.ts**

```typescript
import { PublicOrderDto } from './dto/public-order.dto';
```

- [ ] **Step 6: Verificar compilación y build**

Run: `npx tsc --noEmit -p tsconfig.json && npm run build`
Expected: exit 0 en ambos.

- [ ] **Step 7: Commit**

```bash
git add src/public/public.service.ts src/public/public.module.ts
git commit -m "feat(public): getProductsBySlug + createOrder (tienda pública)"
```

---

## Task 3: PublicController — endpoints de tienda

**Files:**
- Modify: `src/public/public.controller.ts`

- [ ] **Step 1: Añadir los dos endpoints**

Calca exactamente el estilo de `book` (mismo guard de rate-limit). Añadir dentro de la clase:

```typescript
  @Get(':slug/products')
  getProducts(@Param('slug') slug: string) {
    return this.publicService.getProductsBySlug(slug);
  }

  @UseGuards(PublicBookingRateLimitGuard)
  @Post(':slug/order')
  order(@Param('slug') slug: string, @Body() dto: PublicOrderDto) {
    return this.publicService.createOrder(slug, dto);
  }
```

Y el import arriba:

```typescript
import { PublicOrderDto } from './dto/public-order.dto';
```

- [ ] **Step 2: Verificar compilación**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 3: Probar contra prod (con el túnel arriba) — solo lectura primero**

Run (PowerShell o curl): `curl -s https://stockup-backend.../public/nextlevelbarbershop/products | head`
> NOTA: usar la URL real del backend en prod (revisar `FRONTEND_URL`/config). Verificar que devuelve JSON con `products: [...]`. Aún NO probar el POST de orden contra prod hasta tener el FE; o probarlo con un producto de prueba y luego borrar la orden.

- [ ] **Step 4: Commit**

```bash
git add src/public/public.controller.ts
git commit -m "feat(public): endpoints GET :slug/products y POST :slug/order"
```

---

## Task 4: Frontend — página pública de tienda

**Files:**
- Create: `stockup-frontend/src/pages/PublicStore.tsx`
- Modify: `stockup-frontend/src/App.tsx`
- Modify: `stockup-frontend/src/lib/api.ts` (ruta real del cliente API — verificar)

**Contexto:** Calcar `stockup-frontend/src/pages/PublicCalendar.tsx` (misma forma de leer `:slug` con `useParams`, mismo cliente API, mismo estilo Tailwind y manejo de loading/error). NO reinventar el layout: copiar la cáscara visual del PublicCalendar.

- [ ] **Step 1: Leer PublicCalendar.tsx completo como referencia**

Run: abrir `stockup-frontend/src/pages/PublicCalendar.tsx`. Identificar: cómo obtiene el base URL del API, cómo usa `useParams`, el patrón loading/error, y los componentes de UI reutilizables (botones, cards) para mantener consistencia visual.

- [ ] **Step 2: Añadir las llamadas API**

En el archivo de api del front (donde están las del PublicCalendar, ej. `getPublicStore`/`bookPublic`), añadir:

```typescript
export const getPublicStoreProducts = (slug: string) =>
  api.get(`/public/${slug}/products`).then(r => r.data);

export const createPublicOrder = (slug: string, payload: {
  customerName: string; customerPhone: string;
  items: { productId: string; variantId?: string; quantity: number }[];
  paymentMethod?: string; notes?: string;
}) => api.post(`/public/${slug}/order`, payload).then(r => r.data);
```

- [ ] **Step 3: Crear PublicStore.tsx**

Página con: header (nombre del negocio), grilla de productos (imagen, nombre, precio, stock), carrito simple en estado local (`Map<productId, qty>`), formulario (nombre + teléfono + método de pago opcional), botón "Hacer pedido" → `createPublicOrder`, y pantalla de éxito ("¡Pedido registrado! El negocio te contactará"). Manejar loading y error como PublicCalendar.

```tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getPublicStoreProducts, createPublicOrder } from '../lib/api';

export default function PublicStore() {
  const { slug = '' } = useParams();
  const [data, setData] = useState<any>(null);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [pay, setPay] = useState('');
  const [done, setDone] = useState<any>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    getPublicStoreProducts(slug)
      .then(setData)
      .catch(() => setErr('No pudimos cargar la tienda.'))
      .finally(() => setLoading(false));
  }, [slug]);

  const setQty = (id: string, q: number) =>
    setCart(c => { const n = { ...c }; if (q <= 0) delete n[id]; else n[id] = q; return n; });

  const items = Object.entries(cart).map(([productId, quantity]) => ({ productId, quantity }));
  const total = (data?.products ?? [])
    .filter((p: any) => cart[p.productId])
    .reduce((s: number, p: any) => s + Number(p.salePrice) * cart[p.productId], 0);

  const submit = async () => {
    setErr('');
    if (!name.trim() || phone.replace(/\D/g, '').length < 7) { setErr('Pon tu nombre y un teléfono válido.'); return; }
    if (items.length === 0) { setErr('Agrega al menos un producto.'); return; }
    setSubmitting(true);
    try {
      const res = await createPublicOrder(slug, { customerName: name, customerPhone: phone, items, paymentMethod: pay || undefined });
      setDone(res);
    } catch {
      setErr('No se pudo registrar el pedido. Intenta de nuevo.');
    } finally { setSubmitting(false); }
  };

  if (loading) return <div className="p-8 text-center">Cargando…</div>;
  if (err && !data) return <div className="p-8 text-center text-red-600">{err}</div>;
  if (done) return (
    <div className="max-w-md mx-auto p-8 text-center">
      <h1 className="text-2xl font-bold mb-2">¡Pedido registrado! 🎉</h1>
      <p>El negocio te contactará para coordinar la entrega y el pago.</p>
    </div>
  );

  return (
    <div className="max-w-2xl mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">{data.name}</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {data.products.map((p: any) => (
          <div key={p.productId} className="border rounded-xl p-3 flex flex-col">
            {p.imageUrl && <img src={p.imageUrl} alt={p.name} className="h-32 w-full object-cover rounded-lg mb-2" />}
            <div className="font-semibold">{p.name}</div>
            <div className="text-sm text-gray-500">${Number(p.salePrice).toLocaleString('es-CO')}</div>
            <div className="mt-auto flex items-center gap-2 pt-2">
              <button className="px-2 py-1 border rounded" onClick={() => setQty(p.productId, (cart[p.productId] ?? 0) - 1)}>-</button>
              <span>{cart[p.productId] ?? 0}</span>
              <button className="px-2 py-1 border rounded" onClick={() => setQty(p.productId, (cart[p.productId] ?? 0) + 1)}>+</button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 space-y-2">
        <input className="w-full border rounded-lg p-2" placeholder="Tu nombre" value={name} onChange={e => setName(e.target.value)} />
        <input className="w-full border rounded-lg p-2" placeholder="Tu teléfono (WhatsApp)" value={phone} onChange={e => setPhone(e.target.value)} />
        {(data.paymentMethods ?? []).length > 0 && (
          <select className="w-full border rounded-lg p-2" value={pay} onChange={e => setPay(e.target.value)}>
            <option value="">Método de pago (opcional)</option>
            {data.paymentMethods.map((m: string) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        {err && <div className="text-red-600 text-sm">{err}</div>}
        <button disabled={submitting} className="w-full bg-black text-white rounded-lg p-3 disabled:opacity-50" onClick={submit}>
          {submitting ? 'Enviando…' : `Hacer pedido${total ? ` · $${total.toLocaleString('es-CO')}` : ''}`}
        </button>
      </div>
    </div>
  );
}
```

> NOTA: ajustar imports (`api` base, clases Tailwind) a lo que use realmente PublicCalendar. Si el front usa un cliente API distinto a axios `api`, adaptarlo.

- [ ] **Step 4: Registrar la ruta**

En `src/App.tsx`, junto a `<Route path="/cal/:slug" ... />`:

```tsx
import PublicStore from './pages/PublicStore';
// ...
<Route path="/tienda/:slug" element={<PublicStore />} />
```

- [ ] **Step 5: Verificar build del front**

Run (en `stockup-frontend`): `npm run build`
Expected: build OK, sin errores de tipos.

- [ ] **Step 6: Commit**

```bash
git add stockup-frontend/src/pages/PublicStore.tsx stockup-frontend/src/App.tsx stockup-frontend/src/lib/api.ts
git commit -m "feat(public): página pública de tienda /tienda/:slug"
```

---

## Task 5: Chatbot de respaldo cuando la IA cae (un mensaje, intent-aware, sin repetir)

**Files:**
- Modify: `src/ai/ai.service.ts` (bloque "cartuchos agotados", ~línea 1784, donde hoy hay `return null` del commit `d1cfefb`)

**Comportamiento:**
1. Detectar intención por palabras clave (NO LLM): cita vs producto.
2. Construir UN mensaje con saludo + el/los link(s) correspondientes.
3. Dedup: si en el historial reciente (`history`) ya hay un mensaje de respaldo de la IA, devolver `null` (silencio) — así NO se repite en cada mensaje del cliente (que fue justo el bug del incidente).

- [ ] **Step 1: Helper de intención y de mensaje (a nivel módulo, cerca de los otros helpers)**

```typescript
// Respaldo determinístico cuando el LLM está caído. Detecta intención por palabras
// clave (no usa LLM porque el LLM es justo lo que falló) y arma UN mensaje con los
// links públicos. Un marcador invisible permite detectar en el historial que ya se
// envió, para no repetirlo en cada mensaje (el spam del incidente del 2026-06-18).
const FALLBACK_MARKER = 'no está disponible en este momento';
const PRODUCT_INTENT_RE = /\b(producto|productos|comprar|compra|vende[ns]?|precio de|cu[aá]nto vale|domicilio|env[ií]o|gel|cera|shampoo|pomada|cuesta)\b/i;
const APPT_INTENT_RE    = /\b(cita|agendar|agenda|turno|corte|barba|cejas?|hora|disponib|reservar|peluqu)\b/i;

function buildFallbackMessage(opts: { hasSlug: boolean; frontendUrl: string; slug?: string; lastUserText: string }): string | null {
  if (!opts.hasSlug || !opts.frontendUrl || !opts.slug) return null;
  const cal    = `${opts.frontendUrl}/cal/${opts.slug}`;
  const tienda = `${opts.frontendUrl}/tienda/${opts.slug}`;
  const t = opts.lastUserText;
  const wantsProduct = PRODUCT_INTENT_RE.test(t);
  const wantsAppt    = APPT_INTENT_RE.test(t);

  let cuerpo: string;
  if (wantsProduct && !wantsAppt) {
    cuerpo = `Para tu compra, puedes ver los productos y dejar tu pedido aquí:\n🛍️ ${tienda}`;
  } else if (wantsAppt && !wantsProduct) {
    cuerpo = `Para agendar tu cita, entra aquí y elige horario:\n📅 ${cal}`;
  } else {
    cuerpo = `Si quieres agendar una cita: 📅 ${cal}\nSi buscas un producto: 🛍️ ${tienda}`;
  }
  return `¡Hola! 👋 Nuestro asistente ${FALLBACK_MARKER}, pero vuelve muy pronto. ${cuerpo}`;
}
```

- [ ] **Step 2: Reemplazar el bloque de cartuchos agotados**

En `ai.service.ts`, sustituir el bloque actual (commit `d1cfefb`):

```typescript
      if (reply === undefined) {
        // Todos los cartuchos agotados ...
        this.logger.error(`[Pool] Todos los cartuchos agotados para store ${storeId} — silencio (no se envía fallback)`);
        return null;
      }
```

por:

```typescript
      if (reply === undefined) {
        // Todos los cartuchos agotados. En vez de silencio total (o del spam viejo),
        // mandamos UN mensaje útil con los links públicos — pero solo si no lo mandamos
        // ya en esta conversación (dedup por historial), para no repetirlo en cada turno.
        this.logger.error(`[Pool] Todos los cartuchos agotados para store ${storeId} — respaldo`);
        const yaEnviado = (history ?? []).some(
          (m: any) => m?.isAiResponse && typeof m.content === 'string' && m.content.includes(FALLBACK_MARKER),
        );
        if (yaEnviado) {
          this.logger.log(`[Pool] Respaldo ya enviado en esta conversación → silencio`);
          return null;
        }
        const frontendUrl = (process.env.FRONTEND_URL ?? '').replace(/\/$/, '');
        return buildFallbackMessage({
          hasSlug:      !!store?.slug,
          frontendUrl,
          slug:         store?.slug ?? undefined,
          lastUserText: latestMessage ?? '',
        });
      }
```

> NOTA: confirmar que en ese scope existen las variables `history`, `store`, `storeId` y `latestMessage` (el plan asume sus nombres del código actual). Si el último mensaje del usuario tiene otro nombre de variable, ajustarlo. Si `buildFallbackMessage` devuelve `null` (sin slug/frontendUrl), el flujo manda silencio — comportamiento aceptable.

- [ ] **Step 3: Verificar compilación y build**

Run: `npx tsc --noEmit -p tsconfig.json && npm run build`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/ai/ai.service.ts
git commit -m "feat(ia): chatbot de respaldo (un mensaje + links públicos) al caer el LLM"
```

---

## Task 6: Deploy + verificación en prod

- [ ] **Step 1: Push de todo**

```bash
git push origin main
```

- [ ] **Step 2: Deploy BE en el pod (vía SSH `instapod@5.161.231.61:2212`, sudo disponible)**

```bash
ssh -p 2212 instapod@5.161.231.61 'cd ~/app && git checkout -- src/generated/prisma; git pull origin main && npm run build && sudo systemctl restart app.service'
```

Verificar: `ssh -p 2212 instapod@5.161.231.61 'systemctl show app.service -p ExecMainPID -p ActiveEnterTimestamp'` (debe mostrar reinicio reciente).

- [ ] **Step 3: Deploy FE**

El front es Vercel (`stockup-frontend.vercel.app`) — auto-deploy al pushear a `main`. Confirmar deploy verde en Vercel.

- [ ] **Step 4: Verificación manual (Alex)**

- Abrir `https://stockup-frontend.vercel.app/tienda/nextlevelbarbershop` → ver productos, hacer un pedido de prueba, confirmar que llega a Pedidos en el panel (y borrarlo).
- Simular IA caída (o esperar a un agotamiento real) y confirmar: llega UN solo mensaje con el link correcto según lo que pida el cliente, y que NO se repite en mensajes siguientes de la misma conversación.

---

## Self-Review

- **Cobertura del spec:** (1) página pública de productos → Tasks 1-4. (2) chatbot de respaldo un-mensaje-intent-aware-sin-repetir → Task 5. (3) link de cita ya existía; link de tienda nuevo → cubierto. ✅
- **Placeholders:** los `as any` y las "NOTA para el ejecutor" son intencionales (puntos donde hay que confirmar la firma real de `CreateOrderDto`/`notifyOrderCreated`/cliente API del front, que no se leyeron byte a byte en el plan). No son TODOs de lógica, son verificaciones de integración. El ejecutor DEBE leer `create-order.dto.ts` y el api del front antes de finalizar Tasks 2 y 4.
- **Consistencia de tipos:** `PublicOrderDto` (Task 1) se usa igual en Tasks 2-3. `items: {productId, variantId?, quantity}` consistente FE↔BE (el FE no manda precio; el BE lo resuelve). `FALLBACK_MARKER` definido y usado en Task 5. ✅
- **Riesgo principal:** la firma de `CreateOrderDto` y si `OrdersService` se exporta desde `OrdersModule`. El ejecutor lo verifica en Task 2 (Steps 2 y 4) antes del commit.
