# Citas con acompañantes (grupo back-to-back) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la IA detecte en una conversación que el cliente viene con acompañantes y cree N citas consecutivas (back-to-back) con el mismo asesor y mismo servicio, confirmando una sola vez.

**Architecture:** Todo el cambio vive en `src/ai/ai.service.ts`. Se añade `partySize` al extractor de citas; cuando `partySize > 1` se entra a una rama de grupo que busca la primera ventana de N slots consecutivos libres del barbero (vía `computeSlotsForAI`), y crea N citas reutilizando un helper `insertAiAppointment` extraído del path single actual. NO se toca `AppointmentsService.create()`, ni la detección de conflicto/slots, ni el anti-doble-booking. NO se añaden columnas al schema (el grupo solo existe al momento de crear).

**Tech Stack:** NestJS 11 + Prisma 6, TypeScript. Provider LLM vía `createCompletion`.

**Spec:** `docs/superpowers/specs/2026-06-18-citas-acompanantes-design.md`

**Sin tests automatizados:** verificación por `npx tsc --noEmit` + escenarios manuales en WhatsApp real. NO escribir tests ni introducir un framework (igual que el resto del proyecto).

**Repo:** `C:\Users\alexp\Desktop\proyectos\whatsapp-crm`

**Restricción dura:** NO modificar la lógica de detección de conflicto/slots ni el anti-doble-booking. La rama de grupo reutiliza `computeSlotsForAI` (solo lectura) y el helper `insertAiAppointment` (que conserva el guard de conflicto dentro de la transacción tal cual está hoy). Trabajar en `main`, NO pushear hasta la tarea de deploy.

**Nota de líneas:** anclas al estado actual del archivo; localiza por el texto citado.

---

## Task 1: Parser de cantidad de personas (módulo) + campo `partySize` en el extractor

**Files:**
- Modify: `src/ai/ai.service.ts` (parsers de módulo ~línea 413; prompt extractor de citas ~línea 2123-2173; fallbacks ~línea 2186-2205)

- [ ] **Step 1: Agregar el parser `parsePartySize` a nivel de módulo**

En `src/ai/ai.service.ts`, junto a los demás parsers de módulo (cerca de `parseNombreCliente`, ~línea 413, antes de la clase del servicio), agregar:
```ts
// ─── Parser de cantidad de personas (acompañantes) ───────────────────────────
// Heurística de respaldo: el LLM es la fuente primaria de partySize; esto cubre
// los casos en que devuelve null. Devuelve null si no detecta un grupo.
export function parsePartySize(text: string): number | null {
  const t = (text || '').toLowerCase();
  const WORD: Record<string, number> = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 };

  // "somos 3", "venimos 2", "vamos 4", "para 3"
  const digitVerb = t.match(/\b(?:somos|venimos|ser[ií]amos|vamos|llevamos|para)\s+(\d{1,2})\b/);
  if (digitVerb) { const n = parseInt(digitVerb[1], 10); if (n >= 1 && n <= 20) return n; }

  // "3 personas", "2 cupos", "4 turnos"
  const digitNoun = t.match(/\b(\d{1,2})\s+(?:personas?|cupos?|turnos?|citas?)\b/);
  if (digitNoun) { const n = parseInt(digitNoun[1], 10); if (n >= 1 && n <= 20) return n; }

  // en palabras: "somos tres", "venimos dos", "tres personas"
  const wordVerb = t.match(/\b(?:somos|venimos|ser[ií]amos|vamos)\s+(un|una|uno|dos|tres|cuatro|cinco|seis)\b/);
  if (wordVerb) return WORD[wordVerb[1]];
  const wordNoun = t.match(/\b(dos|tres|cuatro|cinco|seis)\s+(?:personas?|cupos?|turnos?|citas?)\b/);
  if (wordNoun) return WORD[wordNoun[1]];

  // acompañante implícito: "yo y mi hijo", "con mi esposa", "y mi novia" → 2
  if (/\b(?:yo\s+y\s+mi|con\s+mi|y\s+mi)\s+(hij[oa]|espos[oa]|novi[oa]|amig[oa]|herman[oa]|pap[aá]|mam[aá]|pareja|cu[ñn]ad[oa]|primo|prima)\b/.test(t)) {
    return 2;
  }
  return null;
}
```

- [ ] **Step 2: Agregar `partySize` al JSON y reglas del extractor de citas**

En el `appointmentPrompt` (~línea 2123), dentro de "REGLAS ESTRICTAS", agregar una regla nueva (después de la regla 8 "staffId", antes del bloque "Responde ÚNICAMENTE..."):
```ts
9. "partySize": número de personas que serán atendidas en esta solicitud (el cliente + sus acompañantes). Detéctalo de frases como "venimos 3", "somos 2", "yo y mi hijo" (=2), "para mí y mi novia" (=2), "3 personas". Si el cliente NO menciona acompañantes, devuelve 1. Todas las personas del grupo van con el MISMO servicio y el MISMO ${'profesional'}.
```
Y en el objeto JSON de respuesta (el bloque que empieza con `{` y termina con `}` ~línea 2156), agregar la línea `"partySize"` después de `"staffName"`:
```ts
  "staffId": "uuid del profesional elegido o null",
  "staffName": "nombre del profesional elegido o null",
  "partySize": number (1 si no hay acompañantes)
```

- [ ] **Step 3: Normalizar `partySize` en los fallbacks TS**

En la sección de fallbacks (justo después de `extracted = JSON.parse(jsonMatch[0]);`, ~línea 2186, antes del bloque de nombre placeholder), agregar:
```ts
        // ── partySize: normalizar a entero ≥ 1; fallback TS si el LLM no lo dio ──
        let partySize = Number.isFinite(extracted.partySize) ? Math.trunc(extracted.partySize) : 1;
        if (partySize < 1) partySize = 1;
        if (partySize === 1) {
          const allClientText = [
            ...history.filter((m: any) => !m.isAiResponse).map((m: any) => m.content),
            latestMessage,
          ].join(' ');
          const tsParty = parsePartySize(allClientText);
          if (tsParty && tsParty > 1) {
            this.logger.log(`[Cita] partySize fallback TS: ${tsParty}`);
            partySize = tsParty;
          }
        }
        extracted.partySize = partySize;
```
(`history` y `latestMessage` ya están en scope en esta función — se usan en los otros fallbacks de fecha/hora justo abajo.)

- [ ] **Step 4: Compilar**

Run: `cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm" && npx tsc --noEmit`
Expected: sin salida.

- [ ] **Step 5: Commit**
```bash
cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm"
git add src/ai/ai.service.ts
git commit -m "feat(ia): extractor de citas captura partySize (acompañantes)"
```

---

## Task 2: Extraer helper `insertAiAppointment` (DRY del path single)

**Files:**
- Modify: `src/ai/ai.service.ts` (path single de creación ~línea 2760-2813; agregar método privado)

- [ ] **Step 1: Agregar el método privado `insertAiAppointment`**

Justo ANTES del método `computeSlotsForAI` (~línea 1051, dentro de la clase), agregar:
```ts
  // Inserta UNA cita de la IA: guard final de conflicto dentro de la transacción
  // (anti-doble-booking) + creación + timeline. Reutilizado por el path single y el
  // de grupo (acompañantes). `descriptionOverride` permite marcar "Persona k de N".
  private async insertAiAppointment(
    storeId: string,
    customerId: string,
    resolvedStaffId: string | null,
    scheduledAt: Date,
    endsAt: Date | null,
    durationMinutes: number | null,
    extracted: any,
    descriptionOverride?: string | null,
  ): Promise<any> {
    return this.prisma.$transaction(async (tx) => {
      // Guard final dentro de la transacción para evitar doble-booking concurrente
      if (resolvedStaffId) {
        const slotEnd = endsAt ?? new Date(scheduledAt.getTime() + 30 * 60_000);
        const conflict = await tx.appointment.findFirst({
          where: {
            staffId: resolvedStaffId,
            status: { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
            AND: [
              { scheduledAt: { lt: slotEnd } },
              {
                OR: [
                  { endsAt: { gt: scheduledAt } },
                  { endsAt: null, scheduledAt: { gt: new Date(scheduledAt.getTime() - 30 * 60_000) } },
                ],
              },
            ],
          },
        });
        if (conflict) throw new Error('Conflicto de horario detectado');
      }

      const appt = await tx.appointment.create({
        data: {
          storeId,
          customerId,
          serviceId:        extracted.serviceId        ?? null,
          serviceVariantId: extracted.serviceVariantId ?? null,
          type:             extracted.type             ?? 'cita',
          status:           'PENDING',
          priority:         'NORMAL',
          source:           'AI',
          scheduledAt,
          endsAt,
          durationMinutes,
          description:  descriptionOverride !== undefined ? descriptionOverride : (extracted.description ?? null),
          address:      extracted.address     ?? null,
          notes:        extracted.notes       ?? null,
          agreedPrice:  extracted.agreedPrice ?? null,
          staffId:      resolvedStaffId,
        },
      });
      await tx.appointmentTimeline.create({
        data: {
          appointmentId: appt.appointmentId,
          action:        'CREATED',
          newStatus:     'PENDING',
          note:          'Cita creada automáticamente por el asistente de WhatsApp',
          isPublic:      true,
          performedById: null,
        },
      });
      return appt;
    });
  }
```

- [ ] **Step 2: Reemplazar el bloque inline del path single por el helper**

En el path single, localizar el bloque que empieza con `appointment = await this.prisma.$transaction(async (tx) => {` (~línea 2760) y termina con `return appt;\n        });` (~línea 2813). Reemplazar TODO ese bloque por:
```ts
        appointment = await this.insertAiAppointment(
          storeId,
          customer.customerId,
          resolvedStaffId,
          scheduledAt,
          endsAt,
          durationMinutes,
          extracted,
        );
```
No cambiar nada antes (`else {` con la auto-asignación y el `preConflict`) ni después (`}` de cierre del else, línea 2814).

- [ ] **Step 3: Compilar**

Run: `cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm" && npx tsc --noEmit`
Expected: sin salida.

- [ ] **Step 4: Commit**
```bash
cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm"
git add src/ai/ai.service.ts
git commit -m "refactor(ia): extraer insertAiAppointment del path single (reutilizable por grupo)"
```

---

## Task 3: Helper `findConsecutiveBlock`

**Files:**
- Modify: `src/ai/ai.service.ts` (agregar método privado junto a `insertAiAppointment`)

- [ ] **Step 1: Agregar el método privado `findConsecutiveBlock`**

Justo después del método `insertAiAppointment` (de Task 2), agregar:
```ts
  // Dada la lista de slots libres de 30 min ("HH:MM") de un profesional ese día,
  // devuelve la hora "HH:MM" del primer bloque donde caben `n` citas de `durationMin`
  // consecutivas, buscando primero desde `fromMin` y, si no hay, en todo el día.
  // Devuelve null si no existe ningún bloque consecutivo de ese tamaño.
  private findConsecutiveBlock(
    freeSlots: string[],
    fromMin: number,
    n: number,
    durationMin: number,
  ): string | null {
    const SLOT = 30;
    const slotsPerPerson = Math.max(1, Math.ceil(durationMin / SLOT));
    const need = slotsPerPerson * n; // # de slots de 30 min requeridos en total
    const freeSet = new Set(
      freeSlots.map(t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; }),
    );
    const fits = (start: number): boolean => {
      for (let i = 0; i < need; i++) {
        if (!freeSet.has(start + i * SLOT)) return false;
      }
      return true;
    };
    const toLabel = (min: number) =>
      `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

    // 1) primero desde la hora pedida en adelante
    const fromHere = [...freeSet].filter(min => min >= fromMin).sort((a, b) => a - b);
    for (const start of fromHere) if (fits(start)) return toLabel(start);

    // 2) si no hay, la ventana consecutiva más cercana del día (cualquier hora)
    const all = [...freeSet].sort((a, b) => a - b);
    for (const start of all) if (fits(start)) return toLabel(start);

    return null;
  }
```

- [ ] **Step 2: Compilar**

Run: `cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm" && npx tsc --noEmit`
Expected: sin salida.

- [ ] **Step 3: Commit**
```bash
cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm"
git add src/ai/ai.service.ts
git commit -m "feat(ia): findConsecutiveBlock (ventana de N slots consecutivos libres)"
```

---

## Task 4: Rama de grupo en el flujo de creación de cita

**Files:**
- Modify: `src/ai/ai.service.ts` (insertar la rama justo después de calcular `endsAt`, ~línea 2604, antes del comentario `// Reagendar solo si...` ~línea 2606)

**Contexto:** En este punto del flujo ya están en scope: `extracted` (con `partySize`, `staffId`, `serviceId`, `scheduledTime`, `scheduledDate`, `agreedPrice`...), `scheduledAt` (Date), `durationMinutes`, `endsAt`, `activeStaff`, `store`, `storeId`, `customer`, `services`, `staffLabel`, `conversationId`. La función retorna objetos `{ created: boolean, message: string }`. El registro de citas creadas usa `this.conversationCreatedAppts`. Las notificaciones: `this.notifications.notifyAppointmentCreated(appt).catch(()=>{})`.

- [ ] **Step 1: Insertar la rama de grupo**

Localizar (~línea 2603-2605):
```ts
      const durationMinutes = extracted.durationMinutes ?? null;
      const endsAt          = durationMinutes ? new Date(scheduledAt.getTime() + durationMinutes * 60_000) : null;

      // Reagendar solo si NO se ha creado ninguna cita en esta conversación aún.
```
Insertar entre la línea de `endsAt` y el comentario `// Reagendar solo si...`:
```ts

      // ─── Rama de GRUPO (acompañantes): N citas back-to-back, mismo barbero/servicio ───
      const partySize = Math.trunc(extracted.partySize ?? 1);
      if (partySize > 1) {
        const N = partySize;
        const GROUP_CAP = 4;

        // Cap: grupos grandes → no auto-agendar, derivar a asesor
        if (N > GROUP_CAP) {
          this.cancelConfirmReminder(conversationId);
          this.pendingAppointments.delete(conversationId);
          return {
            created: false,
            message: `Para grupos de más de ${GROUP_CAP} personas prefiero que un asesor te coordine directamente para no dejarte mal con los horarios. Te contacta en breve. 🙌`,
          };
        }

        // Requiere barbero elegido si hay equipo (las N van con el mismo)
        if (activeStaff.length > 0 && !extracted.staffId) {
          this.cancelConfirmReminder(conversationId);
          return {
            created: false,
            message: `Para agendar a las ${N} personas necesito que elijas con qué ${staffLabel} las atendemos (van todas con el mismo): ${activeStaff.map(s => s.name).join(', ')}.`,
          };
        }

        const groupStaffId = extracted.staffId ?? activeStaff[0]?.staffId ?? null;
        const staffInfoG   = activeStaff.find(s => s.staffId === groupStaffId);
        const svcG         = services.find((s: any) => s.serviceId === extracted.serviceId);
        const D            = durationMinutes ?? svcG?.estimatedMinutes ?? 30;

        const to12 = (min: number): string => {
          const h = Math.floor(min / 60), m = min % 60;
          const period = h < 12 ? 'a. m.' : 'p. m.';
          const h12 = h % 12 === 0 ? 12 : h % 12;
          return `${h12}:${String(m).padStart(2, '0')} ${period}`;
        };

        // Slots libres del barbero ese día (solo lectura)
        let libresG: string[] = [];
        try {
          const slotsData = await this.computeSlotsForAI(storeId, scheduledAt, activeStaff as any, store as any);
          libresG = slotsData.find(s => s.name === staffInfoG?.name)?.slots ?? [];
        } catch (e: any) {
          this.logger.warn(`[Cita][Grupo] No se pudo computar slots: ${e?.message}`);
        }

        const [bh, bm] = extracted.scheduledTime!.split(':').map(Number);
        const baseMin  = bh * 60 + bm;
        const blockStart = this.findConsecutiveBlock(libresG, baseMin, N, D);

        if (!blockStart) {
          this.cancelConfirmReminder(conversationId);
          this.pendingAppointments.delete(conversationId);
          return {
            created: false,
            message: `Uy, no tengo ${N} turnos seguidos con ${staffInfoG?.name ?? 'ese profesional'} ese día. ¿Quieres mirar otro día u otro ${staffLabel}?`,
          };
        }

        const blockMin = (() => { const [h, m] = blockStart.split(':').map(Number); return h * 60 + m; })();

        // Si el bloque libre no arranca en la hora pedida, ofrecerlo y esperar confirmación
        if (blockMin !== baseMin) {
          this.cancelConfirmReminder(conversationId);
          return {
            created: false,
            message: `A las ${to12(baseMin)} no me caben los ${N} seguidos con ${staffInfoG?.name}. ¿Te sirve arrancando ${to12(blockMin)}? Los dejo back-to-back. 💈`,
          };
        }

        // Crear N citas back-to-back desde la hora pedida
        const createdGroup: any[] = [];
        for (let k = 0; k < N; k++) {
          const at   = new Date(scheduledAt.getTime() + k * D * 60_000);
          const ends = new Date(at.getTime() + D * 60_000);
          try {
            const appt = await this.insertAiAppointment(
              storeId, customer.customerId, groupStaffId, at, ends, D, extracted, `Persona ${k + 1} de ${N}`,
            );
            createdGroup.push({ appt, at });
            this.notifications.notifyAppointmentCreated(appt as any).catch(() => {});
          } catch (e: any) {
            this.logger.warn(`[Cita][Grupo] Falló la cita ${k + 1}/${N}: ${e?.message}`);
            break; // no revertir las ya creadas (mismo criterio que citas múltiples actuales)
          }
        }

        this.cancelConfirmReminder(conversationId);
        this.pendingAppointments.delete(conversationId);

        if (createdGroup.length === 0) {
          return {
            created: false,
            message: `Uy, no pude dejar los turnos (alguien tomó ese horario). ¿Probamos otra hora?`,
          };
        }

        // Registrar para que el extractor no re-extraiga el grupo
        const reg = this.conversationCreatedAppts.get(conversationId) ?? [];
        for (const g of createdGroup) {
          reg.push({
            scheduledDate: extracted.scheduledDate!,
            scheduledTime: `${String(g.at.getHours()).padStart(2, '0')}:${String(g.at.getMinutes()).padStart(2, '0')}`,
            type: extracted.type ?? 'cita',
          });
        }
        this.conversationCreatedAppts.set(conversationId, reg);
        setTimeout(() => this.conversationCreatedAppts.delete(conversationId), ORDER_GUARD_TTL_MS);

        await this.prisma.conversation.update({ where: { conversationId }, data: { status: 'pending_human' } });

        const horas = createdGroup
          .map(g => g.at.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' }))
          .join(', ');
        const fechaG = scheduledAt.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Bogota' });
        const profLine = staffInfoG?.name ? ` con ${staffInfoG.name}` : '';
        const faltaron = createdGroup.length < N
          ? `\n\n(Solo pude dejar ${createdGroup.length} de ${N}; para el resto te contacta un asesor.)`
          : '';

        this.logger.log(`✅ [Cita][Grupo] ${createdGroup.length}/${N} citas — ${extracted.scheduledDate} desde ${extracted.scheduledTime}`);
        return {
          created: true,
          message: `¡Listo! ✅ Dejé ${createdGroup.length} turno${createdGroup.length > 1 ? 's' : ''}${profLine} el ${fechaG}: ${horas}.${faltaron}\n\nUn asesor confirma pronto. ¡Gracias! 😊`,
        };
      }
```

- [ ] **Step 2: Compilar**

Run: `cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm" && npx tsc --noEmit`
Expected: sin salida.

- [ ] **Step 3: Commit**
```bash
cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm"
git add src/ai/ai.service.ts
git commit -m "feat(ia): rama de grupo — N citas back-to-back con acompañantes (mismo asesor/servicio)"
```

---

## Task 5: Guía conversacional para confirmación de grupo en el prompt

**Files:**
- Modify: `src/ai/ai.service.ts` (`agendamientoSection`, dentro de `buildSystemPrompt` ~línea 3078-3107)

- [ ] **Step 1: Agregar una regla de grupo al flujo de agendamiento**

En `agendamientoSection`, localizar el bloque (~línea 3094-3096):
```ts
Cuando tengas todo, muestra el resumen y pide confirmación:
"¿Confirmamos tu cita de [servicio] con [profesional] para el [fecha] a las [hora]?"
```
Reemplazarlo por:
```ts
Cuando tengas todo, muestra el resumen y pide confirmación:
"¿Confirmamos tu cita de [servicio] con [profesional] para el [fecha] a las [hora]?"

ACOMPAÑANTES (GRUPO): si el cliente viene con acompañantes ("venimos 3", "yo y mi hijo", "somos 2"), se agendan citas separadas consecutivas (back-to-back) con el MISMO profesional y el MISMO servicio. Pide UNA sola confirmación listando los horarios, ej: "Para confirmar: 3 cortes con [profesional] arrancando a las 3:00 p. m. (3:00, 3:30 y 4:00 p. m.). ¿Todo bien?". NO confirmes una por una. El sistema calcula los horarios reales y crea las citas; tú solo confirmas una vez.
```

- [ ] **Step 2: Compilar**

Run: `cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm" && npx tsc --noEmit`
Expected: sin salida.

- [ ] **Step 3: Commit**
```bash
cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm"
git add src/ai/ai.service.ts
git commit -m "feat(ia): prompt confirma grupos de acompañantes en un solo mensaje"
```

---

## Task 6: Build, deploy y verificación manual

**Files:** ninguno.

- [ ] **Step 1: Build backend**

Run: `cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm" && npm run build`
Expected: build NestJS sin errores.

- [ ] **Step 2: FRENAR para revisión del usuario antes de pushear.** Mostrar al usuario un resumen de los cambios y pedir luz verde (igual que en Spec 1 y 2).

- [ ] **Step 3: Push (tras luz verde)**
```bash
cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm" && git push origin main
```

- [ ] **Step 4: Verificar deploy backend**

Run: `curl -s -m 15 https://whatsapp-crm.ash-1.instapods.app/health`
Expected: `{"status":"ok",...}`.

- [ ] **Step 5: Verificación manual (escenarios del spec)**
1. "venimos 2 a corte hoy 3pm con Oswar" con 3:00 y 3:30 libres → crea 2 citas (3:00, 3:30), UN solo mensaje de éxito listando ambas.
2. Mismo caso pero 3:30 ocupado → ofrece arrancar en la ventana consecutiva más cercana (ej. 4:00 y 4:30); al decir "sí" crea las 2.
3. "somos 3" sin barbero elegido (con equipo) → pregunta con qué barbero; al elegir, agenda 3 consecutivas.
4. "venimos 6" → responde "grupos de más de 4… te contacta un asesor", NO agenda.
5. Sin acompañantes ("quiero corte mañana 10am") → 1 cita normal (no regresión del path single).
6. Las N citas suman en analytics e ingreso y aparecen en el rendimiento del barbero.

---

## Self-review (cobertura del spec)
- Modelo N citas separadas back-to-back, reutiliza el mecanismo de creación AI vía `insertAiAppointment` → Task 2 + Task 4. ✅
- Mismo servicio para todas (duración D del servicio) → Task 4 (usa `extracted.serviceId` y `D`). ✅
- Todas bajo el mismo `customerId`, `description` "Persona k de N" → Task 4 (`insertAiAppointment(..., customer.customerId, ..., 'Persona k de N')`). ✅
- Conflicto de grupo: ventana consecutiva más cercana; si no hay, otro día/barbero → Task 3 (`findConsecutiveBlock`) + Task 4 (mensajes). ✅
- Cap 4 → Task 4 (`GROUP_CAP`). ✅
- Sin barbero + equipo → preguntar barbero → Task 4. ✅
- Extracción de `partySize` (LLM + fallback TS, clamp ≥1) → Task 1. ✅
- Una sola confirmación / un solo éxito → Task 4 (mensaje combinado) + Task 5 (prompt). ✅
- No tocar conflicto/slots/anti-doble-booking; no columnas de schema → `insertAiAppointment` conserva el guard tal cual; `computeSlotsForAI` solo lectura; sin cambios de Prisma schema. ✅
- No regresión del path single → Task 2 Step 2 (mismo comportamiento) + escenario manual 5. ✅
