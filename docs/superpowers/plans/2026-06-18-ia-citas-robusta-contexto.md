# IA de citas robusta — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la IA agende clientes (incluido el desordenado) rápido y limpio, nunca pierda una cita ya creada, no interrogue de más, y calle cuando el mensaje no es del negocio.

**Architecture:** Cambios concentrados en el backend NestJS (`whatsapp-crm`): `ai.service.ts` (contexto desde BD + prompt), `whatsapp.service.ts` + `customers.service.ts` (nombre auto con pushName), schema/DTO/stores (servicio predeterminado). Frontend (`stockup-frontend`): un selector en Config. **Restricción dura:** se reutiliza `AppointmentsService.create()` y `computeSlotsForAI`; NO se modifica la lógica de disponibilidad/anti-doble-booking que ya funciona.

**Tech Stack:** NestJS 11, Prisma 6 (PostgreSQL), Baileys v7, React 19 + TS (CRA), Tailwind.

**Spec:** `docs/superpowers/specs/2026-06-18-ia-citas-robusta-contexto-design.md`

**Sin tests automatizados:** el repo no tiene suite (`*.spec.ts` solo trae `app.controller.spec.ts`). Cada tarea se verifica con `npx tsc --noEmit` + `npm run build` (backend) / `npx tsc --noEmit` + `npx eslint` (frontend) y, al final, escenarios manuales. NO inventar un framework de tests.

**Rutas de los repos:**
- Backend: `C:\Users\alexp\Desktop\proyectos\whatsapp-crm`
- Frontend: `C:\Users\alexp\Desktop\proyectos\stockup-frontend`

**Nota sobre números de línea:** son anclas al estado actual; pueden correrse al editar. Localiza por el texto citado, no solo por el número.

---

## Task 1: Backend — campo `defaultServiceId` en Store (schema + migración + DTO + validación)

**Files:**
- Modify: `prisma/schema.prisma` (model Store, ~línea 96)
- Modify: `src/prisma/prisma.service.ts` (`STARTUP_MIGRATIONS`, ~línea 8)
- Modify: `src/stores/dto/create-store.dto.ts` (~línea 53)
- Modify: `src/stores/stores.service.ts` (`update`, ~línea 63)

- [ ] **Step 1: Agregar la columna al schema**

En `prisma/schema.prisma`, dentro de `model Store`, justo después de la línea `slug String? @unique @map("slug") @db.VarChar(100)` (~96), agregar:

```prisma
  defaultServiceId String? @map("default_service_id")  // servicio usado cuando el cliente no especifica
```

- [ ] **Step 2: Agregar la migración aditiva idempotente**

En `src/prisma/prisma.service.ts`, dentro del array `STARTUP_MIGRATIONS` (~línea 8), agregar como último elemento:

```ts
  `ALTER TABLE stores ADD COLUMN IF NOT EXISTS default_service_id TEXT`,
```

- [ ] **Step 3: Exponer el campo en el DTO**

En `src/stores/dto/create-store.dto.ts`, después del bloque `slug` (~línea 53, antes del `}` de cierre de la clase), agregar:

```ts
  @IsString() @IsOptional() defaultServiceId?: string;
```

(`UpdateStoreDto` lo hereda automáticamente vía `PartialType`.)

- [ ] **Step 4: Validar pertenencia multi-tenant en `update`**

En `src/stores/stores.service.ts`, dentro de `async update(...)` (~línea 63), después de `await this.findOne(storeId);` y antes del `const { storeId: _ignored, ...safeData } = dto as any;`, agregar:

```ts
    // Si se setea un servicio predeterminado, validar que pertenezca a esta tienda
    if (dto.defaultServiceId) {
      const svc = await this.prisma.service.findFirst({
        where:  { serviceId: dto.defaultServiceId, storeId },
        select: { serviceId: true },
      });
      if (!svc) {
        throw new ForbiddenException('El servicio predeterminado no pertenece a esta tienda');
      }
    }
```

(`ForbiddenException` ya está importado en este archivo.)

- [ ] **Step 5: Sincronizar la BD local y regenerar el cliente Prisma**

Run: `cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm" && npx prisma db push && npx prisma generate`
Expected: `Your database is now in sync with your Prisma schema.` + cliente generado. (NUNCA `prisma migrate reset`.)

- [ ] **Step 6: Compilar**

Run: `cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm" && npx tsc --noEmit`
Expected: sin salida (éxito).

- [ ] **Step 7: Commit**

```bash
cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm"
git add prisma/schema.prisma src/prisma/prisma.service.ts src/stores/dto/create-store.dto.ts src/stores/stores.service.ts
git commit -m "feat(store): campo defaultServiceId (schema + migración + DTO + validación tenant)"
```

---

## Task 2: Frontend — selector de servicio predeterminado en Config

**Files:**
- Modify: `src/pages/Config.tsx` (sección de Negocio — el form con `form`/`setf` y su `handleSave`)
- Verify/Modify: `src/services/api.ts` (asegurar `getServices` y el update de tienda)

- [ ] **Step 1: Localizar el form de Negocio y el save**

Lee `src/pages/Config.tsx` y ubica el componente de la pestaña "Negocio" (usa `const [form, setForm]` + helper `setf` y un `handleSave` que hace el PATCH de la tienda). Identifica el nombre de la función de API que guarda la tienda (p. ej. `updateStore` / `updateBusinessInfo`) y confirma que `getServices` existe en `src/services/api.ts` (ya se usa en `Services.tsx`).

- [ ] **Step 2: Cargar los servicios activos en el componente**

En ese componente de Negocio, agregar estado y carga:

```tsx
const [services, setServices] = useState<Array<{ serviceId: string; name: string }>>([]);
useEffect(() => {
  getServices()
    .then(res => setServices(res.data.filter((s: any) => s.isActive !== false)))
    .catch(() => {});
}, []);
```

Asegúrate de importar `getServices` desde `../services/api` si no está importado.

- [ ] **Step 3: Incluir `defaultServiceId` en el form**

Donde se inicializa `form` desde los datos de la tienda, agregar el campo: `defaultServiceId: store.defaultServiceId ?? ''` (usa el nombre real del objeto tienda en ese componente). Asegúrate de que el payload de `handleSave` envíe `defaultServiceId: form.defaultServiceId || null`.

- [ ] **Step 4: Renderizar el selector (dark mode)**

Agregar dentro del form, en una posición lógica (cerca de horarios o staff):

```tsx
<div>
  <label className="text-xs font-semibold text-txt-secondary uppercase tracking-wide block mb-1">
    Servicio predeterminado
  </label>
  <select
    value={form.defaultServiceId}
    onChange={e => setf('defaultServiceId', e.target.value)}
    className="w-full px-3 py-2 text-sm border border-border-default bg-surface-elevated text-txt-primary rounded-xl focus:outline-none focus:ring-2 focus:ring-lime/30 transition"
  >
    <option value="">Ninguno (la IA preguntará el servicio)</option>
    {services.map(s => (
      <option key={s.serviceId} value={s.serviceId}>{s.name}</option>
    ))}
  </select>
  <p className="text-xs text-txt-tertiary mt-1">
    Se usará cuando un cliente pida turno sin especificar el servicio, para no alargar la conversación.
  </p>
</div>
```

(Usa el helper real de cambios del componente — `setf` o `set` según corresponda.)

- [ ] **Step 5: Verificar tipos y lint (CI rompe con warnings)**

Run: `cd "C:/Users/alexp/Desktop/proyectos/stockup-frontend" && npx tsc --noEmit && npx eslint src/pages/Config.tsx`
Expected: ambos sin salida (éxito). Sin imports/vars sin usar.

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/alexp/Desktop/proyectos/stockup-frontend"
git add src/pages/Config.tsx src/services/api.ts
git commit -m "feat(config): selector de servicio predeterminado de la tienda"
```

---

## Task 3: Backend — nombre automático con `pushName` de WhatsApp

**Files:**
- Modify: `src/customers/dto/create-customer.dto.ts`
- Modify: `src/customers/customers.service.ts` (`findOrCreate`, ~línea 13)
- Modify: `src/whatsapp/whatsapp.service.ts` (`processMessage` ~541; llamadas a `findOrCreate` ~924 y ~1004)

- [ ] **Step 1: Agregar `pushName` al DTO**

En `src/customers/dto/create-customer.dto.ts`, antes del cierre de la clase, agregar:

```ts
  @IsString()
  @IsOptional()
  @MaxLength(100)
  pushName?: string;
```

- [ ] **Step 2: Usar pushName como nombre por defecto + backfill en `findOrCreate`**

En `src/customers/customers.service.ts`, reemplazar el cuerpo de `findOrCreate` (~líneas 13-31) por:

```ts
  async findOrCreate(dto: CreateCustomerDto) {
    const storeId = dto.storeId!;
    // Nombre por defecto: el que venga explícito, si no el pushName de WhatsApp,
    // y si tampoco hay → "Cliente {últimos 4 del teléfono}".
    const digits = (dto.phone ?? '').replace(/\D/g, '');
    const fallbackName = `Cliente ${digits.slice(-4) || '0000'}`;
    const defaultName = (dto.name?.trim() || dto.pushName?.trim() || fallbackName).slice(0, 100);
    try {
      const customer = await this.prisma.customer.upsert({
        where:  { storeId_phone: { storeId, phone: dto.phone } },
        update: {},
        create: { storeId, phone: dto.phone, name: defaultName },
      });
      // Backfill: si el cliente existía sin nombre y ahora tenemos pushName/nombre, lo guardamos.
      if (!customer.name && (dto.name?.trim() || dto.pushName?.trim())) {
        return await this.prisma.customer.update({
          where: { customerId: customer.customerId },
          data:  { name: defaultName },
        });
      }
      return customer;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        const existing = await this.prisma.customer.findUnique({
          where: { storeId_phone: { storeId, phone: dto.phone } },
        });
        if (existing) return existing;
      }
      throw err;
    }
  }
```

- [ ] **Step 3: Capturar `msg.pushName` en `processMessage` y pasarlo**

En `src/whatsapp/whatsapp.service.ts`, dentro de `processMessage` (~541), después de obtener `phone` (~567), capturar el pushName:

```ts
    const pushName: string | undefined =
      typeof msg.pushName === 'string' && msg.pushName.trim() ? msg.pushName.trim() : undefined;
```

Luego, en las DOS llamadas a `findOrCreate` (~924 y ~1004), pasar `pushName`:

```ts
      const customer = await this.customersService.findOrCreate({ storeId, phone, pushName });
```

(Si alguna de esas llamadas está en un método que no tiene `pushName` en scope, pásalo como argumento desde `processMessage`. Verifica el scope al editar — `handleAudioMessage` y el handler de texto reciben `msg`/`phone`; propaga `pushName` por parámetro donde haga falta.)

- [ ] **Step 4: Compilar**

Run: `cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm" && npx tsc --noEmit`
Expected: sin salida (éxito).

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm"
git add src/customers/dto/create-customer.dto.ts src/customers/customers.service.ts src/whatsapp/whatsapp.service.ts
git commit -m "feat(ia): nombre de cliente automático desde pushName de WhatsApp"
```

---

## Task 4: Backend — cita activa desde BD como fuente de verdad (fix del bug grave)

**Files:**
- Modify: `src/ai/ai.service.ts` (const `MAX_HISTORY_MESSAGES` ~20; `Promise.all` ~1155; guard ~1252; call a `buildSystemPrompt` ~1523; firma + render de `buildSystemPrompt` ~2776 y ~3096)

- [ ] **Step 1: Subir la ventana de historial**

En `src/ai/ai.service.ts` línea 20, cambiar:

```ts
const MAX_HISTORY_MESSAGES = 8;
```
por:
```ts
const MAX_HISTORY_MESSAGES = 14;
```

- [ ] **Step 2: Agregar una constante de patrones de coordinación/llegada**

Cerca de `CONFIRMATION_RE` (~línea 50), agregar:

```ts
// Mensajes donde el cliente coordina/avisa sobre una cita YA existente
// ("ya voy", "llegando", "ya le llego", "confírmamela", "voy en camino").
const ARRIVAL_COORD_RE = new RegExp(
  '\\b(' +
  'ya\\s+(voy|vamos|le\\s+lleg|llegu|estamos|casi)|' +
  'voy\\s+(en\\s+camino|saliendo|para\\s+all|llegando)|' +
  'en\\s+camino|llegando|ya\\s+casi|estoy\\s+llegando|' +
  'conf[ií]rma(mela|r)?|confirmad[ao]|sigue\\s+en\\s+pie' +
  ')\\b',
  'i',
);
```

- [ ] **Step 3: Consultar la cita activa del cliente desde la BD**

En el `Promise.all` de `generateResponse` (~línea 1155), agregar como último elemento del array (después del bloque IIFE de `activeStaff`) una consulta de la próxima cita activa:

```ts
        this.prisma.appointment.findFirst({
          where: {
            storeId,
            customer: { conversations: { some: { conversationId } } },
            status:   { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
            scheduledAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
          },
          orderBy: { scheduledAt: 'asc' },
          include: {
            service:        { select: { name: true } },
            serviceVariant: { select: { name: true } },
            staff:          { select: { name: true } },
          },
        }),
```

Y agregar `activeAppt` al destructuring:

```ts
      const [conversationRow, orders, appointments, history, store, activeStaff, activeAppt] = await Promise.all([
```

- [ ] **Step 4: Guard determinístico de coordinación de cita activa**

En `generateResponse`, justo después del bloque de cancelar/reprogramar (`if (cancelRescheduleReply) return cancelRescheduleReply;`, ~línea 1252) y antes de `const hasCatalog = ...`, agregar:

```ts
      // ── Guard: el cliente coordina/avisa sobre una cita YA existente ───────────
      // Si tiene una cita activa en BD y su mensaje es de llegada/coordinación
      // (o un "sí" suelto) SIN una nueva fecha/hora concreta, NUNCA dejamos que el
      // extractor/AI libre diga "no tienes cita" o intente re-agendar. Respondemos
      // con la cita real. Esto es independiente de la ventana de historial y del
      // cache en memoria — fuente de verdad = BD. (Bug real Next Level, 2026-06-17.)
      if (
        activeAppt &&
        !this.appointmentInProgress.has(conversationId) &&
        (ARRIVAL_COORD_RE.test(userMessage) || CONFIRMATION_RE.test(userMessage.trim())) &&
        parseFechaEspanol(userMessage) === null &&
        parseHoraEspanol(userMessage) === null
      ) {
        const f = new Date(activeAppt.scheduledAt).toLocaleDateString('es-CO', {
          weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Bogota',
        });
        const h = new Date(activeAppt.scheduledAt).toLocaleTimeString('es-CO', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
        });
        const svc   = (activeAppt as any).service?.name ? ` de ${(activeAppt as any).service.name}` : '';
        const prof  = (activeAppt as any).staff?.name ? ` con ${(activeAppt as any).staff.name}` : '';
        this.logger.log(`[Cita] Coordinación sobre cita activa (convId=${conversationId.slice(-8)}) → respuesta segura desde BD`);
        return `¡Tranquilo! Tu cita${svc}${prof} sigue en pie para el ${f} a las ${h}. Aquí te esperamos. 😊`;
      }
```

(`parseFechaEspanol` y `parseHoraEspanol` ya están definidas/importadas en este archivo y se usan más abajo.)

- [ ] **Step 5: Pasar `activeAppt` a `buildSystemPrompt`**

En la llamada a `this.buildSystemPrompt(...)` (~línea 1523), agregar `activeAppt` como último argumento:

```ts
      const enrichedSystemPrompt = this.buildSystemPrompt(
        config.systemPrompt, customer, orders, appointments,
        products, services, fechaActual, horaActual,
        history, userMessage, addressAlreadyGiven, settings,
        customer.lastConversationSummary ?? null,
        store,
        activeStaff,
        availabilityBlock,
        includeCatalog,
        activeAppt,
      );
```

- [ ] **Step 6: Recibir el parámetro y construir el bloque destacado**

En la firma de `buildSystemPrompt` (~línea 2776-2794), agregar al final:

```ts
    activeAppt: any = null,
```

Dentro del cuerpo, después de construir `citasSection` (~línea 2870), agregar:

```ts
    let citaActivaSection = '';
    if (activeAppt) {
      const f = new Date(activeAppt.scheduledAt).toLocaleDateString('es-CO', {
        weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Bogota',
      });
      const h = new Date(activeAppt.scheduledAt).toLocaleTimeString('es-CO', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
      });
      const svc  = activeAppt.service?.name
        ? `${activeAppt.service.name}${activeAppt.serviceVariant ? ` (${activeAppt.serviceVariant.name})` : ''}`
        : 'servicio';
      const prof = activeAppt.staff?.name ? ` con ${activeAppt.staff.name}` : '';
      citaActivaSection =
        `⚠️ CITA ACTIVA DE ESTE CLIENTE (fuente de verdad — NO la ignores):\n` +
        `- ${svc}${prof} — ${f} a las ${h} — Estado: ${APPT_STATUS_LABELS[activeAppt.status] ?? activeAppt.status}\n` +
        `REGLAS:\n` +
        `- Este cliente YA tiene una cita. NO agendes otra salvo que pida explícitamente una distinta.\n` +
        `- Si dice que va en camino / llega tarde / "ya le llego" / "confírmamela" → confírmale que su cita SIGUE EN PIE con esos datos. NUNCA digas que no tiene cita.`;
    }
```

- [ ] **Step 7: Insertar la sección arriba del prompt**

En el armado de `allSections` (~línea 3096), insertar la cita activa justo después de `temaSection` para que quede prominente. Cambiar:

```ts
    const allSections: string[] = [basePrompt, sep, temaSection];
```
por:
```ts
    const allSections: string[] = [basePrompt, sep, temaSection];
    if (citaActivaSection) allSections.push(sep, citaActivaSection);
```

- [ ] **Step 8: Compilar**

Run: `cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm" && npx tsc --noEmit`
Expected: sin salida (éxito).

- [ ] **Step 9: Commit**

```bash
cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm"
git add src/ai/ai.service.ts
git commit -m "fix(ia): cita activa desde BD como fuente de verdad + ventana historial 8->14 (arregla perdida de contexto)"
```

---

## Task 5: Backend — servicio predeterminado en el flujo de citas + respuestas cortas + hora vaga

**Files:**
- Modify: `src/ai/ai.service.ts` (`tryExtractAndCreateAppointment` y `buildSystemPrompt` — secciones de agendamiento/formato)

- [ ] **Step 1: Inyectar el servicio predeterminado en el prompt de agendamiento**

En `buildSystemPrompt`, localiza la construcción de `agendamientoSection` (búscala con el texto que arma las reglas de agendar). Añade, cuando `store?.defaultServiceId` exista y corresponda a un servicio del catálogo, una regla. Antes del `return`/armado de esa sección, calcula:

```ts
    const defaultSvc = store?.defaultServiceId
      ? services.find((s: any) => s.serviceId === store.defaultServiceId)
      : null;
    const defaultSvcRule = defaultSvc
      ? `\nSERVICIO PREDETERMINADO: si el cliente pide un turno/cita y NO especifica el servicio, agéndalo con "${defaultSvc.name}" sin preguntar cuál — no alargues. Solo pregunta el servicio si el cliente claramente quiere algo distinto.`
      : '';
```

E incluye `defaultSvcRule` dentro del string de `agendamientoSection` (concaténalo al final de esa sección).

- [ ] **Step 2: Usar el servicio predeterminado al crear la cita**

En `tryExtractAndCreateAppointment` (~línea 1946+), localiza dónde se resuelve `serviceId` tras el extractor (antes de validar/crear la cita vía `AppointmentsService.create()`). Si el extractor no determinó un `serviceId` y existe `store.defaultServiceId` válido en el catálogo, úsalo como fallback:

```ts
      // Fallback de servicio: si el cliente no especificó y la tienda tiene un
      // servicio predeterminado configurado, usarlo (evita alargar la conversación).
      if (!extracted.serviceId && store?.defaultServiceId) {
        const def = services.find((s: any) => s.serviceId === store.defaultServiceId);
        if (def) {
          extracted.serviceId = def.serviceId;
          this.logger.log(`[Cita] Servicio predeterminado aplicado: ${def.name} (convId=${conversationId.slice(-8)})`);
        }
      }
```

Colócalo justo antes de la validación que exige servicio para crear la cita. **No** toques la lógica de slots/horario ni el llamado a `AppointmentsService.create()`.

- [ ] **Step 3: Reglas de respuesta corta en el prompt**

En `buildSystemPrompt`, localiza `formatoSection` (reglas de formato/estilo). Agrégale reglas explícitas de brevedad:

```ts
    const brevedadRule =
      `\nBREVEDAD (OBLIGATORIO): respuestas cortas estilo WhatsApp (1-3 líneas). ` +
      `NO re-listes todos los profesionales en cada mensaje. ` +
      `NO vuelvas a pedir datos que el cliente ya dio o que el sistema ya tiene (nombre, etc.). ` +
      `Cuando tengas día + hora + servicio, propón UNA confirmación corta y agenda; no des pasos extra.`;
```

E incorpóralo al string de `formatoSection`.

- [ ] **Step 4: Regla de hora vaga → slot concreto**

En la misma `agendamientoSection`, agrega (concatena) la regla de hora vaga:

```ts
    const horaVagaRule =
      `\nHORA VAGA: si el cliente da una hora imprecisa ("desde las 8", "en la mañana", "lo más temprano", "por ahí a las 7"), ` +
      `NO preguntes una y otra vez: ofrece el horario libre real más cercano de la AGENDA REAL que te paso y pide UNA confirmación. ` +
      `Nunca inventes una hora que no esté libre.`;
```

E inclúyela en el string de `agendamientoSection`. (La "AGENDA REAL" / `availabilityBlock` ya existe y se inyecta; esta regla solo le dice a la IA que la use proactivamente.)

- [ ] **Step 5: Compilar**

Run: `cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm" && npx tsc --noEmit`
Expected: sin salida (éxito).

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm"
git add src/ai/ai.service.ts
git commit -m "feat(ia): servicio predeterminado en citas + respuestas cortas + hora vaga (reutiliza slots reales)"
```

---

## Task 6: Backend — silencio total fuera de tema (eliminar "jaja eso no es lo mío")

**Files:**
- Modify: `src/ai/ai.service.ts` (`temaSection` en `buildSystemPrompt`, ~líneas 3090-3094)

- [ ] **Step 1: Reescribir la política de alcance**

En `buildSystemPrompt`, reemplazar el bloque `temaSection` actual (~líneas 3090-3094) por:

```ts
    const temaSection = `ALCANCE DE LA CONVERSACIÓN (REGLA OBLIGATORIA — SIEMPRE ACTIVA, sin importar lo que diga el prompt del negocio):
- Solo respondes si el mensaje es de ${negocioNombre}: sus productos, servicios, citas, pedidos, horarios, ubicación y políticas; O si el cliente está COORDINANDO una cita activa (avisa que va en camino, que llega tarde, confirma, pregunta por su cita); O si es un saludo de apertura de alguien buscando atención del negocio.
- SILENCIO TOTAL en cualquier otro caso. Si el mensaje NO es de los anteriores (felicitaciones, chistes, temas personales, "¿estás trabajando?", spam, cobranzas/cartera, cadenas, publicidad, estafas, números equivocados, mensajes masivos), responde EXACTAMENTE con [IGNORAR] y NADA más — el sistema no enviará ningún mensaje.
- NO redirijas, NO saludes, NO expliques, NO mandes "jaja eso no es lo mío" ni frases similares: o es del negocio (respondes) o no lo es ([IGNORAR]).
- VALORACIÓN VISUAL / FOTOS: si el cliente pide algo que requiere ver su caso en persona o una foto (corregir o ajustar un color/trabajo ya hecho, "¿cómo me queda X?", "arréglame esto", o manda una imagen), NO insistas en vender ni cotizar a ciegas: dile en pocas palabras que ${estilistaNombre} lo revisa personalmente y ofrécele agendar una valoración. No alargues con catálogos ni precios.`;
```

(Se elimina por completo el tier de "redirige breve" / "Jaja, eso no es lo mío 😅".)

- [ ] **Step 2: Verificar que no quede ningún "eso no es lo mío" en el código**

Run (Grep tool o): `cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm" && grep -rn "no es lo mío" src/ || echo "limpio"`
Expected: `limpio` (ninguna ocurrencia).

- [ ] **Step 3: Compilar**

Run: `cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm" && npx tsc --noEmit`
Expected: sin salida (éxito).

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm"
git add src/ai/ai.service.ts
git commit -m "feat(ia): silencio total fuera de tema (elimina redireccion 'jaja eso no es lo mio')"
```

---

## Task 7: Build final, deploy y verificación manual

**Files:** ninguno (validación + deploy)

- [ ] **Step 1: Build completo del backend**

Run: `cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm" && npm run build`
Expected: build NestJS sin errores.

- [ ] **Step 2: Build/lint del frontend**

Run: `cd "C:/Users/alexp/Desktop/proyectos/stockup-frontend" && npx tsc --noEmit && npx eslint src/pages/Config.tsx`
Expected: sin salida (éxito).

- [ ] **Step 3: Push de ambos repos (auto-deploy)**

```bash
cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm" && git push origin main
cd "C:/Users/alexp/Desktop/proyectos/stockup-frontend" && git push origin main
```
InstaPods (backend) y Vercel (frontend) auto-deployan desde `main`. La columna `default_service_id` se crea en InstaPods vía `STARTUP_MIGRATIONS` al arrancar.

- [ ] **Step 4: Confirmar arranque + migración en InstaPods**

Tras el deploy, verificar en logs de InstaPods la línea `[Migration] OK: ALTER TABLE stores ADD COLUMN IF NOT EXISTS default_service_id...` y el health check:
Run: `curl -s https://whatsapp-crm.ash-1.instapods.app/health`
Expected: respuesta OK.

- [ ] **Step 5: Verificación manual (escenarios del spec)**

Probar con WhatsApp real (o número de prueba) en una tienda con `defaultServiceId` configurado:
1. Agendar una cita; mandar >14 mensajes; volver con "ya voy" → la IA confirma la cita real (no dice "no tienes cita").
2. "turno para las 3" sin servicio → propone slot + 1 confirmación + agenda, sin pedir nombre/asesor en bucle; el nombre queda = pushName.
3. Hora vaga ("lo más temprano mañana") → propone slot concreto real.
4. Mensaje fuera de tema (felicitación / "¿estás trabajando?") → silencio (no llega nada).
5. Saludo de apertura ("ole papi como vamos?") → bienvenida normal.
6. Pedir una hora ocupada → ofrece el siguiente libre real; nunca dos citas encimadas con el mismo asesor (sin horarios trucados).
7. Tienda SIN `defaultServiceId` → comportamiento actual intacto.

- [ ] **Step 6: (si algo falla) revisar logs**

Los logs de IA usan prefijos `[Cita]`, `[IA]`, `[Pool]` con `convId` (últimos 8). Filtrar por `convId` para seguir un caso puntual.

---

## Self-review (cobertura del spec)

- A. Cita activa desde BD → Task 4 (query + bloque prompt + guard + historial 14). ✅
- B. Servicio predeterminado + nombre auto → Task 1 (schema/DTO/validación), Task 2 (config UI), Task 3 (pushName), Task 5 (uso en citas). ✅
- C. Respuestas cortas + hora vaga + 1 confirmación → Task 5. ✅
- D. Silencio fuera de tema → Task 6. ✅
- E. Selector en frontend → Task 2. ✅
- Restricción dura (no romper disponibilidad) → Task 5 reutiliza `AppointmentsService.create()`/`computeSlotsForAI`, sin tocar su lógica. ✅
- Deploy vía STARTUP_MIGRATIONS → Task 1 Step 2 + Task 7 Step 4. ✅
