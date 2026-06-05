# Staff System — Spec

**Fecha:** 2026-06-05
**Proyecto:** Stockup Messages (whatsapp-crm + stockup-frontend)
**Estado:** Aprobado

---

## Problema

Una barbería con 4 barberos necesita que las citas se asginen a un barbero específico, con disponibilidad independiente por barbero. La IA debe preguntar con qué empleado quiere ser atendido el cliente y verificar disponibilidad real de ese empleado.

Debe funcionar también para negocios con un solo dueño (sin staff configurado): en ese caso el comportamiento actual se mantiene intacto.

---

## Regla central de disponibilidad

```
¿Store tiene staff activo?
  NO  → comportamiento actual: store.businessHours, sin preguntar empleado
  SÍ  → IA pregunta empleado → verifica schedule del empleado elegido
       → detecta conflictos solo de ese empleado
```

---

## 1. Base de datos

### 1.1 Nuevo modelo `Staff`

```prisma
model Staff {
  staffId   String   @id @default(uuid()) @map("staff_id")
  storeId   String   @map("store_id")
  name      String   @db.VarChar(100)
  isActive  Boolean  @default(true) @map("is_active")

  // null = hereda store.businessHours
  // Si está definido: mismo shape que Store.businessHours
  // { mon: { open: "09:00", close: "19:00", closed: false }, ... }
  schedule  Json?    @map("schedule")

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt      @map("updated_at")

  store        Store         @relation(fields: [storeId], references: [storeId], onDelete: Cascade)
  appointments Appointment[]

  @@index([storeId, isActive])
  @@map("staff")
}
```

### 1.2 `Store` — nuevo campo

```prisma
staffLabel  String?  @default("Profesional") @map("staff_label") @db.VarChar(50)
// Valores sugeridos: "Barbero" | "Estilista" | "Técnico" | "Asesor" | texto libre
```

### 1.3 `Appointment` — nuevo campo

```prisma
staffId  String? @map("staff_id")
staff    Staff?  @relation(fields: [staffId], references: [staffId])

// Agregar índice:
@@index([storeId, staffId, scheduledAt])
```

La relación es opcional (`String?`) — citas existentes y negocios sin staff no se ven afectados.

---

## 2. Backend

### 2.1 Nuevo módulo `StaffModule`

**Endpoints** (todos requieren JWT, storeId del token):

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/staff` | Lista staff activo de la tienda |
| `POST` | `/staff` | Crear empleado |
| `PATCH` | `/staff/:id` | Editar nombre, schedule, isActive |
| `DELETE` | `/staff/:id` | Soft delete (isActive = false) |

**`CreateStaffDto`:**
```typescript
name:      string  // requerido
schedule?: object  // null = hereda store hours
```

**`UpdateStaffDto`:**
```typescript
name?:     string
isActive?: boolean
schedule?: object | null
```

Multi-tenant: storeId siempre del JWT, nunca del body. El DELETE verifica que `staff.storeId === storeId` del token.

### 2.2 `AppointmentsService` — cambios

**`CreateAppointmentDto` / `UpdateAppointmentDto`:** agregar `staffId?: string`

**`APPOINTMENT_INCLUDE`:** agregar:
```typescript
staff: { select: { staffId: true, name: true } }
```

**`findAll`:** soporta filtro `?staffId=uuid`

**Validación de horario en `create`:**
```
si dto.staffId:
  cargar staff → obtener effectiveSchedule = staff.schedule ?? store.businessHours
  validar scheduledAt contra effectiveSchedule
sino:
  validar contra store.businessHours (comportamiento actual)
```

**Detección de conflicto** (solo cuando `staffId` presente):
```
Buscar appointment donde:
  staffId = dto.staffId
  status in [PENDING, CONFIRMED, IN_PROGRESS]
  scheduledAt < endsAtNueva  AND  (endsAt ?? scheduledAt + 30min) > scheduledAtNueva

Si existe → BadRequestException("El [staffLabel] ya tiene una cita en ese horario")
```

### 2.3 `AiService` — cambios

**`AppointmentExtractionResult`** — nuevo campo:
```typescript
staffId:   string | null;
staffName: string | null;  // para log/confirmación
```

**`buildSystemPrompt`** — en `agendamientoSection`:

Cuando la tienda tiene staff activo, inyectar:
```
EQUIPO DISPONIBLE:
{{staffLabel}}es:
- Carlos (id: abc-123)
- Luis   (id: def-456)
- Diego  (id: ghi-789)

REGLA OBLIGATORIA:
1. SIEMPRE pregunta: "¿Con qué {{staffLabel}} quieres tu cita? Tenemos: Carlos, Luis, Diego."
2. El cliente DEBE elegir uno antes de confirmar.
3. Una vez elegido, NO preguntes de nuevo.
4. Si el {{staffLabel}} elegido no está disponible en ese horario, informa y sugiere
   otro horario con ese mismo {{staffLabel}} o un {{staffLabel}} alternativo.
```

Cuando NO hay staff: sección omitida, flujo actual sin cambios.

**Extractor de citas** — prompt actualizado:

Incluir lista de staff con IDs para que el LLM resuelva nombre → ID:
```
EQUIPO:
- "Carlos" → staffId: "abc-123"
- "Luis"   → staffId: "def-456"
```

Campo adicional en JSON de respuesta:
```json
"staffId": "uuid o null"
```

**Creación de cita en `ai.service.ts`:** pasar `staffId` al `prisma.appointment.create`.

**Mensaje de confirmación al cliente** incluye nombre del empleado:
```
¡Cita agendada, Juan! ✅
📆 Fecha: lunes 9 de junio
🕐 Hora: 10:00 am
✂️ Barbero: Carlos
```

### 2.4 `StoresService` / `UpdateStoreDto`

Agregar `staffLabel?: string` al DTO y al update de store.

---

## 3. Frontend

### 3.1 Config → Negocio (`Config.tsx`)

**Campo `staffLabel`** (nuevo en sección Negocio):
- Dropdown con opciones: Barbero / Estilista / Técnico / Asesor / Otro
- Si elige "Otro": campo de texto libre aparece
- Se guarda en `PATCH /stores/:storeId`

**Nueva subsección "Equipo"** (debajo de Negocio, misma página Config):
- Tabla: Nombre | Estado (activo/inactivo) | Horario | Acciones
- Botón "Agregar [staffLabel]"
- Modal agregar/editar:
  - Campo nombre (requerido)
  - Toggle "Horario propio" — si activa, muestra los mismos selectores de horario por día que ya tiene Config → Negocio
  - Si toggle apagado: muestra "Hereda el horario del negocio"
- Soft delete con confirmación

### 3.2 Appointments (`Appointments.tsx`)

**Lista:**
- Nueva columna "[staffLabel]" entre "Servicio" y "Estado"
- Muestra nombre del empleado o "—" si no tiene asignado

**Filtros:**
- Nuevo selector "Todos los [staffLabel]es" con lista desplegable
- Parámetro `?staffId=` en el fetch

**Calendario:**
- Tarjeta de cita muestra nombre del empleado debajo del cliente

**Modal "Nueva cita manual":**
- Selector de empleado (opcional, si la tienda tiene staff)
- Si no hay staff configurado: campo no aparece

### 3.3 `api.ts` — nuevos endpoints

```typescript
// Staff
getStaff:        () => api.get('/staff')
createStaff:     (dto) => api.post('/staff', dto)
updateStaff:     (id, dto) => api.patch(`/staff/${id}`, dto)
deleteStaff:     (id) => api.delete(`/staff/${id}`)
```

---

## 4. Retrocompatibilidad

- `Appointment.staffId` es nullable → citas existentes no se ven afectadas.
- Tiendas sin staff configurado: flujo de IA idéntico al actual.
- `prisma db push` (no migrate) — agrega columnas nullable sin riesgo de data loss.
- `staffLabel` tiene default `"Profesional"` → tiendas existentes no rompen.

---

## 5. Orden de implementación

1. Schema Prisma + `prisma db push`
2. `StaffModule` (backend CRUD)
3. `AppointmentsService` — agregar staffId, validación horario, conflictos
4. `AiService` — `buildSystemPrompt` + extractor
5. Frontend Config — staffLabel + sección Equipo
6. Frontend Appointments — columna, filtro, calendario, modal

---

## 6. Fuera de alcance (esta iteración)

- Vista tipo agenda lado a lado por empleado (columnas en calendario)
- Notificaciones al empleado específico por WhatsApp/email
- Estadísticas de ingresos por empleado
- 3+ citas en un solo mensaje (limitación conocida del extractor actual)
