# Public Calendar & AI Availability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Public shareable link showing real available slots per staff member; AI responds with real availability when clients ask.

**Architecture:** New `PublicModule` (no auth) computes slots from staff schedules minus booked appointments. Frontend public page `/cal/:slug` requires no login. AI detects availability queries and injects real slot data into the system prompt.

**Tech Stack:** NestJS 11, Prisma 6, React 19, Tailwind. `prisma db push` only — no migrate.

---

## Files map

### Backend — create
- `src/public/public.controller.ts`
- `src/public/public.service.ts`
- `src/public/public.module.ts`

### Backend — modify
- `prisma/schema.prisma` — add `Store.slug`
- `src/stores/dto/create-store.dto.ts` — add `slug` field
- `src/app.module.ts` — register `PublicModule`

### Frontend — create
- `src/pages/PublicCalendar.tsx`

### Frontend — modify
- `src/App.tsx` — add `/cal/:slug` route (public, no auth wrapper)
- `src/services/api.ts` — add `getPublicStore`, `getPublicAvailability`
- `src/pages/Config.tsx` — add slug field + copy link in NegocioSection

### AI — modify
- `src/ai/ai.service.ts` — add `extractQueryDate`, `computeSlotsForDate`, `availabilityBlock` param in `buildSystemPrompt`

---

## Task 1: Schema — Store.slug + prisma db push

**Files:** `prisma/schema.prisma`

- [ ] **Step 1: Add `slug` to Store model**

In `prisma/schema.prisma`, inside `model Store`, add after the `staffLabel` line:
```prisma
  slug        String?  @unique @map("slug") @db.VarChar(100)
```

- [ ] **Step 2: Run db push**
```bash
cd C:\Users\alexp\Desktop\proyectos\whatsapp-crm
npx prisma db push --accept-data-loss
```
Expected: `Your database is now in sync with your Prisma schema.`

- [ ] **Step 3: Regenerate client**
```bash
npx prisma generate
```

- [ ] **Step 4: Commit**
```bash
git add prisma/schema.prisma
git commit -m "feat: add Store.slug for public calendar URL"
```

---

## Task 2: PublicModule backend

**Files:**
- Create: `src/public/public.service.ts`
- Create: `src/public/public.controller.ts`
- Create: `src/public/public.module.ts`
- Modify: `src/app.module.ts`
- Modify: `src/stores/dto/create-store.dto.ts`

- [ ] **Step 1: Add `slug` to StoreDto**

In `src/stores/dto/create-store.dto.ts`, add after `staffLabel`:
```typescript
  @IsString()
  @IsOptional()
  @Matches(/^[a-z0-9-]{3,100}$/, { message: 'Slug: solo minúsculas, números y guiones (3-100 chars)' })
  slug?: string;
```

Add `Matches` to the `class-validator` imports.

- [ ] **Step 2: Create PublicService**

Create `src/public/public.service.ts`:

```typescript
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isWithinBusinessHours, BusinessHoursJson } from '../utils/business-hours.util';

interface SlotResult {
  staffId: string | null;
  name: string;
  slots: string[];
}

@Injectable()
export class PublicService {
  constructor(private readonly prisma: PrismaService) {}

  async getStoreBySlug(slug: string) {
    const store = await this.prisma.store.findUnique({
      where: { slug },
      select: { storeId: true, name: true, staffLabel: true, businessHours: true },
    });
    if (!store) throw new NotFoundException('Negocio no encontrado');

    const staffCount = await this.prisma.staff.count({
      where: { storeId: store.storeId, isActive: true },
    });

    return {
      name:          store.name,
      staffLabel:    store.staffLabel ?? 'Profesional',
      hasStaff:      staffCount > 0,
      businessHours: store.businessHours,
    };
  }

  async getAvailability(slug: string, dateStr: string): Promise<{ date: string; dayName: string; staff: SlotResult[] }> {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new BadRequestException('Parámetro date requerido en formato YYYY-MM-DD');
    }

    const store = await this.prisma.store.findUnique({
      where:  { slug },
      select: { storeId: true, name: true, businessHours: true },
    });
    if (!store) throw new NotFoundException('Negocio no encontrado');

    const date       = new Date(`${dateStr}T00:00:00-05:00`); // Colombia TZ
    const dayNames   = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
    const dayName    = dayNames[date.getDay()];

    const activeStaff = await this.prisma.staff.findMany({
      where:   { storeId: store.storeId, isActive: true },
      orderBy: { createdAt: 'asc' },
      select:  { staffId: true, name: true, schedule: true },
    });

    const results: SlotResult[] = [];

    if (activeStaff.length === 0) {
      // Single availability for the store
      const effectiveHours = store.businessHours as unknown as BusinessHoursJson | null;
      if (!effectiveHours) return { date: dateStr, dayName, staff: [] };

      const appointments = await this.prisma.appointment.findMany({
        where: {
          storeId:     store.storeId,
          staffId:     null,
          status:      { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
          scheduledAt: { gte: new Date(`${dateStr}T00:00:00-05:00`), lt: new Date(`${dateStr}T23:59:59-05:00`) },
        },
        select: { scheduledAt: true, endsAt: true },
      });

      results.push({
        staffId: null,
        name:    store.name,
        slots:   this.computeSlots(date, effectiveHours, appointments),
      });
    } else {
      for (const staff of activeStaff) {
        const effectiveHours = (staff.schedule ?? store.businessHours) as unknown as BusinessHoursJson | null;
        if (!effectiveHours) { results.push({ staffId: staff.staffId, name: staff.name, slots: [] }); continue; }

        const appointments = await this.prisma.appointment.findMany({
          where: {
            storeId:     store.storeId,
            staffId:     staff.staffId,
            status:      { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
            scheduledAt: { gte: new Date(`${dateStr}T00:00:00-05:00`), lt: new Date(`${dateStr}T23:59:59-05:00`) },
          },
          select: { scheduledAt: true, endsAt: true },
        });

        results.push({
          staffId: staff.staffId,
          name:    staff.name,
          slots:   this.computeSlots(date, effectiveHours, appointments),
        });
      }
    }

    return { date: dateStr, dayName, staff: results };
  }

  private computeSlots(
    date: Date,
    hours: BusinessHoursJson,
    appointments: { scheduledAt: Date; endsAt: Date | null }[],
    slotMinutes = 30,
  ): string[] {
    const DAY_KEYS = ['sun','mon','tue','wed','thu','fri','sat'] as const;
    const dayKey   = DAY_KEYS[date.getDay()];
    const daySchedule = hours[dayKey];

    if (!daySchedule?.isOpen) return [];

    const shifts = [daySchedule.shift1, daySchedule.shift2].filter(Boolean) as { open: string; close: string }[];
    const allSlots: string[] = [];

    for (const shift of shifts) {
      const [openH,  openM]  = shift.open.split(':').map(Number);
      const [closeH, closeM] = shift.close.split(':').map(Number);
      let current = openH * 60 + openM;
      const end   = closeH * 60 + closeM;

      while (current + slotMinutes <= end) {
        const hh = String(Math.floor(current / 60)).padStart(2, '0');
        const mm = String(current % 60).padStart(2, '0');
        allSlots.push(`${hh}:${mm}`);
        current += slotMinutes;
      }
    }

    // Remove occupied slots
    return allSlots.filter(slot => {
      const [h, m]    = slot.split(':').map(Number);
      const slotStart = new Date(date);
      slotStart.setHours(h, m, 0, 0);
      const slotEnd   = new Date(slotStart.getTime() + slotMinutes * 60_000);

      return !appointments.some(appt => {
        const apptStart = new Date(appt.scheduledAt);
        const apptEnd   = appt.endsAt ? new Date(appt.endsAt) : new Date(apptStart.getTime() + 30 * 60_000);
        return apptStart < slotEnd && apptEnd > slotStart;
      });
    });
  }
}
```

- [ ] **Step 3: Create PublicController**

Create `src/public/public.controller.ts`:

```typescript
import { Controller, Get, Param, Query } from '@nestjs/common';
import { PublicService } from './public.service';

@Controller('public')
export class PublicController {
  constructor(private readonly publicService: PublicService) {}

  @Get(':slug')
  getStore(@Param('slug') slug: string) {
    return this.publicService.getStoreBySlug(slug);
  }

  @Get(':slug/availability')
  getAvailability(@Param('slug') slug: string, @Query('date') date: string) {
    return this.publicService.getAvailability(slug, date);
  }
}
```

- [ ] **Step 4: Create PublicModule**

Create `src/public/public.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { PublicController } from './public.controller';
import { PublicService } from './public.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports:     [PrismaModule],
  controllers: [PublicController],
  providers:   [PublicService],
  exports:     [PublicService],
})
export class PublicModule {}
```

- [ ] **Step 5: Register in AppModule**

In `src/app.module.ts`, add:
```typescript
import { PublicModule } from './public/public.module';
```
And add `PublicModule` to the imports array.

- [ ] **Step 6: Verify build**
```bash
npm run build 2>&1 | tail -5
```
Expected: no TypeScript errors.

- [ ] **Step 7: Commit**
```bash
git add src/public/ src/app.module.ts src/stores/dto/create-store.dto.ts
git commit -m "feat: add PublicModule with store info and availability endpoints"
```

---

## Task 3: Frontend — api.ts + Config.tsx slug field

**Files:**
- Modify: `src/services/api.ts`
- Modify: `src/pages/Config.tsx`

- [ ] **Step 1: Add public endpoints to api.ts**

In `src/services/api.ts`, after `deleteAppointment`, add:

```typescript
// ── Public (no auth) ──────────────────────────────────────────────────────────
export const getPublicStore = (slug: string) =>
  api.get(`/public/${slug}`);

export const getPublicAvailability = (slug: string, date: string) =>
  api.get(`/public/${slug}/availability`, { params: { date } });
```

- [ ] **Step 2: Add slug field to NegocioSection in Config.tsx**

Read `src/pages/Config.tsx`. In `NegocioSection`:

a) Add `slug: ''` to the form state.

b) In the `useEffect` `setForm`, add: `slug: d.slug ?? '',`

c) In `handleSave`, add to the payload: `slug: form.slug || undefined,`

d) In the JSX (after the store name input), add a slug card:

```tsx
{/* Slug / Link público */}
<div className={card}>
  <p className="text-sm font-semibold text-txt-primary mb-1">Link público del calendario</p>
  <p className="text-xs text-txt-secondary mb-3">
    Comparte este link para que tus clientes vean tu disponibilidad en tiempo real.
  </p>
  <div className="flex gap-2 items-center">
    <span className="text-xs text-txt-tertiary whitespace-nowrap">…/cal/</span>
    <input
      value={form.slug}
      onChange={e => setf('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
      placeholder="mi-negocio"
      maxLength={100}
      className={ic}
    />
  </div>
  {form.slug && (
    <div className="mt-2 flex items-center gap-2 p-2 bg-surface-elevated rounded-lg border border-border-default">
      <span className="text-xs text-txt-secondary truncate flex-1">
        {window.location.origin}/cal/{form.slug}
      </span>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(`${window.location.origin}/cal/${form.slug}`);
          alert('¡Link copiado!');
        }}
        className="text-xs text-lime hover:underline flex-shrink-0"
      >
        Copiar
      </button>
    </div>
  )}
</div>
```

- [ ] **Step 3: Build check**
```bash
cd C:\Users\alexp\Desktop\proyectos\stockup-frontend
npm run build 2>&1 | tail -5
```

- [ ] **Step 4: Commit**
```bash
git add src/services/api.ts src/pages/Config.tsx
git commit -m "feat: add public endpoints to api.ts and slug field to Config"
```

---

## Task 4: Public calendar page

**Files:**
- Create: `src/pages/PublicCalendar.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create PublicCalendar.tsx**

Create `src/pages/PublicCalendar.tsx`:

```tsx
import React, { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { getPublicStore, getPublicAvailability } from '../services/api';

interface StaffSlots { staffId: string | null; name: string; slots: string[]; }
interface StoreInfo  { name: string; staffLabel: string; hasStaff: boolean; }

const fmt = (d: Date) => d.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
const toISO = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

export default function PublicCalendar() {
  const { slug }                      = useParams<{ slug: string }>();
  const [store,    setStore]          = useState<StoreInfo | null>(null);
  const [date,     setDate]           = useState(new Date());
  const [staff,    setStaff]          = useState<StaffSlots[]>([]);
  const [loading,  setLoading]        = useState(true);
  const [loadSlots, setLoadSlots]     = useState(false);
  const [notFound, setNotFound]       = useState(false);

  useEffect(() => {
    if (!slug) return;
    getPublicStore(slug)
      .then(r => setStore(r.data))
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [slug]);

  const loadSlotsFn = useCallback(async (d: Date) => {
    if (!slug) return;
    setLoadSlots(true);
    try {
      const r = await getPublicAvailability(slug, toISO(d));
      setStaff(r.data.staff ?? []);
    } catch { setStaff([]); }
    finally  { setLoadSlots(false); }
  }, [slug]);

  useEffect(() => { if (store) loadSlotsFn(date); }, [store, date, loadSlotsFn]);

  const today = new Date(); today.setHours(0,0,0,0);
  const canBack = date > today;
  const canFwd  = addDays(date, 1) <= addDays(today, 30);

  if (loading) return (
    <div className="min-h-screen bg-[#0A0A0F] flex items-center justify-center">
      <div className="w-8 h-8 rounded-full border-2 border-[#D4FF00] border-t-transparent animate-spin" />
    </div>
  );

  if (notFound) return (
    <div className="min-h-screen bg-[#0A0A0F] flex items-center justify-center text-center px-4">
      <div>
        <p className="text-4xl mb-4">🔍</p>
        <h1 className="text-xl font-bold text-white mb-2">Negocio no encontrado</h1>
        <p className="text-sm text-gray-400">Verifica que el link sea correcto.</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0A0A0F] text-white">
      {/* Header */}
      <div className="bg-[#111117] border-b border-white/10 px-4 py-4 text-center">
        <p className="text-xs font-bold tracking-widest text-[#D4FF00] uppercase mb-1">Stockup</p>
        <h1 className="text-xl font-bold">{store?.name}</h1>
        <p className="text-sm text-gray-400 mt-0.5">
          Consulta la disponibilidad de nuestros {(store?.staffLabel ?? 'profesional').toLowerCase()}s
        </p>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        {/* Date navigator */}
        <div className="flex items-center justify-between bg-[#111117] rounded-2xl px-4 py-3 border border-white/10">
          <button
            onClick={() => canBack && setDate(d => addDays(d, -1))}
            disabled={!canBack}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-white/10 disabled:opacity-30 transition"
          >
            ‹
          </button>
          <div className="text-center">
            <p className="font-semibold capitalize">{fmt(date)}</p>
            {toISO(date) === toISO(today) && (
              <span className="text-xs text-[#D4FF00]">Hoy</span>
            )}
          </div>
          <button
            onClick={() => canFwd && setDate(d => addDays(d, 1))}
            disabled={!canFwd}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-white/10 disabled:opacity-30 transition"
          >
            ›
          </button>
        </div>

        {/* Slots */}
        {loadSlots ? (
          <div className="flex justify-center py-12">
            <div className="w-6 h-6 rounded-full border-2 border-[#D4FF00] border-t-transparent animate-spin" />
          </div>
        ) : staff.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <p className="text-4xl mb-3">📅</p>
            <p className="text-sm">Sin disponibilidad para este día</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {staff.map((s, i) => (
              <div key={s.staffId ?? i} className="bg-[#111117] rounded-2xl p-4 border border-white/10">
                <p className="font-semibold mb-3 flex items-center gap-2">
                  <span className="text-[#D4FF00]">✂</span> {s.name}
                </p>
                {s.slots.length === 0 ? (
                  <p className="text-xs text-gray-500 italic">Sin disponibilidad</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {s.slots.map(slot => (
                      <span key={slot}
                        className="px-3 py-1.5 rounded-xl text-sm font-medium bg-white/5 border border-white/10 text-white">
                        {slot}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <p className="text-center text-xs text-gray-600 pb-4">
          Los slots son orientativos. Confirma tu cita escribiéndonos por WhatsApp. · Powered by Stockup
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add route to App.tsx**

In `src/App.tsx`:

Add import at the top:
```typescript
import PublicCalendar from './pages/PublicCalendar';
```

In the `<Routes>` block, add BEFORE the `<Route path="*" ...>` line:
```tsx
<Route path="/cal/:slug" element={<PublicCalendar />} />
```

- [ ] **Step 3: Build check**
```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 4: Commit**
```bash
git add src/pages/PublicCalendar.tsx src/App.tsx
git commit -m "feat: add public calendar page /cal/:slug"
```

---

## Task 5: AI — availability detection and injection

**Files:** `src/ai/ai.service.ts`

- [ ] **Step 1: Add `extractQueryDate` helper**

Near the top of `ai.service.ts` (in the utility functions section, after `mergeAppt`), add:

```typescript
function extractQueryDate(message: string, today: Date): Date | null {
  const msg = message.toLowerCase();
  const tz  = 'America/Bogota';

  // "hoy"
  if (/\bhoy\b/.test(msg)) return new Date(today);

  // "mañana"
  if (/\bma[ñn]ana\b/.test(msg)) {
    const d = new Date(today); d.setDate(d.getDate() + 1); return d;
  }

  // "el lunes/martes/.../domingo" → next occurrence
  const DAYS: Record<string,number> = { lunes:1,martes:2,mi[eé]rcoles:3,jueves:4,viernes:5,s[aá]bado:6,domingo:0 };
  for (const [pattern, dayNum] of Object.entries(DAYS)) {
    if (new RegExp(`\\b${pattern}\\b`).test(msg)) {
      const d = new Date(today);
      const diff = (dayNum - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + diff);
      return d;
    }
  }

  // "el 10" or "el 10 de junio"
  const MONTHS: Record<string,number> = {
    enero:0,febrero:1,marzo:2,abril:3,mayo:4,junio:5,
    julio:6,agosto:7,septiembre:8,octubre:9,noviembre:10,diciembre:11,
  };
  const dateMatch = msg.match(/el\s+(\d{1,2})(?:\s+de\s+([a-záéíóú]+))?/);
  if (dateMatch) {
    const day   = parseInt(dateMatch[1]);
    const month = dateMatch[2] ? (MONTHS[dateMatch[2]] ?? today.getMonth()) : today.getMonth();
    const year  = today.getFullYear();
    const d     = new Date(year, month, day);
    if (!isNaN(d.getTime()) && d >= today) return d;
  }

  return null;
}
```

Note: The `DAYS` object syntax above uses template literals for character classes — adapt to valid TypeScript regex patterns when implementing.

- [ ] **Step 2: Add `computeSlotsForAI` method to AiService**

Add this private method to the `AiService` class (near other private methods):

```typescript
  private async computeSlotsForAI(
    storeId: string,
    date: Date,
    activeStaff: Array<{ staffId: string; name: string }>,
    store: any,
  ): Promise<string> {
    const DAY_KEYS = ['sun','mon','tue','wed','thu','fri','sat'] as const;
    const dateStr  = date.toISOString().slice(0, 10);
    const dayKey   = DAY_KEYS[date.getDay()];
    const dayNames = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
    const dayName  = dayNames[date.getDay()];

    const computeSlots = (hours: any, appts: any[]): string[] => {
      const day = hours?.[dayKey];
      if (!day?.isOpen) return [];
      const SLOT_MIN = 30;
      const shifts = [day.shift1, day.shift2].filter(Boolean);
      const all: string[] = [];
      for (const sh of shifts) {
        const [oh, om] = sh.open.split(':').map(Number);
        const [ch, cm] = sh.close.split(':').map(Number);
        let cur = oh * 60 + om;
        const end = ch * 60 + cm;
        while (cur + SLOT_MIN <= end) {
          all.push(`${String(Math.floor(cur/60)).padStart(2,'0')}:${String(cur%60).padStart(2,'0')}`);
          cur += SLOT_MIN;
        }
      }
      return all.filter(slot => {
        const [h, m]    = slot.split(':').map(Number);
        const slotStart = new Date(date); slotStart.setHours(h, m, 0, 0);
        const slotEnd   = new Date(slotStart.getTime() + SLOT_MIN * 60_000);
        return !appts.some(a => {
          const s = new Date(a.scheduledAt);
          const e = a.endsAt ? new Date(a.endsAt) : new Date(s.getTime() + 30 * 60_000);
          return s < slotEnd && e > slotStart;
        });
      });
    };

    const lines: string[] = [`DISPONIBILIDAD REAL PARA ${dayName} ${dateStr}:`];

    if (activeStaff.length === 0) {
      const appts = await this.prisma.appointment.findMany({
        where: {
          storeId,
          staffId:     null,
          status:      { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
          scheduledAt: { gte: new Date(`${dateStr}T00:00:00-05:00`), lt: new Date(`${dateStr}T23:59:59-05:00`) },
        },
        select: { scheduledAt: true, endsAt: true },
      });
      const slots = computeSlots(store?.businessHours, appts);
      lines.push(slots.length > 0 ? `Horarios libres: ${slots.join(', ')}` : 'Sin disponibilidad para ese día.');
    } else {
      for (const member of activeStaff) {
        const staffRow = await this.prisma.staff.findUnique({ where: { staffId: member.staffId }, select: { schedule: true } });
        const hours    = staffRow?.schedule ?? store?.businessHours;
        const appts    = await this.prisma.appointment.findMany({
          where: {
            storeId,
            staffId:     member.staffId,
            status:      { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
            scheduledAt: { gte: new Date(`${dateStr}T00:00:00-05:00`), lt: new Date(`${dateStr}T23:59:59-05:00`) },
          },
          select: { scheduledAt: true, endsAt: true },
        });
        const slots = computeSlots(hours, appts);
        lines.push(`- ${member.name}: ${slots.length > 0 ? slots.join(', ') : 'sin disponibilidad'}`);
      }
    }

    lines.push('\nINSTRUCCIÓN: Usa SOLO estos horarios al responder. No inventes horas que no estén en la lista. Si el cliente elige uno, avanza al flujo de agendamiento normal.');
    return lines.join('\n');
  }
```

- [ ] **Step 3: Add availability detection in `generateResponse`**

In `generateResponse`, find where `activeStaff` is available and the `buildSystemPrompt` call is about to happen (after the `Promise.all` that loads staff). Add:

```typescript
      // Detect availability query and compute real slots
      const AVAIL_RE = /horario|disponible|disponibilidad|cuándo puedo|qué hora|hora libre|cuando tiene|qué días|que dia/i;
      let availabilityBlock = '';
      if (AVAIL_RE.test(userMessage)) {
        const todayLocal = new Date();
        const queryDate  = extractQueryDate(userMessage, todayLocal);
        if (queryDate) {
          try {
            availabilityBlock = await this.computeSlotsForAI(storeId, queryDate, activeStaff, store);
          } catch { /* non-fatal */ }
        }
      }
```

- [ ] **Step 4: Pass `availabilityBlock` to `buildSystemPrompt`**

Find the `buildSystemPrompt` call and add `availabilityBlock` as the last argument:
```typescript
      const enrichedSystemPrompt = this.buildSystemPrompt(
        ...,
        activeStaff,
        availabilityBlock,
      );
```

- [ ] **Step 5: Update `buildSystemPrompt` signature and injection**

Add `availabilityBlock: string = ''` as the last parameter.

At the END of the method, before `return`, inject the block if present:

```typescript
    if (availabilityBlock) {
      return enriched + `\n\n---\n${availabilityBlock}`;
    }
    return enriched;
```

Also add to the agendamiento section the instruction for when no date is given:
```typescript
    const availabilityInstruction = activeStaff.length > 0 || store?.businessHours
      ? `\nCONSULTA DE DISPONIBILIDAD:\nSi el cliente pregunta por horarios disponibles y no menciona un día específico, pregunta: "¿Para qué día quieres consultar la disponibilidad? Por ejemplo: mañana, el lunes, el 15 de junio."`
      : '';
```

Append `availabilityInstruction` to `agendamientoSection`.

- [ ] **Step 6: Build check**
```bash
cd C:\Users\alexp\Desktop\proyectos\whatsapp-crm
npm run build 2>&1 | tail -5
```

- [ ] **Step 7: Commit**
```bash
git add src/ai/ai.service.ts
git commit -m "feat: AI detects availability queries and responds with real slot data"
```

---

## Task 6: Deploy

- [ ] **Step 1: Push backend**
```bash
cd C:\Users\alexp\Desktop\proyectos\whatsapp-crm
git push origin main
```

- [ ] **Step 2: Push frontend**
```bash
cd C:\Users\alexp\Desktop\proyectos\stockup-frontend
git push origin main
```

- [ ] **Step 3: Smoke test**
1. Config → Negocio → poner slug `nextlevel-barbershop` → guardar
2. Abrir `https://[frontend]/cal/nextlevel-barbershop` sin login → debe mostrar el calendario
3. Cambiar de día → slots actualizados
4. WhatsApp: escribir "¿qué horarios tienen el lunes?" → IA responde con horarios reales
