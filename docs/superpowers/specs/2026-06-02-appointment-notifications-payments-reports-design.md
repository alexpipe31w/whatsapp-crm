# Appointment Notifications, Payments & Reports — Design Spec
**Date:** 2026-06-02  
**Project:** stockup-mensajes (whatsapp-crm backend + stockup-frontend)  
**Status:** Approved

---

## Context

The appointment system already has: full CRUD, AI extraction (date/time/service/client), calendar + list views, state machine, timeline audit. What's missing is the notification loop, payment tracking, and daily reports.

---

## Architecture: Option B — Dedicated Services + Granular Crons

Three new NestJS modules, each with a single responsibility, injecting the existing `NotificationsService` (WA via Baileys + email via Brevo). No new infrastructure dependencies.

```
ai.service.ts  ──────────────────────────────────────────────────────┐
AppointmentsService (PATCH confirm/approve)  ─────────────────────────┤
RemindersService (cron every 30min)  ─────────────────────────────────┼──► NotificationService
ReportsService (cron 9pm Colombia)  ──────────────────────────────────┘
                                                  │           │
                                            WhatsappService  EmailService
                                              (Baileys)      (Brevo)
```

---

## Section 1 — Data Model Changes

### `Appointment` — new fields

**Payment tracking:**
```prisma
paymentStatus       String   @default("PENDING") // PENDING | PAID | PARTIAL | REFUNDED
paymentMethod       String?  // efectivo | transferencia | tarjeta | nequi | daviplata | otro
paymentAmount       Decimal? @db.Decimal(10, 2)
paymentProofUrl     String?  // image URL or text excerpt from WA message
paymentNotes        String?
paymentConfirmedAt  DateTime?
```

**Pending actions (cancel/reschedule waiting admin approval):**
```prisma
pendingAction       String?  // CANCEL_REQUESTED | RESCHEDULE_REQUESTED
pendingActionAt     DateTime?
pendingActionData   Json?    // { newDate, newTime } if reschedule
pendingActionReason String?
```

**Reminder tracking (prevents duplicate sends):**
```prisma
reminder8hSentAt  DateTime?
reminder2hSentAt  DateTime?
reminder1hSentAt  DateTime?
```

### New table: `DailyReport`
```prisma
model DailyReport {
  reportId         String   @id @default(uuid())
  storeId          String
  date             DateTime // date only (start of day UTC)
  appointmentsData Json     // { total, completed, confirmed, cancelled, noShow, pending }
  paymentsData     Json     // { confirmed, pending, byMethod: { efectivo, transferencia, ... } }
  clientsData      Json     // { new, recurring }
  createdAt        DateTime @default(now())

  store Store @relation(...)
  @@unique([storeId, date])
  @@map("daily_reports")
}
```

---

## Section 2 — NotificationService

**File:** `src/notifications/notifications.service.ts`  
**Module:** `src/notifications/notifications.module.ts`

Central hub — all other services inject this. Nobody calls WhatsApp or email directly for appointment events.

### Public methods

```typescript
// When AI creates appointment
notifyAppointmentCreated(appt: AppointmentWithRelations): Promise<void>
// → WA to store admin: "📅 Nueva cita agendada por IA — [Cliente] el [fecha] a las [hora]..."
// → Email to admin: full appointment summary

// When admin confirms appointment
notifyAppointmentConfirmed(appt: AppointmentWithRelations): Promise<void>
// → WA to client: "✅ Tu cita está confirmada — [fecha], [hora], [servicio]. ¡Te esperamos!"
// → Email to client (if email exists in customer record)

// Reminders
notifyReminder(appt: AppointmentWithRelations, window: '8h' | '2h' | '1h'): Promise<void>
// → WA + email to client with time-appropriate message

// Cancel/reschedule request from client, waiting admin approval
notifyPendingAction(appt: AppointmentWithRelations, action: 'cancel' | 'reschedule'): Promise<void>
// → WA to admin: "⚠️ [Cliente] solicita [cancelar/reprogramar] su cita del [fecha]"
// → Email to admin with panel link

// Admin approved or rejected client request
notifyActionResolved(appt: AppointmentWithRelations, approved: boolean, reason?: string): Promise<void>
// → WA + email to client

// AI detected payment proof from client
notifyPaymentProofDetected(appt: AppointmentWithRelations, proofExcerpt: string): Promise<void>
// → WA + email to admin: "💳 [Cliente] indica que pagó. Verifica en el panel."
```

### Resilience rules
- Each method sends WA and email independently — partial failure is logged but doesn't throw
- 2 internal retries with 1s backoff on transient errors
- If store has no WA connected: email only, no error
- If client has no email: WA only, no error

---

## Section 3 — RemindersService

**File:** `src/reminders/reminders.service.ts`  
**Cron:** Every 30 minutes (`0,30 * * * *`)

### Algorithm

```
1. Query appointments WHERE:
   - status IN ('CONFIRMED', 'IN_PROGRESS')
   - scheduledAt BETWEEN now AND now + 9 hours
   - storeId IN (active stores with valid subscription)

2. For each appointment, check windows:
   - 8h: reminder8hSentAt IS NULL AND scheduledAt <= now + 8h30m
   - 2h: reminder2hSentAt IS NULL AND scheduledAt <= now + 2h30m
   - 1h: reminder1hSentAt IS NULL AND scheduledAt <= now + 1h30m

3. For each unsent window:
   a. Send via NotificationService.notifyReminder()
   b. In same transaction: UPDATE appointment SET reminder{X}hSentAt = now
      WHERE reminder{X}hSentAt IS NULL  ← atomic, prevents duplicates

4. Max 50 appointments per run (batched to avoid overloading Baileys)
5. Per-appointment errors are caught and logged — don't stop the batch
```

---

## Section 4 — ReportsService

**File:** `src/reports/reports.service.ts`  
**Cron:** `0 2 * * *` (UTC) = 9:00pm Colombia time

### Report content per store

```
CITAS DEL DÍA
─────────────────────────────
Total agendadas:     X
  Completadas:       X  ✅
  Confirmadas:       X  📅  (scheduled but not done yet)
  Canceladas:        X  ❌
  No show:           X  👻
  Pendientes:        X  ⏳

PAGOS DEL DÍA
─────────────────────────────
Ingresos confirmados:  $X,XXX
  Efectivo:            $X,XXX
  Transferencia:       $X,XXX
  Nequi/Daviplata:     $X,XXX
Pagos pendientes:      $X,XXX  (completed appointments, payment unconfirmed)

CLIENTES
─────────────────────────────
Nuevos hoy:            X
Recurrentes:           X
```

### Delivery
- **DB**: saved as `DailyReport` record for Analytics history
- **WhatsApp**: formatted message to admin's store phone
- **Email**: same content via Brevo to admin's email

### Scope
- Runs for all stores with `subscriptionStatus = 'active'`
- If store WA disconnected: email only
- Processes stores in parallel with `Promise.allSettled()` — one store failing doesn't block others

---

## Section 5 — AI Enhancements

Both flows added to `ai.service.ts` as private methods called from `generateReply()`.

### Flow A — Payment Proof Detection

**Trigger keywords** (checked before main AI reply):
```
"pagué", "pagé", "transferí", "te mandé", "comprobante", "transacción",
"consigné", "listo el pago", "ya pagué", "hice el pago"
+ any image/document message type
```

**Logic:**
```
1. Find most recent CONFIRMED or PENDING appointment for this customer
   within the last 48 hours

2. If found:
   a. Save paymentProofUrl or note excerpt to appointment
   b. Call NotificationService.notifyPaymentProofDetected()
   c. Return AI response: "Recibido ✅ Tu comprobante fue enviado al admin para verificación.
      Te confirmaremos en breve."

3. If not found:
   → Fall through to normal AI reply (don't false-positive)
```

### Flow B — Cancel / Reschedule Detection

**Trigger keywords:**
```
"cancelar", "no puedo ir", "no puedo asistir", "cambiar la cita",
"reprogramar", "mover la cita", "otro día", "otra hora",
"posponer", "aplazar"
```

**Logic:**
```
1. Find active appointment (PENDING or CONFIRMED) for this customer

2. Check minimum advance notice:
   - Extracted from store's AI systemPrompt via regex pattern
   - Default: 2 hours if not specified
   - Example system prompt config: "Cancelaciones con mínimo 2 horas de anticipación"

3. If appointment is within the minimum window:
   → IA responds: "Lo sentimos, solo podemos procesar cambios con al menos [X] horas
     de anticipación. Contacta directamente a la barbería."
   → Return early

4. If outside window:
   a. Extract intent: CANCEL_REQUESTED vs RESCHEDULE_REQUESTED
   b. If reschedule: extract proposed new date/time
   c. Set appointment.pendingAction + pendingActionAt + pendingActionData + pendingActionReason
   d. Call NotificationService.notifyPendingAction()
   e. IA responds: "Tu solicitud fue enviada al admin. Te confirmaremos en breve ✅"

5. When admin approves from panel (PATCH /appointments/:id):
   - CANCEL: status → CANCELLED, pendingAction → null
   - RESCHEDULE: scheduledAt updated, status stays CONFIRMED, pendingAction → null
   - In both cases: NotificationService.notifyActionResolved()
```

---

## Section 6 — Frontend

### A — Appointment Detail Panel — new "Pago" tab

Added to existing slide-in panel in `Appointments.tsx`:

```
Pestaña "Pago":
  [Badge] PENDIENTE / PAGADO / PARCIAL / REEMBOLSADO

  Método:    [dropdown] efectivo | transferencia | tarjeta | nequi | daviplata | otro
  Monto:     [$] input numérico
  Notas:     textarea (comprobante, referencia, etc.)
  Proof URL: link/thumbnail si IA detectó imagen

  [Botón primario] "Confirmar pago" → PATCH { paymentStatus: 'PAID', paymentMethod, paymentAmount, paymentNotes }
  [Texto] Confirmado el [fecha] (si ya está pagado)
```

### B — Pending Actions Badge + Filter

```
Header de /appointments:
  [Chip rojo] "X solicitudes pendientes" (si pendingAction count > 0)
  → Click: filtra vista a citas con pendingAction !== null

En el panel de detalle (si pendingAction activo):
  [Card ámbar] ⚠️ Solicitud de [cancelación/reprogramación]
  Motivo: "[texto del cliente]"
  Nueva fecha propuesta: [fecha] (si aplica)
  [✅ Aprobar] [❌ Rechazar con razón]
```

### C — Daily Report in Analytics

```
Nueva sección en Analytics.tsx: "Reporte del Día"
  Cards: Ingresos confirmados | Citas completadas | Canceladas | No-show
  Historial: lista de reportes anteriores (fecha + resumen)
  [Botón] "Generar reporte ahora" → POST /reports/generate (manual trigger)
```

---

## API Changes

### Modified endpoints
- `PATCH /appointments/:id` — accepts new payment fields + pendingAction resolution fields

### New endpoints
- `POST /reports/generate` — manual trigger (admin only, uses CRON_SECRET or JWT)
- `GET /reports/daily?storeId=&limit=30` — history for Analytics

---

## Module Structure

```
src/
  notifications/
    notifications.module.ts
    notifications.service.ts
  reminders/
    reminders.module.ts
    reminders.service.ts
  reports/
    reports.module.ts
    reports.service.ts
    reports.controller.ts
```

---

## Constraints & Rules

- **Idempotency**: reminder sends use `WHERE sentAt IS NULL` atomic update
- **Multi-tenant**: all queries scoped by `storeId`
- **Subscription gate**: reminders and reports only for active subscriptions
- **WA disconnected**: graceful fallback to email-only, logged not thrown
- **Batch limits**: 50 appointments per reminder run, stores processed with `Promise.allSettled()`
- **Cancellation window**: configurable via system prompt, default 2h
- **Reminder windows**: 8h, 2h, 1h before appointment
- **Report time**: 9pm Colombia (02:00 UTC) daily
