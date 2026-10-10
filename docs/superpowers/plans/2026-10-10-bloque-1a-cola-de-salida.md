# Bloque 1a — Cola de salida de WhatsApp e idempotencia · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que todo lo que el CRM envía por WhatsApp salga de una cola persistente (`wa_outbound`) con clave de idempotencia, reintentos acotados y un solo envío en curso por tienda, que lo entrante repetido no se procese dos veces, y que desaparezcan los envíos duplicados y perdidos que hay hoy. Todo en el proceso único actual.

**Architecture:** Los 17 puntos de envío dejan de llamar a `WhatsappService.sendMessage` y pasan a `OutboundService.enqueue()` (`INSERT … ON CONFLICT (idempotency_key) DO NOTHING`), dentro de la transacción de negocio cuando la hay. Un `OutboundDispatcher` en el mismo proceso reclama filas con `FOR UPDATE SKIP LOCKED` (una por tienda, garantizado además por un índice único parcial), trocea, llama a `WhatsappService.sendPart` (un intento, sin reintentos propios) a través del token `WA_TRANSPORT`, y decide reintento/fallo/aplazamiento con una política pura. Lo entrante se deduplica con `wa_inbound` (mínima). Un servicio de mantenimiento cierra campañas y purga lo viejo con candado de Postgres.

**Tech Stack:** NestJS 11, Prisma 6.19 (`prisma-client` + `@prisma/adapter-pg`), Postgres 16, `@nestjs/schedule`, Jest 30 (proyectos `unit` e `int`), supertest, Baileys 7.0.0-rc.9 (solo detrás de `WA_TRANSPORT`).

**Spec:** `docs/superpowers/specs/2026-10-09-crm-impecable-design.md` (Bloque 1). **Auditoría:** `docs/superpowers/plans/2026-10-10-bloque-1-auditoria.md` (§4 tabla de envíos, §8 alcance de 1a).

---

## Datos que hay que saber antes de empezar

- Repo `C:\Users\alexp\Desktop\proyectos\whatsapp-crm`, rama de trabajo **`bloque-1a-cola-de-salida`** desde `main`.
- Tests: `npm test` (unitarios, `src/**/*.spec.ts`), `npm run test:db` (aplica migraciones a `crm_test`), `npm run test:int` (`test/**/*.int-spec.ts`, Postgres real en WSL puerto **5434**). Si WSL está apagado: `wsl -u root -- service postgresql start`; para tandas largas, `wsl -u root -- sleep 3600` en segundo plano. El **5433** es el túnel a producción: nunca en tests.
- **PROHIBIDO** `prisma db push`, `prisma migrate dev` y `prisma migrate reset` (borran índices parciales como `customers_store_wa_lid_key`; hay un hook que los bloquea). Las migraciones se generan con `prisma migrate diff … --script` y se revisan a mano.
- Harness de integración (`test/support/`): `createTestApp()` levanta `AppModule` con `jest.mock('@whiskeysockets/baileys')` y sustituye WhatsApp por `FakeWhatsapp`; `testPrisma()`, `resetDb()`, `closeTestPrisma()`; `bearer(user)`; fábricas `createStoreWithAdmin`, `createCustomer`, `createProduct`, `createProductWithVariants`. La red está cortada (nada sale a Groq, Meta…).
- **Los mensajes y las conversaciones se borran a las 24 h** (`src/cleanup/cleanup.service.ts:24`, cron `0 5 * * *`: borra toda conversación con más de 24 h de vida). Por eso "clientes que escribieron alguna vez" NO se puede sacar de `messages`: se añade `customers.last_inbound_at` (Task 4) y se rellena con lo que hay.
- Fechas: Prisma guarda `DateTime` en columnas `timestamp(3)` **sin zona, en UTC**. En SQL crudo compara siempre con `(now() AT TIME ZONE 'UTC')`, nunca con `now()` a secas (dependería de la zona de la sesión). Las columnas `@updatedAt` no tienen DEFAULT en BD: un `UPDATE` crudo debe poner `updated_at` a mano.
- `createMany({ skipDuplicates: true })` de Prisma en Postgres es `INSERT … ON CONFLICT DO NOTHING`. Las transacciones interactivas de Prisma tienen 5 s de timeout por defecto (`{ timeout }` para subirlo).
- El despachador se desactiva en tests con `WA_OUTBOUND_DISPATCHER=off` (lo fija `test/support/setup-env.ts`); los tests lo mueven a mano con `dispatcher.tick()`.
- Producción: pod `ssh -o BatchMode=yes -p 2229 instapod@167.114.209.204`, app en `~/app`, BD `instapod`, servicio `app.service`, deploy con `bash ~/app/scripts/deploy-pod.sh` (copia de BD + `migrate deploy` si hay migraciones). Hoy **ningún número está conectado** (auditoría §5.4) y el servicio está cerrado a los clientes: no hay E2E real posible en este sub-bloque.
- Nunca `Set-Content` de PowerShell para `.ts` (mete BOM). Usar Write/Edit.

## Decisiones de diseño (por qué así)

1. **Despachador en `src/whatsapp/`, cola en `src/outbound/`.** `OutboundService` (encolar, cancelar grupo) solo depende de Prisma y lo usa la "API". El despachador es transporte y en 1c se muda al gateway tal cual. Se hablan por `OutboundSignal` (en 1c, LISTEN/NOTIFY) y el despachador llega a Baileys por el token `WA_TRANSPORT` (en 1c, `WhatsAppProvider`). Así no hay dependencias circulares nuevas y desaparecen dos (`Messages↔Whatsapp`, `Notifications→Whatsapp`).
2. **`sendPart` hace un solo intento y no trocea.** El troceo (`splitForWhatsapp`) y los reintentos viven en el despachador; `safeSend` (4 reintentos internos × trozo) desaparece. Así no hay doble troceo ni doble reintento. El progreso de un mensaje troceado se guarda en `provider_message_ids` (un id por trozo enviado): un reintento reanuda en el trozo siguiente y no repite los ya entregados.
3. **`provider_message_ids TEXT[]` en vez de un único `provider_message_id`.** Un mensaje lógico puede ser varios mensajes de WhatsApp; 1c necesita todos los ids para reconocer los ecos `fromMe` propios, y el array sirve también de contador de progreso. Para Cloud API (bloque 8, 1:1) es un array de un elemento.
4. **Clasificación de errores:** `disconnected` (sin socket, 428, "Connection Closed") → la fila vuelve a `pending` con `not_before = now + 30 s ± 20 %` **sin gastar intento**, y se aplazan también las demás pendientes de la tienda (no se martillea un socket caído). Lo que lo acota es la **caducidad por tipo** (`expires_at`: respuesta 6 h, aviso 24 h, recordatorio hasta la hora de la cita, campaña 72 h) → `skipped`; así un número que vuelve tras días no suelta de golpe respuestas viejas. `permanent` (400/403/404) → `failed` sin reintento. `temporary` (timeout, 5xx, `not-acceptable`, desconocido) → backoff exponencial 2 s·2ⁿ⁻¹ con tope 5 min, ±20 % de jitter, mínimo 6 s para `not-acceptable`, y `failed` al 6.º intento.
5. **Un envío en curso por tienda, garantizado por la BD:** índice único parcial `wa_outbound(store_id) WHERE status='sending'` (Prisma no lo declara, igual que `customers_store_wa_lid_key`) + la consulta de candidatos excluye tiendas con una fila en `sending`. Un 23505 al reclamar = "otro proceso ya envía para esa tienda" → se salta.
6. **Orden por destinatario tras un fallo:** una fila no sale si hay otra anterior al mismo `to_jid` que ya falló y espera reintento (`attempts > 0`). Evita que la respuesta del turno N+1 llegue antes que la del turno N.
7. **Huérfanas:** el reclamo pone `locked_until = now + 5 min` y un `claim_token`; si el proceso muere, la siguiente pasada devuelve la fila a `pending` (gastando un intento, para no entrar en bucle si el envío tumba el proceso). Las escrituras de cierre van con `WHERE claim_token = …`: un despachador que perdió su arriendo no pisa a otro. Sigue siendo "al menos una vez": si el proceso muere entre que WhatsApp acepta y se guarda, ese trozo puede repetirse (Baileys no deduplica); está documentado y es inevitable.
8. **Claves naturales:** la auditoría propone `inbound_batch_id`, que no existe hasta 1c. Se usa el **id de WhatsApp del último mensaje del lote** del debounce (`turnId`): estable si el mismo mensaje se reprocesa. Si el mensaje no trae id, `local-<uuid>` (no deduplica, se registra). En el aviso "cita creada" y en las acciones de la IA la clave es por cita; en las solicitudes de cancelar/reprogramar, por cita + momento/fecha pedida. En "¿Confirmamos tu cita?" la deduplicación es "un solo pendiente por conversación" (`group_key`): reprogramar cancela el anterior.
9. **Campañas:** el POST hace `UPDATE … WHERE status='draft'` → `sending` (0 filas = 409) y encola una fila por destinatario **en la misma transacción** (si no hay destinatarios, 400 y la campaña sigue en `draft`). Pasa a `sent` cuando no le quedan filas `pending`/`sending` (servicio de mantenimiento, cada 60 s, idempotente), con `sent_count` = filas enviadas. Se eligió "sent al terminar" y no "sent al encolar" porque el panel ya pinta `sending` como "Enviando" (`stockup-frontend/src/pages/Campaigns.tsx:37`) y mentir "enviada" durante horas (con el hueco entre mensajes una campaña de 500 tarda ~2 h) es peor. Destinatarios: `last_inbound_at IS NOT NULL` (escribieron alguna vez), `accepts_marketing = true`, no bloqueados (mismo criterio de 10 dígitos que `BlockedService.isBlocked`).
10. **Hueco entre mensajes de campaña: 8–20 s al azar desde ya** (valores de la spec, configurables). El bucle actual metía 1,5 s + 2 s cada 10 mensajes (`campaigns.service.ts:91-94`); sin ninguna pausa, la cola soltaría la campaña a la velocidad del socket, que es justo lo que bloquea números. Las respuestas no esperan al hueco (prioridad 0 frente a 20).
11. **Dedupe de entrada:** tabla `wa_inbound` mínima (`id`, `store_id`, `provider_message_id`, `created_at`, UNIQUE `(store_id, provider_message_id)`) con el nombre definitivo: 1c le añade columnas con DEFAULT, sin renombrar. Se inserta con `ON CONFLICT DO NOTHING` en `processMessage` después de descartar grupos y tipos internos (para no llenarla de ruido) y antes de bloqueados/audio/media/texto.
12. **`payload JSONB`** (`{ text, record? }`) en vez de texto: el bloque 8 (plantillas) y media caben sin migración. `record.conversationId` hace que, al enviarse, el texto se guarde en `messages` (lo usa "¿Confirmamos tu cita?", que hoy se guarda al dispararse el temporizador). Ese guardado es posterior al `sent` y "mejor esfuerzo" (si la conversación ya se purgó, se registra un aviso): que falle no puede reenviar el mensaje.

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `src/outbound/outbound.types.ts` | Tipos, prioridad y caducidad por `kind`, forma del `payload` |
| `src/outbound/outbound-keys.ts` (+ `.spec.ts`) | Todas las claves de idempotencia y grupos, `turnIdFor` |
| `src/outbound/outbound-config.ts` (+ `.spec.ts`) | Configuración por entorno (sin valores fijos en código) |
| `src/outbound/outbound.signal.ts` | Timbre encolar → despachador (en 1c, LISTEN/NOTIFY) |
| `src/outbound/outbound.service.ts` | `enqueue`, `enqueueMany`, `cancelGroup`, `wake` |
| `src/outbound/outbound-maintenance.service.ts` | Cierre de campañas terminadas y purga con candado |
| `src/outbound/outbound.module.ts` | Módulo de la cola |
| `src/whatsapp/wa-transport.ts` | Token `WA_TRANSPORT` e interfaz `WaTransport` |
| `src/whatsapp/send-errors.ts` (+ `.spec.ts`) | `WaNotConnectedError`, `SendTimeoutError`, `classifySendError` |
| `src/whatsapp/split-text.ts` (+ `.spec.ts`) | Troceo a 4096 determinista |
| `src/whatsapp/outbound-retry.ts` (+ `.spec.ts`) | Backoff y decisión ante un fallo (puro) |
| `src/whatsapp/outbound-dispatcher.ts` | Reclamo, envío, reintentos, huérfanas, caducidad, hueco de campaña |
| `src/whatsapp/whatsapp.send-part.spec.ts` | `sendPart` hace un intento y propaga el error |
| `prisma/migrations/20261010000002_cola_de_salida_whatsapp/migration.sql` | Tablas, índice parcial, `last_inbound_at` y su relleno |
| `test/support/fake-whatsapp.ts` | Doble de transporte con fallos programables |
| `test/support/app.ts` | `createTestApp({ realWhatsappService, overrides })` |
| `test/support/wait-for.ts` | `waitFor` y `sleep` para el flujo con debounce |
| `test/support/factories.ts` | + `createConversation`, `createAppointment`, opciones de `createCustomer` |
| `test/integration/*.int-spec.ts` | Una suite por pieza (ver cada Task) |

Modificados: `prisma/schema.prisma`, `src/app.module.ts`, `src/whatsapp/whatsapp.service.ts`, `src/whatsapp/whatsapp.module.ts`, `src/messages/*`, `src/notifications/*`, `src/appointments/*`, `src/auto-confirm/*`, `src/reminders/*`, `src/admin-assistant/*`, `src/ai/ai.service.ts`, `src/ai/ai.module.ts`, `src/public/public.service.ts`, `src/campaigns/*`, `src/reports/*`, `test/support/setup-env.ts`, `test/README.md`.

---

### Task 1: Rama, tipos de la cola y claves de idempotencia

**Files:**
- Create: `src/outbound/outbound.types.ts`
- Create: `src/outbound/outbound-keys.ts`
- Test: `src/outbound/outbound-keys.spec.ts`

- [ ] **Step 1: Crear la rama**

```bash
cd /c/Users/alexp/Desktop/proyectos/whatsapp-crm
git checkout main && git pull --ff-only
git checkout -b bloque-1a-cola-de-salida
```

- [ ] **Step 2: Escribir el test que falla**

`src/outbound/outbound-keys.spec.ts`:

```ts
import { outboundGroups, outboundKeys, turnIdFor } from './outbound-keys';
import { KIND_PRIORITY, KIND_TTL_MS, OUTBOUND_KINDS } from './outbound.types';

const STORE = '5ed677ed-0000-4000-8000-000000000001';
const UUID = '0b6a3f0e-1111-4222-8333-444455556666';

describe('outboundKeys', () => {
  it('las claves de un turno de entrada llevan la tienda y el id de WhatsApp', () => {
    expect(outboundKeys.aiReply(STORE, '3EB0ABC')).toBe(`reply:${STORE}:3EB0ABC`);
    expect(outboundKeys.handoff(STORE, '3EB0ABC')).toBe(`handoff:${STORE}:3EB0ABC`);
    expect(outboundKeys.mediaAck(STORE, '3EB0ABC')).toBe(`media-ack:${STORE}:3EB0ABC`);
    expect(outboundKeys.audioTooLong(STORE, '3EB0ABC')).toBe(`audio-long:${STORE}:3EB0ABC`);
    expect(outboundKeys.adminReply(STORE, '3EB0ABC')).toBe(`admin-reply:${STORE}:3EB0ABC`);
  });

  it('la confirmación depende de la hora de la cita: si se reprograma, vuelve a avisar', () => {
    const a = outboundKeys.apptConfirmed(UUID, new Date('2026-11-01T15:00:00Z'));
    const b = outboundKeys.apptConfirmed(UUID, new Date('2026-11-02T15:00:00Z'));
    expect(a).toBe(`appt:${UUID}:confirmed:${Date.parse('2026-11-01T15:00:00Z')}`);
    expect(a).not.toBe(b);
  });

  it('no mete teléfonos ni textos del cliente en claro (las claves salen en los logs)', () => {
    const k1 = outboundKeys.adminToCustomer(STORE, 'T1', '+57 300 111 2233');
    expect(k1).not.toContain('3001112233');
    expect(k1).toBe(outboundKeys.adminToCustomer(STORE, 'T1', '573001112233'));
    const k2 = outboundKeys.apptPaymentProof(UUID, 'Pagué por Nequi 300 111 2233');
    expect(k2).not.toContain('Nequi');
    expect(k2).toBe(outboundKeys.apptPaymentProof(UUID, 'Pagué por Nequi 300 111 2233'));
    const k3 = outboundKeys.apptPendingAction(UUID, 'reschedule', '2026-11-01T10:00');
    expect(k3).not.toBe(outboundKeys.apptPendingAction(UUID, 'reschedule', '2026-11-01T11:00'));
  });

  it('resolución de una solicitud: distinta por acción, resultado y momento de la solicitud', () => {
    const at = new Date('2026-11-01T10:00:00Z');
    const approved = outboundKeys.apptResolved(UUID, 'CANCEL_REQUESTED', true, at);
    expect(approved).toBe(`appt:${UUID}:resolved:CANCEL_REQUESTED:approved:${at.getTime()}`);
    expect(outboundKeys.apptResolved(UUID, 'CANCEL_REQUESTED', false, at)).not.toBe(approved);
    expect(outboundKeys.apptResolved(UUID, 'CANCEL_REQUESTED', true, null)).toBe(
      `appt:${UUID}:resolved:CANCEL_REQUESTED:approved:na`,
    );
  });

  it('recordatorios, avisos al admin, reportes y campañas', () => {
    expect(outboundKeys.apptReminder(UUID, '2h')).toBe(`appt:${UUID}:reminder:2h`);
    expect(outboundKeys.apptCreatedAdmin(UUID)).toBe(`appt:${UUID}:created:admin`);
    expect(outboundKeys.apptCancelledByAdmin(UUID)).toBe(`appt:${UUID}:cancelled`);
    expect(outboundKeys.agentMessage(UUID)).toBe(`msg:${UUID}`);
    expect(outboundKeys.dailyReport(STORE, '2026-10-10')).toBe(`report:${STORE}:2026-10-10`);
    expect(outboundKeys.manualReport(STORE, UUID)).toBe(`report:${STORE}:manual:${UUID}`);
    expect(outboundKeys.morningBriefing(STORE, '2026-10-10')).toBe(`briefing:${STORE}:2026-10-10`);
    expect(outboundKeys.campaign(UUID, STORE)).toBe(`campaign:${UUID}:${STORE}`);
    expect(outboundKeys.confirmNudge(UUID, 'abc')).toBe(`confirm-nudge:${UUID}:abc`);
  });

  it('todas las claves caben en la columna (200)', () => {
    const long = 'x'.repeat(40);
    const keys = [
      outboundKeys.aiReply(STORE, long),
      outboundKeys.adminToCustomer(STORE, long, '573001112233'),
      outboundKeys.apptResolved(UUID, 'RESCHEDULE_REQUESTED', false, new Date()),
      outboundKeys.apptPendingAction(UUID, 'reschedule', '2026-11-01T10:00'),
      outboundKeys.confirmNudge(UUID, UUID),
      outboundKeys.campaign(UUID, UUID),
      outboundKeys.manualReport(STORE, UUID),
    ];
    for (const k of keys) expect(k.length).toBeLessThanOrEqual(200);
  });

  it('grupos', () => {
    expect(outboundGroups.campaign(UUID)).toBe(`campaign:${UUID}`);
    expect(outboundGroups.confirmNudge(UUID)).toBe(`confirm-nudge:${UUID}`);
  });
});

describe('turnIdFor', () => {
  it('usa el id de WhatsApp si lo hay', () => {
    expect(turnIdFor(' 3EB0ABC ')).toBe('3EB0ABC');
  });

  it('sin id genera uno local distinto cada vez', () => {
    const a = turnIdFor(undefined);
    const b = turnIdFor('');
    expect(a).toMatch(/^local-[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});

describe('prioridad y caducidad por tipo', () => {
  it('respuestas antes que avisos y recordatorios, y estos antes que campañas', () => {
    expect(KIND_PRIORITY.reply).toBeLessThan(KIND_PRIORITY.notification);
    expect(KIND_PRIORITY.notification).toBe(KIND_PRIORITY.reminder);
    expect(KIND_PRIORITY.reminder).toBeLessThan(KIND_PRIORITY.campaign);
  });

  it('todos los tipos caducan', () => {
    for (const k of OUTBOUND_KINDS) expect(KIND_TTL_MS[k]).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Comprobar que falla**

Run: `npm test -- src/outbound/outbound-keys.spec.ts`
Expected: FAIL, `Cannot find module './outbound-keys'`.

- [ ] **Step 4: Crear `src/outbound/outbound.types.ts`**

```ts
/**
 * Tipos de la cola de salida de WhatsApp (tabla wa_outbound, bloque 1a).
 * El gateway del bloque 1c leerá esta misma tabla: no cambiar los valores que se
 * guardan en BD (kind, status) sin migración.
 */
export const OUTBOUND_KINDS = ['reply', 'notification', 'reminder', 'campaign'] as const;
export type OutboundKind = (typeof OUTBOUND_KINDS)[number];

export const OUTBOUND_STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped'] as const;
export type OutboundStatus = (typeof OUTBOUND_STATUSES)[number];

/** Menor = antes. Respuestas > avisos y recordatorios > campañas (spec). */
export const KIND_PRIORITY: Record<OutboundKind, number> = {
  reply: 0,
  notification: 10,
  reminder: 10,
  campaign: 20,
};

/**
 * Caducidad por defecto (desde not_before). Pasado este tiempo sin poder enviarse
 * (p. ej. con WhatsApp desconectado) la fila pasa a `skipped`: así un número que
 * vuelve tras días no suelta de golpe respuestas viejas. Los recordatorios pasan su
 * propia caducidad (la hora de la cita).
 */
export const KIND_TTL_MS: Record<OutboundKind, number> = {
  reply: 6 * 60 * 60 * 1000,
  notification: 24 * 60 * 60 * 1000,
  reminder: 12 * 60 * 60 * 1000,
  campaign: 72 * 60 * 60 * 1000,
};

/** Lo que se guarda en wa_outbound.payload (JSONB: el bloque 8 añadirá plantillas y media). */
export interface OutboundPayload {
  text: string;
  /** Si viene, al enviarse se guarda el texto en `messages` de esa conversación. */
  record?: { conversationId: string };
}
```

- [ ] **Step 5: Crear `src/outbound/outbound-keys.ts`**

```ts
import { createHash, randomUUID } from 'node:crypto';

/**
 * Claves de idempotencia de wa_outbound (UNIQUE). Dos encolados con la misma clave
 * dejan UNA fila: es lo que impide los envíos duplicados. Las claves salen en los
 * logs, así que teléfonos y textos del cliente van con hash, nunca en claro.
 * Ver la tabla de la auditoría del bloque 1, §4.
 */
function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * Id del "turno" de entrada: el id de WhatsApp del último mensaje del lote del
 * debounce. Si WhatsApp reentrega el mismo mensaje, el turno es el mismo y la
 * respuesta no se encola dos veces. Sin id (raro), uno local: ese turno no se
 * puede deduplicar entre reinicios.
 */
export function turnIdFor(waMessageId: string | null | undefined): string {
  const id = waMessageId?.trim();
  return id ? id : `local-${randomUUID()}`;
}

export const outboundKeys = {
  aiReply: (storeId: string, turnId: string) => `reply:${storeId}:${turnId}`,
  handoff: (storeId: string, turnId: string) => `handoff:${storeId}:${turnId}`,
  mediaAck: (storeId: string, turnId: string) => `media-ack:${storeId}:${turnId}`,
  audioTooLong: (storeId: string, turnId: string) => `audio-long:${storeId}:${turnId}`,
  adminReply: (storeId: string, turnId: string) => `admin-reply:${storeId}:${turnId}`,
  adminToCustomer: (storeId: string, turnId: string, phone: string) =>
    `admin-msg:${storeId}:${turnId}:${shortHash(phone.replace(/\D/g, '') || phone)}`,
  agentMessage: (messageId: string) => `msg:${messageId}`,
  apptConfirmed: (appointmentId: string, scheduledAt: Date) =>
    `appt:${appointmentId}:confirmed:${scheduledAt.getTime()}`,
  apptCancelledByAdmin: (appointmentId: string) => `appt:${appointmentId}:cancelled`,
  apptResolved: (appointmentId: string, action: string, approved: boolean, requestedAt: Date | null | undefined) =>
    `appt:${appointmentId}:resolved:${action}:${approved ? 'approved' : 'rejected'}:${requestedAt ? requestedAt.getTime() : 'na'}`,
  apptReminder: (appointmentId: string, window: '8h' | '2h' | '1h') => `appt:${appointmentId}:reminder:${window}`,
  apptCreatedAdmin: (appointmentId: string) => `appt:${appointmentId}:created:admin`,
  apptPendingAction: (appointmentId: string, action: 'cancel' | 'reschedule', requestKey: string) =>
    `appt:${appointmentId}:pending:${action}:${shortHash(requestKey)}`,
  apptPaymentProof: (appointmentId: string, excerpt: string) =>
    `appt:${appointmentId}:payment-proof:${shortHash(excerpt)}`,
  /** Un id por programación: la deduplicación aquí es "un pendiente por conversación" (grupo). */
  confirmNudge: (conversationId: string, scheduleId: string) => `confirm-nudge:${conversationId}:${scheduleId}`,
  dailyReport: (storeId: string, localDate: string) => `report:${storeId}:${localDate}`,
  manualReport: (storeId: string, requestId: string) => `report:${storeId}:manual:${requestId}`,
  morningBriefing: (storeId: string, localDate: string) => `briefing:${storeId}:${localDate}`,
  campaign: (campaignId: string, customerId: string) => `campaign:${campaignId}:${customerId}`,
};

/** group_key: filas que se cancelan o se cierran juntas. */
export const outboundGroups = {
  campaign: (campaignId: string) => `campaign:${campaignId}`,
  confirmNudge: (conversationId: string) => `confirm-nudge:${conversationId}`,
};
```

- [ ] **Step 6: Comprobar que pasa**

Run: `npm test -- src/outbound/outbound-keys.spec.ts`
Expected: PASS (12 tests).

- [ ] **Step 7: Commit**

```bash
git add src/outbound/outbound.types.ts src/outbound/outbound-keys.ts src/outbound/outbound-keys.spec.ts
git commit -m "feat(outbound): tipos de la cola y claves de idempotencia de WhatsApp"
```

---

### Task 2: Troceo, clasificación de errores y política de reintentos (puros)

**Files:**
- Create: `src/whatsapp/split-text.ts`, `src/whatsapp/send-errors.ts`, `src/whatsapp/outbound-retry.ts`
- Test: `src/whatsapp/split-text.spec.ts`, `src/whatsapp/send-errors.spec.ts`, `src/whatsapp/outbound-retry.spec.ts`

- [ ] **Step 1: Escribir los tests que fallan**

`src/whatsapp/split-text.spec.ts`:

```ts
import { splitForWhatsapp, WA_MAX_TEXT_LENGTH } from './split-text';

describe('splitForWhatsapp', () => {
  it('un texto corto va entero', () => {
    expect(splitForWhatsapp('hola')).toEqual(['hola']);
  });

  it('sin saltos de línea corta en seco a 4096', () => {
    const parts = splitForWhatsapp('a'.repeat(5000));
    expect(parts.map((p) => p.length)).toEqual([4096, 904]);
  });

  it('corta por el último salto de línea si está por encima del 70 %', () => {
    const text = 'a'.repeat(3500) + '\n' + 'b'.repeat(1500);
    const parts = splitForWhatsapp(text);
    expect(parts[0]).toBe('a'.repeat(3500) + '\n');
    expect(parts[1]).toBe('b'.repeat(1500));
  });

  it('ignora un salto de línea por debajo del 70 %', () => {
    const text = 'a'.repeat(1000) + '\n' + 'b'.repeat(4000);
    expect(splitForWhatsapp(text)[0].length).toBe(4096);
  });

  it('nunca pasa de 4096 aunque el salto caiga justo en la posición 4096 (safeSend daba 4097)', () => {
    const text = 'a'.repeat(4096) + '\n' + 'b'.repeat(10);
    for (const p of splitForWhatsapp(text)) expect(p.length).toBeLessThanOrEqual(WA_MAX_TEXT_LENGTH);
  });

  it('es determinista y no pierde ni un carácter', () => {
    const text = Array.from({ length: 900 }, (_, i) => `línea ${i} con texto`).join('\n');
    const a = splitForWhatsapp(text);
    expect(splitForWhatsapp(text)).toEqual(a);
    expect(a.join('')).toBe(text);
  });
});
```

`src/whatsapp/send-errors.spec.ts`:

```ts
import { classifySendError, isNotAcceptable, SendTimeoutError, WaNotConnectedError } from './send-errors';

const boom = (message: string, statusCode: number) => Object.assign(new Error(message), { output: { statusCode } });

describe('classifySendError', () => {
  it('sin socket = desconectado', () => {
    expect(classifySendError(new WaNotConnectedError('s1'))).toBe('disconnected');
  });

  it('Connection Closed (428) o conexión perdida = desconectado', () => {
    expect(classifySendError(boom('Connection Closed', 428))).toBe('disconnected');
    expect(classifySendError(new Error('Connection Lost'))).toBe('disconnected');
  });

  it('timeout, 5xx y nuestro propio timeout = temporal', () => {
    expect(classifySendError(boom('Timed Out', 408))).toBe('temporary');
    expect(classifySendError(boom('Internal Server Error', 500))).toBe('temporary');
    expect(classifySendError(new SendTimeoutError(30_000))).toBe('temporary');
  });

  it('not-acceptable = temporal y se reconoce para esperar más', () => {
    const err = new Error('not-acceptable');
    expect(classifySendError(err)).toBe('temporary');
    expect(isNotAcceptable(err)).toBe(true);
    expect(isNotAcceptable(new Error('Timed Out'))).toBe(false);
  });

  it('400, 403 y 404 = permanente', () => {
    expect(classifySendError(boom('bad-request', 400))).toBe('permanent');
    expect(classifySendError(boom('forbidden', 403))).toBe('permanent');
    expect(classifySendError(boom('item-not-found', 404))).toBe('permanent');
  });

  it('lo desconocido = temporal (lo frena el tope de intentos)', () => {
    expect(classifySendError(new Error('???'))).toBe('temporary');
    expect(classifySendError('texto suelto')).toBe('temporary');
    expect(classifySendError(undefined)).toBe('temporary');
  });
});
```

`src/whatsapp/outbound-retry.spec.ts`:

```ts
import { computeRetryDelay, decideOnFailure, NOT_ACCEPTABLE_MIN_DELAY_MS, RetryConfig } from './outbound-retry';

const cfg: RetryConfig = { maxAttempts: 6, retryBaseMs: 2_000, retryMaxMs: 300_000, disconnectedDelayMs: 30_000 };
const noJitter = () => 0.5; // 0.8 + 0.5*0.4 = 1.0

describe('computeRetryDelay', () => {
  it('exponencial desde 2 s', () => {
    expect(computeRetryDelay(1, false, cfg, noJitter)).toBe(2_000);
    expect(computeRetryDelay(2, false, cfg, noJitter)).toBe(4_000);
    expect(computeRetryDelay(3, false, cfg, noJitter)).toBe(8_000);
  });

  it('con tope de 5 min', () => {
    expect(computeRetryDelay(20, false, cfg, noJitter)).toBe(300_000);
  });

  it('not-acceptable espera al menos 6 s (sesión Signal renegociando)', () => {
    expect(computeRetryDelay(1, true, cfg, noJitter)).toBe(NOT_ACCEPTABLE_MIN_DELAY_MS);
  });

  it('jitter de ±20 %', () => {
    expect(computeRetryDelay(1, false, cfg, () => 0)).toBe(1_600);
    expect(computeRetryDelay(1, false, cfg, () => 1)).toBe(2_400);
  });
});

describe('decideOnFailure', () => {
  it('desconectado: vuelve a pendiente sin gastar intento y aplaza la tienda', () => {
    expect(decideOnFailure('disconnected', false, 2, cfg, noJitter)).toEqual({
      status: 'pending', attempts: 2, delayMs: 30_000, postponeStore: true,
    });
  });

  it('temporal: gasta un intento y reintenta con backoff', () => {
    expect(decideOnFailure('temporary', false, 0, cfg, noJitter)).toEqual({
      status: 'pending', attempts: 1, delayMs: 2_000, postponeStore: false,
    });
  });

  it('temporal en el último intento: falla', () => {
    expect(decideOnFailure('temporary', false, 5, cfg, noJitter)).toEqual({
      status: 'failed', attempts: 6, delayMs: null, postponeStore: false,
    });
  });

  it('permanente: falla al primero', () => {
    expect(decideOnFailure('permanent', false, 0, cfg, noJitter)).toEqual({
      status: 'failed', attempts: 1, delayMs: null, postponeStore: false,
    });
  });
});
```

- [ ] **Step 2: Comprobar que fallan**

Run: `npm test -- src/whatsapp/split-text.spec.ts src/whatsapp/send-errors.spec.ts src/whatsapp/outbound-retry.spec.ts`
Expected: FAIL, `Cannot find module` en las tres.

- [ ] **Step 3: Crear `src/whatsapp/split-text.ts`**

```ts
export const WA_MAX_TEXT_LENGTH = 4096;

/**
 * Trocea un texto para WhatsApp (máx. 4096 por mensaje). Corta por el último salto
 * de línea si cae por encima del 70 % del trozo; si no, corta en seco. Mismo criterio
 * que el antiguo safeSend, salvo que el salto se busca hasta max-1 (safeSend podía
 * devolver un trozo de 4097). Es determinista: un reintento reanuda por el trozo
 * exacto donde se quedó (wa_outbound.provider_message_ids guarda los ya enviados).
 */
export function splitForWhatsapp(text: string, max = WA_MAX_TEXT_LENGTH): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let cut = max;
    if (remaining.length > max) {
      const lastNewline = remaining.lastIndexOf('\n', max - 1);
      if (lastNewline > max * 0.7) cut = lastNewline + 1;
    }
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return parts;
}
```

- [ ] **Step 4: Crear `src/whatsapp/send-errors.ts`**

```ts
/** No hay socket de WhatsApp para la tienda (desconectada, pidiendo QR, reconectando). */
export class WaNotConnectedError extends Error {
  constructor(readonly storeId: string) {
    super(`WhatsApp no conectado (store ${storeId})`);
    this.name = 'WaNotConnectedError';
  }
}

/** El envío no respondió a tiempo. Puede que WhatsApp lo haya aceptado igualmente. */
export class SendTimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`Timed Out (envío > ${ms} ms)`);
    this.name = 'SendTimeoutError';
  }
}

export type SendErrorClass = 'disconnected' | 'temporary' | 'permanent';

const DISCONNECTED_STATUS = new Set([428]);
const PERMANENT_STATUS = new Set([400, 403, 404]);
const DISCONNECTED_RE = /connection closed|connection lost|connection terminated/i;
const PERMANENT_RE = /bad-request|item-not-found|forbidden/i;

/**
 * Clasifica un error de envío. Baileys lanza errores Boom (`output.statusCode`).
 * Lo desconocido se trata como temporal: lo acota el tope de intentos.
 */
export function classifySendError(err: unknown): SendErrorClass {
  if (err instanceof WaNotConnectedError) return 'disconnected';
  if (err instanceof SendTimeoutError) return 'temporary';
  const e = err as { message?: unknown; output?: { statusCode?: number }; data?: { statusCode?: number } } | null;
  const status = e?.output?.statusCode ?? e?.data?.statusCode;
  const message = String(e?.message ?? '');
  if ((status !== undefined && DISCONNECTED_STATUS.has(status)) || DISCONNECTED_RE.test(message)) return 'disconnected';
  if ((status !== undefined && PERMANENT_STATUS.has(status)) || PERMANENT_RE.test(message)) return 'permanent';
  return 'temporary';
}

/** `not-acceptable`: la sesión Signal se está renegociando; hay que esperar más. */
export function isNotAcceptable(err: unknown): boolean {
  return /not-acceptable/i.test(String((err as { message?: unknown } | null)?.message ?? ''));
}
```

- [ ] **Step 5: Crear `src/whatsapp/outbound-retry.ts`**

```ts
import type { SendErrorClass } from './send-errors';

export const NOT_ACCEPTABLE_MIN_DELAY_MS = 6_000;

export interface RetryConfig {
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  disconnectedDelayMs: number;
}

export interface FailureDecision {
  status: 'pending' | 'failed';
  /** Intentos tras este fallo (los de "desconectado" no cuentan). */
  attempts: number;
  /** Espera hasta el siguiente intento; null si la fila queda en failed. */
  delayMs: number | null;
  /** true: aplazar también las demás pendientes de la tienda (socket caído). */
  postponeStore: boolean;
}

function jitter(ms: number, random: () => number): number {
  return Math.round(ms * (0.8 + random() * 0.4));
}

/** Backoff exponencial con tope y ±20 % de jitter. `attempt` empieza en 1. */
export function computeRetryDelay(
  attempt: number,
  notAcceptable: boolean,
  cfg: RetryConfig,
  random: () => number = Math.random,
): number {
  const exp = Math.min(cfg.retryBaseMs * 2 ** Math.max(0, attempt - 1), cfg.retryMaxMs);
  const base = notAcceptable ? Math.max(exp, NOT_ACCEPTABLE_MIN_DELAY_MS) : exp;
  return jitter(base, random);
}

/**
 * Qué hacer con una fila cuyo envío falló.
 * - desconectado: vuelve a pending sin gastar intento (lo acota expires_at).
 * - permanente o tope alcanzado: failed.
 * - temporal: pending con backoff.
 */
export function decideOnFailure(
  errorClass: SendErrorClass,
  notAcceptable: boolean,
  attemptsBefore: number,
  cfg: RetryConfig,
  random: () => number = Math.random,
): FailureDecision {
  if (errorClass === 'disconnected') {
    return { status: 'pending', attempts: attemptsBefore, delayMs: jitter(cfg.disconnectedDelayMs, random), postponeStore: true };
  }
  const attempts = attemptsBefore + 1;
  if (errorClass === 'permanent' || attempts >= cfg.maxAttempts) {
    return { status: 'failed', attempts, delayMs: null, postponeStore: false };
  }
  return { status: 'pending', attempts, delayMs: computeRetryDelay(attempts, notAcceptable, cfg, random), postponeStore: false };
}
```

- [ ] **Step 6: Comprobar que pasan**

Run: `npm test -- src/whatsapp/split-text.spec.ts src/whatsapp/send-errors.spec.ts src/whatsapp/outbound-retry.spec.ts`
Expected: PASS (6 + 6 + 8 tests).

- [ ] **Step 7: Commit**

```bash
git add src/whatsapp/split-text.ts src/whatsapp/split-text.spec.ts src/whatsapp/send-errors.ts src/whatsapp/send-errors.spec.ts src/whatsapp/outbound-retry.ts src/whatsapp/outbound-retry.spec.ts
git commit -m "feat(whatsapp): troceo determinista, clasificación de errores y política de reintentos"
```

---

### Task 3: Configuración de la cola por entorno

**Files:**
- Create: `src/outbound/outbound-config.ts`
- Test: `src/outbound/outbound-config.spec.ts`

- [ ] **Step 1: Escribir el test que falla**

`src/outbound/outbound-config.spec.ts`:

```ts
import { loadOutboundConfig } from './outbound-config';

describe('loadOutboundConfig', () => {
  it('valores por defecto sin variables', () => {
    expect(loadOutboundConfig({})).toEqual({
      dispatcherEnabled: true,
      pollMs: 2_000,
      maxParallel: 5,
      maxLoopsPerTick: 50,
      maxAttempts: 6,
      retryBaseMs: 2_000,
      retryMaxMs: 300_000,
      leaseMs: 300_000,
      sendTimeoutMs: 30_000,
      disconnectedDelayMs: 30_000,
      campaignGapMinMs: 8_000,
      campaignGapMaxMs: 20_000,
      outboundRetentionDays: 30,
      inboundRetentionDays: 7,
    });
  });

  it('lee las variables', () => {
    const cfg = loadOutboundConfig({
      WA_OUTBOUND_DISPATCHER: 'off',
      WA_OUTBOUND_MAX_ATTEMPTS: '3',
      WA_CAMPAIGN_GAP_MIN_MS: '0',
      WA_CAMPAIGN_GAP_MAX_MS: '0',
    });
    expect(cfg.dispatcherEnabled).toBe(false);
    expect(cfg.maxAttempts).toBe(3);
    expect(cfg.campaignGapMinMs).toBe(0);
  });

  it('falla al arrancar con un valor inválido (mejor que un valor raro en silencio)', () => {
    expect(() => loadOutboundConfig({ WA_OUTBOUND_POLL_MS: 'abc' })).toThrow(/WA_OUTBOUND_POLL_MS/);
    expect(() => loadOutboundConfig({ WA_OUTBOUND_MAX_ATTEMPTS: '0' })).toThrow(/WA_OUTBOUND_MAX_ATTEMPTS/);
    expect(() => loadOutboundConfig({ WA_OUTBOUND_DISPATCHER: 'quizas' })).toThrow(/WA_OUTBOUND_DISPATCHER/);
  });

  it('el hueco de campaña máximo no puede ser menor que el mínimo', () => {
    expect(() => loadOutboundConfig({ WA_CAMPAIGN_GAP_MIN_MS: '9000', WA_CAMPAIGN_GAP_MAX_MS: '1000' })).toThrow(/GAP/);
  });
});
```

- [ ] **Step 2: Comprobar que falla**

Run: `npm test -- src/outbound/outbound-config.spec.ts`
Expected: FAIL, `Cannot find module './outbound-config'`.

- [ ] **Step 3: Crear `src/outbound/outbound-config.ts`**

```ts
/**
 * Configuración de la cola de salida. Todo por entorno: ampliar el pod o ajustar
 * ritmos = cambiar variables y reiniciar, sin tocar código (spec).
 */
export interface OutboundConfig {
  /** WA_OUTBOUND_DISPATCHER=on|off. off en tests: se mueve a mano con tick(). */
  dispatcherEnabled: boolean;
  /** Sondeo de respaldo (además del aviso inmediato al encolar). */
  pollMs: number;
  /** Tiendas atendidas en paralelo por pasada (siempre una fila por tienda). */
  maxParallel: number;
  /** Vueltas máximas por pasada antes de ceder. */
  maxLoopsPerTick: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /** Arriendo de una fila en `sending`; vencido, se considera huérfana. */
  leaseMs: number;
  /** Tiempo máximo por trozo enviado. */
  sendTimeoutMs: number;
  /** Espera antes de volver a probar una tienda sin socket. */
  disconnectedDelayMs: number;
  campaignGapMinMs: number;
  campaignGapMaxMs: number;
  outboundRetentionDays: number;
  inboundRetentionDays: number;
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, def: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`[outbound] ${name}="${raw}" no es un entero >= ${min}`);
  }
  return n;
}

export function loadOutboundConfig(env: Env = process.env): OutboundConfig {
  const flag = (env.WA_OUTBOUND_DISPATCHER ?? 'on').trim().toLowerCase();
  if (flag !== 'on' && flag !== 'off') {
    throw new Error(`[outbound] WA_OUTBOUND_DISPATCHER="${flag}": usa on u off`);
  }
  const cfg: OutboundConfig = {
    dispatcherEnabled: flag === 'on',
    pollMs: int(env, 'WA_OUTBOUND_POLL_MS', 2_000, 100),
    maxParallel: int(env, 'WA_OUTBOUND_MAX_PARALLEL', 5, 1),
    maxLoopsPerTick: int(env, 'WA_OUTBOUND_MAX_LOOPS', 50, 1),
    maxAttempts: int(env, 'WA_OUTBOUND_MAX_ATTEMPTS', 6, 1),
    retryBaseMs: int(env, 'WA_OUTBOUND_RETRY_BASE_MS', 2_000, 1),
    retryMaxMs: int(env, 'WA_OUTBOUND_RETRY_MAX_MS', 300_000, 1),
    leaseMs: int(env, 'WA_OUTBOUND_LEASE_MS', 300_000, 1_000),
    sendTimeoutMs: int(env, 'WA_SEND_TIMEOUT_MS', 30_000, 1),
    disconnectedDelayMs: int(env, 'WA_OUTBOUND_DISCONNECTED_DELAY_MS', 30_000, 1),
    campaignGapMinMs: int(env, 'WA_CAMPAIGN_GAP_MIN_MS', 8_000, 0),
    campaignGapMaxMs: int(env, 'WA_CAMPAIGN_GAP_MAX_MS', 20_000, 0),
    outboundRetentionDays: int(env, 'WA_OUTBOUND_RETENTION_DAYS', 30, 1),
    inboundRetentionDays: int(env, 'WA_INBOUND_RETENTION_DAYS', 7, 1),
  };
  if (cfg.campaignGapMaxMs < cfg.campaignGapMinMs) {
    throw new Error('[outbound] WA_CAMPAIGN_GAP_MAX_MS no puede ser menor que WA_CAMPAIGN_GAP_MIN_MS');
  }
  if (cfg.retryMaxMs < cfg.retryBaseMs) {
    throw new Error('[outbound] WA_OUTBOUND_RETRY_MAX_MS no puede ser menor que WA_OUTBOUND_RETRY_BASE_MS');
  }
  return cfg;
}
```

- [ ] **Step 4: Comprobar que pasa**

Run: `npm test -- src/outbound/outbound-config.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/outbound/outbound-config.ts src/outbound/outbound-config.spec.ts
git commit -m "feat(outbound): configuración de la cola por variables de entorno"
```

---

### Task 4: Migración: `wa_outbound`, `wa_inbound` y `customers.last_inbound_at`

**Files:**
- Modify: `prisma/schema.prisma` (modelos `Store`, `Customer`; nuevos `WaOutbound`, `WaInbound`)
- Create: `prisma/migrations/20261010000002_cola_de_salida_whatsapp/migration.sql`
- Test: `test/integration/wa-tables.int-spec.ts`

- [ ] **Step 1: Escribir el test que falla**

`test/integration/wa-tables.int-spec.ts`:

```ts
import { closeTestPrisma, resetDb, testPrisma } from '../support/db';
import { createCustomer, createStoreWithAdmin } from '../support/factories';

describe('tablas de la cola de WhatsApp (migración 1a)', () => {
  afterAll(async () => { await closeTestPrisma(); });
  beforeEach(async () => { await resetDb(); });

  const row = (storeId: string, key: string) => ({
    storeId,
    toJid: '573001112233@s.whatsapp.net',
    payload: { text: 'hola' },
    kind: 'reply',
    priority: 0,
    idempotencyKey: key,
    notBefore: new Date(),
  });

  it('idempotency_key es única', async () => {
    const { storeId } = await createStoreWithAdmin();
    await testPrisma().waOutbound.create({ data: row(storeId, 'k1') });
    await expect(testPrisma().waOutbound.create({ data: row(storeId, 'k1') })).rejects.toThrow();
  });

  it('solo una fila en sending por tienda (índice único parcial)', async () => {
    const { storeId } = await createStoreWithAdmin();
    const a = await testPrisma().waOutbound.create({ data: row(storeId, 'k1') });
    const b = await testPrisma().waOutbound.create({ data: row(storeId, 'k2') });
    await testPrisma().waOutbound.update({ where: { id: a.id }, data: { status: 'sending' } });
    await expect(testPrisma().waOutbound.update({ where: { id: b.id }, data: { status: 'sending' } })).rejects.toThrow();
  });

  it('otra tienda sí puede tener su propio envío en curso', async () => {
    const a = await createStoreWithAdmin('A');
    const b = await createStoreWithAdmin('B');
    const ra = await testPrisma().waOutbound.create({ data: row(a.storeId, 'ka') });
    const rb = await testPrisma().waOutbound.create({ data: row(b.storeId, 'kb') });
    await testPrisma().waOutbound.update({ where: { id: ra.id }, data: { status: 'sending' } });
    await expect(testPrisma().waOutbound.update({ where: { id: rb.id }, data: { status: 'sending' } })).resolves.toBeTruthy();
  });

  it('valores por defecto de una fila nueva', async () => {
    const { storeId } = await createStoreWithAdmin();
    const r = await testPrisma().waOutbound.create({ data: row(storeId, 'k1') });
    expect(r).toMatchObject({ status: 'pending', attempts: 0, providerMessageIds: [], claimToken: null, sentAt: null });
  });

  it('wa_inbound deduplica por tienda e id de WhatsApp', async () => {
    const a = await createStoreWithAdmin('A');
    const b = await createStoreWithAdmin('B');
    const ins = (storeId: string) =>
      testPrisma().waInbound.createMany({ data: [{ storeId, providerMessageId: 'WA1' }], skipDuplicates: true });
    expect((await ins(a.storeId)).count).toBe(1);
    expect((await ins(a.storeId)).count).toBe(0);
    expect((await ins(b.storeId)).count).toBe(1);
  });

  it('customers.last_inbound_at existe y empieza vacío', async () => {
    const { storeId } = await createStoreWithAdmin();
    const c = await createCustomer(storeId);
    expect(c.lastInboundAt).toBeNull();
  });
});
```

- [ ] **Step 2: Comprobar que falla**

Run: `npm run test:int -- test/integration/wa-tables.int-spec.ts`
Expected: FAIL al compilar: `Property 'waOutbound' does not exist on type 'PrismaService'` (y `waInbound`, `lastInboundAt`).

- [ ] **Step 3: Modificar `prisma/schema.prisma`**

En `model Store`, añadir al final de la lista de relaciones (después de `syncOutbox        SyncOutbox[]`):

```prisma
  waOutbound        WaOutbound[]
  waInbound         WaInbound[]
```

En `model Customer`, después de `acceptsMarketing Boolean @default(true) @map("accepts_marketing")`:

```prisma
  // Último mensaje recibido de este cliente por WhatsApp. Los mensajes se purgan a las
  // 24 h (CleanupService), así que esta columna es la única memoria duradera de "ya
  // nos escribió": decide a quién se le pueden mandar campañas (spec, Baileys) y en el
  // bloque 8 la ventana de 24 h de Cloud API.
  lastInboundAt DateTime? @map("last_inbound_at")
```

y en los índices de `Customer`, después de `@@index([storeId, totalSpent])`:

```prisma
  @@index([storeId, lastInboundAt])
```

Al final del archivo:

```prisma
// ─── Cola de salida de WhatsApp (bloque 1a) ───────────────────────────────────
// Todo envío por WhatsApp pasa por aquí. idempotency_key UNIQUE = nunca dos veces.
// Índice único PARCIAL `wa_outbound_one_sending_per_store` (WHERE status='sending'),
// creado a mano en la migración 20261010000002: Prisma no declara índices parciales.
// NUNCA `prisma db push` / `migrate dev` / `migrate reset`: lo borrarían.
model WaOutbound {
  id                 String    @id @default(uuid())
  storeId            String    @map("store_id")
  toJid              String    @map("to_jid") @db.VarChar(64)
  payload            Json
  kind               String    @db.VarChar(16)
  priority           Int
  idempotencyKey     String    @unique @map("idempotency_key") @db.VarChar(200)
  groupKey           String?   @map("group_key") @db.VarChar(120)
  notBefore          DateTime  @default(now()) @map("not_before")
  expiresAt          DateTime? @map("expires_at")
  status             String    @default("pending") @db.VarChar(16)
  attempts           Int       @default(0)
  lastError          String?   @map("last_error") @db.VarChar(500)
  claimToken         String?   @map("claim_token") @db.VarChar(64)
  lockedUntil        DateTime? @map("locked_until")
  providerMessageIds String[]  @default([]) @map("provider_message_ids")
  deliveryStatus     String?   @map("delivery_status") @db.VarChar(16)
  sentAt             DateTime? @map("sent_at")
  createdAt          DateTime  @default(now()) @map("created_at")
  updatedAt          DateTime  @updatedAt @map("updated_at")

  store Store @relation(fields: [storeId], references: [storeId], onDelete: Cascade)

  @@index([status, notBefore, priority])
  @@index([storeId, status])
  @@index([groupKey, status])
  @@map("wa_outbound")
}

// ─── Dedupe de entrada de WhatsApp (bloque 1a, mínima) ────────────────────────
// Ids de mensajes ya vistos por tienda. En el bloque 1c se amplía (payload, estado,
// reclamo) añadiendo columnas con DEFAULT, sin renombrar.
model WaInbound {
  id                String   @id @default(uuid())
  storeId           String   @map("store_id")
  providerMessageId String   @map("provider_message_id") @db.VarChar(128)
  createdAt         DateTime @default(now()) @map("created_at")

  store Store @relation(fields: [storeId], references: [storeId], onDelete: Cascade)

  @@unique([storeId, providerMessageId])
  @@index([createdAt])
  @@map("wa_inbound")
}
```

- [ ] **Step 4: Generar el SQL con `migrate diff` y revisarlo**

```bash
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url postgresql://crm_test:crm_test@localhost:5434/crm_shadow_test \
  --script > /tmp/1a.sql
cat /tmp/1a.sql
```

Expected: exactamente estas sentencias (el orden y los espacios pueden variar), **ningún `DROP`**:
- `ALTER TABLE "customers" ADD COLUMN "last_inbound_at" TIMESTAMP(3);`
- `CREATE TABLE "wa_outbound" (…)` y `CREATE TABLE "wa_inbound" (…)`
- `CREATE INDEX "customers_store_id_last_inbound_at_idx"`, `CREATE UNIQUE INDEX "wa_outbound_idempotency_key_key"`, `CREATE INDEX "wa_outbound_status_not_before_priority_idx"`, `CREATE INDEX "wa_outbound_store_id_status_idx"`, `CREATE INDEX "wa_outbound_group_key_status_idx"`, `CREATE INDEX "wa_inbound_created_at_idx"`, `CREATE UNIQUE INDEX "wa_inbound_store_id_provider_message_id_key"`
- dos `ADD CONSTRAINT … FOREIGN KEY ("store_id") REFERENCES "stores"("store_id") ON DELETE CASCADE ON UPDATE CASCADE`

Si aparece cualquier otra cosa (sobre todo un `DROP INDEX "customers_store_wa_lid_key"`), **parar** y anotarlo en "Hallazgos".

- [ ] **Step 5: Crear la migración**

```bash
mkdir -p prisma/migrations/20261010000002_cola_de_salida_whatsapp
{
  echo "-- Bloque 1a: cola de salida de WhatsApp (wa_outbound), dedupe de entrada (wa_inbound)"
  echo "-- y customers.last_inbound_at. Solo añade: ningún DROP ni cambio de datos existentes,"
  echo "-- salvo el relleno de last_inbound_at del final."
  cat /tmp/1a.sql
} > prisma/migrations/20261010000002_cola_de_salida_whatsapp/migration.sql
```

Y añadir **al final** de `migration.sql` lo que Prisma no puede expresar:

```sql
-- Un solo envío en curso por tienda, garantizado por la BD (no solo por el despachador).
-- Índice único PARCIAL: Prisma no lo declara (igual que customers_store_wa_lid_key).
CREATE UNIQUE INDEX "wa_outbound_one_sending_per_store"
  ON "wa_outbound" ("store_id") WHERE "status" = 'sending';

-- Relleno de last_inbound_at con lo que se sabe hoy:
-- 1) el último mensaje del cliente que aún esté en `messages` (se purgan a las 24 h);
UPDATE "customers" c
SET "last_inbound_at" = s.last_in
FROM (
  SELECT conv."customer_id", max(m."created_at") AS last_in
  FROM "messages" m
  JOIN "conversations" conv ON conv."conversation_id" = m."conversation_id"
  WHERE m."sender" = 'customer'
  GROUP BY conv."customer_id"
) s
WHERE c."customer_id" = s."customer_id";

-- 2) los que tienen resumen de conversación: CleanupService solo lo genera con 2+
--    mensajes del cliente, así que escribieron seguro. La fecha es aproximada.
UPDATE "customers"
SET "last_inbound_at" = "updated_at"
WHERE "last_inbound_at" IS NULL AND "last_conversation_summary" IS NOT NULL;
```

- [ ] **Step 6: Aplicar a la BD de tests y regenerar el cliente**

```bash
npm run test:db
npx prisma generate
```

Expected: `Applying migration 20261010000002_cola_de_salida_whatsapp` y `All migrations have been successfully applied.`; luego `Generated Prisma Client`.

- [ ] **Step 7: Comprobar que la BD de tests coincide con el esquema**

```bash
npx prisma migrate diff \
  --from-url postgresql://crm_test:crm_test@localhost:5434/crm_test \
  --to-schema-datamodel prisma/schema.prisma --exit-code
```

Expected: `No difference detected.` (Prisma 6.19 no marca los índices parciales; si los listara como `DROP INDEX`, es esperado y solo esos dos: `customers_store_wa_lid_key` y `wa_outbound_one_sending_per_store`).

- [ ] **Step 8: Comprobar que el test pasa**

Run: `npm run test:int -- test/integration/wa-tables.int-spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261010000002_cola_de_salida_whatsapp test/integration/wa-tables.int-spec.ts
git commit -m "feat(db): tablas wa_outbound y wa_inbound, last_inbound_at y un envío en curso por tienda"
```

---

### Task 5: `OutboundService` (encolar idempotente) y módulo de la cola

**Files:**
- Create: `src/outbound/outbound.signal.ts`, `src/outbound/outbound.service.ts`, `src/outbound/outbound.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/integration/outbound-enqueue.int-spec.ts`

- [ ] **Step 1: Escribir el test que falla**

`test/integration/outbound-enqueue.int-spec.ts`:

```ts
import { createTestApp, TestApp } from '../support/app';
import { closeTestPrisma, resetDb, testPrisma } from '../support/db';
import { createStoreWithAdmin } from '../support/factories';
import { EnqueueInput, OutboundService } from '../../src/outbound/outbound.service';

describe('OutboundService (BD real)', () => {
  let t: TestApp;
  let outbound: OutboundService;

  beforeAll(async () => {
    t = await createTestApp();
    outbound = t.app.get(OutboundService);
  });
  afterAll(async () => { await t.close(); await closeTestPrisma(); });
  beforeEach(async () => { await resetDb(); t.wa.reset(); });

  const input = (storeId: string, over: Partial<EnqueueInput> = {}): EnqueueInput => ({
    storeId, to: '+57 300 111 2233', text: 'Hola', kind: 'reply', key: `test:${storeId}:1`, ...over,
  });

  it('dos encolados con la misma clave dejan una sola fila', async () => {
    const { storeId } = await createStoreWithAdmin();
    expect(await outbound.enqueue(input(storeId))).toBe('queued');
    expect(await outbound.enqueue(input(storeId))).toBe('duplicate');
    expect(await testPrisma().waOutbound.count()).toBe(1);
  });

  it('dos encolados simultáneos con la misma clave dejan una sola fila', async () => {
    const { storeId } = await createStoreWithAdmin();
    const results = await Promise.all([outbound.enqueue(input(storeId)), outbound.enqueue(input(storeId))]);
    expect(results.sort()).toEqual(['duplicate', 'queued']);
    expect(await testPrisma().waOutbound.count()).toBe(1);
  });

  it('si la transacción de negocio se revierte, no queda fila', async () => {
    const { storeId } = await createStoreWithAdmin();
    await expect(
      testPrisma().$transaction(async (tx) => {
        await outbound.enqueue(input(storeId), tx);
        throw new Error('fallo de negocio');
      }),
    ).rejects.toThrow('fallo de negocio');
    expect(await testPrisma().waOutbound.count()).toBe(0);
  });

  it('resuelve el destino a jid y fija prioridad, estado y caducidad por tipo', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId));
    await outbound.enqueue(input(storeId, { to: 'lid:123456789', key: 'k-lid' }));
    await outbound.enqueue(input(storeId, { kind: 'campaign', key: 'k-camp' }));

    const reply = await testPrisma().waOutbound.findUniqueOrThrow({ where: { idempotencyKey: `test:${storeId}:1` } });
    expect(reply).toMatchObject({
      toJid: '573001112233@s.whatsapp.net', kind: 'reply', priority: 0, status: 'pending', attempts: 0,
      payload: { text: 'Hola' },
    });
    expect(reply.expiresAt!.getTime() - reply.notBefore.getTime()).toBe(6 * 60 * 60 * 1000);

    const lid = await testPrisma().waOutbound.findUniqueOrThrow({ where: { idempotencyKey: 'k-lid' } });
    expect(lid.toJid).toBe('123456789@lid');

    const camp = await testPrisma().waOutbound.findUniqueOrThrow({ where: { idempotencyKey: 'k-camp' } });
    expect(camp.priority).toBe(20);
  });

  it('respeta not_before, expires_at, grupo y record', async () => {
    const { storeId } = await createStoreWithAdmin();
    const notBefore = new Date(Date.now() + 5 * 60_000);
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    await outbound.enqueue(input(storeId, { notBefore, expiresAt, groupKey: 'g1', record: { conversationId: 'c1' } }));
    const r = await testPrisma().waOutbound.findFirstOrThrow();
    expect(r.notBefore.getTime()).toBe(notBefore.getTime());
    expect(r.expiresAt!.getTime()).toBe(expiresAt.getTime());
    expect(r.groupKey).toBe('g1');
    expect(r.payload).toEqual({ text: 'Hola', record: { conversationId: 'c1' } });
  });

  it('no encola texto vacío ni destinatarios sin número', async () => {
    const { storeId } = await createStoreWithAdmin();
    expect(await outbound.enqueue(input(storeId, { text: '   ' }))).toBe('invalid');
    expect(await outbound.enqueue(input(storeId, { to: 'venta-rapida', key: 'k2' }))).toBe('invalid');
    expect(await testPrisma().waOutbound.count()).toBe(0);
  });

  it('rechaza una clave de más de 200 caracteres', async () => {
    const { storeId } = await createStoreWithAdmin();
    await expect(outbound.enqueue(input(storeId, { key: 'x'.repeat(201) }))).rejects.toThrow(/200/);
  });

  it('enqueueMany inserta en bloque e ignora las claves repetidas', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, { key: 'k1' }));
    const n = await outbound.enqueueMany([
      input(storeId, { key: 'k1' }),
      input(storeId, { key: 'k2' }),
      input(storeId, { key: 'k3' }),
    ]);
    expect(n).toBe(2);
    expect(await testPrisma().waOutbound.count()).toBe(3);
  });

  it('cancelGroup marca como skipped solo las pendientes de ese grupo', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, { key: 'a', groupKey: 'g1' }));
    await outbound.enqueue(input(storeId, { key: 'b', groupKey: 'g1' }));
    await outbound.enqueue(input(storeId, { key: 'c', groupKey: 'g2' }));
    await testPrisma().waOutbound.update({ where: { idempotencyKey: 'b' }, data: { status: 'sent' } });

    expect(await outbound.cancelGroup('g1', 'prueba')).toBe(1);
    const rows = await testPrisma().waOutbound.findMany({ orderBy: { idempotencyKey: 'asc' } });
    expect(rows.map((r) => [r.idempotencyKey, r.status])).toEqual([['a', 'skipped'], ['b', 'sent'], ['c', 'pending']]);
    expect(rows[0].lastError).toBe('prueba');
  });
});
```

- [ ] **Step 2: Comprobar que falla**

Run: `npm run test:int -- test/integration/outbound-enqueue.int-spec.ts`
Expected: FAIL, `Cannot find module '../../src/outbound/outbound.service'`.

- [ ] **Step 3: Crear `src/outbound/outbound.signal.ts`**

```ts
import { Injectable } from '@nestjs/common';

/**
 * Timbre entre quien encola y el despachador (hoy en el mismo proceso). Encolar sin
 * transacción toca el timbre al momento; quien encola dentro de una transacción llama a
 * OutboundService.wake() DESPUÉS del commit (antes, el despachador no vería la fila).
 * Si nadie toca, el sondeo de respaldo la recoge. En el bloque 1c pasa a LISTEN/NOTIFY.
 */
@Injectable()
export class OutboundSignal {
  private listener: (() => void) | null = null;

  onWake(listener: () => void): void {
    this.listener = listener;
  }

  wake(): void {
    this.listener?.();
  }
}
```

- [ ] **Step 4: Crear `src/outbound/outbound.service.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { jidFromPhone } from '../utils/wa-identity.util';
import { KIND_PRIORITY, KIND_TTL_MS, OutboundKind, OutboundPayload } from './outbound.types';
import { OutboundSignal } from './outbound.signal';

export interface EnqueueInput {
  storeId: string;
  /** Identidad del destinatario: teléfono ("+57…") o "lid:<user>". Se resuelve a jid al encolar. */
  to: string;
  text: string;
  kind: OutboundKind;
  /** Clave de idempotencia (outbound-keys.ts). Misma clave = una sola fila. */
  key: string;
  notBefore?: Date;
  /** Por defecto notBefore + KIND_TTL_MS[kind]. */
  expiresAt?: Date;
  groupKey?: string;
  record?: { conversationId: string };
}

/** queued = fila nueva; duplicate = ya existía esa clave; invalid = no se encola (texto vacío o sin destino). */
export type EnqueueResult = 'queued' | 'duplicate' | 'invalid';

const MAX_KEY_LENGTH = 200;
const MAX_GROUP_LENGTH = 120;

/**
 * Cola de salida de WhatsApp. Encolar es `INSERT … ON CONFLICT (idempotency_key) DO
 * NOTHING`: reintentar, duplicar un webhook o un doble clic nunca deja dos filas.
 * Con `tx`, la fila nace dentro de la transacción de negocio del llamador.
 * Nunca registra el texto ni el teléfono: solo tienda, tipo y clave.
 */
@Injectable()
export class OutboundService {
  private readonly logger = new Logger(OutboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly signal: OutboundSignal,
  ) {}

  async enqueue(input: EnqueueInput, tx?: Prisma.TransactionClient): Promise<EnqueueResult> {
    const row = this.toRow(input, new Date());
    if (!row) return 'invalid';
    const db: Prisma.TransactionClient = tx ?? this.prisma;
    const { count } = await db.waOutbound.createMany({ data: [row], skipDuplicates: true });
    if (count === 0) {
      this.logger.debug(`[outbound] duplicado ignorado kind=${input.kind} store=${input.storeId} key=${input.key}`);
      return 'duplicate';
    }
    this.logger.log(`[outbound] encolado kind=${input.kind} store=${input.storeId} key=${input.key}`);
    if (!tx) this.signal.wake();
    return 'queued';
  }

  /** Inserción en bloque (campañas). Devuelve cuántas filas nuevas quedaron. */
  async enqueueMany(inputs: EnqueueInput[], tx?: Prisma.TransactionClient): Promise<number> {
    const now = new Date();
    const rows = inputs
      .map((i) => this.toRow(i, now))
      .filter((r): r is Prisma.WaOutboundCreateManyInput => r !== null);
    if (rows.length === 0) return 0;
    const db: Prisma.TransactionClient = tx ?? this.prisma;
    const { count } = await db.waOutbound.createMany({ data: rows, skipDuplicates: true });
    const first = inputs[0];
    this.logger.log(
      `[outbound] encoladas ${count}/${rows.length} kind=${first.kind} store=${first.storeId}` +
        (first.groupKey ? ` grupo=${first.groupKey}` : ''),
    );
    if (!tx && count > 0) this.signal.wake();
    return count;
  }

  /** Avisa al despachador. Llamar después del commit cuando se encoló dentro de una transacción. */
  wake(): void {
    this.signal.wake();
  }

  /** Marca como skipped las pendientes de un grupo (p. ej. reprogramar un recordatorio). */
  async cancelGroup(groupKey: string, reason: string, tx?: Prisma.TransactionClient): Promise<number> {
    const db: Prisma.TransactionClient = tx ?? this.prisma;
    const { count } = await db.waOutbound.updateMany({
      where: { groupKey, status: 'pending' },
      data: { status: 'skipped', lastError: reason.slice(0, 500) },
    });
    if (count > 0) this.logger.log(`[outbound] ${count} pendiente(s) cancelada(s) grupo=${groupKey} motivo=${reason}`);
    return count;
  }

  private toRow(input: EnqueueInput, now: Date): Prisma.WaOutboundCreateManyInput | null {
    if (input.key.length > MAX_KEY_LENGTH) {
      throw new Error(`[outbound] clave de más de ${MAX_KEY_LENGTH} caracteres: ${input.key.slice(0, 60)}…`);
    }
    if (input.groupKey && input.groupKey.length > MAX_GROUP_LENGTH) {
      throw new Error(`[outbound] grupo de más de ${MAX_GROUP_LENGTH} caracteres: ${input.groupKey.slice(0, 60)}…`);
    }
    if (!input.text?.trim()) {
      this.logger.warn(`[outbound] texto vacío: no se encola store=${input.storeId} key=${input.key}`);
      return null;
    }
    const toJid = jidFromPhone(input.to ?? '');
    if (toJid.startsWith('@')) {
      this.logger.warn(`[outbound] destinatario sin número ni LID: no se encola store=${input.storeId} key=${input.key}`);
      return null;
    }
    const notBefore = input.notBefore ?? now;
    const payload: OutboundPayload = input.record ? { text: input.text, record: input.record } : { text: input.text };
    return {
      storeId: input.storeId,
      toJid,
      payload: payload as unknown as Prisma.InputJsonValue,
      kind: input.kind,
      priority: KIND_PRIORITY[input.kind],
      idempotencyKey: input.key,
      groupKey: input.groupKey ?? null,
      notBefore,
      expiresAt: input.expiresAt ?? new Date(notBefore.getTime() + KIND_TTL_MS[input.kind]),
    };
  }
}
```

- [ ] **Step 5: Crear `src/outbound/outbound.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { OutboundService } from './outbound.service';
import { OutboundSignal } from './outbound.signal';

/** Cola de salida de WhatsApp. PrismaModule es global. */
@Module({
  providers: [OutboundService, OutboundSignal],
  exports: [OutboundService, OutboundSignal],
})
export class OutboundModule {}
```

- [ ] **Step 6: Registrar el módulo en `src/app.module.ts`**

Añadir el import:

```ts
import { OutboundModule } from './outbound/outbound.module';
```

y en `imports`, justo después de `PrismaModule,`:

```ts
    OutboundModule,
```

- [ ] **Step 7: Comprobar que pasa**

Run: `npm run test:int -- test/integration/outbound-enqueue.int-spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 8: Commit**

```bash
git add src/outbound/outbound.signal.ts src/outbound/outbound.service.ts src/outbound/outbound.module.ts src/app.module.ts test/integration/outbound-enqueue.int-spec.ts
git commit -m "feat(outbound): encolar con ON CONFLICT DO NOTHING, dentro de la transacción del llamador"
```

---

### Task 6: Transporte `WA_TRANSPORT`, `sendPart` de un intento y harness de tests

**Files:**
- Create: `src/whatsapp/wa-transport.ts`, `src/whatsapp/whatsapp.send-part.spec.ts`, `test/support/wait-for.ts`
- Modify: `src/whatsapp/whatsapp.service.ts`, `src/whatsapp/whatsapp.module.ts`, `src/outbound/outbound.module.ts`, `test/support/fake-whatsapp.ts`, `test/support/app.ts`, `test/support/setup-env.ts`

- [ ] **Step 1: Token de configuración en `src/outbound/outbound.module.ts`**

Los tests necesitan cambiar la configuración (hueco de campaña, intentos) sin tocar `process.env` después del arranque. Se inyecta por token:

```ts
import { Module } from '@nestjs/common';
import { loadOutboundConfig } from './outbound-config';
import { OutboundService } from './outbound.service';
import { OutboundSignal } from './outbound.signal';

/** Token de la configuración de la cola (los tests lo sustituyen con overrideProvider). */
export const OUTBOUND_CONFIG = Symbol('OUTBOUND_CONFIG');

/** Cola de salida de WhatsApp. PrismaModule es global. */
@Module({
  providers: [OutboundService, OutboundSignal, { provide: OUTBOUND_CONFIG, useFactory: () => loadOutboundConfig() }],
  exports: [OutboundService, OutboundSignal, OUTBOUND_CONFIG],
})
export class OutboundModule {}
```

- [ ] **Step 2: Crear `src/whatsapp/wa-transport.ts`**

```ts
/**
 * Lo único que el despachador necesita de WhatsApp: mandar UN trozo de texto y
 * devolver el id que le dio WhatsApp. Hoy lo implementa WhatsappService (Baileys);
 * en 1c, el gateway; en el bloque 8, Cloud API.
 * Contrato: un solo intento, sin trocear, sin reintentos. Lanza WaNotConnectedError
 * si no hay socket. El timeout lo pone el despachador.
 */
export const WA_TRANSPORT = Symbol('WA_TRANSPORT');

export interface WaTransport {
  sendPart(storeId: string, jid: string, text: string): Promise<string>;
}
```

- [ ] **Step 3: Test que falla `src/whatsapp/whatsapp.send-part.spec.ts`**

```ts
jest.mock('@whiskeysockets/baileys', () => ({}));

import { WhatsappService } from './whatsapp.service';
import { WaNotConnectedError } from './send-errors';

function build() {
  // Los parámetros del constructor no se usan en sendPart: basta con objetos vacíos.
  const deps = Array.from({ length: WhatsappService.length }, () => ({}) as any);
  const svc = new (WhatsappService as any)(...deps) as WhatsappService;
  const sockets: Map<string, any> = (svc as any).sockets;
  return { svc, sockets };
}

describe('WhatsappService.sendPart', () => {
  it('sin socket lanza WaNotConnectedError', async () => {
    const { svc } = build();
    await expect(svc.sendPart('s1', '573001112233@s.whatsapp.net', 'hola')).rejects.toBeInstanceOf(WaNotConnectedError);
  });

  it('hace UN intento y devuelve el id de WhatsApp', async () => {
    const { svc, sockets } = build();
    const sendMessage = jest.fn().mockResolvedValue({ key: { id: '3EB0XYZ' } });
    sockets.set('s1', { user: { id: 'me' }, sendMessage });
    await expect(svc.sendPart('s1', 'j@s.whatsapp.net', 'hola')).resolves.toBe('3EB0XYZ');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('j@s.whatsapp.net', { text: 'hola' });
  });

  it('si falla, propaga el error sin reintentar (los reintentos son del despachador)', async () => {
    const { svc, sockets } = build();
    const sendMessage = jest.fn().mockRejectedValue(new Error('not-acceptable'));
    sockets.set('s1', { user: { id: 'me' }, sendMessage });
    await expect(svc.sendPart('s1', 'j@s.whatsapp.net', 'hola')).rejects.toThrow('not-acceptable');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('WhatsApp aceptó pero no devolvió id: no lanza (reintentar duplicaría) y da un id local', async () => {
    const { svc, sockets } = build();
    sockets.set('s1', { user: { id: 'me' }, sendMessage: jest.fn().mockResolvedValue(undefined) });
    await expect(svc.sendPart('s1', 'j@s.whatsapp.net', 'hola')).resolves.toMatch(/^sin-id-/);
  });
});
```

Run: `npm test -- src/whatsapp/whatsapp.send-part.spec.ts` → FAIL (`sendPart is not a function`).

- [ ] **Step 4: Implementar `sendPart` en `src/whatsapp/whatsapp.service.ts`**

Imports nuevos:

```ts
import { randomUUID } from 'node:crypto';
import { WaNotConnectedError } from './send-errors';
import { WaTransport } from './wa-transport';
```

`export class WhatsappService implements OnModuleInit, WaTransport {` y, en "API pública", antes de `sendMessage`:

```ts
  /** Un trozo, un intento (contrato de WaTransport). El troceo y los reintentos son del despachador. */
  async sendPart(storeId: string, jid: string, text: string): Promise<string> {
    const sock = this.sockets.get(storeId);
    if (!sock?.user) throw new WaNotConnectedError(storeId);
    const res = await sock.sendMessage(jid, { text });
    const id: string | undefined = res?.key?.id;
    if (!id) {
      // WhatsApp lo aceptó (no lanzó): reintentar lo duplicaría. Se registra y se sigue.
      this.logger.warn(`[outbound] sendMessage sin id de WhatsApp (store ${storeId})`);
      return `sin-id-${randomUUID()}`;
    }
    return id;
  }
```

`sendMessage` y `safeSend` se quedan hasta la Task 15 (los usan los sitios aún no migrados).

- [ ] **Step 5: Registrar el transporte en `src/whatsapp/whatsapp.module.ts`**

```ts
import { OutboundModule } from '../outbound/outbound.module';
import { WA_TRANSPORT } from './wa-transport';
```

Añadir `OutboundModule` a `imports`, y:

```ts
  providers: [WhatsappService, { provide: WA_TRANSPORT, useExisting: WhatsappService }],
  exports: [WhatsappService, WA_TRANSPORT],
```

(`useExisting`: en los tests, `overrideProvider(WhatsappService)` hace que `WA_TRANSPORT` resuelva al doble.)

- [ ] **Step 6: Reescribir `test/support/fake-whatsapp.ts`**

```ts
import { WaNotConnectedError } from '../../src/whatsapp/send-errors';
import type { WaTransport } from '../../src/whatsapp/wa-transport';

export interface SentMessage {
  storeId: string;
  /** jid de destino tal cual lo recibió el transporte. */
  jid: string;
  message: string;
}

/**
 * Doble de WhatsappService y de WA_TRANSPORT: nunca abre sockets, registra lo que
 * se habría enviado y permite programar fallos (`failNext`) o desconexión (`disconnect`).
 */
export class FakeWhatsapp implements WaTransport {
  readonly sent: SentMessage[] = [];
  private readonly connected = new Set<string>();
  private readonly offline = new Set<string>();
  private failures: unknown[] = [];
  private seq = 0;

  async onModuleInit(): Promise<void> {}

  async sendPart(storeId: string, jid: string, text: string): Promise<string> {
    if (this.offline.has(storeId)) throw new WaNotConnectedError(storeId);
    if (this.failures.length > 0) throw this.failures.shift();
    this.sent.push({ storeId, jid, message: text });
    return `FAKE-${++this.seq}`;
  }

  /** Los próximos envíos fallan con estos errores, en orden. */
  failNext(...errors: unknown[]): void {
    this.failures.push(...errors);
  }

  /** La tienda queda sin socket hasta `reconnect`. */
  disconnect(storeId: string): void {
    this.offline.add(storeId);
  }

  reconnect(storeId: string): void {
    this.offline.delete(storeId);
  }

  /** Compatibilidad hasta la Task 15 (sitios aún no migrados a la cola). */
  async sendMessage(storeId: string, phone: string, message: string): Promise<void> {
    this.sent.push({ storeId, jid: phone, message });
  }

  async connectStore(storeId: string): Promise<any> {
    this.connected.add(storeId);
    return { status: 'connected' };
  }

  async disconnectStore(storeId: string): Promise<void> {
    this.connected.delete(storeId);
  }

  getQR(_storeId: string): string | null {
    return null;
  }

  isConnected(storeId: string): boolean {
    return this.connected.has(storeId);
  }

  reset(): void {
    this.sent.length = 0;
    this.connected.clear();
    this.offline.clear();
    this.failures = [];
    this.seq = 0;
  }
}
```

- [ ] **Step 7: `createTestApp` con opciones en `test/support/app.ts`**

```ts
// Baileys es ESM puro y Jest (CommonJS) no lo carga. Con WhatsappService sustituido, o real
// pero sin filas en whatsapp_sessions (no abre sockets), basta con un módulo vacío.
jest.mock('@whiskeysockets/baileys', () => ({}));

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { WhatsappService } from '../../src/whatsapp/whatsapp.service';
import { WA_TRANSPORT } from '../../src/whatsapp/wa-transport';
import { FakeWhatsapp } from './fake-whatsapp';

export interface TestApp {
  app: INestApplication;
  wa: FakeWhatsapp;
  close: () => Promise<void>;
}

export interface TestAppOptions {
  /**
   * true: WhatsappService real (para probar el flujo de entrada) y solo el transporte
   * sustituido por el doble. Por defecto se sustituye todo WhatsappService.
   */
  realWhatsappService?: boolean;
  /** Sustituciones extra: [token, valor]. */
  overrides?: Array<[unknown, unknown]>;
}

/** La app real (AppModule + configureApp) con WhatsApp sustituido por el doble. */
export async function createTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const wa = new FakeWhatsapp();
  let builder = Test.createTestingModule({ imports: [AppModule] });
  builder = opts.realWhatsappService
    ? builder.overrideProvider(WA_TRANSPORT).useValue(wa)
    : builder.overrideProvider(WhatsappService).useValue(wa);
  for (const [token, value] of opts.overrides ?? []) {
    builder = builder.overrideProvider(token as any).useValue(value);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication({ rawBody: true, logger: ['error'] });
  configureApp(app);
  await app.init();
  return { app, wa, close: () => app.close() };
}
```

- [ ] **Step 8: Crear `test/support/wait-for.ts`**

```ts
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Repite `check` hasta que devuelva algo "truthy" o venza `timeoutMs`. */
export async function waitFor<T>(check: () => Promise<T> | T, timeoutMs = 8_000, everyMs = 100): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await check();
    if (last) return last;
    await sleep(everyMs);
  } while (Date.now() < until);
  throw new Error(`waitFor: no se cumplió en ${timeoutMs} ms (último valor: ${JSON.stringify(last!)})`);
}
```

- [ ] **Step 9: Apagar el despachador en tests** — en `test/support/setup-env.ts`, antes de `installNetworkGuard();`:

```ts
// La cola de WhatsApp no se mueve sola en tests: se mueve con dispatcher.tick().
process.env.WA_OUTBOUND_DISPATCHER = 'off';
```

- [ ] **Step 10: Comprobar**

Run: `npm test -- src/whatsapp/whatsapp.send-part.spec.ts` → PASS (4). `npm run test:int` → PASS (suites de las Tasks 4 y 5 y `orders.int-spec.ts`, cuyo `expect(t.wa.sent).toEqual([])` sigue valiendo). `npx tsc --noEmit` → sin errores.

- [ ] **Step 11: Commit**

```bash
git add src/whatsapp/wa-transport.ts src/whatsapp/whatsapp.send-part.spec.ts src/whatsapp/whatsapp.service.ts src/whatsapp/whatsapp.module.ts src/outbound/outbound.module.ts test/support
git commit -m "feat(whatsapp): transporte WA_TRANSPORT con sendPart de un intento y doble con fallos programables"
```

---

### Task 7: `OutboundDispatcher` (reclamo, envío, reintentos, huérfanas, caducidad, hueco de campaña)

**Files:**
- Create: `src/whatsapp/outbound-dispatcher.ts`
- Modify: `src/whatsapp/whatsapp.module.ts`, `test/support/factories.ts`
- Test: `test/integration/outbound-dispatcher.int-spec.ts`

- [ ] **Step 1: Fábricas en `test/support/factories.ts`**

```ts
export async function createConversation(storeId: string, customerId: string, status = 'active') {
  return testPrisma().conversation.create({ data: { storeId, customerId, status } });
}
```

Y `createCustomer` con opciones (lo usan las Tasks 9 y 14), sin romper las llamadas actuales:

```ts
export async function createCustomer(
  storeId: string,
  name = 'Cliente',
  opts: { phone?: string; lastInboundAt?: Date | null; acceptsMarketing?: boolean } = {},
) {
  const n = next();
  return testPrisma().customer.create({
    data: {
      storeId,
      phone: opts.phone ?? `57310000${String(n).padStart(4, '0')}`,
      name,
      lastInboundAt: opts.lastInboundAt ?? null,
      acceptsMarketing: opts.acceptsMarketing ?? true,
    },
  });
}
```

(Comprobar en `schema.prisma` que `Conversation` no tiene más campos obligatorios sin DEFAULT; si los tiene, añadirlos con un valor fijo.)

- [ ] **Step 2: Escribir el test que falla**

`test/integration/outbound-dispatcher.int-spec.ts`:

```ts
import { createTestApp, TestApp } from '../support/app';
import { closeTestPrisma, resetDb, testPrisma } from '../support/db';
import { createConversation, createCustomer, createStoreWithAdmin } from '../support/factories';
import { EnqueueInput, OutboundService } from '../../src/outbound/outbound.service';
import { OUTBOUND_CONFIG } from '../../src/outbound/outbound.module';
import { loadOutboundConfig } from '../../src/outbound/outbound-config';
import { OutboundDispatcher } from '../../src/whatsapp/outbound-dispatcher';

const boom = (message: string, statusCode: number) => Object.assign(new Error(message), { output: { statusCode } });

describe('OutboundDispatcher (BD real)', () => {
  let t: TestApp;
  let outbound: OutboundService;
  let dispatcher: OutboundDispatcher;
  const prisma = () => testPrisma();

  beforeAll(async () => {
    const cfg = {
      ...loadOutboundConfig({ WA_OUTBOUND_DISPATCHER: 'off' }),
      retryBaseMs: 1, retryMaxMs: 1, campaignGapMinMs: 60_000, campaignGapMaxMs: 60_000,
    };
    t = await createTestApp({ overrides: [[OUTBOUND_CONFIG, cfg]] });
    outbound = t.app.get(OutboundService);
    dispatcher = t.app.get(OutboundDispatcher);
  });
  afterAll(async () => { await t.close(); await closeTestPrisma(); });
  beforeEach(async () => { await resetDb(); t.wa.reset(); jest.restoreAllMocks(); });

  const input = (storeId: string, key: string, over: Partial<EnqueueInput> = {}): EnqueueInput => ({
    storeId, to: '573001112233', text: `texto ${key}`, kind: 'reply', key, ...over,
  });
  /** Deja listas ya las pendientes (los reintentos ponen not_before en el futuro). */
  const dueNow = () =>
    prisma().$executeRaw`UPDATE wa_outbound SET not_before = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE status = 'pending'`;
  const row = (key: string) => prisma().waOutbound.findUniqueOrThrow({ where: { idempotencyKey: key } });

  it('envía, guarda el id de WhatsApp y marca sent', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'k1'));
    await dispatcher.tick();
    expect(t.wa.sent).toEqual([{ storeId, jid: '573001112233@s.whatsapp.net', message: 'texto k1' }]);
    const r = await row('k1');
    expect(r).toMatchObject({ status: 'sent', attempts: 0, providerMessageIds: ['FAKE-1'], claimToken: null });
    expect(r.sentAt).not.toBeNull();
  });

  it('otra pasada no reenvía lo ya enviado', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'k1'));
    await dispatcher.tick();
    await dispatcher.tick();
    expect(t.wa.sent).toHaveLength(1);
  });

  it('un mensaje largo sale en trozos y un fallo a mitad reanuda en el trozo siguiente', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'largo', { text: 'a'.repeat(5000) }));
    const real = t.wa.sendPart.bind(t.wa);
    let calls = 0;
    jest.spyOn(t.wa, 'sendPart').mockImplementation(async (...args) => {
      calls++;
      if (calls === 2) throw boom('Timed Out', 408);
      return real(...args);
    });
    await dispatcher.tick();
    expect(await row('largo')).toMatchObject({ status: 'pending', attempts: 1, providerMessageIds: ['FAKE-1'] });
    await dueNow();
    await dispatcher.tick();
    expect(t.wa.sent.map((s) => s.message.length)).toEqual([4096, 904]);
    expect(await row('largo')).toMatchObject({ status: 'sent', providerMessageIds: ['FAKE-1', 'FAKE-2'] });
  });

  it('error permanente: failed al primero, sin reintentar', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'k1'));
    t.wa.failNext(boom('bad-request', 400));
    await dispatcher.tick();
    const r = await row('k1');
    expect(r).toMatchObject({ status: 'failed', attempts: 1 });
    expect(r.lastError).toContain('bad-request');
  });

  it('error temporal: reintenta hasta el tope y queda failed', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'k1'));
    for (let i = 0; i < 6; i++) t.wa.failNext(boom('Internal Server Error', 500));
    for (let i = 0; i < 6; i++) { await dueNow(); await dispatcher.tick(); }
    expect(await row('k1')).toMatchObject({ status: 'failed', attempts: 6 });
    expect(t.wa.sent).toHaveLength(0);
  });

  it('desconectado: no gasta intentos, aplaza toda la tienda y sale al volver', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'k1'));
    await outbound.enqueue(input(storeId, 'k2', { to: '573009998877' }));
    t.wa.disconnect(storeId);
    await dispatcher.tick();
    const rows = await prisma().waOutbound.findMany();
    expect(rows.every((r) => r.status === 'pending' && r.attempts === 0)).toBe(true);
    expect(rows.every((r) => r.notBefore.getTime() > Date.now() + 10_000)).toBe(true);
    t.wa.reconnect(storeId);
    await dueNow();
    await dispatcher.tick();
    expect(t.wa.sent).toHaveLength(2);
  });

  it('caducada: pasa a skipped sin enviarse', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'k1', {
      notBefore: new Date(Date.now() - 2000), expiresAt: new Date(Date.now() - 1000),
    }));
    await dispatcher.tick();
    expect(await row('k1')).toMatchObject({ status: 'skipped', lastError: 'caducado' });
    expect(t.wa.sent).toHaveLength(0);
  });

  it('huérfana (arriendo vencido): vuelve a pending gastando un intento y luego sale', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'k1'));
    await prisma().$executeRaw`UPDATE wa_outbound SET status = 'sending', claim_token = 'muerto', locked_until = (now() AT TIME ZONE 'UTC') - interval '1 minute'`;
    await dispatcher.tick();
    expect(await row('k1')).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('respuestas antes que campañas en la misma tienda', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'camp', { kind: 'campaign', to: '573001110000' }));
    await outbound.enqueue(input(storeId, 'resp'));
    await dispatcher.tick();
    expect(t.wa.sent[0].message).toBe('texto resp');
  });

  it('hueco de campaña: tras un envío de campaña, el resto de la campaña espera', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueueMany([
      input(storeId, 'c1', { kind: 'campaign', to: '573001110001' }),
      input(storeId, 'c2', { kind: 'campaign', to: '573001110002' }),
    ]);
    await outbound.enqueue(input(storeId, 'resp'));
    await dispatcher.tick();
    expect(t.wa.sent.map((s) => s.message).sort()).toEqual(['texto c1', 'texto resp']);
    const c2 = await row('c2');
    expect(c2.status).toBe('pending');
    expect(c2.notBefore.getTime()).toBeGreaterThan(Date.now() + 50_000);
  });

  it('orden por destinatario: si una anterior al mismo número falló y espera, la nueva no se adelanta', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'turno1'));
    t.wa.failNext(boom('Timed Out', 408));
    await dispatcher.tick(); // turno1 → pending, attempts=1, not_before futuro
    await outbound.enqueue(input(storeId, 'turno2'));
    await dispatcher.tick();
    expect(t.wa.sent).toHaveLength(0);
    await dueNow();
    await dispatcher.tick();
    expect(t.wa.sent.map((s) => s.message)).toEqual(['texto turno1', 'texto turno2']);
  });

  it('dos tiendas se atienden en la misma pasada', async () => {
    const a = await createStoreWithAdmin('A');
    const b = await createStoreWithAdmin('B');
    await outbound.enqueue(input(a.storeId, 'ka'));
    await outbound.enqueue(input(b.storeId, 'kb'));
    await dispatcher.tick();
    expect(t.wa.sent).toHaveLength(2);
  });

  it('ticks a la vez no envían dos veces la misma fila', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'k1'));
    await Promise.all([dispatcher.tick(), dispatcher.tick(), dispatcher.tick()]);
    expect(t.wa.sent).toHaveLength(1);
  });

  it('record: al enviarse guarda el texto en messages de la conversación', async () => {
    const { storeId } = await createStoreWithAdmin();
    const customer = await createCustomer(storeId);
    const conv = await createConversation(storeId, customer.customerId);
    await outbound.enqueue(input(storeId, 'k1', { record: { conversationId: conv.conversationId } }));
    await dispatcher.tick();
    const msgs = await prisma().message.findMany({ where: { conversationId: conv.conversationId } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ content: 'texto k1', sender: 'store', isAiResponse: true });
  });

  it('record con la conversación ya purgada: el envío queda sent igual', async () => {
    const { storeId } = await createStoreWithAdmin();
    await outbound.enqueue(input(storeId, 'k1', { record: { conversationId: '00000000-0000-4000-8000-000000000000' } }));
    await dispatcher.tick();
    expect(await row('k1')).toMatchObject({ status: 'sent' });
  });
});
```

Notas:
- "orden por destinatario" en la última pasada: `turno1` sale en la primera vuelta y `turno2` en la segunda vuelta de la misma pasada (el bucle de `runPass` sigue mientras haya trabajo).
- "ticks a la vez": el segundo y el tercer `tick()` devuelven la pasada en curso; además el reclamo atómico protege si fueran dos procesos.

Run: `npm run test:int -- test/integration/outbound-dispatcher.int-spec.ts` → FAIL (`Cannot find module '../../src/whatsapp/outbound-dispatcher'`).

- [ ] **Step 3: Crear `src/whatsapp/outbound-dispatcher.ts`**

```ts
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OUTBOUND_CONFIG } from '../outbound/outbound.module';
import { OutboundConfig } from '../outbound/outbound-config';
import { OutboundSignal } from '../outbound/outbound.signal';
import { OutboundPayload } from '../outbound/outbound.types';
import { decideOnFailure } from './outbound-retry';
import { classifySendError, isNotAcceptable, SendTimeoutError } from './send-errors';
import { splitForWhatsapp } from './split-text';
import { WA_TRANSPORT, WaTransport } from './wa-transport';

interface ClaimedRow {
  id: string;
  store_id: string;
  to_jid: string;
  payload: OutboundPayload;
  kind: string;
  attempts: number;
  provider_message_ids: string[];
  claim_token: string;
}

const NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;
const ms = (n: number) => Prisma.sql`(${n} * interval '1 millisecond')`;

/**
 * Despachador de wa_outbound (bloque 1a: en el mismo proceso; en 1c se muda al gateway).
 * - Un envío en curso por tienda: la consulta de candidatos lo excluye y el índice único
 *   parcial wa_outbound_one_sending_per_store lo garantiza en BD.
 * - Reclamo atómico: UPDATE … WHERE status='pending' sobre la fila FOR UPDATE SKIP LOCKED.
 * - Las escrituras de cierre llevan WHERE claim_token: quien perdió el arriendo no pisa a otro.
 * - "Al menos una vez": si el proceso muere entre que WhatsApp acepta un trozo y se guarda,
 *   ese trozo puede repetirse (Baileys no deduplica). Inevitable y acotado a un trozo.
 * Nunca registra textos ni teléfonos: id de fila, tienda, tipo e intentos.
 */
@Injectable()
export class OutboundDispatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboundDispatcher.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<number> | null = null;
  private rerun = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly signal: OutboundSignal,
    @Inject(WA_TRANSPORT) private readonly transport: WaTransport,
    @Inject(OUTBOUND_CONFIG) private readonly cfg: OutboundConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.cfg.dispatcherEnabled) {
      this.logger.log('[outbound] despachador apagado (WA_OUTBOUND_DISPATCHER=off)');
      return;
    }
    this.signal.onWake(() => this.kick());
    this.timer = setInterval(() => this.kick(), this.cfg.pollMs);
    this.timer.unref();
    this.kick();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private kick(): void {
    if (this.stopped) return;
    this.tick().catch((err) => this.logger.error(`[outbound] pasada fallida: ${err?.message ?? err}`));
  }

  /**
   * Una pasada: caduca, recupera huérfanas y envía hasta vaciar lo que está listo (o
   * maxLoopsPerTick vueltas). Si ya hay una en marcha, devuelve esa y apunta otra para
   * después (solo con el despachador encendido). Devuelve cuántas filas atendió.
   */
  tick(): Promise<number> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.runPass().finally(() => {
      this.running = null;
      const again = this.rerun && !this.stopped && this.cfg.dispatcherEnabled;
      this.rerun = false;
      if (again) setImmediate(() => this.kick());
    });
    return this.running;
  }

  private async runPass(): Promise<number> {
    await this.expire();
    await this.recoverOrphans();
    let total = 0;
    for (let loop = 0; loop < this.cfg.maxLoopsPerTick; loop++) {
      const ids = await this.candidates();
      if (ids.length === 0) break;
      const results = await Promise.all(ids.map((id) => this.processOne(id)));
      const done = results.filter(Boolean).length;
      total += done;
      if (done === 0) break;
    }
    return total;
  }

  private async expire(): Promise<void> {
    const n = await this.prisma.$executeRaw`
      UPDATE wa_outbound SET status = 'skipped', last_error = 'caducado', updated_at = ${NOW}
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ${NOW}`;
    if (n > 0) this.logger.warn(`[outbound] ${n} fila(s) caducadas sin enviar → skipped`);
  }

  private async recoverOrphans(): Promise<void> {
    const n = await this.prisma.$executeRaw`
      UPDATE wa_outbound SET
        attempts = attempts + 1,
        status = CASE WHEN attempts + 1 >= ${this.cfg.maxAttempts} THEN 'failed' ELSE 'pending' END,
        last_error = 'arriendo vencido (¿el proceso murió enviando?)',
        claim_token = NULL, locked_until = NULL, not_before = ${NOW}, updated_at = ${NOW}
      WHERE status = 'sending' AND locked_until < ${NOW}`;
    if (n > 0) this.logger.warn(`[outbound] ${n} fila(s) huérfana(s) recuperada(s)`);
  }

  /** La siguiente fila lista de cada tienda sin envío en curso (máx. maxParallel tiendas). */
  private async candidates(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM (
        SELECT DISTINCT ON (o.store_id) o.id, o.priority, o.created_at
        FROM wa_outbound o
        WHERE o.status = 'pending' AND o.not_before <= ${NOW}
          AND NOT EXISTS (SELECT 1 FROM wa_outbound s WHERE s.store_id = o.store_id AND s.status = 'sending')
          AND NOT EXISTS (
            SELECT 1 FROM wa_outbound p
            WHERE p.store_id = o.store_id AND p.to_jid = o.to_jid AND p.status = 'pending'
              AND p.attempts > 0 AND p.created_at < o.created_at AND p.id <> o.id)
        ORDER BY o.store_id, o.priority, o.created_at
      ) c
      ORDER BY c.priority, c.created_at
      LIMIT ${this.cfg.maxParallel}`;
    return rows.map((r) => r.id);
  }

  /** Reclama y envía una fila. true si la atendió (enviada, fallida o reprogramada). */
  private async processOne(id: string): Promise<boolean> {
    const row = await this.claim(id);
    if (!row) return false;
    const parts = splitForWhatsapp(row.payload.text);
    try {
      for (let i = row.provider_message_ids.length; i < parts.length; i++) {
        const waId = await this.withTimeout(this.transport.sendPart(row.store_id, row.to_jid, parts[i]));
        await this.prisma.$executeRaw`
          UPDATE wa_outbound SET provider_message_ids = array_append(provider_message_ids, ${waId}), updated_at = ${NOW}
          WHERE id = ${row.id} AND claim_token = ${row.claim_token}`;
      }
    } catch (err) {
      await this.onFailure(row, err);
      return true;
    }
    await this.onSent(row);
    return true;
  }

  private async claim(id: string): Promise<ClaimedRow | null> {
    const token = randomUUID();
    try {
      const rows = await this.prisma.$queryRaw<ClaimedRow[]>`
        UPDATE wa_outbound SET status = 'sending', claim_token = ${token},
          locked_until = ${NOW} + ${ms(this.cfg.leaseMs)}, updated_at = ${NOW}
        WHERE id = (SELECT id FROM wa_outbound WHERE id = ${id} AND status = 'pending' FOR UPDATE SKIP LOCKED)
        RETURNING id, store_id, to_jid, payload, kind, attempts, provider_message_ids, claim_token`;
      return rows[0] ?? null;
    } catch (err: any) {
      // Otro despachador ya envía para esa tienda (índice único parcial).
      if (String(err?.message ?? '').includes('wa_outbound_one_sending_per_store')) return null;
      throw err;
    }
  }

  private async onSent(row: ClaimedRow): Promise<void> {
    const closed = await this.prisma.$executeRaw`
      UPDATE wa_outbound SET status = 'sent', sent_at = ${NOW}, claim_token = NULL, locked_until = NULL,
        last_error = NULL, updated_at = ${NOW}
      WHERE id = ${row.id} AND claim_token = ${row.claim_token}`;
    if (closed === 0) {
      this.logger.warn(`[outbound] fila ${row.id} enviada pero el arriendo ya no era nuestro`);
      return;
    }
    this.logger.log(`[outbound] enviado id=${row.id} kind=${row.kind} store=${row.store_id}`);
    if (row.kind === 'campaign') await this.applyCampaignGap(row.store_id);
    if (row.payload.record?.conversationId) await this.recordMessage(row);
  }

  private async onFailure(row: ClaimedRow, err: unknown): Promise<void> {
    const errorClass = classifySendError(err);
    const decision = decideOnFailure(errorClass, isNotAcceptable(err), row.attempts, this.cfg);
    const message = String((err as any)?.message ?? err).slice(0, 500);
    const notBefore = decision.delayMs === null ? NOW : Prisma.sql`${NOW} + ${ms(decision.delayMs)}`;
    await this.prisma.$executeRaw`
      UPDATE wa_outbound SET status = ${decision.status}, attempts = ${decision.attempts}, last_error = ${message},
        not_before = ${notBefore}, claim_token = NULL, locked_until = NULL, updated_at = ${NOW}
      WHERE id = ${row.id} AND claim_token = ${row.claim_token}`;
    if (decision.postponeStore && decision.delayMs !== null) {
      await this.prisma.$executeRaw`
        UPDATE wa_outbound SET not_before = ${NOW} + ${ms(decision.delayMs)}, updated_at = ${NOW}
        WHERE store_id = ${row.store_id} AND status = 'pending' AND not_before < ${NOW} + ${ms(decision.delayMs)}`;
    }
    const line =
      `[outbound] fallo id=${row.id} kind=${row.kind} store=${row.store_id} clase=${errorClass} ` +
      `intentos=${decision.attempts} → ${decision.status}: ${message}`;
    if (decision.status === 'failed') this.logger.error(line);
    else this.logger.warn(line);
  }

  /** El hueco entre mensajes de campaña se guarda en BD (not_before): sobrevive a reinicios. */
  private async applyCampaignGap(storeId: string): Promise<void> {
    const { campaignGapMinMs: min, campaignGapMaxMs: max } = this.cfg;
    if (max === 0) return;
    const gap = Math.round(min + Math.random() * (max - min));
    await this.prisma.$executeRaw`
      UPDATE wa_outbound SET not_before = GREATEST(not_before, ${NOW} + ${ms(gap)}), updated_at = ${NOW}
      WHERE store_id = ${storeId} AND kind = 'campaign' AND status = 'pending'`;
  }

  /** Mejor esfuerzo y después del sent: que falle no puede reenviar el mensaje. */
  private async recordMessage(row: ClaimedRow): Promise<void> {
    const conversationId = row.payload.record!.conversationId;
    try {
      await this.prisma.$transaction([
        this.prisma.message.create({
          data: { conversationId, storeId: row.store_id, content: row.payload.text, type: 'text', sender: 'store', isAiResponse: true },
        }),
        this.prisma.conversation.update({ where: { conversationId }, data: { lastMessageAt: new Date() } }),
      ]);
    } catch (err: any) {
      this.logger.warn(`[outbound] enviado pero no guardado en messages id=${row.id} conv=${conversationId}: ${err.message}`);
    }
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    const limit = this.cfg.sendTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new SendTimeoutError(limit)), limit);
      }),
    ]).finally(() => clearTimeout(timer));
  }
}
```

Notas para el implementador:
- El 23505 de `$queryRaw` llega como `PrismaClientKnownRequestError` (`P2010`). Comprobar con el test de ticks simultáneos (o forzándolo con dos filas y un `UPDATE` manual a `sending`) que el nombre del índice aparece en `err.message`; si no aparece, mirar `err.meta` y ajustar la condición. Nunca tragarse otros errores.
- `payload` llega ya parseado (JSONB). `provider_message_ids` llega como `string[]`.
- La consulta de candidatos usa los índices `(status, not_before, priority)` y `(store_id, status)`. Con la cola casi vacía (lo normal) es trivial; revisar con `EXPLAIN` en el Task 16 Step 2.

- [ ] **Step 4: Registrar en `src/whatsapp/whatsapp.module.ts`**

```ts
import { OutboundDispatcher } from './outbound-dispatcher';
// …
  providers: [WhatsappService, { provide: WA_TRANSPORT, useExisting: WhatsappService }, OutboundDispatcher],
  exports: [WhatsappService, WA_TRANSPORT, OutboundDispatcher],
```

- [ ] **Step 5: Comprobar** — `npm run test:int -- test/integration/outbound-dispatcher.int-spec.ts` → PASS (15). `npm run test:int` completo → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/whatsapp/outbound-dispatcher.ts src/whatsapp/whatsapp.module.ts test/integration/outbound-dispatcher.int-spec.ts test/support/factories.ts
git commit -m "feat(whatsapp): despachador de wa_outbound con reclamo atómico, reintentos, huérfanas, caducidad y hueco de campaña"
```

---

### Task 8: Respuestas de la conversación por la cola (envíos #1–#5) y fin del doble aviso de asesor

**Files:**
- Modify: `src/whatsapp/whatsapp.service.ts`, `src/messages/messages.service.ts`, `src/admin-assistant/admin-assistant.service.ts` (solo la firma de `handle`)
- Test: `test/integration/inbound-replies.int-spec.ts`

Qué cambia:
- `bufferAndProcess` recibe el id de WhatsApp del mensaje y el buffer guarda el **último** (`lastMsgId`). `handleIncomingMessage(storeId, phone, content, pushName, turnId)` ya no recibe `sock`.
- `turnId = turnIdFor(lastMsgId)` y claves `outboundKeys.aiReply / handoff / mediaAck / audioTooLong / adminReply`.
- Los cinco `this.safeSend(...)` pasan a `this.outbound.enqueue({ storeId, to: phone, text, kind: 'reply', key })`.
- **Doble aviso de asesor:** `MessagesService` gana `record(dto)` (guarda, nunca envía). `WhatsappService` usa `record` para todo lo que guarda. `create` sigue siendo la entrada del panel (Task 10).

- [ ] **Step 1: Escribir el test que falla**

`test/integration/inbound-replies.int-spec.ts` (WhatsappService real; `processMessage` es privado → `(wa as any)`; la IA se sustituye con `jest.spyOn`):

```ts
import { createTestApp, TestApp } from '../support/app';
import { closeTestPrisma, resetDb, testPrisma } from '../support/db';
import { createStoreWithAdmin } from '../support/factories';
import { sleep, waitFor } from '../support/wait-for';
import { WhatsappService } from '../../src/whatsapp/whatsapp.service';
import { AiService } from '../../src/ai/ai.service';

const CLIENT = '573001112233';
export const textMsg = (id: string, text: string) => ({
  key: { id, remoteJid: `${CLIENT}@s.whatsapp.net`, fromMe: false },
  message: { conversation: text },
  pushName: 'Ana',
});

describe('respuestas a lo entrante por la cola (BD real)', () => {
  let t: TestApp;
  let wa: WhatsappService;
  let ai: AiService;
  const sock = {} as any;

  beforeAll(async () => {
    t = await createTestApp({ realWhatsappService: true });
    wa = t.app.get(WhatsappService);
    ai = t.app.get(AiService);
  });
  afterAll(async () => { await t.close(); await closeTestPrisma(); });
  beforeEach(async () => { await resetDb(); t.wa.reset(); jest.restoreAllMocks(); });

  const outboundRows = () => testPrisma().waOutbound.findMany({ orderBy: { createdAt: 'asc' } });
  const someRows = () => waitFor(async () => { const r = await outboundRows(); return r.length ? r : null; });

  it('la respuesta de la IA se encola con la clave del último mensaje del lote', async () => {
    const { storeId } = await createStoreWithAdmin();
    jest.spyOn(ai, 'generateReply').mockResolvedValue('¡Hola Ana!');
    await (wa as any).processMessage(textMsg('WA-1', 'hola'), storeId, sock);
    await (wa as any).processMessage(textMsg('WA-2', 'precio?'), storeId, sock);
    const rows = await someRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'reply', idempotencyKey: `reply:${storeId}:WA-2`, payload: { text: '¡Hola Ana!' } });
    expect(ai.generateReply).toHaveBeenCalledTimes(1);
  });

  it('aviso de asesor: UNA fila (antes salía dos veces) y se guarda una vez', async () => {
    const { storeId } = await createStoreWithAdmin();
    await (wa as any).processMessage(textMsg('WA-9', 'quiero hablar con un asesor'), storeId, sock);
    const rows = await someRows();
    await sleep(300);
    expect(await outboundRows()).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBe(`handoff:${storeId}:WA-9`);
    expect(await testPrisma().message.count({ where: { storeId, sender: 'store' } })).toBe(1);
  });

  it('acuse de imagen por la cola', async () => {
    const { storeId } = await createStoreWithAdmin();
    await (wa as any).processMessage({
      key: { id: 'WA-IMG', remoteJid: `${CLIENT}@s.whatsapp.net`, fromMe: false },
      message: { imageMessage: {} },
    }, storeId, sock);
    const rows = await outboundRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBe(`media-ack:${storeId}:WA-IMG`);
  });

  it('un sticker no responde, no cambia la conversación ni registra error', async () => {
    const { storeId } = await createStoreWithAdmin();
    await (wa as any).processMessage({
      key: { id: 'WA-ST', remoteJid: `${CLIENT}@s.whatsapp.net`, fromMe: false },
      message: { stickerMessage: {} },
    }, storeId, sock);
    expect(await outboundRows()).toHaveLength(0);
    expect(await testPrisma().conversation.count({ where: { storeId, status: 'pending_human' } })).toBe(0);
  });

  it('IA que decide no responder ([IGNORAR] → null): no se encola nada', async () => {
    const { storeId } = await createStoreWithAdmin();
    const spy = jest.spyOn(ai, 'generateReply').mockResolvedValue(null);
    await (wa as any).processMessage(textMsg('WA-3', 'ok'), storeId, sock);
    await waitFor(() => spy.mock.calls.length > 0);
    await sleep(200);
    expect(await outboundRows()).toHaveLength(0);
  });
});
```

Run: `npm run test:int -- test/integration/inbound-replies.int-spec.ts` → FAIL (hoy `safeSend` llama a `sock.sendMessage` de un objeto vacío y no hay filas).

Notas:
- El debounce es de 3 s (`MSG_DEBOUNCE_MS`): `waitFor` espera hasta 8 s; el proyecto `int` tiene `testTimeout: 30000`.
- `resolveSenderIdentity(msg, sock)` con `remoteJid` de teléfono no debería tocar el `sock`. Si lo toca, usar `sock = { signalRepository: { lidMapping: { getPNForLID: async () => null } } }`.
- La tienda de la fábrica no tiene `adminPhone`: el cliente no se confunde con el dueño.

- [ ] **Step 2: `MessagesService.record`** — en `src/messages/messages.service.ts`:

```ts
  /** Guarda un mensaje en el historial. NUNCA envía por WhatsApp (lo usa el flujo de entrada). */
  async record(dto: CreateMessageDto) {
    const conv = await this.prisma.conversation.findUnique({ where: { conversationId: dto.conversationId } });
    if (!conv) throw new NotFoundException('Conversación no encontrada');
    if (conv.storeId !== dto.storeId) throw new ForbiddenException('El mensaje no pertenece a esta tienda');
    if (!dto.content?.trim()) throw new BadRequestException('El contenido del mensaje no puede estar vacío');
    const content = dto.content.length > 65_536 ? dto.content.slice(0, 65_536) : dto.content;
    const sender = dto.sender ?? (dto.isAiResponse ? 'store' : 'customer');
    const message = await this.prisma.message.create({
      data: {
        conversationId: dto.conversationId, storeId: conv.storeId, content,
        type: dto.type ?? 'text', isAiResponse: dto.isAiResponse ?? false, sender,
      },
    });
    await this.prisma.conversation
      .update({ where: { conversationId: dto.conversationId }, data: { lastMessageAt: new Date() } })
      .catch((err) => this.logger.warn(`lastMessageAt no actualizado conv=${dto.conversationId}: ${err.message}`));
    return message;
  }
```

(`create` se reescribe en la Task 10; de momento sigue igual.)

- [ ] **Step 3: Cambios en `src/whatsapp/whatsapp.service.ts`**

1. Inyectar `private readonly outbound: OutboundService` en el constructor e importar `outboundKeys`, `turnIdFor` de `../outbound/outbound-keys`.
2. `messageBuffers`: el valor gana `lastMsgId?: string`.
3. `bufferAndProcess(storeId, phone, content, pushName?, msgId?)` (fuera `sock`): al crear el buffer guarda `lastMsgId: msgId`; al acumular, `if (msgId) existing.lastMsgId = msgId`. Al vencer: `this.handleIncomingMessage(storeId, phone, combined, buffer.pushName, turnIdFor(buffer.lastMsgId))`.
4. `processMessage`: `this.bufferAndProcess(storeId, phone, content, pushName, msg.key?.id)` y `this.handleMediaMessage(storeId, phone, messageType, pushName, msg.key?.id)`.
5. `handleAudioMessage`: el audio largo → `await this.outbound.enqueue({ storeId, to: phone, text: '…', kind: 'reply', key: outboundKeys.audioTooLong(storeId, turnIdFor(msg.key?.id)) })` (mismo texto); la transcripción → `this.bufferAndProcess(storeId, phone, text, pushName, msg.key?.id)`; el `fallback` pasa `msg.key?.id`. La descarga sigue usando `sock` (es el único sitio que lo necesita).
6. `handleMediaMessage(storeId, phone, messageType, pushName?, msgId?)`: `const reply = this.getMediaReply(messageType); if (!reply) return;` **antes** de `findOrCreate` (sticker = nada). Guardar con `messagesService.record` y encolar con `outboundKeys.mediaAck(storeId, turnIdFor(msgId))`. `getMediaReply` devuelve `string | null` (fuera el `null as any`).
7. `handleIncomingMessage(storeId, phone, content, pushName, turnId)`:
   - dueño: `const reply = await this.adminAssistant.handle(storeId, phone, content, turnId); await this.outbound.enqueue({ storeId, to: phone, text: reply, kind: 'reply', key: outboundKeys.adminReply(storeId, turnId) });`
   - los `messagesService.create` → `messagesService.record`. El aviso de asesor se guarda con `isAiResponse: true` (texto automático, no del asesor).
   - aviso de asesor: `enqueue(… outboundKeys.handoff(storeId, turnId))` y después `record` con `.catch` que registra (no vacío).
   - respuesta de la IA: `record` primero (como hoy, para el historial de la IA) y luego `enqueue(… outboundKeys.aiReply(storeId, turnId))`.
   - quitar `const jid = jidFromPhone(phone)`.
8. `AdminAssistantService.handle(storeId, adminPhone, content, turnId: string)`: de momento solo recibe el parámetro (lo usa la Task 12).
9. Si el test de la Task 6 usa `WhatsappService.length`, no hay que tocarlo al añadir dependencias.

- [ ] **Step 4: Comprobar** — la suite nueva → PASS (5); `npm test` y `npm run test:int` → PASS; `npx tsc --noEmit` limpio.

- [ ] **Step 5: Commit**

```bash
git add src/whatsapp/whatsapp.service.ts src/messages/messages.service.ts src/admin-assistant/admin-assistant.service.ts test/integration/inbound-replies.int-spec.ts
git commit -m "feat(whatsapp): respuestas por la cola con clave por turno; el aviso de asesor deja de enviarse dos veces"
```

---

### Task 9: Dedupe de entrada (`wa_inbound`) y `customers.last_inbound_at`

**Files:**
- Modify: `src/whatsapp/whatsapp.service.ts`, `src/customers/customers.service.ts`
- Test: `test/integration/inbound-dedupe.int-spec.ts`

- [ ] **Step 1: Escribir el test que falla**

`test/integration/inbound-dedupe.int-spec.ts` — mismo arranque, `beforeEach` y `textMsg` que `inbound-replies.int-spec.ts` (copiarlos; no importar entre suites):

```ts
  it('el mismo id de WhatsApp dos veces (reentrega tras reinicio) se procesa una vez', async () => {
    const { storeId } = await createStoreWithAdmin();
    const spy = jest.spyOn(ai, 'generateReply').mockResolvedValue('respuesta');
    await (wa as any).processMessage(textMsg('WA-DUP', 'hola'), storeId, sock);
    await (wa as any).processMessage(textMsg('WA-DUP', 'hola'), storeId, sock);
    await waitFor(async () => (await testPrisma().waOutbound.count()) > 0);
    await sleep(300);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await testPrisma().waInbound.count({ where: { storeId, providerMessageId: 'WA-DUP' } })).toBe(1);
    expect((wa as any).processedMsgIds).toBeUndefined(); // el dedupe en memoria ya no existe
  });

  it('el mismo id en otra tienda sí se procesa', async () => {
    const a = await createStoreWithAdmin('A');
    const b = await createStoreWithAdmin('B');
    jest.spyOn(ai, 'generateReply').mockResolvedValue('r');
    await (wa as any).processMessage(textMsg('WA-X', 'hola'), a.storeId, sock);
    await (wa as any).processMessage(textMsg('WA-X', 'hola'), b.storeId, sock);
    await waitFor(async () => (await testPrisma().waOutbound.count()) === 2);
  });

  it('grupos y tipos internos no entran en wa_inbound', async () => {
    const { storeId } = await createStoreWithAdmin();
    await (wa as any).processMessage({ key: { id: 'G1', remoteJid: '123@g.us' }, message: { conversation: 'x' } }, storeId, sock);
    await (wa as any).processMessage({ key: { id: 'P1', remoteJid: `${CLIENT}@s.whatsapp.net` }, message: { protocolMessage: {} } }, storeId, sock);
    expect(await testPrisma().waInbound.count()).toBe(0);
  });

  it('un mensaje del cliente actualiza last_inbound_at', async () => {
    const { storeId } = await createStoreWithAdmin();
    jest.spyOn(ai, 'generateReply').mockResolvedValue('r');
    await (wa as any).processMessage(textMsg('WA-L', 'hola'), storeId, sock);
    const c = await waitFor(() => testPrisma().customer.findFirst({ where: { storeId, lastInboundAt: { not: null } } }));
    expect(c!.lastInboundAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
```

(Comprobar que `protocolMessage` está en `IGNORED_TYPES`; si no, usar uno que lo esté.)

Run → FAIL.

- [ ] **Step 2: Implementar en `processMessage`**

- Borrar el bloque "Deduplicación" en memoria, el campo `processedMsgIds` y `MSG_DEDUP_TTL_MS`.
- Justo después de `if (IGNORED_TYPES.has(messageType)) { … return; }`:

```ts
    // Dedupe persistente: una reentrega de WhatsApp (p. ej. tras reiniciar) no se procesa dos veces.
    const msgId: string | undefined = msg.key?.id || undefined;
    if (msgId) {
      const { count } = await this.prisma.waInbound.createMany({
        data: [{ storeId, providerMessageId: msgId }],
        skipDuplicates: true,
      });
      if (count === 0) {
        this.logger.debug(`[inbound] duplicado ignorado store=${storeId} id=${msgId}`);
        return;
      }
    } else {
      this.logger.warn(`[inbound] mensaje sin id de WhatsApp: no se puede deduplicar (store ${storeId})`);
    }
```

Si la BD falla aquí, el error sube y el mensaje no se procesa (lo registra el `catch` del bucle de `messages.upsert`). Es coherente: sin BD tampoco se podría guardar ni responder.

Ojo con el orden: el dedupe va **después** de la fusión LID (`linkLidIdentity`), que es idempotente; no moverla.

- [ ] **Step 3: `last_inbound_at`** — en `CustomersService`:

```ts
  /** El cliente nos escribió: memoria duradera para campañas (Baileys) y la ventana de 24 h (bloque 8). */
  async touchInbound(customerId: string): Promise<void> {
    await this.prisma.customer.update({ where: { customerId }, data: { lastInboundAt: new Date() } });
  }
```

Llamarlo en `handleIncomingMessage` (tras `findOrCreate` del cliente, antes de guardar el mensaje; **no** en la rama del dueño) y en `handleMediaMessage` (tras `findOrCreate`), con `.catch((err) => this.logger.warn(\`[inbound] last_inbound_at no actualizado customer=${customer.customerId}: ${err.message}\`))`: que falle no debe dejar sin respuesta al cliente.

- [ ] **Step 4: Comprobar** — suite nueva → PASS (4); `npm run test:int` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/whatsapp/whatsapp.service.ts src/customers/customers.service.ts test/integration/inbound-dedupe.int-spec.ts
git commit -m "feat(whatsapp): dedupe persistente de entrada en wa_inbound y last_inbound_at del cliente"
```

---

### Task 10: Mensaje del asesor desde el panel (envío #7) en la misma transacción

**Files:**
- Modify: `src/messages/messages.service.ts`, `src/messages/messages.module.ts`, `src/whatsapp/whatsapp.module.ts`, `src/whatsapp/whatsapp.service.ts`
- Test: `test/integration/messages-send.int-spec.ts`

- [ ] **Step 1: Test que falla**

```ts
import request from 'supertest';
import { createTestApp, TestApp } from '../support/app';
import { bearer } from '../support/auth';
import { closeTestPrisma, resetDb, testPrisma } from '../support/db';
import { createConversation, createCustomer, createStoreWithAdmin } from '../support/factories';

describe('POST /messages (asesor)', () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(async () => { await t.close(); await closeTestPrisma(); });
  beforeEach(async () => { await resetDb(); t.wa.reset(); });

  it('guarda el mensaje y encola UNA fila con clave msg:{messageId}', async () => {
    const { storeId, admin } = await createStoreWithAdmin();
    const c = await createCustomer(storeId);
    const conv = await createConversation(storeId, c.customerId, 'human');
    const res = await request(t.app.getHttpServer()).post('/messages').set(bearer(admin))
      .send({ conversationId: conv.conversationId, content: 'Hola, soy Laura', sender: 'store' }).expect(201);
    const rows = await testPrisma().waOutbound.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ idempotencyKey: `msg:${res.body.messageId}`, kind: 'reply', storeId });
  });

  it('un mensaje con sender=customer no se envía', async () => {
    const { storeId, admin } = await createStoreWithAdmin();
    const c = await createCustomer(storeId);
    const conv = await createConversation(storeId, c.customerId);
    await request(t.app.getHttpServer()).post('/messages').set(bearer(admin))
      .send({ conversationId: conv.conversationId, content: 'x', sender: 'customer' }).expect(201);
    expect(await testPrisma().waOutbound.count()).toBe(0);
  });

  it('conversación de otra tienda: 403 y ni mensaje ni fila', async () => {
    const a = await createStoreWithAdmin('A');
    const b = await createStoreWithAdmin('B');
    const c = await createCustomer(b.storeId);
    const conv = await createConversation(b.storeId, c.customerId);
    await request(t.app.getHttpServer()).post('/messages').set(bearer(a.admin))
      .send({ conversationId: conv.conversationId, content: 'x', sender: 'store' }).expect(403);
    expect(await testPrisma().message.count()).toBe(0);
    expect(await testPrisma().waOutbound.count()).toBe(0);
  });
});
```

(Comprobar el nombre de la PK de `Message` en Prisma y la forma de `bearer` en `orders.int-spec.ts`; adaptar si difiere.)

- [ ] **Step 2: Reescribir `create`**

```ts
  /** Entrada del panel. Si es del asesor (store, no IA), se guarda y se encola en UNA transacción. */
  async create(dto: CreateMessageDto) {
    const sender = dto.sender ?? (dto.isAiResponse ? 'store' : 'customer');
    if (dto.isAiResponse || sender !== 'store') return this.record(dto);

    const conv = await this.prisma.conversation.findUnique({
      where: { conversationId: dto.conversationId }, include: { customer: true },
    });
    if (!conv) throw new NotFoundException('Conversación no encontrada');
    if (conv.storeId !== dto.storeId) throw new ForbiddenException('El mensaje no pertenece a esta tienda');
    if (!dto.content?.trim()) throw new BadRequestException('El contenido del mensaje no puede estar vacío');

    const message = await this.prisma.$transaction(async (tx) => {
      const m = await tx.message.create({
        data: { conversationId: dto.conversationId, storeId: conv.storeId, content: dto.content, type: dto.type ?? 'text', isAiResponse: false, sender },
      });
      await tx.conversation.update({ where: { conversationId: dto.conversationId }, data: { lastMessageAt: new Date() } });
      const result = await this.outbound.enqueue(
        { storeId: conv.storeId, to: conv.customer.phone, text: dto.content, kind: 'reply', key: outboundKeys.agentMessage(m.messageId) },
        tx,
      );
      if (result === 'invalid') throw new BadRequestException('Este cliente no tiene un número de WhatsApp al que escribir');
      return m;
    });
    this.outbound.wake();
    return message;
  }
```

Imports: `BadRequestException`, `OutboundService`, `outboundKeys`. Constructor: `private prisma: PrismaService, private outbound: OutboundService` (fuera `WhatsappService` y `forwardRef`). Hoy un fallo de WhatsApp devolvía 200 y el mensaje "enviado"; ahora el mensaje solo existe si quedó encolado, y el estado real del envío queda en `wa_outbound`.

- [ ] **Step 3: Módulos** — `MessagesModule`: `imports: [PrismaModule, OutboundModule]`, fuera el comentario del ciclo. `WhatsappModule`: `MessagesModule` sin `forwardRef`; en `WhatsappService` el parámetro `messagesService` sin `@Inject(forwardRef(...))`. Si Nest sigue detectando un ciclo por otro camino, dejar el `forwardRef` y anotarlo en Hallazgos.

- [ ] **Step 4: Comprobar** → suite nueva PASS (3), el resto PASS, `tsc` limpio.

- [ ] **Step 5: Commit**

```bash
git add src/messages src/whatsapp/whatsapp.module.ts src/whatsapp/whatsapp.service.ts test/integration/messages-send.int-spec.ts
git commit -m "feat(messages): el mensaje del asesor se guarda y se encola en una transacción; adiós ciclo Messages↔Whatsapp"
```

---

### Task 11: Avisos de citas (envíos #8–#13), confirmación solo en la transición y recordatorios atómicos

**Files:**
- Modify: `src/notifications/notifications.service.ts`, `src/notifications/notifications.module.ts`, `src/appointments/appointments.service.ts`, `src/appointments/appointments.controller.ts`, `src/auto-confirm/auto-confirm.service.ts`, `src/auto-confirm/auto-confirm.module.ts`, `src/reminders/reminders.service.ts`, `src/ai/ai.service.ts` (solo los `.catch(() => {})` de notificaciones), `src/public/public.service.ts`, `test/support/factories.ts`
- Test: `test/integration/appointment-notifications.int-spec.ts`

Decisiones:
- `NotificationsService` deja de enviar: cada `notify*` **encola** con su clave y acepta un `tx` opcional. Sin `withRetry` en WhatsApp (los reintentos son de la cola); el email no se toca.
- "Confirmada" y "solicitud resuelta" se encolan **dentro** de la transacción de `AppointmentsService.update`: atómico con el cambio de estado. El controlador deja el `setImmediate`.
- `'confirmed'` solo si la cita no estaba confirmada o cambió de hora. La clave `appt:{id}:confirmed:{scheduledAt}` cubre además panel + autoconfirmación + asistente a la vez.
- **Bug encontrado al planificar:** al aprobar, el controlador usa `appointment.pendingAction ?? 'CANCEL_REQUESTED'`, pero `appointment` es la fila **ya actualizada** (`pendingAction = null`): una reprogramación aprobada se le anuncia al cliente como "cancelación aprobada". Se arregla usando `current.pendingAction` dentro de `update`.
- Autoconfirmación: `update(…, { expectStatus: PENDING })` bloquea la fila (`SELECT … FOR UPDATE`) y lanza `ConflictException` si ya no está `PENDING` (el dueño la canceló en ese instante).
- Recordatorios: reclamo (`updateMany … reminderXSentAt = null`) y encolado en la misma transacción; caducidad = hora de la cita. La clave no lleva la hora porque hoy reprogramar no reinicia `reminderXSentAt` (comprobado: nada lo pone a `null` fuera de `reminders.service.ts`).
- Avisos al dueño desde la IA y la web pública (`notifyAppointmentCreated`, `notifyPendingAction`, `notifyPaymentProofDetected`): siguen fuera de la transacción de negocio (meter el flujo de citas de la IA en transacciones es del bloque 4); la clave los hace idempotentes. Los `.catch(() => {})` vacíos pasan a registrar el error con el id de la cita.
- Clave de solicitud: reprogramar → `${newDate}T${newTime}`; cancelar → `cancel:${scheduledAt ms}`.

- [ ] **Step 1: Fábrica `createAppointment(storeId, customerId, over = {})`** en `test/support/factories.ts` con los campos obligatorios del modelo `Appointment` (leer `schema.prisma`: `type`, `scheduledAt`, `status`, `source`…), `scheduledAt` por defecto mañana a las 15:00 UTC.

- [ ] **Step 2: Test que falla** — `test/integration/appointment-notifications.int-spec.ts` (con `createTestApp()`, supertest y `bearer`). Casos:

1. `PATCH /appointments/:id {status: 'CONFIRMED'}` dos veces → **una** fila `appt:{id}:confirmed:{scheduledAt ms}`, `kind=notification`, `toJid` del cliente.
2. Cita ya `CONFIRMED`: `PATCH {status:'CONFIRMED'}` misma hora → 0 filas; `PATCH {status:'CONFIRMED', scheduledAt: otra}` → 1 fila con la nueva hora en la clave.
3. Aprobar una reprogramación (`pendingAction='RESCHEDULE_REQUESTED'`, `pendingActionData={newDate:'2026-11-05', newTime:'10:00'}`, `pendingActionAt` fijo) con `PATCH {pendingActionResolution:'approved'}` → texto encolado con "reprogramación fue aprobada" y clave `appt:{id}:resolved:RESCHEDULE_REQUESTED:approved:{pendingActionAt ms}`.
4. `jest.spyOn(t.app.get(OutboundService), 'enqueue').mockRejectedValueOnce(new Error('x'))` + `PATCH {status:'CONFIRMED'}` → 500 y la cita sigue `PENDING`.
5. `t.app.get(AutoConfirmService).runAutoConfirm()` con una cita `PENDING` creada hace 20 min (`createdAt` en la fábrica), tienda con `subscriptionStatus:'active'` y `autoConfirmAppointments:true` → `CONFIRMED` + 1 fila; otra ejecución → sigue 1.
6. `t.app.get(RemindersService).runReminders()` con una cita `CONFIRMED` dentro de 2 h → filas `appt:{id}:reminder:8h` y `…:2h`, `kind=reminder`, `expiresAt = scheduledAt`; otra ejecución → mismas 2 filas; con `enqueue` fallando una vez → `reminder8hSentAt` sigue `null`.

Run → FAIL.

- [ ] **Step 3: `NotificationsService`**

- Constructor: `prisma`, `email`, `outbound: OutboundService`. `NotificationsModule`: `imports: [PrismaModule, EmailModule, OutboundModule]`.
- Sustituir `sendWA` por:

```ts
  private async queueWA(
    input: { storeId: string; to: string; text: string; kind: 'notification' | 'reminder'; key: string; expiresAt?: Date },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const result = await this.outbound.enqueue(input, tx);
    if (result === 'invalid') this.logger.warn(`[Notif] sin destino WhatsApp: no se encola key=${input.key}`);
  }

  /** Avisar al despachador tras un commit (cuando se encoló con tx). */
  wake(): void {
    this.outbound.wake();
  }
```

- Firmas (el texto de cada mensaje no cambia):
  - `notifyAppointmentCreated(appt, origin = 'ai')` → admin, `outboundKeys.apptCreatedAdmin(id)`.
  - `notifyAppointmentConfirmed(appt, tx?)` → cliente, `outboundKeys.apptConfirmed(id, appt.scheduledAt)`.
  - `notifyReminder(appt, window, tx?)` → cliente, `kind: 'reminder'`, `expiresAt: appt.scheduledAt`, `outboundKeys.apptReminder(id, window)`.
  - `notifyPendingAction(appt, action)` → admin, `outboundKeys.apptPendingAction(id, action, requestKey)`.
  - `notifyActionResolved(appt, approved, reason?, requestedAt?, tx?)` → cliente, `outboundKeys.apptResolved(id, appt.pendingAction ?? 'NONE', approved, requestedAt)`.
  - `notifyPaymentProofDetected(appt, excerpt)` → admin, `outboundKeys.apptPaymentProof(id, excerpt)`.
- En los avisos al dueño el `Promise.allSettled([wa, email])` se queda, sin `withRetry` en la parte WA.

- [ ] **Step 4: `AppointmentsService.update(appointmentId, storeId, dto, performedById?, opts: { expectStatus?: AppointmentStatus } = {})`**

- Mover el cálculo de `scheduleChanged` antes de los disparadores y cambiar la regla:

```ts
    if (!notificationTrigger && dto.status === AppointmentStatus.CONFIRMED &&
        (current.status !== AppointmentStatus.CONFIRMED || scheduleChanged)) {
      notificationTrigger = 'confirmed';
    }
```

- Primera sentencia dentro del `$transaction`:

```ts
      if (opts.expectStatus) {
        const [locked] = await tx.$queryRaw<{ status: string }[]>`
          SELECT status FROM appointments WHERE appointment_id = ${appointmentId} FOR UPDATE`;
        if (locked?.status !== opts.expectStatus) {
          throw new ConflictException(`La cita ya no está ${opts.expectStatus}`);
        }
      }
```

- Antes de `return updated;` dentro de la transacción:

```ts
      if (notificationTrigger === 'confirmed') {
        await this.notifications.notifyAppointmentConfirmed(updated as any, tx);
      } else if (notificationTrigger === 'action_approved_cancel' || notificationTrigger === 'action_approved_reschedule') {
        await this.notifications.notifyActionResolved(
          { ...(updated as any), pendingAction: current.pendingAction }, true, undefined, current.pendingActionAt, tx);
      } else if (notificationTrigger === 'action_rejected') {
        await this.notifications.notifyActionResolved(
          { ...(updated as any), pendingAction: current.pendingAction }, false, dto.rejectionReason, current.pendingActionAt, tx);
      }
```

- Después del `$transaction`: `if (notificationTrigger) this.notifications.wake();`.
- Inyectar `NotificationsService` en `AppointmentsService` (el módulo ya importa `NotificationsModule`). Comprobar que `current` (de `findAndVerify`) trae `pendingAction` y `pendingActionAt`.

- [ ] **Step 5: `AppointmentsController.update`** — borrar el bloque `setImmediate`, devolver `appointment`, quitar `NotificationsService` del constructor si queda sin uso.

- [ ] **Step 6: `AutoConfirmService`** — `await this.appointments.update(p.appointmentId, p.storeId, { status: AppointmentStatus.CONFIRMED }, undefined, { expectStatus: AppointmentStatus.PENDING })`; borrar `notifyAppointmentConfirmed` y `NotificationsService` del servicio y del módulo. Un `ConflictException` se registra con `log` (carrera esperada), el resto con `error`.

- [ ] **Step 7: `RemindersService.processReminders`**

```ts
      const claimed = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.appointment.updateMany({
          where: { appointmentId: appt.appointmentId, [w.dbField]: null },
          data:  { [w.dbField]: now },
        });
        if (updated.count === 0) return false;
        await this.notifications.notifyReminder(appt, w.field, tx);
        return true;
      });
      if (!claimed) continue;
      this.logger.log(`✅ Recordatorio ${w.field} encolado — cita ${appt.appointmentId}`);
```

y `this.notifications.wake()` al final de `runReminders`.

- [ ] **Step 8: Catch vacíos** — en `ai.service.ts` (las 6 llamadas a `notifications.*` de §4) y `public.service.ts:256`: `.catch(() => {})` → `.catch((err) => this.logger.error(\`[Notif] no encolado (cita ${…appointmentId}): ${err.message}\`))`.

- [ ] **Step 9: Comprobar** → suite nueva PASS (6), `npm test` + `npm run test:int` PASS, `tsc` limpio.

- [ ] **Step 10: Commit**

```bash
git add src/notifications src/appointments src/auto-confirm src/reminders src/ai/ai.service.ts src/public/public.service.ts test/integration/appointment-notifications.int-spec.ts test/support/factories.ts
git commit -m "feat(citas): avisos por la cola con clave, confirmación solo en la transición y encolado atómico con el cambio de estado"
```

---

### Task 12: "¿Confirmamos tu cita?" (#14) y asistente del dueño (#6) por la cola

**Files:**
- Modify: `src/ai/ai.service.ts`, `src/ai/ai.module.ts`, `src/admin-assistant/admin-assistant.service.ts`, `src/admin-assistant/admin-assistant.module.ts`, `src/whatsapp/whatsapp.service.ts`, `src/outbound/outbound.service.ts`
- Test: `test/integration/confirm-nudge.int-spec.ts`, `test/integration/admin-assistant-actions.int-spec.ts`, `test/integration/outbound-enqueue.int-spec.ts`

**Hallazgo al planificar (decisión tomada, avisar a Alex):** el temporizador comprueba al dispararse `pendingAppointments.has(conversationId)`, que vive **en memoria**. Si el recordatorio sobreviviera a un reinicio, el cliente contestaría "Sí" a una IA que ya olvidó la cita pendiente. Por eso: va a la cola con `not_before = +5 min` (trazable, con reintentos), se cancela con `cancelGroup` donde hoy hay `clearTimeout`, y **al arrancar se cancelan todos los pendientes** `confirm-nudge:%`. Cuando el bloque 4 lleve `pendingAppointments` a BD, se quita esa cancelación.

- [ ] **Step 1: Tests que fallan**

`outbound-enqueue.int-spec.ts`, caso nuevo: `cancelGroupsByPrefix('confirm-nudge:', 'x')` deja `skipped` las pendientes de grupos `confirm-nudge:a` y `confirm-nudge:b` y no toca `campaign:c`.

`confirm-nudge.int-spec.ts` (privados con `(ai as any)`; esperar con `waitFor` porque programar va en segundo plano):
1. `scheduleConfirmReminder(conv, store, '573001112233')` → 1 fila `kind=reply`, `groupKey=confirm-nudge:{conv}`, `notBefore` entre +4 y +6 min, `payload.record.conversationId = conv`.
2. Programarlo dos veces → una `skipped` y una `pending`.
3. `cancelConfirmReminder(conv)` → `skipped`.
4. `ai.onModuleInit()` → los `confirm-nudge:%` pendientes pasan a `skipped`.

`admin-assistant-actions.int-spec.ts` (`executeAction` con `(svc as any)` y una cita en BD con cliente):
1. `CONFIRM_APPOINTMENT` sobre una `PENDING` → `CONFIRMED` y fila con la clave del panel (`appt:{id}:confirmed:{ms}`); repetirla → "ya no está pendiente" y sigue 1 fila.
2. `CANCEL_APPOINTMENT` → fila `appt:{id}:cancelled`.
3. `SEND_CUSTOMER_MESSAGE` con contexto `{ turnId: 'T1' }` dos veces → 1 fila `admin-msg:{store}:T1:{hash}`.

- [ ] **Step 2: `OutboundService.cancelGroupsByPrefix(prefix, reason)`** — como `cancelGroup` con `where: { groupKey: { startsWith: prefix }, status: 'pending' }`.

- [ ] **Step 3: `AiService`**

- Inyectar `OutboundService` (`AiModule` importa `OutboundModule`). Borrar `pendingConfirmTimers`, `sendFn` y `setSendFn`. Imports: `randomUUID`, `outboundKeys`, `outboundGroups`.
- `implements OnModuleInit`:

```ts
  async onModuleInit(): Promise<void> {
    // pendingAppointments vive en memoria: tras un reinicio, un "¿Confirmamos?" pendiente
    // llegaría a una IA que ya no recuerda la cita. Se cancelan (el bloque 4 lo quitará).
    await this.outbound.cancelGroupsByPrefix('confirm-nudge:', 'reinicio: la IA perdió la cita pendiente');
  }
```

- Las dos funciones (siguen síncronas para no tocar sus ~20 llamadores; el trabajo va en segundo plano con el error registrado):

```ts
  private scheduleConfirmReminder(conversationId: string, storeId: string, phone: string): void {
    const group = outboundGroups.confirmNudge(conversationId);
    const text = '¿Confirmamos tu cita? Responde *Sí* para agendarla o *No* si prefieres otro horario. 😊';
    this.prisma
      .$transaction(async (tx) => {
        await this.outbound.cancelGroup(group, 'reprogramado', tx);
        await this.outbound.enqueue({
          storeId, to: phone, text, kind: 'reply', groupKey: group,
          key: outboundKeys.confirmNudge(conversationId, randomUUID()),
          notBefore: new Date(Date.now() + CONFIRM_REMINDER_MS),
          record: { conversationId },
        }, tx);
      })
      .then(() => this.outbound.wake())
      .catch((err) => this.logger.error(`[Cita] recordatorio no programado (conv ${conversationId}): ${err.message}`));
  }

  private cancelConfirmReminder(conversationId: string): void {
    this.outbound
      .cancelGroup(outboundGroups.confirmNudge(conversationId), 'ya no hace falta')
      .catch((err) => this.logger.error(`[Cita] recordatorio no cancelado (conv ${conversationId}): ${err.message}`));
  }
```

  Carrera posible: si en el **mismo** turno se programa y luego se cancela, el `cancel` podría llegar a la BD antes que el `schedule`. Revisar los llamadores (ai.service.ts ~2784-2813): hoy programar es la última rama de un `if/else` y no se cancela después en el mismo turno. Si se encuentra otro caso, encadenar ambas operaciones en una promesa por conversación y anotarlo.

- [ ] **Step 4: `AdminAssistantService`**

- Inyectar `OutboundService` y `NotificationsService` (`AdminAssistantModule` importa `OutboundModule` y `NotificationsModule`; `NotificationsModule` no importa nada del asistente: sin ciclo). Borrar `notifyFn`/`setNotifyFn`.
- `handle(storeId, adminPhone, content, turnId)` → `this.executeAction(storeId, actionType, actionParams, { turnId })`.
- `CANCEL_APPOINTMENT`: `await this.outbound.enqueue({ storeId, to: appt.customer.phone, text: msg, kind: 'notification', key: outboundKeys.apptCancelledByAdmin(appt.appointmentId) })` (con `await`; si falla, el `catch` general se lo dice al dueño).
- `CONFIRM_APPOINTMENT`: `updateMany({ where: { appointmentId, status: 'PENDING' }, data: { status: 'CONFIRMED' } })`; `count === 0` → `❌ Esa cita ya no está pendiente.`; después `await this.notifications.notifyAppointmentConfirmed(appt)` (misma clave que panel y autoconfirmación; el texto propio del asistente desaparece, el contenido es el mismo).
- `SEND_CUSTOMER_MESSAGE`: `enqueue({ …, kind: 'reply', key: outboundKeys.adminToCustomer(storeId, ctx.turnId, targetPhone) })`; `'invalid'` → `❌ Ese cliente no tiene un número de WhatsApp.`; `'duplicate'` → misma respuesta de éxito.
- `WhatsappService.onModuleInit`: borrar `setSendFn` y `setNotifyFn`.

- [ ] **Step 5: Comprobar** → las suites PASS, todo PASS, `tsc` limpio, `grep -rn "setSendFn\|setNotifyFn\|pendingConfirmTimers\|notifyFn" src` vacío.

- [ ] **Step 6: Commit**

```bash
git add src/ai src/admin-assistant src/whatsapp/whatsapp.service.ts src/outbound/outbound.service.ts test/integration
git commit -m "feat(ia): recordatorio de confirmación y acciones del asistente del dueño por la cola, con clave"
```

---

### Task 13: Reporte diario y resumen matutino (#15, #16)

**Files:**
- Modify: `src/reports/reports.service.ts`, `src/reports/reports.module.ts`, `src/reports/reports.controller.ts`
- Test: `test/integration/reports-send.int-spec.ts`

- [ ] **Step 1: Tests que fallan** — tienda con `adminPhone`:
1. `generateAndSendReport(storeId)` dos veces → 1 fila `report:{store}:{yyyy-mm-dd}` (fecha de Bogotá).
2. `POST /reports/generate` dos veces → 2 filas `report:{store}:manual:{uuid}` (cada clic es una petición explícita) — esperar con `waitFor`, el controlador no espera.
3. Con una cita hoy, `runMorningBriefings()` dos veces → 1 fila `briefing:{store}:{fecha}`.

- [ ] **Step 2: Implementar**

- `ReportsService`: `OutboundService` en lugar de `WhatsappService`; módulo con `OutboundModule` en lugar de `forwardRef(() => WhatsappModule)`.
- `generateAndSendReport(storeId, opts: { manualRequestId?: string } = {})`: `const localDate = localNow.toISOString().slice(0, 10);` (la `localNow` que ya calcula está desplazada a Bogotá). Clave `opts.manualRequestId ? outboundKeys.manualReport(storeId, opts.manualRequestId) : outboundKeys.dailyReport(storeId, localDate)`, `kind: 'notification'`. El WA deja de llevar `.catch(() => {})`: el encolado va con `await` y su error lo registra el `catch` que ya rodea el método. El email sigue igual.
- `sendMorningBriefing`: igual, con `outboundKeys.morningBriefing(store.storeId, localDate)`.
- `ReportsController.generate`: `this.reports.generateAndSendReport(req.user.storeId, { manualRequestId: randomUUID() }).catch((err) => this.logger.error(\`[reportes] manual store=${req.user.storeId}: ${err.message}\`))` (añadir `Logger`).

- [ ] **Step 3: Comprobar y commit**

```bash
git add src/reports test/integration/reports-send.int-spec.ts
git commit -m "feat(reportes): reporte diario y resumen matutino por la cola con clave por día"
```

---

### Task 14: Campañas fuera de la petición HTTP (#17) y mantenimiento de la cola

**Files:**
- Modify: `src/campaigns/campaigns.service.ts`, `src/campaigns/campaigns.module.ts`, `src/outbound/outbound.module.ts`, `stockup-frontend/src/pages/Campaigns.tsx`
- Create: `src/outbound/outbound-maintenance.service.ts`
- Test: `test/integration/campaigns-send.int-spec.ts`, `test/integration/outbound-maintenance.int-spec.ts`

- [ ] **Step 1: Tests que fallan**

`campaigns-send.int-spec.ts` (`t.wa.connectStore(storeId)` para que `isConnected` dé `true`):
1. Clientes: A (`lastInboundAt` puesto), B (sin `lastInboundAt`), C (`acceptsMarketing:false`), D (bloqueado: `blocked_contacts.phone` = sus 10 últimos dígitos con otro prefijo) → `POST /campaigns/:id/send` 201 con `status:'sending'` y **solo** la fila de A (`campaign:{id}:{customerId}`, `groupKey=campaign:{id}`, `kind=campaign`).
2. Dos `POST` a la vez (`Promise.all`) → un 201 y un **409**; filas sin duplicar.
3. Sin elegibles → 400, la campaña sigue `draft` y 0 filas.
4. Campaña de otra tienda → 403.

`outbound-maintenance.int-spec.ts`:
1. Campaña `sending` con filas 2 `sent` + 1 `failed` → `closeFinishedCampaigns()` → `sent`, `sentCount=2`. Con una fila `pending` → sigue `sending`. Dos ejecuciones → mismo resultado.
2. `purge()`: borra `sent/failed/skipped` con `updated_at` de hace 31 días y `wa_inbound` de hace 8; no toca `pending`/`sending` viejos ni lo reciente.
3. Dos `purge()` a la vez → uno devuelve `{ skipped: true }` y ninguno lanza.

- [ ] **Step 2: `CampaignsService.send`**

```ts
  async send(campaignId: string, storeId: string) {
    await this.findOne(campaignId, storeId);
    if (!this.whatsappService.isConnected(storeId)) {
      throw new BadRequestException('WhatsApp no está conectado para esta tienda');
    }
    const campaign = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.campaign.updateMany({ where: { campaignId, storeId, status: 'draft' }, data: { status: 'sending' } });
      if (claimed.count === 0) throw new ConflictException('Esta campaña ya se está enviando o ya se envió');
      const c = await tx.campaign.findUniqueOrThrow({ where: { campaignId } });
      // Solo a quien ya nos escribió (spec: Baileys), acepta marketing y no está bloqueado
      // (mismo criterio que BlockedService.isBlocked: últimos 10 dígitos).
      const recipients = await tx.$queryRaw<{ customer_id: string; phone: string }[]>`
        SELECT c.customer_id, c.phone FROM customers c
        WHERE c.store_id = ${storeId} AND c.last_inbound_at IS NOT NULL AND c.accepts_marketing = true
          AND NOT EXISTS (
            SELECT 1 FROM blocked_contacts b
            WHERE b.store_id = c.store_id
              AND length(regexp_replace(c.phone, '[^0-9]', '', 'g')) > 0
              AND b.phone LIKE '%' || right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10))`;
      if (recipients.length === 0) {
        throw new BadRequestException('No hay clientes que te hayan escrito y acepten mensajes');
      }
      await this.outbound.enqueueMany(
        recipients.map((r) => ({
          storeId, to: r.phone, text: c.message, kind: 'campaign' as const,
          key: outboundKeys.campaign(campaignId, r.customer_id), groupKey: outboundGroups.campaign(campaignId),
        })),
        tx,
      );
      return c;
    }, { timeout: 30_000 });
    this.outbound.wake();
    return campaign;
  }
```

(`[^0-9]` en vez de `\D` para no pelear con el escape dentro de la plantilla. Un `BadRequestException` dentro de la transacción la revierte: la campaña vuelve a `draft`. `CampaignsModule`: `imports: [WhatsappModule, OutboundModule]`; borrar `BASE_DELAY_MS`, `BATCH_EXTRA_MS` y el bucle.)

- [ ] **Step 3: Panel** — `stockup-frontend/src/pages/Campaigns.tsx`, `handleSend`: el estado lo dice el servidor:

```tsx
      const res = await sendCampaign(campaign.campaignId);
      setCampaigns((prev) =>
        prev.map((c) => c.campaignId === campaign.campaignId ? { ...c, status: res.data?.status ?? 'sending' } : c)
      );
```

(Comprobar que `sendCampaign` devuelve la respuesta de axios. El `catch {}` vacío que oculta el 409/400 se anota en Hallazgos: mostrar el error es UI, para 1d.)

- [ ] **Step 4: `src/outbound/outbound-maintenance.service.ts`**

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { OUTBOUND_CONFIG } from './outbound.module';
import { OutboundConfig } from './outbound-config';

const PURGE_LOCK = 'wa-outbound-purge';
const PURGE_BATCH = 5_000;

/** Cierra campañas terminadas y purga lo viejo. Idempotente; la purga, con candado de Postgres. */
@Injectable()
export class OutboundMaintenanceService {
  private readonly logger = new Logger(OutboundMaintenanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OUTBOUND_CONFIG) private readonly cfg: OutboundConfig,
  ) {}

  @Interval('outbound-close-campaigns', 60_000)
  async closeCampaignsTick(): Promise<void> {
    if (!this.cfg.dispatcherEnabled) return;
    await this.closeFinishedCampaigns().catch((err) => this.logger.error(`[outbound] cierre de campañas: ${err.message}`));
  }

  @Cron('15 5 * * *', { name: 'outbound-purge', timeZone: 'UTC' })
  async purgeTick(): Promise<void> {
    if (!this.cfg.dispatcherEnabled) return;
    await this.purge().catch((err) => this.logger.error(`[outbound] purga: ${err.message}`));
  }

  /** sending → sent cuando no le quedan filas pending/sending. sent_count = filas enviadas. */
  async closeFinishedCampaigns(): Promise<number> {
    const n = await this.prisma.$executeRaw`
      UPDATE campaigns c SET status = 'sent',
        sent_count = (SELECT count(*) FROM wa_outbound o WHERE o.group_key = 'campaign:' || c.campaign_id AND o.status = 'sent')
      WHERE c.status = 'sending'
        AND NOT EXISTS (SELECT 1 FROM wa_outbound o
                        WHERE o.group_key = 'campaign:' || c.campaign_id AND o.status IN ('pending', 'sending'))`;
    if (n > 0) this.logger.log(`[outbound] ${n} campaña(s) terminada(s)`);
    return n;
  }

  /** Borra por lotes lo cerrado y viejo. Con dos procesos, solo uno purga (candado). */
  async purge(): Promise<{ skipped: boolean; outbound: number; inbound: number }> {
    return this.prisma.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${PURGE_LOCK})) AS locked`;
      if (!locked) return { skipped: true, outbound: 0, inbound: 0 };
      let outbound = 0;
      let inbound = 0;
      for (;;) {
        const n = await tx.$executeRaw`
          DELETE FROM wa_outbound WHERE id IN (
            SELECT id FROM wa_outbound
            WHERE status IN ('sent', 'failed', 'skipped')
              AND updated_at < (now() AT TIME ZONE 'UTC') - (${this.cfg.outboundRetentionDays} * interval '1 day')
            LIMIT ${PURGE_BATCH})`;
        outbound += n;
        if (n < PURGE_BATCH) break;
      }
      for (;;) {
        const n = await tx.$executeRaw`
          DELETE FROM wa_inbound WHERE id IN (
            SELECT id FROM wa_inbound
            WHERE created_at < (now() AT TIME ZONE 'UTC') - (${this.cfg.inboundRetentionDays} * interval '1 day')
            LIMIT ${PURGE_BATCH})`;
        inbound += n;
        if (n < PURGE_BATCH) break;
      }
      this.logger.log(`[outbound] purga: ${outbound} salientes y ${inbound} entrantes borrados`);
      return { skipped: false, outbound, inbound };
    }, { timeout: 120_000 });
  }
}
```

Registrar en `OutboundModule.providers`. Notas: (1) `campaigns.campaign_id` es `text`/uuid como `group_key`: si Postgres se queja del `||`, castear `c.campaign_id::text`. (2) Los `failed` se borran a los 30 días como el resto. (3) Con 20-100 tiendas la purga diaria tarda segundos; si crece, añadir índice `(status, updated_at)` entonces, no ahora.

- [ ] **Step 5: Comprobar y commit**

```bash
git add src/campaigns src/outbound test/integration/campaigns-send.int-spec.ts test/integration/outbound-maintenance.int-spec.ts
git commit -m "feat(campañas): envío fuera de la petición HTTP, solo a quien escribió, y mantenimiento de la cola"
```

Panel, en su repo y en rama propia (sin push hasta el deploy):

```bash
cd ../stockup-frontend && git checkout -b bloque-1a-campanas
git add src/pages/Campaigns.tsx && git commit -m "fix(campañas): el estado tras enviar lo dice el servidor (Enviando)"
cd ../whatsapp-crm
```

---

### Task 15: Limpieza: fuera `sendMessage`, `safeSend` y el código muerto

**Files:**
- Modify: `src/whatsapp/whatsapp.service.ts`, `test/support/fake-whatsapp.ts`, `test/README.md`

- [ ] **Step 1: Comprobar que no quedan llamadores**

```bash
grep -rn "\.sendMessage(\|safeSend(" src --include=*.ts | grep -v "sock\.sendMessage\|currentSock\.sendMessage\|\.spec\.ts"
```

Expected: solo la definición de `sendMessage` en `whatsapp.service.ts`. Si sale otro sitio, migrarlo antes con su clave y añadirlo a la tabla §4 de la auditoría.

- [ ] **Step 2: Borrar** de `whatsapp.service.ts`: `sendMessage`, `safeSend`, `withRetry` (muerto, auditoría §1.1), `SEND_RETRY_ATTEMPTS`, `SEND_RETRY_DELAY_MS`, `SEND_NOT_ACCEPTABLE_DELAY_MS`, parámetros `sock` sin uso e imports huérfanos. De `FakeWhatsapp`: `sendMessage`.

- [ ] **Step 3: `test/README.md`** — sección "Cola de WhatsApp": despachador apagado en tests (`WA_OUTBOUND_DISPATCHER=off`), se mueve con `t.app.get(OutboundDispatcher).tick()`; `t.wa.failNext(...)` / `t.wa.disconnect(storeId)` programan fallos; `createTestApp({ realWhatsappService: true })` para el flujo de entrada; `overrides: [[OUTBOUND_CONFIG, cfg]]` para cambiar ritmos.

- [ ] **Step 4: Verificación completa**

```bash
npx tsc --noEmit
npm run lint
npm test
npm run test:db && npm run test:int
npm run build
```

Expected: todo verde. Pegar la salida en el PR.

- [ ] **Step 5: Commit**

```bash
git add -A src test
git commit -m "refactor(whatsapp): fuera sendMessage, safeSend y withRetry: todo envío pasa por wa_outbound"
```

---

### Task 16: Revisión, ensayo, PR y despliegue (con OK de Alex)

- [ ] **Step 1: Revisión** — `/code-review` sobre la rama (o la skill `requesting-code-review`), buscando a propósito: un envío que no pase por la cola, una clave que pueda colisionar entre tiendas, un `$queryRaw` con `now()` sin `AT TIME ZONE 'UTC'`, un `UPDATE` crudo sin `updated_at`, un `catch` vacío nuevo. Arreglar y repetir la Task 15 Step 4.

- [ ] **Step 2: Ensayo de la migración sobre copia de estructura de producción** (método de la Fase 0): `pg_dump --schema-only` por el túnel (5433) → restaurar en `crm_prod_shape_test` (WSL 5434) → `prisma migrate deploy` contra ella. Expected: aplica `20261010000002` sin errores; `\d wa_outbound` muestra `wa_outbound_one_sending_per_store`; `customers_store_wa_lid_key` sigue existiendo. `EXPLAIN` de la consulta de candidatos del despachador: usa índices, sin `Seq Scan` sobre una tabla grande.

- [ ] **Step 3: Precheck de producción** (solo lectura, por el túnel): `prisma migrate status` = solo falta `20261010000002`; sin transacciones largas (`pg_stat_activity`); cuántos clientes recibirán `last_inbound_at` con el relleno (las dos condiciones de la migración) para comprobarlo después.

- [ ] **Step 4: PR** `bloque-1a-cola-de-salida` → `main` con la verificación y los hallazgos. **Parar y pedir OK a Alex** para mergear y desplegar.

- [ ] **Step 5: Despliegue** (tras el OK): merge + push; `ssh -o BatchMode=yes -p 2229 instapod@167.114.209.204 'bash ~/app/scripts/deploy-pod.sh'` (copia de BD, `migrate deploy`, build, reinicio, health). Panel: merge de `bloque-1a-campanas` y push → Vercel.

- [ ] **Step 6: Verificación en producción**
  - `journalctl -u app.service --since "10 min ago" | grep -E "outbound|ERROR"`: el despachador arranca sin errores (no debe decir "apagado").
  - BD: `wa_outbound` y `wa_inbound` existen, el índice parcial existe, `last_inbound_at` relleno con el número del Step 3.
  - Un envío real de punta a punta **no es posible** hoy (ningún número conectado; servicio cerrado a clientes): queda para la reconexión controlada del cierre del programa. Lo que sí: encolar a mano una fila de prueba (`kind='reply'`, `expires_at` a 3 min) para una tienda desconectada → ver que queda `pending`, aplazada, `attempts = 0`, y que pasa a `skipped` al caducar; después borrarla.
  - Actualizar la memoria (`crm_impecable.md`) con commit, estado y pendientes.

---

## Hallazgos durante la planificación (para Alex)

1. **Reprogramación aprobada anunciada como cancelación** (Task 11): el controlador lee `pendingAction` de la cita ya actualizada (`null`) y cae en `'CANCEL_REQUESTED'`. Se arregla en este bloque.
2. **"¿Confirmamos tu cita?" y reinicios** (Task 12): que sobreviva al reinicio sería peor que perderlo, porque la IA olvida la cita pendiente (memoria). Decisión: se cancelan al arrancar hasta el bloque 4.
3. **Stickers**: hoy pasan la conversación a `pending_human` y registran un error. Se arregla de paso (Task 8): un sticker se ignora entero.
4. **Panel de campañas**: el `catch {}` vacío oculta el 409/400. Queda para 1d (UI).
5. **Avisos al dueño desde la IA fuera de transacción** (cita creada, solicitudes, comprobantes): idempotentes por clave, pero si el proceso muere entre crear la cita y encolar, ese aviso se pierde (ventana de milisegundos). Se cierra cuando el bloque 4 meta el flujo de citas de la IA en transacciones.
6. **`isConnected` miente** (da `true` con creds aunque el socket esté caído): una campaña puede encolarse con el número caído. Ya no se pierde (espera y caduca a las 72 h). El arreglo es de 1b.
7. **Mensaje del asesor con WhatsApp caído**: antes devolvía 200 y el mensaje constaba como enviado aunque no saliera. Ahora queda encolado y su estado real está en `wa_outbound`; el panel todavía no lo muestra (1d).
