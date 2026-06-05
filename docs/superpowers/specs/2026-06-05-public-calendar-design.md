# Public Calendar & AI Availability — Spec

**Fecha:** 2026-06-05
**Proyecto:** Stockup Messages
**Estado:** Aprobado

---

## Problema

Los clientes no pueden ver la disponibilidad real de los barberos/profesionales antes de escribir. La IA tampoco puede responder "¿qué horarios tienes?" con datos reales. Necesitamos:

1. Un link público (sin login) que muestre slots disponibles por día y por barbero.
2. Que la IA consulte disponibilidad real cuando el cliente lo pida.

---

## Regla central de slots disponibles

```
Para una fecha dada y un profesional:
  horario_efectivo = staff.schedule ?? store.businessHours
  slots_base       = intervalos de 30 min dentro del horario_efectivo para ese día
  slots_ocupados   = citas con status IN [PENDING, CONFIRMED, IN_PROGRESS]
                     cubriendo [scheduledAt, endsAt ?? scheduledAt + 30min]
  slots_libres     = slots_base − slots_ocupados
```

Si la tienda no tiene staff activo → aplica igual pero con un único "profesional = negocio".

---

## 1. Base de datos

### `Store.slug` — nuevo campo

```prisma
slug  String?  @unique @map("slug") @db.VarChar(100)
```

- Formato: solo letras minúsculas, números y guiones (`/^[a-z0-9-]{3,100}$/`)
- Opcional: tiendas sin slug no tienen calendario público
- Ejemplo: `nextlevel-barbershop`, `salon-maria`, `tecni-frio`

`prisma db push` (no migrate) — columna nullable, sin riesgo.

---

## 2. Backend

### 2.1 `UpdateStoreDto` — agregar `slug`

```typescript
@IsString() @IsOptional()
@Matches(/^[a-z0-9-]{3,100}$/, { message: 'Slug solo puede tener letras minúsculas, números y guiones' })
slug?: string;
```

### 2.2 Nuevo módulo `PublicModule` (sin auth)

**Endpoints — todos públicos, sin JwtAuthGuard:**

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/public/:slug` | Info básica de la tienda |
| `GET` | `/public/:slug/availability` | Slots disponibles para una fecha |

#### `GET /public/:slug`

Respuesta:
```json
{
  "name": "Next Level Barbershop",
  "staffLabel": "Barbero",
  "hasStaff": true,
  "businessHours": { ... }
}
```

#### `GET /public/:slug/availability?date=YYYY-MM-DD`

- `date` requerido — si falta → `BadRequestException`
- Respuesta:
```json
{
  "date": "2026-06-09",
  "dayName": "lunes",
  "staff": [
    {
      "staffId": "abc-123",
      "name": "Carlos",
      "slots": ["09:00", "09:30", "10:00", "11:30", "14:00"]
    },
    {
      "staffId": "def-456",
      "name": "Luis",
      "slots": ["09:00", "10:00", "14:30", "15:00"]
    }
  ]
}
```

Si no hay staff activo → `staff` tiene un solo elemento con `staffId: null, name: store.name, slots: [...]`.

#### Lógica de slots (función reutilizable `computeSlots`)

```typescript
function computeSlots(
  date: Date,
  effectiveHours: BusinessHoursJson,
  appointments: { scheduledAt: Date; endsAt: Date | null }[],
  slotMinutes = 30,
  tz = 'America/Bogota',
): string[]  // ["09:00", "09:30", ...]
```

1. Obtener día de semana de `date` en timezone `tz`
2. Si `daySchedule.isOpen === false` → devolver `[]`
3. Generar slots a partir de shift1 y shift2 (si existe)
4. Para cada slot: marcar ocupado si existe una cita donde:
   `cita.scheduledAt < slotEnd AND (cita.endsAt ?? cita.scheduledAt + 30min) > slotStart`
5. Devolver solo los slots libres en formato `"HH:MM"`

### 2.3 `StoresService` — permitir actualizar slug

El `update` existente ya hace `prisma.store.update` con el DTO completo. Solo necesita que el DTO tenga `slug`.

---

## 3. Frontend

### 3.1 Config.tsx — campo slug + link compartible

En `NegocioSection`, agregar después del campo de nombre de negocio:

```
┌─────────────────────────────────────┐
│ Link público del calendario          │
│ ┌────────────────────┐ [Guardar]     │
│ │ nextlevel-barberia │               │
│ └────────────────────┘               │
│ 🔗 https://app.com/cal/nextlevel-… [Copiar] │
└─────────────────────────────────────┘
```

- Input con validación de formato slug
- Muestra el link completo debajo cuando hay slug guardado
- Botón "Copiar link" → `navigator.clipboard.writeText(...)`
- Mensaje de éxito al copiar

### 3.2 Nueva página pública `/cal/:slug`

**Ruta:** `<Route path="/cal/:slug" element={<PublicCalendar />} />` — fuera de `PrivateRoute`, antes del `*` wildcard.

**UI:**

```
┌──────────────────────────────────────────┐
│  [Logo Stockup]                           │
│                                           │
│  Next Level Barbershop                    │
│  Consulta la disponibilidad de nuestros   │
│  barberos                                 │
│                                           │
│  ◀ lun 9 jun  ▶  [hoy]                   │
│                                           │
│  ┌─────────────────┐  ┌─────────────────┐│
│  │ 💈 Carlos       │  │ 💈 Luis          ││
│  │ 09:00  09:30    │  │ 09:00  10:30    ││
│  │ 10:00  11:30    │  │ 14:00  14:30    ││
│  │ 14:00  15:00    │  │ 15:00  15:30    ││
│  └─────────────────┘  └─────────────────┘│
│                                           │
│  Los slots mostrados son aproximados.     │
│  Confirma tu cita escribiendo por WhatsApp│
└──────────────────────────────────────────┘
```

**Comportamiento:**
- Carga del store al montar (`/public/:slug`)
- Fecha inicial: hoy. Navegación ±30 días (no mostrar fechas pasadas)
- Al cambiar fecha: fetch a `/public/:slug/availability?date=YYYY-MM-DD`
- Loading spinner mientras carga
- Si no hay slots para ese día: "Sin disponibilidad para este día"
- Si el slug no existe: pantalla de error "Negocio no encontrado"
- NO hay botón de agendar — solo vista

### 3.3 `api.ts` — endpoints públicos

```typescript
export const getPublicStore = (slug: string) =>
  api.get(`/public/${slug}`);

export const getPublicAvailability = (slug: string, date: string) =>
  api.get(`/public/${slug}/availability`, { params: { date } });
```

---

## 4. IA — respuesta de disponibilidad

### 4.1 Detección de consulta de disponibilidad

En `generateResponse`, antes de llamar al LLM, detectar si el mensaje contiene una consulta de disponibilidad:

```typescript
const AVAILABILITY_KEYWORDS = /horario|disponible|disponibilidad|cuándo puedo|qué hora|hora libre|cuando tiene|qué días|que dias/i;
const isAvailabilityQuery = AVAILABILITY_KEYWORDS.test(latestMessage);
```

### 4.2 Extracción de fecha del mensaje

Si `isAvailabilityQuery === true`, intentar extraer una fecha del mensaje:

```typescript
function extractQueryDate(message: string, today: Date, tz: string): Date | null
```

Patrones soportados:
- "mañana" → today + 1
- "hoy" → today
- "el lunes/martes/.../ viernes/sábado/domingo" → próximo día de esa semana
- "el 10" / "el 10 de junio" → fecha específica del mes actual o mencionado
- Si no se puede extraer → `null`

### 4.3 Inyección en sistema prompt

Si hay fecha extraída Y la tienda tiene staff (o businessHours):

```typescript
const availabilityData = await computeSlotsForDate(storeId, queryDate, activeStaff, store);
const availabilityBlock = formatAvailabilityForAI(availabilityData, queryDate);
```

Formato del bloque:
```
DISPONIBILIDAD REAL PARA [día, fecha]:
- Carlos: 09:00, 09:30, 10:00, 11:30, 14:00, 15:30
- Luis: 09:00, 10:30, 14:00, 14:30
(Sin disponibilidad para Luis a las 10am — ya tiene cita)

INSTRUCCIÓN: Responde con estos horarios exactos. No inventes horas que no estén en la lista.
Si el cliente elige un slot específico, avanza al flujo de agendamiento normal.
```

Si NO se puede extraer fecha del mensaje → el `buildSystemPrompt` incluye en la sección de agendamiento:

```
CONSULTA DE DISPONIBILIDAD:
Si el cliente pregunta sobre horarios disponibles y no menciona un día específico,
pregunta: "¿Para qué día quieres consultar la disponibilidad? (ej: mañana, el lunes, el 15 de junio)"
```

### 4.4 `buildSystemPrompt` — nuevo parámetro

```typescript
private buildSystemPrompt(
  ...
  activeStaff: Array<{ staffId: string; name: string }> = [],
  availabilityBlock: string = '',  // nuevo
): string
```

Inyectar `availabilityBlock` en el prompt cuando no esté vacío.

---

## 5. Retrocompatibilidad

- `Store.slug` nullable → tiendas sin slug no se ven afectadas
- `PublicModule` es totalmente nuevo, no modifica código existente
- AI: `availabilityBlock` default vacío → sin cambio en comportamiento actual
- La ruta `/cal/:slug` es nueva y pública — no afecta rutas privadas

---

## 6. Orden de implementación

1. Schema — `Store.slug` + `prisma db push`
2. `PublicModule` backend — endpoint info + availability con `computeSlots`
3. `UpdateStoreDto` — campo slug
4. Config.tsx — input slug + link compartible
5. Frontend página pública `/cal/:slug` + ruta en App.tsx
6. AI — `extractQueryDate` + `computeSlotsForDate` + inyección en `buildSystemPrompt`

---

## 7. Fuera de alcance (esta iteración)

- Botón de agendar desde el calendario público
- Notificaciones al cliente cuando el slot que eligió ya no está disponible
- Vista semanal multi-columna por barbero
- Personalización del calendario (logo, colores del negocio)
