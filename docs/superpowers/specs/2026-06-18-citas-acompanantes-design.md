# Citas con acompañantes (grupo back-to-back) — Design Spec

**Fecha:** 2026-06-18
**Estado:** Aprobado por Alex, listo para plan de implementación.

## Problema

Hoy la IA solo puede agendar **una** cita por solicitud. Cuando un cliente escribe "venimos mi hijo y yo a corte el viernes 3pm con Oswar" o "somos 3", la IA no entiende que son varias personas: agenda una sola (o se confunde). El negocio quiere poder agendar a un cliente **junto con sus acompañantes** en citas consecutivas (back-to-back) con el mismo asesor, en un solo intercambio de chat.

## Objetivo

Que la IA, en una sola conversación, detecte que el cliente viene con acompañantes y cree **N citas separadas consecutivas** con el **mismo asesor**, **mismo servicio**, confirmando una sola vez.

## Decisiones de diseño (validadas)

1. **Modelo de datos:** N citas separadas back-to-back (cada persona = una cita real consecutiva). Reutiliza `AppointmentsService.create()` tal cual. Suma correctamente en analytics y rendimiento del barbero. **No** se añade `partySize`/`groupId` al schema de la cita; el agrupamiento es solo en el momento de crear.
2. **Servicios:** mismo servicio (o el predeterminado) para todas las personas del grupo. Duración uniforme D.
3. **Identidad:** todas las citas quedan bajo el **mismo `customerId`** (quien escribe). No se crean clientes fantasma. Cada cita marca en su `description` "Acompañante k de N" (o "Persona k de N").
4. **Conflicto de grupo:** si no hay N slots consecutivos libres en la hora pedida, ofrecer la **ventana consecutiva más cercana** ese día con ese barbero. Si no hay bloque ese día → proponer otro día u otro barbero. (No se reparte entre barberos en paralelo; no se agendan grupos partidos.)
5. **Cap máximo:** `partySize` se limita a **4**. Si el cliente pide más, la IA responde que para grupos grandes lo contacta un asesor y no auto-agenda.

## Arquitectura

Extiende el flujo de agendamiento existente en `src/ai/ai.service.ts`. **No** toca `AppointmentsService.create()`, ni la detección de conflicto/slots, ni el anti-doble-booking.

### 1. Extracción (`appointmentPrompt` + JSON)

- Añadir campo `partySize` (entero ≥ 1, default 1) al JSON que devuelve el extractor de citas.
- Regla en el prompt: detectar cantidad de personas a partir de frases como "venimos 3", "yo y mi hijo", "somos 2", "para mí y mi novia". Sin mención explícita de acompañantes → `partySize: 1`.
- Fallback TS: si el LLM no lo devuelve, default 1. Validar rango `1..4`; si > 4, marcar para respuesta de "grupo grande" (no agendar).

### 2. Slotting back-to-back

Cuando `partySize > 1` y hay barbero resuelto:
- Duración D = duración del servicio (o slot de 30 min si no hay duración).
- Se necesitan N = `partySize` slots de D consecutivos libres con ese barbero ese día.
- Reutilizar `computeSlotsForAI(storeId, date, activeStaff, store)` para obtener los slots libres del barbero.
- Buscar la primera secuencia de N slots consecutivos (a paso D) **a partir de la hora pedida**. Si no existe a partir de ahí, buscar la ventana consecutiva más cercana del día.
- Si se encontró ventana distinta a la pedida → la IA la ofrece ("¿Te sirve arrancando 4:00 p. m. los tres seguidos?") en am/pm.
- Si no hay ninguna ventana de N consecutivos ese día → mensaje proponiendo otro día u otro barbero (consistente con los mensajes de "no disponible" actuales).

### 3. Creación

- Bucle sobre `create()` actual, N veces. Horas: base, base+D, base+2D, … con el mismo `staffId`, `serviceId`, `agreedPrice`, `customerId`, `source: 'AI'`.
- `description` de cada cita: "Persona k de N" (k = 1..N), conservando cualquier descripción base.
- Si una creación falla a mitad (p. ej. carrera de doble-booking), informar cuántas quedaron creadas; **no** se revierten las ya creadas (mismo comportamiento que hoy para citas múltiples en una conversación).
- Registrar las N en `conversationCreatedAppts` para no re-extraer el grupo.

### 4. Confirmación / UX

- **Una sola** confirmación previa que liste los N horarios:
  *"Para confirmar: 3 cortes con Oswar hoy — 3:00, 3:30 y 4:00 p. m. ¿Todo bien?"*
- Tras crear, **un solo** mensaje de éxito con los N horarios (no N mensajes "¡Cita agendada! ✅").
- Las horas siempre en am/pm para el cliente.

## Flujo de datos

```
Mensaje cliente ("venimos 3 a corte 3pm con Oswar")
  → extractor JSON { ..., partySize: 3, staffId, serviceId, scheduledTime }
  → si partySize > 4 → respuesta "grupo grande, te contacta un asesor" (fin)
  → resolver barbero + duración D
  → computeSlotsForAI → slots libres del barbero ese día
  → buscar N=3 slots consecutivos desde la hora pedida (o la ventana más cercana)
      → si no hay → ofrecer otro día/barbero (fin)
      → si la ventana != hora pedida → ofrecer y esperar confirmación (fin de turno)
  → confirmar (una sola pregunta con los 3 horarios)
  → crear 3 citas back-to-back vía create()
  → un mensaje de éxito con los 3 horarios
```

## Manejo de errores

- `partySize` > 4 → no agendar, mensaje de "grupo grande".
- No hay ventana de N consecutivos ese día → proponer otro día/barbero.
- Falla parcial al crear (carrera) → informar cuántas quedaron; no revertir.
- Sin barbero elegido y hay equipo (varios barberos) → la IA **pregunta primero con qué barbero** quiere el grupo (la búsqueda del bloque consecutivo se hace contra ese barbero ya elegido). Para grupo NO se usa la auto-asignación por slot individual, porque las N citas deben quedar con el mismo asesor. Si hay un solo barbero/sin equipo, se usa ese.

## Fuera de alcance (YAGNI)

- Servicios distintos por persona.
- Acompañantes como clientes propios (customer records separados).
- Reparto entre barberos en paralelo (mismo horario, distintos asesores).
- Campos de schema `partySize`/`groupId` persistidos en la cita.

## Verificación

Sin tests automatizados (igual que el resto del proyecto): `npx tsc --noEmit` + escenarios manuales en WhatsApp real:
1. "venimos 2 a corte hoy 3pm con Oswar" con 3:00 y 3:30 libres → crea 2 citas (3:00, 3:30), un solo mensaje de éxito.
2. Mismo caso pero 3:30 ocupado → ofrece la ventana consecutiva más cercana (ej. 4:00 y 4:30).
3. "somos 3" sin barbero elegido → pregunta barbero, luego agenda 3 consecutivas.
4. `partySize` 6 → responde "grupo grande, te contacta un asesor", no agenda.
5. Sin acompañantes ("quiero corte mañana 10am") → comportamiento normal de 1 cita (no regresión).
6. Las N citas suman en analytics e ingreso, y aparecen en el rendimiento del barbero.
