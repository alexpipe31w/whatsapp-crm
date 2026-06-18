# Citas: llegar tarde + walk-ins — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar al admin (a) una acción rápida para correr la cita de un cliente que llegó tarde, y (b) un "Atender ahora" que registra un walk-in como cita atendida + venta en un solo paso.

**Architecture:** Reutiliza `AppointmentsService.create()` (candado anti-doble-booking) y `update()` (auto-orden al marcar PAID). "Llegar tarde" es frontend puro sobre `updateAppointment`. Walk-in añade un opt-out de conflicto acotado en `create()` y un método/endpoint `createWalkIn` que encadena create()+update() server-side; el frontend agrega un modal.

**Tech Stack:** NestJS 11 + Prisma 6 (backend), React 19 + TS (CRA) + Tailwind (frontend).

**Spec:** `docs/superpowers/specs/2026-06-18-citas-tarde-walkins-design.md`

**Sin tests automatizados:** verificación por `tsc --noEmit` / `nest build` (backend) y `tsc --noEmit` + `eslint` (frontend) + escenarios manuales. NO escribir tests ni introducir un framework.

**Repos:**
- Backend: `C:\Users\alexp\Desktop\proyectos\whatsapp-crm`
- Frontend: `C:\Users\alexp\Desktop\proyectos\stockup-frontend`

**Restricción dura:** NO modificar la lógica de detección de conflicto/slots. El único cambio permitido es envolver el bloque de conflicto existente de `create()` en un `if (!dto.skipConflictCheck)` (opt-out explícito) y la maquinaria de auto-orden se reutiliza tal cual vía `update()`. Trabajar en `main`, NO pushear hasta la tarea de deploy.

**Nota de líneas:** anclas al estado actual; localiza por el texto citado.

---

## Task 1: Backend — opt-out de conflicto en `create()` para walk-ins

**Files:**
- Modify: `src/appointments/dto/create-appointment.dto.ts`
- Modify: `src/appointments/appointments.service.ts` (`create`, bloque de conflicto ~línea 200)

- [ ] **Step 1: Agregar `skipConflictCheck` al DTO**

En `src/appointments/dto/create-appointment.dto.ts`, después del campo `forceSchedule` (al final de la clase), agregar:
```ts
  // Permite omitir la verificación de conflicto (solo para walk-ins: el admin
  // atiende al cliente conscientemente en el momento aunque el slot esté ocupado).
  @IsBoolean() @IsOptional() @Type(() => Boolean)
  skipConflictCheck?: boolean;
```
(`IsBoolean`, `IsOptional`, `Type` ya están importados.)

- [ ] **Step 2: Gatear el bloque de conflicto en `create()`**

En `src/appointments/appointments.service.ts`, dentro de `create()`, el bloque de conflicto empieza con `if (dto.staffId) {` (~línea 200). Cambiar SOLO esa condición de apertura a:
```ts
      if (dto.staffId && !dto.skipConflictCheck) {
```
No tocar nada más dentro del bloque (la detección de conflicto queda idéntica).

- [ ] **Step 3: Compilar**

Run: `cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm" && npx tsc --noEmit`
Expected: sin salida.

- [ ] **Step 4: Commit**
```bash
cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm"
git add src/appointments/dto/create-appointment.dto.ts src/appointments/appointments.service.ts
git commit -m "feat(appointments): skipConflictCheck en create() (opt-out de conflicto para walk-ins)"
```

---

## Task 2: Backend — método y endpoint `createWalkIn`

**Files:**
- Create: `src/appointments/dto/create-walk-in.dto.ts`
- Modify: `src/appointments/appointments.service.ts` (agregar método `createWalkIn`)
- Modify: `src/appointments/appointments.controller.ts` (agregar `POST /appointments/walk-in`)

- [ ] **Step 1: Crear el DTO**

Crear `src/appointments/dto/create-walk-in.dto.ts`:
```ts
import { IsUUID, IsOptional, IsInt, IsNumber, IsPositive, IsString, Min, Max, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateWalkInDto {
  @IsUUID()
  customerId: string;

  @IsUUID()
  @IsOptional()
  serviceId?: string;

  @IsUUID()
  @IsOptional()
  staffId?: string;

  @IsInt() @IsOptional() @Min(5) @Max(1440) @Type(() => Number)
  durationMinutes?: number;

  @IsNumber() @IsPositive() @Type(() => Number)
  price: number;

  @IsString() @MaxLength(50)
  paymentMethod: string;
}
```

- [ ] **Step 2: Agregar el método `createWalkIn` al service**

En `src/appointments/appointments.service.ts`, justo después del método `create()` (tras su `}` de cierre, ~línea 263), agregar:
```ts
  // ─── Walk-in: cliente atendido sin cita previa ───────────────────────────────
  // Crea una cita a la hora actual y la marca COMPLETED + PAID en un paso. Reutiliza
  // create() (forzando horario y omitiendo conflicto: el admin lo atiende ahora) y
  // update() (que ya dispara la auto-orden de servicio idempotente al pasar a PAID).
  async createWalkIn(storeId: string, dto: CreateWalkInDto, performedById?: string) {
    const created = await this.create(
      storeId,
      {
        customerId:        dto.customerId,
        serviceId:         dto.serviceId,
        staffId:           dto.staffId,
        scheduledAt:       new Date().toISOString(),
        durationMinutes:   dto.durationMinutes,
        agreedPrice:       dto.price,
        source:            AppointmentSource.MANUAL,
        forceSchedule:     true,
        skipConflictCheck: true,
      } as CreateAppointmentDto,
      performedById,
    );

    const { appointment } = await this.update(
      created.appointmentId,
      storeId,
      {
        status:        AppointmentStatus.COMPLETED,
        paymentStatus: 'PAID',
        paymentMethod: dto.paymentMethod,
        paymentAmount: dto.price,
      } as UpdateAppointmentDto,
      performedById,
    );

    return appointment;
  }
```
Verifica que en la cabecera del archivo ya estén importados `CreateAppointmentDto`, `UpdateAppointmentDto`, `AppointmentSource`, `AppointmentStatus` (lo están — se usan en `create`/`update`). Agrega el import de `CreateWalkInDto`:
```ts
import { CreateWalkInDto } from './dto/create-walk-in.dto';
```

- [ ] **Step 3: Agregar el endpoint al controller**

En `src/appointments/appointments.controller.ts`, mira cómo el endpoint `@Post()` `create` obtiene `storeId` y el id del usuario (del JWT) y replica EXACTAMENTE ese patrón (mismos guards/decorators). Agrega, junto a los demás endpoints:
```ts
  @Post('walk-in')
  async createWalkIn(
    // usa los MISMOS decorators que el @Post() create de este archivo para storeId y userId
    // (ej. @CurrentUser()/@Req()), respetando su forma exacta:
    /* storeId del JWT */ storeId: string,
    /* body */ dto: CreateWalkInDto,
    /* userId del JWT (performedById) */ userId?: string,
  ) {
    return this.appointmentsService.createWalkIn(storeId, dto, userId);
  }
```
IMPORTANTE: copia la firma de parámetros/decorators del `create` existente (no inventes decorators). Importa `CreateWalkInDto`. El `:id` del `@Patch(':id')` no debe capturar `walk-in` porque `@Post('walk-in')` es POST y aquél es PATCH — pero igual coloca `@Post('walk-in')` ANTES de cualquier `@Post(':id')` si existiera (no hay, el create es `@Post()`).

- [ ] **Step 4: Compilar**

Run: `cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm" && npx tsc --noEmit`
Expected: sin salida.

- [ ] **Step 5: Commit**
```bash
cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm"
git add src/appointments/dto/create-walk-in.dto.ts src/appointments/appointments.service.ts src/appointments/appointments.controller.ts
git commit -m "feat(appointments): endpoint walk-in (cita COMPLETED + venta vía auto-orden PAID)"
```

---

## Task 3: Frontend — función API `createWalkIn`

**Files:**
- Modify: `src/services/api.ts`

- [ ] **Step 1: Localizar `createAppointment` en `api.ts`**

Lee `src/services/api.ts` y encuentra `createAppointment` y `updateAppointment` para copiar su estilo (cliente axios `api`, rutas, tipos de retorno).

- [ ] **Step 2: Agregar `createWalkIn`**

Junto a `createAppointment`, agregar (ajusta la forma exacta — `api.post` vs export const — al patrón del archivo):
```ts
export const createWalkIn = (data: {
  customerId: string;
  serviceId?: string;
  staffId?: string;
  durationMinutes?: number;
  price: number;
  paymentMethod: string;
}) => api.post('/appointments/walk-in', data);
```

- [ ] **Step 3: Verificar tipos**

Run: `cd "C:/Users/alexp/Desktop/proyectos/stockup-frontend" && npx tsc --noEmit`
Expected: sin salida.

- [ ] **Step 4: Commit**
```bash
cd "C:/Users/alexp/Desktop/proyectos/stockup-frontend"
git add src/services/api.ts
git commit -m "feat(api): createWalkIn"
```

---

## Task 4: Frontend — acción "Mover" (cliente que llegó tarde)

**Files:**
- Modify: `src/pages/Appointments.tsx` (panel de detalle, tab "Detalle", bajo el bloque "Fecha y hora" ~línea 374; usa el `onUpdate(appt.appointmentId, payload)` ya existente)

- [ ] **Step 1: Agregar un helper de redondeo a 5 min y los botones "Mover"**

En el componente del panel de detalle (donde está `doStatus`/`handleEditSave`, que reciben `appt` y `onUpdate`), añadir un handler:
```tsx
  const moveTo = async (when: Date) => {
    setSaving(true);
    try {
      await onUpdate(appt.appointmentId, { scheduledAt: when.toISOString() });
    } catch (err: any) {
      // el backend rechaza si choca con otra cita del profesional
      alert(err?.response?.data?.message || 'No se pudo mover la cita (¿choca con otra?).');
    } finally {
      setSaving(false);
    }
  };
  const nowRounded5 = () => {
    const d = new Date();
    d.setSeconds(0, 0);
    d.setMinutes(Math.round(d.getMinutes() / 5) * 5);
    return d;
  };
  const plusMin = (m: number) => new Date(new Date(appt.scheduledAt).getTime() + m * 60_000);
```
(`setSaving` ya existe en ese componente.)

- [ ] **Step 2: Renderizar los botones solo para citas activas**

En el tab "Detalle", justo después del bloque `{/* datetime */}` (la card de "Fecha y hora", ~línea 374-380), agregar:
```tsx
            {['PENDING', 'CONFIRMED', 'IN_PROGRESS'].includes(appt.status) && (
              <div className="space-y-1.5">
                <p className="text-xs text-txt-tertiary flex items-center gap-1">Mover cita (llegó tarde)</p>
                <div className="flex gap-1.5">
                  <button onClick={() => moveTo(nowRounded5())} disabled={saving}
                    className="flex-1 px-2 py-1.5 text-xs font-medium rounded-lg bg-surface-elevated text-txt-primary border border-border-default hover:border-lime/50 disabled:opacity-50 transition">
                    A ahora
                  </button>
                  <button onClick={() => moveTo(plusMin(15))} disabled={saving}
                    className="flex-1 px-2 py-1.5 text-xs font-medium rounded-lg bg-surface-elevated text-txt-primary border border-border-default hover:border-lime/50 disabled:opacity-50 transition">
                    +15 min
                  </button>
                  <button onClick={() => moveTo(plusMin(30))} disabled={saving}
                    className="flex-1 px-2 py-1.5 text-xs font-medium rounded-lg bg-surface-elevated text-txt-primary border border-border-default hover:border-lime/50 disabled:opacity-50 transition">
                    +30 min
                  </button>
                </div>
              </div>
            )}
```

- [ ] **Step 3: Verificar tipos + lint**

Run: `cd "C:/Users/alexp/Desktop/proyectos/stockup-frontend" && npx tsc --noEmit && npx eslint src/pages/Appointments.tsx`
Expected: ambos sin salida.

- [ ] **Step 4: Commit**
```bash
cd "C:/Users/alexp/Desktop/proyectos/stockup-frontend"
git add src/pages/Appointments.tsx
git commit -m "feat(citas): acción Mover (A ahora / +15 / +30) para clientes que llegan tarde"
```

---

## Task 5: Frontend — botón + modal "Atender ahora" (walk-in)

**Files:**
- Modify: `src/pages/Appointments.tsx` (importar `createWalkIn` y `getStaff`; agregar un `WalkInModal` y un botón en el header de la página)

- [ ] **Step 1: Imports**

En `src/pages/Appointments.tsx`, agregar a los imports de `../services/api`: `createWalkIn` (y `getStaff` si no está ya importado). Asegúrate de que `createCustomer`, `getCustomers`, `getServices` ya están (lo están).

- [ ] **Step 2: Crear el componente `WalkInModal`**

Modelado sobre el modal "Nueva cita manual" existente en este archivo (toggle cliente existente/nuevo, selector de servicio con autoprecio, clase de input `ic`, modal `z-[60]`). Agregar este componente cerca del modal manual:
```tsx
function WalkInModal({ storeId, onClose, onDone }: { storeId: string; onClose: () => void; onDone: () => void }) {
  const [customers, setCustomers] = useState<any[]>([]);
  const [services, setServices]   = useState<any[]>([]);
  const [staff, setStaff]         = useState<any[]>([]);
  const [loadingOpts, setLoadingOpts] = useState(true);
  const [customerMode, setCustomerMode] = useState<'existing' | 'new'>('existing');
  const [newCustomer, setNewCustomer] = useState({ phone: '', name: '' });
  const [form, setForm] = useState({ customerId: '', serviceId: '', staffId: '', price: '', durationMinutes: '', paymentMethod: 'efectivo' });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  useEffect(() => {
    Promise.all([getCustomers(storeId), getServices(), getStaff()])
      .then(([cr, sr, st]) => { setCustomers(cr.data); setServices(sr.data); setStaff(st.data); })
      .catch(() => {})
      .finally(() => setLoadingOpts(false));
  }, [storeId]);

  const onService = (serviceId: string) => {
    const svc = services.find((s: any) => s.serviceId === serviceId);
    setForm(f => ({
      ...f,
      serviceId,
      price:           svc?.basePrice != null ? String(svc.basePrice) : f.price,
      durationMinutes: svc?.estimatedMinutes != null ? String(svc.estimatedMinutes) : f.durationMinutes,
    }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (customerMode === 'new' && !newCustomer.phone.trim()) { setError('El teléfono del cliente es obligatorio.'); return; }
    if (customerMode === 'existing' && !form.customerId)     { setError('Selecciona un cliente.'); return; }
    if (!form.price || Number(form.price) <= 0)              { setError('El precio es obligatorio.'); return; }
    setSaving(true); setError('');
    try {
      let customerId = form.customerId;
      if (customerMode === 'new') {
        const res = await createCustomer({ phone: newCustomer.phone.trim(), name: newCustomer.name.trim() || undefined });
        customerId = res.data.customerId;
      }
      await createWalkIn({
        customerId,
        serviceId:       form.serviceId || undefined,
        staffId:         form.staffId   || undefined,
        durationMinutes: form.durationMinutes ? Number(form.durationMinutes) : undefined,
        price:           Number(form.price),
        paymentMethod:   form.paymentMethod,
      });
      onDone();
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Error al registrar el walk-in.');
    } finally {
      setSaving(false);
    }
  };

  const ic = 'w-full px-3 py-2 rounded-xl border border-border-default bg-surface-elevated text-sm focus:outline-none focus:ring-2 focus:ring-lime/30 text-txt-primary';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4">
      <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle sticky top-0 bg-surface z-10">
          <h2 className="text-base font-bold text-txt-primary">Atender ahora (walk-in)</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg text-txt-tertiary hover:bg-surface-overlay">✕</button>
        </div>
        {loadingOpts ? (
          <div className="py-16 text-center text-txt-tertiary text-sm">Cargando...</div>
        ) : (
          <form onSubmit={submit} className="p-6 space-y-4">
            <div className="flex gap-2">
              <button type="button" onClick={() => setCustomerMode('existing')}
                className={`flex-1 py-2 rounded-xl text-sm font-medium border transition ${customerMode === 'existing' ? 'border-lime bg-lime/10 text-txt-primary' : 'border-border-default text-txt-secondary'}`}>Cliente existente</button>
              <button type="button" onClick={() => setCustomerMode('new')}
                className={`flex-1 py-2 rounded-xl text-sm font-medium border transition ${customerMode === 'new' ? 'border-lime bg-lime/10 text-txt-primary' : 'border-border-default text-txt-secondary'}`}>Cliente nuevo</button>
            </div>

            {customerMode === 'existing' ? (
              <select className={ic} value={form.customerId} onChange={e => setForm(f => ({ ...f, customerId: e.target.value }))}>
                <option value="">Selecciona un cliente</option>
                {customers.map((c: any) => <option key={c.customerId} value={c.customerId}>{c.name ?? c.phone}</option>)}
              </select>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <input className={ic} placeholder="Teléfono *" value={newCustomer.phone} onChange={e => setNewCustomer(n => ({ ...n, phone: e.target.value }))} />
                <input className={ic} placeholder="Nombre (opcional)" value={newCustomer.name} onChange={e => setNewCustomer(n => ({ ...n, name: e.target.value }))} />
              </div>
            )}

            <select className={ic} value={form.staffId} onChange={e => setForm(f => ({ ...f, staffId: e.target.value }))}>
              <option value="">Sin asignar profesional</option>
              {staff.map((s: any) => <option key={s.staffId} value={s.staffId}>{s.name}</option>)}
            </select>

            <select className={ic} value={form.serviceId} onChange={e => onService(e.target.value)}>
              <option value="">Servicio (opcional)</option>
              {services.map((s: any) => <option key={s.serviceId} value={s.serviceId}>{s.name}</option>)}
            </select>

            <div className="grid grid-cols-2 gap-2">
              <input className={ic} type="number" placeholder="Precio *" value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} />
              <select className={ic} value={form.paymentMethod} onChange={e => setForm(f => ({ ...f, paymentMethod: e.target.value }))}>
                <option value="efectivo">Efectivo</option>
                <option value="transferencia">Transferencia</option>
                <option value="tarjeta">Tarjeta</option>
                <option value="nequi">Nequi</option>
              </select>
            </div>

            {error && <p className="text-sm text-red-500">{error}</p>}

            <button type="submit" disabled={saving}
              className="w-full py-2.5 rounded-xl text-sm font-semibold text-[#0A0A0F] disabled:opacity-50 transition"
              style={{ background: 'linear-gradient(135deg, #D4FF00, #A3CC00)' }}>
              {saving ? 'Registrando...' : 'Registrar atención'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
```
IMPORTANTE: si `getStaff()` requiere `storeId` como argumento en este proyecto, pásalo (`getStaff(storeId)`); confírmalo al leer su firma en `api.ts`. Si los métodos de pago del proyecto están centralizados en alguna constante, reutilízala en vez de hardcodear las 4 opciones.

- [ ] **Step 3: Botón en el header de la página + estado del modal**

En el componente principal `Appointments` (la página), agregar estado `const [showWalkIn, setShowWalkIn] = useState(false);`. En el header de la página (donde está el botón "Nueva cita manual"), agregar un botón "Atender ahora":
```tsx
<button onClick={() => setShowWalkIn(true)}
  className="px-3 py-2 rounded-xl text-sm font-medium bg-surface-elevated text-txt-primary border border-border-default hover:border-lime/50 transition">
  Atender ahora
</button>
```
Y renderizar el modal cerca del modal manual existente:
```tsx
{showWalkIn && (
  <WalkInModal
    storeId={storeId}
    onClose={() => setShowWalkIn(false)}
    onDone={() => { setShowWalkIn(false); load(); }}
  />
)}
```
Usa el nombre real de la función que recarga las citas en esta página (en el modal manual se llama vía la prop `onCreated`; localiza el `load()`/refetch real y úsalo).

- [ ] **Step 4: Verificar tipos + lint (CI rompe con warnings)**

Run: `cd "C:/Users/alexp/Desktop/proyectos/stockup-frontend" && npx tsc --noEmit && npx eslint src/pages/Appointments.tsx`
Expected: ambos sin salida. Sin imports/vars sin usar.

- [ ] **Step 5: Commit**
```bash
cd "C:/Users/alexp/Desktop/proyectos/stockup-frontend"
git add src/pages/Appointments.tsx
git commit -m "feat(citas): walk-in 'Atender ahora' (cita atendida + venta en un paso)"
```

---

## Task 6: Build, deploy y verificación manual

**Files:** ninguno.

- [ ] **Step 1: Build backend**

Run: `cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm" && npm run build`
Expected: build NestJS sin errores.

- [ ] **Step 2: Build/lint frontend**

Run: `cd "C:/Users/alexp/Desktop/proyectos/stockup-frontend" && npx tsc --noEmit && npx eslint src/pages/Appointments.tsx src/services/api.ts`
Expected: sin salida.

- [ ] **Step 3: FRENAR para revisión del usuario antes de pushear.** Mostrar al usuario un resumen de los cambios y pedir luz verde (igual que en el Spec 1).

- [ ] **Step 4: Push (tras luz verde)**
```bash
cd "C:/Users/alexp/Desktop/proyectos/whatsapp-crm" && git push origin main
cd "C:/Users/alexp/Desktop/proyectos/stockup-frontend" && git push origin main
```

- [ ] **Step 5: Verificar deploy backend**

Run: `curl -s -m 15 https://whatsapp-crm.ash-1.instapods.app/health`
Expected: `{"status":"ok",...}`.

- [ ] **Step 6: Verificación manual (escenarios del spec)**
1. Cita activa a las 2pm → "A ahora" (2:30) → queda a las 2:30 en lista/calendario + timeline.
2. "+30" cuando el asesor tiene otra cita 30 min después → backend rechaza, alerta de conflicto, la cita original no cambia.
3. "Mover" no aparece en citas COMPLETED/CANCELLED.
4. Walk-in con cliente nuevo → crea cita COMPLETED a la hora actual + venta; aparece en agenda, en rendimiento por profesional, e ingreso suma en analytics.
5. Walk-in con asesor que ya tiene cita encimada → se crea igual (bypass de conflicto).
6. Doble submit del walk-in → no duplica la venta (idempotencia por `appointmentId`).

---

## Self-review (cobertura del spec)
- A. Llegar tarde ("Mover" A ahora/+15/+30, reusa update(), rechaza en conflicto, solo activas) → Task 4. ✅
- B. Walk-in (cita COMPLETED + venta vía auto-orden PAID, bypass conflicto) → Task 1 (opt-out), Task 2 (endpoint), Task 3 (api), Task 5 (UI). ✅
- Restricción dura (no tocar anti-doble-booking; solo `if (!skipConflictCheck)`) → Task 1 Step 2. ✅
- Idempotencia de la venta → reutiliza `update()` PAID (existingOrder check). ✅
- Multi-tenant (storeId del JWT) → Task 2 Step 3 copia el patrón del create existente. ✅
