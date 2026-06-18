# Spec 1 — IA de citas robusta: contexto desde BD, respuestas cortas, servicio predeterminado y silencio fuera de tema

**Fecha:** 2026-06-18
**Repos afectados:** `whatsapp-crm` (backend, principal) + `stockup-frontend` (selector de config)
**Estado:** diseño aprobado, pendiente plan de implementación

## Problema

Quejas reales de clientes y bugs observados en producción (Next Level Barber Shop) en el flujo de IA de citas:

1. **Pérdida de contexto (grave).** Un cliente agendó a las 11:06am ("¡Cita agendada! ✅"). Al volver horas después ("ya voy en camino", "confírmamela"), la IA respondió *"no tengo una cita pendiente de confirmar para ti"* — aunque la cita estaba en la BD. Causa raíz en `src/ai/ai.service.ts`:
   - `MAX_HISTORY_MESSAGES = 8` (línea 20): la IA solo ve los últimos 8 mensajes; en conversaciones largas el "Cita agendada ✅" se sale de la ventana.
   - El flujo de agendar/confirmar se apoya en **caches en memoria** (`pendingAppointments`, `conversationCreatedAppts`) con TTL, **no** en la cita real ya persistida. El query de citas del cliente existe (línea ~1173) pero no se usa como fuente de verdad para el guard de confirmación.

2. **Respuestas largas / interrogatorio.** La IA re-lista todos los asesores y re-pide servicio + asesor + nombre en cada mensaje, alargando la conversación y cansando al cliente. Caso real: cliente que solo quería "turno para las 3" terminó en 10+ mensajes.

3. **No agenda al cliente "desordenado".** En un caso real el cliente divagó, cambió de hora varias veces y dio horas vagas ("desde las 8", "mañana en la mañana", "lo más temprano"). La IA nunca fijó un slot concreto ni creó la cita; el cliente simplemente se presentó.

4. **Habla fuera de tema.** Ante mensajes ajenos al negocio (felicitaciones, chistes, "ando cuidando al viejo") la IA responde con *"Jaja, eso no es lo mío 😅..."* o re-lanza el menú. El dueño quiere **silencio total** salvo que el mensaje sea del negocio. Hoy el system prompt (líneas 3092-3093) **ordena explícitamente** ese comportamiento: solo usa `[IGNORAR]` para spam, y para un cliente real que se desvía manda la redirección "jaja eso no es lo mío".

## Objetivo

Que la IA agende a un cliente real (incluido el desordenado) **rápido y limpio**, nunca pierda una cita ya creada, no interrogue de más, y **calle** cuando el mensaje no es del negocio.

## Alcance

**Incluido (Spec 1):**
- A. Cita activa desde BD como fuente de verdad (fix del bug grave).
- B. Servicio predeterminado configurable + nombre automático (pushName).
- C. Respuestas cortas y agendamiento de hora vaga con confirmación única.
- D. Silencio total fuera de tema (eliminar "jaja eso no es lo mío").
- E. Selector de servicio predeterminado en frontend (Config).

**Fuera de alcance (Spec 2 u otra tanda):**
- Correr horario por cliente que llega tarde (admin; decisión ya tomada: "solo mueve esa cita").
- Walk-ins / clientes sin agendar (registro rápido + contabilidad).
- Agendamiento con acompañantes (N citas back-to-back con el mismo asesor).

## Diseño

### A) Cita activa = fuente de verdad

**Nueva consulta dedicada** (en `generateResponse`, junto al `Promise.all` existente ~línea 1155): la próxima cita activa del cliente:

```
status ∈ { PENDING, CONFIRMED, IN_PROGRESS }
AND scheduledAt >= inicio del día de hoy (TZ America/Bogota)
orderBy scheduledAt asc
take 1
include: service { name }, serviceVariant { name }, staff { name }
```

**Inyección en el prompt (destacada, arriba).** En `buildSystemPrompt`, antes de las demás secciones, si existe cita activa:

```
⚠️ CITA ACTIVA DE ESTE CLIENTE (fuente de verdad — NO la ignores):
- {servicio} {variante} — {fecha} a las {hora} con {asesor} — Estado: {estado}
REGLAS:
- Este cliente YA tiene una cita. NO vuelvas a agendar otra salvo que pida explícitamente una distinta.
- Si dice que va en camino / llega tarde / "ya le llego" / "confírmamela" → confírmale que su cita SIGUE EN PIE con esos datos. Nunca digas que no tiene cita.
```

Cuando `appointments.length === 0` la sección de citas se mantiene como hoy ("Ninguno").

**Guard determinístico en código** (antes del extractor de citas y del flujo libre): si existe cita activa **y** el mensaje del cliente es una confirmación/coordinación (`CONFIRMATION_RE` o patrón de "voy/llegando/en camino/ya le llego/a las N entonces"), devolver una respuesta segura que referencia la cita real (servicio/fecha/hora/asesor), **saltándose** el extractor que antes alucinaba "no tienes cita". Esto hace el fix independiente de la ventana de historial y del cache en memoria.

**Refuerzo barato:** subir `MAX_HISTORY_MESSAGES` de 8 a **14**. No es el fix principal (el fix robusto es DB-driven) pero reduce pérdidas de contexto en general.

### B) Servicio predeterminado + nombre automático

**Schema (`Store`):**
```prisma
defaultServiceId String? @map("default_service_id")   // servicio usado cuando el cliente no especifica
```
Nullable, retrocompatible. Validar (al guardar desde config y al usarlo) que el servicio pertenezca a la tienda (multi-tenant).

**Uso en el flujo de citas:** si el cliente da fecha/hora pero **no** especifica servicio y `store.defaultServiceId` está configurado → usar ese servicio para la cita. Si no hay default configurado → comportamiento actual (preguntar, pero breve, una vez).

**Nombre automático (decisión: auto con pushName):**
- Capturar `msg.pushName` en `processMessage` (`whatsapp.service.ts` ~línea 541) y pasarlo a `customersService.findOrCreate` (llamadas en ~924 y ~1004).
- `findOrCreate` usa el pushName como `name` por defecto al crear el cliente; si el cliente ya existe sin nombre, lo backfillea con el pushName.
- Si pushName viene vacío → `Cliente {últimos 4 dígitos del teléfono}`.
- La IA **nunca** pide el nombre para agendar; usa el del cliente. El system prompt deja de exigirlo.

### C) Respuestas cortas + hora vaga

**System prompt (endurecer):**
- Tope de longitud por respuesta (mensajes breves, estilo WhatsApp).
- Prohibido re-listar todos los asesores en cada mensaje.
- Prohibido re-pedir datos ya recopilados (ya existe la sección "DATOS YA RECOPILADOS"; reforzar).
- Estilo "confirmar y listo".

**Hora vaga → slot concreto + 1 confirmación (decisión: una confirmación corta):**
- Ante expresiones vagas ("desde las 8", "mañana en la mañana", "lo más temprano", "por ahí a las 7") → la IA propone un **slot concreto real** del horario disponible (reutiliza `computeSlotsForAI` / agenda real ya existente) y pide **una** confirmación: *"¿Confirmo {servicio} {día} {hora} con {asesor} a tu nombre? 👍"*.
- Al recibir el sí → crear la cita (PENDING). No auto-crear sin esa confirmación (se preserva el anti-alucinación).

**Respetar SIEMPRE el horario del asesor — no crear horarios trucados (requisito duro):**
- El slot propuesto debe salir de la disponibilidad real del asesor: su `schedule` propio (o `store.businessHours` si hereda), menos las citas ya existentes (PENDING/CONFIRMED/IN_PROGRESS) de ese asesor, considerando la duración del servicio. Nunca proponer una hora ocupada ni fuera de la jornada del asesor.
- Si la hora pedida cae ocupada o fuera de grilla → la IA ofrece el slot libre real más cercano (nunca inventa una hora).
- La creación se hace **a través de `AppointmentsService.create()`**, que ya tiene el candado atómico anti-doble-booking y la validación de horario por asesor (mismo path que el calendario público). El quick-book **no** crea citas por una ruta paralela: si `create()` rechaza por conflicto (race condition, slot tomado entre la propuesta y el sí), la IA lo informa y vuelve a ofrecer el siguiente libre. Cero lógica de horario duplicada.

### D) Silencio total fuera de tema

Reescribir la política (system prompt, líneas ~3092-3093) colapsando los dos tiers en uno:

- La IA responde **solo** si el mensaje es del negocio:
  - pregunta/agenda/compra de **servicios o productos**, o
  - **coordinación de una cita activa** ("ya voy", "llegando", "a las 8 entonces", "confírmamela") — se apoya en la cita activa del punto A, y
  - **saludo de apertura** de alguien buscando atención del negocio.
- Cualquier otra cosa (felicitaciones, chistes, temas personales, número equivocado, spam, cobranza, cadenas) → responder **exactamente** `[IGNORAR]` → el sistema no envía nada (ya existe el manejo del sentinel en líneas 1604-1612).
- **Eliminar** el tier de "redirige breve" y el texto "Jaja, eso no es lo mío 😅...". Ya no se redirige: o es del tema (responde) o no lo es (calla).

Riesgo de callar de más: mitigado porque las coordinaciones de cita activa cuentan como del tema (punto A). El saludo de apertura sigue recibiendo bienvenida.

### E) Frontend (Config)

- En `Config.tsx` (o `AiConfig.tsx`), agregar un selector **"Servicio predeterminado"**: dropdown de servicios activos de la tienda + nota explicativa ("Se usará cuando un cliente pida turno sin especificar el servicio"). Opción "Ninguno".
- Persistir vía el endpoint de actualización de tienda (`stores` PATCH) — agregar `defaultServiceId` al DTO de update.

## Datos / contratos

- `Store.defaultServiceId: string | null` — FK lógica a `Service.serviceId` de la misma tienda. No se añade relación Prisma estricta para evitar drift; se valida en código.
- `customersService.findOrCreate({ storeId, phone, pushName? })` — nueva firma opcional retrocompatible.

## Manejo de errores / robustez

- Todo nullable → sin `defaultServiceId` ni pushName el sistema se comporta como hoy.
- `defaultServiceId` se valida que pertenezca a la tienda antes de usarse; si apunta a un servicio borrado/inactivo → se ignora (fallback a preguntar).
- El guard de cita activa solo dispara con cita en estado activo y futura/hoy; citas pasadas/canceladas no interfieren.
- Anti-alucinación preservado: la cita solo se crea tras la confirmación corta.
- Sin horarios trucados: el quick-book solo propone slots de la disponibilidad real del asesor y crea vía `AppointmentsService.create()` (candado atómico anti-doble-booking). Si hay conflicto al confirmar, se ofrece el siguiente libre — nunca se fuerza la creación.

## Restricción dura (no romper lo que funciona)

La lógica actual de disponibilidad y anti-doble-booking **funciona bien hoy** (si un cliente agendó a las 2pm, ese slot queda ocupado y no se le asigna otro cliente a esa hora con el mismo asesor). El Spec **NO modifica ni refactoriza** esa lógica: solo la **reutiliza** vía `AppointmentsService.create()` y `computeSlotsForAI`. Cualquier cambio en el flujo de quick-book debe apoyarse en esos componentes existentes — nunca crear una ruta paralela de creación o de cálculo de slots.

## Deploy

- `npx prisma db push` (NUNCA `migrate reset` — drift histórico).
- La columna `default_service_id` debe llegar a la BD de InstaPods vía el patrón `STARTUP_MIGRATIONS` en `PrismaService.onModuleInit()` (no confiar en el push local).

## Pruebas (manuales, no hay suite automatizada)

Escenarios a validar en producción/staging:
1. Cliente agenda, vuelve >8 mensajes después con "ya voy" → la IA confirma la cita real, no la "pierde".
2. Cliente dice "turno para las 3" sin servicio (con default configurado) → propone slot + 1 confirmación + crea, sin pedir nombre ni asesor en bucle.
3. Hora vaga ("lo más temprano mañana") → propone slot concreto real.
4. Mensaje fuera de tema (felicitación, chiste, "ando cuidando al viejo") → silencio, no envía nada.
5. Mensaje de apertura ("ole papi como vamos?") → bienvenida normal.
6. Tienda sin `defaultServiceId` → comportamiento actual intacto.
7. Quick-book NO crea horario trucado: pedir una hora ocupada → la IA ofrece el siguiente libre real del asesor; nunca dos citas encimadas con el mismo asesor.
