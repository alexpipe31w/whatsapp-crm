# Spec 2 — Citas: llegar tarde + walk-ins

**Fecha:** 2026-06-18
**Repos afectados:** `stockup-frontend` (principal — UI) + `whatsapp-crm` (backend, cambios mínimos)
**Estado:** diseño aprobado, pendiente plan de implementación

## Problema

Dos situaciones reales de la operación de barberías/salones que hoy no están bien soportadas:

1. **Cliente llega tarde.** Agendó a las 2:00pm, llega 2:30pm. El admin necesita una forma rápida de **correr esa cita** a la hora real de llegada, sin teclear ni reagendar a mano.
2. **Walk-ins (sin agendar).** Llegan clientes "de la nada" a ser atendidos sin cita previa. El negocio necesita **contabilizarlos** (clientes atendidos + ingreso) con una opción rápida de registrarlos.

## Alcance

**Incluido (Spec 2):**
- A. Llegar tarde → acción "Mover" la cita (A ahora / +15 / +30 min).
- B. Walk-in → "Atender ahora": crea una cita atendida + registra la venta en un paso.

**Fuera de alcance:**
- Acompañantes (N citas back-to-back con el mismo asesor) → **Spec 3** (lógica de IA, otra superficie).
- Cascada de horarios al llegar tarde (decisión tomada: **solo mueve esa cita**, no corre las siguientes).

## Restricción dura (no romper lo que funciona)

El backend ya tiene `AppointmentsService.create()` (candado atómico anti-doble-booking, `$transaction`) y `update()` (re-valida conflicto al cambiar `scheduledAt`). Spec 2 **reutiliza** esos métodos; **no** modifica la lógica de conflicto/slots salvo un opt-out explícito y acotado para walk-ins (ver B). Nunca una ruta paralela de creación.

## Diseño

### A) Llegar tarde — "correr esta cita"

**Frontend (`src/pages/Appointments.tsx`):** en la tarjeta de cita (`AppointmentCard`) y/o el detalle, un menú/acción **"Mover"** con tres atajos:
- **A ahora** → `scheduledAt = hora actual redondeada a 5 min`.
- **+15 min** / **+30 min** → `scheduledAt = scheduledAt actual + 15/30 min`.

Llama al endpoint existente `updateAppointment(id, { scheduledAt })` (PATCH `/appointments/:id`). **No hay endpoint nuevo.**

**Comportamiento:**
- Solo visible/activa en citas en estado activo: PENDING / CONFIRMED / IN_PROGRESS. No en COMPLETED/CANCELLED/NO_SHOW.
- El backend `update()` re-valida conflicto por asesor dentro de la transacción. Si la nueva hora **choca** con otra cita del mismo asesor → el backend rechaza con su mensaje de conflicto; el frontend lo muestra ("Choca con otra cita del profesional a las HH:MM") y **no mueve nada** (esto materializa "solo mueve esa cita"). El admin decide.
- El movimiento queda registrado en el timeline de la cita (el `update()` ya lo maneja).
- Feedback de éxito: la cita se re-renderiza en su nueva hora (lista + calendario).

**Sin cambios de backend** para esta pieza.

### B) Walk-in — "Atender ahora" (cita atendida + venta en un paso)

**Frontend (`src/pages/Appointments.tsx`):** botón **"Walk-in / Atender ahora"** en el header de la página. Abre un modal rápido (dark mode) con:
- Cliente: toggle **existente** (busca por nombre/teléfono) / **nuevo** (crea on-the-fly con `createCustomer`: teléfono obligatorio, nombre opcional).
- Asesor (selector de staff activo).
- Servicio (selector del catálogo con autoprecio; permite ajustar el precio).
- Método de pago (efectivo/transferencia/etc., como el `ManualServiceModal` existente).

**Qué crea (en un solo flujo):**
1. Una **cita** a la **hora actual**, asignada al asesor, en estado **COMPLETED** (ya fue atendido) → aparece en la agenda del día y **cuenta en el rendimiento por profesional** (analytics `byStaff`).
2. La **venta** del servicio → se reutiliza la maquinaria existente de **auto-orden al marcar `paymentStatus = PAID`** (idempotente vía `Appointment.appointmentId @unique`), que crea la `Order(type='service')` y actualiza `totalSpent`/`totalOrders` del cliente. **Cero lógica de revenue duplicada.**

**Conflicto (decisión: el walk-in NO bloquea por conflicto):** el admin atiende al cliente conscientemente en el momento, así que la creación del walk-in **omite la validación de conflicto** aunque el asesor tenga el slot ocupado. Implementación: pasar a `create()` un flag explícito de bypass de conflicto. Si el `forced` actual de `create()` (hoy usado para permitir citas en el pasado) ya cubre el conflicto, reutilizarlo; si no, extenderlo de forma mínima y explícita (p. ej. `skipConflictCheck`) **sin** alterar la lógica de detección en sí — solo un `if (!skipConflictCheck)` alrededor del bloque de conflicto ya existente. Esto NO refactoriza el anti-doble-booking; solo agrega un opt-out consciente para el caso walk-in.

**Backend:** endpoint para crear el walk-in. Preferir reutilizar `POST /appointments` (create) con los campos: `scheduledAt = now`, `status = COMPLETED`, `paymentStatus = PAID`, `staffId`, `serviceId`, `manualPaymentMethod`, precio, y el flag de bypass de conflicto. Verificar en el plan que la auto-orden de servicio se dispare al crear con `PAID` (si el hook solo corre en la transición de estado y no en el create, el flujo marca PAID con un segundo paso o invoca la creación de la orden explícitamente — el plan define el mecanismo exacto).

## Datos / contratos

- No se requieren columnas nuevas. Se usan campos existentes de `Appointment` (`status`, `paymentStatus`, `staffId`, `serviceId`, `manualPaymentMethod`, `scheduledAt`, `durationMinutes`) y `Order(type='service')`.
- `createCustomer({ phone, name? })` ya existe (Spec previo).
- `updateAppointment(id, { scheduledAt })` ya existe.

## Manejo de errores / robustez

- "Mover" en conflicto → el backend rechaza, el frontend muestra el conflicto, no se pierde la cita original.
- Walk-in con cliente nuevo sin nombre → se permite (nombre opcional); el nombre puede quedar como el teléfono o "Cliente {tel}" según el patrón ya existente.
- Multi-tenant: todo filtra por `storeId` del JWT.
- Idempotencia de la venta del walk-in: vía `appointmentId @unique` de la auto-orden (no se duplica el ingreso aunque se reintente).
- Reutiliza `create()`/`update()`: el anti-doble-booking sigue intacto para el flujo normal; el walk-in solo lo omite explícitamente cuando el admin lo pide.

## Pruebas (manuales, no hay suite automatizada)

1. Cita PENDING a las 2pm → "Mover → A ahora" (son las 2:30) → la cita queda a las 2:30, visible en lista y calendario, con entrada en el timeline.
2. "Mover → +30" cuando el asesor tiene otra cita 30 min después → el backend rechaza, se muestra el conflicto, la cita original NO cambia.
3. "Mover" no aparece en citas COMPLETED/CANCELLED.
4. Walk-in con cliente nuevo → crea cita COMPLETED a la hora actual + venta; aparece en agenda, en rendimiento por profesional, y el ingreso suma en analytics.
5. Walk-in cuando el asesor ya tiene una cita encimada → se crea igual (bypass de conflicto), sin romper la otra cita.
6. Reintentar el mismo walk-in (doble clic) → no duplica la venta (idempotencia por `appointmentId`).
