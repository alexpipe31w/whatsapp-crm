# Staff System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-employee support (barberos, estilistas, técnicos) so appointments can be assigned to a specific staff member with independent schedules and conflict detection; falls back silently to current behavior for stores with no staff configured.

**Architecture:** New `Staff` model linked to `Store` and `Appointment`. AiService loads staff per store, injects list into system prompt and extractor. AppointmentsService validates schedule and conflicts per staff member. Frontend adds a Config "Equipo" tab and a staff column/filter in Appointments.

**Tech Stack:** NestJS 11, Prisma 6 (db push — no migrate), PostgreSQL Neon, React 19, Tailwind, Axios.

---

## Files map

### Backend — create
- `src/staff/dto/create-staff.dto.ts`
- `src/staff/dto/update-staff.dto.ts`
- `src/staff/staff.service.ts`
- `src/staff/staff.controller.ts`
- `src/staff/staff.module.ts`

### Backend — modify
- `prisma/schema.prisma` — Staff model, Store.staffLabel, Appointment.staffId
- `src/app.module.ts` — register StaffModule
- `src/stores/dto/create-store.dto.ts` — add staffLabel field
- `src/appointments/dto/create-appointment.dto.ts` — add staffId
- `src/appointments/dto/update-appointment.dto.ts` — add staffId
- `src/appointments/appointments.service.ts` — APPOINTMENT_INCLUDE, findAll filter, create validation + conflict
- `src/appointments/appointments.controller.ts` — staffId query param
- `src/ai/ai.service.ts` — AppointmentExtractionResult, mergeAppt, staffCache, generateResponse, buildSystemPrompt, tryExtractAndCreateAppointment

### Frontend — modify
- `src/services/api.ts` — staff endpoints, update getAppointments + createAppointment
- `src/pages/Config.tsx` — staffLabel in NegocioSection, new EquipoSection tab
- `src/pages/Appointments.tsx` — types, staff filter, column, calendar card, NewAppointmentModal

---

## Task 1: Prisma schema — Staff model + Store.staffLabel + Appointment.staffId

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add Staff model to schema**

In `prisma/schema.prisma`, after the `BlockedContact` model (around line 633), add:

```prisma
// ─── Staff ────────────────────────────────────────────────────────────────────

model Staff {
  staffId   String   @id @default(uuid()) @map("staff_id")
  storeId   String   @map("store_id")
  name      String   @db.VarChar(100)
  isActive  Boolean  @default(true) @map("is_active")

  // null = hereda store.businessHours
  // Shape: { mon: { isOpen, shift1, shift2 }, tue: ..., ... }
  schedule  Json?    @map("schedule")

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt      @map("updated_at")

  store        Store         @relation(fields: [storeId], references: [storeId], onDelete: Cascade)
  appointments Appointment[]

  @@index([storeId, isActive])
  @@map("staff")
}
```

- [ ] **Step 2: Add staffLabel to Store model**

In `prisma/schema.prisma`, inside `model Store`, after the `waSessionId` line (line 88), add:

```prisma
  staffLabel  String?  @default("Profesional") @map("staff_label") @db.VarChar(50)
```

Also add `staff Staff[]` to the Store relations section (after `dailyReports DailyReport[]`):

```prisma
  staff           Staff[]
```

- [ ] **Step 3: Add staffId + relation + index to Appointment model**

In `prisma/schema.prisma`, inside `model Appointment`, after the `serviceVariantId` line (line 444), add:

```prisma
  staffId          String? @map("staff_id")
```

Add the relation after `serviceVariant ServiceVariant? @relation(...)` (around line 503):

```prisma
  staff          Staff?                @relation(fields: [staffId], references: [staffId])
```

Add the composite index after `@@index([storeId, createdAt])`:

```prisma
  @@index([storeId, staffId, scheduledAt])
```

- [ ] **Step 4: Run db push**

```bash
cd C:\Users\alexp\Desktop\proyectos\whatsapp-crm
npx prisma db push --accept-data-loss
```

Expected output: `Your database is now in sync with your Prisma schema.`

- [ ] **Step 5: Regenerate Prisma client**

```bash
npx prisma generate
```

Expected: `Generated Prisma Client to src/generated/prisma`

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat: add Staff model, Store.staffLabel, Appointment.staffId to schema"
```

---

## Task 2: StaffModule — backend CRUD

**Files:**
- Create: `src/staff/dto/create-staff.dto.ts`
- Create: `src/staff/dto/update-staff.dto.ts`
- Create: `src/staff/staff.service.ts`
- Create: `src/staff/staff.controller.ts`
- Create: `src/staff/staff.module.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: Create CreateStaffDto**

Create `src/staff/dto/create-staff.dto.ts`:

```typescript
import { IsString, IsOptional, IsObject, MaxLength } from 'class-validator';

export class CreateStaffDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsObject()
  @IsOptional()
  schedule?: Record<string, any> | null;
}
```

- [ ] **Step 2: Create UpdateStaffDto**

Create `src/staff/dto/update-staff.dto.ts`:

```typescript
import { IsString, IsOptional, IsObject, IsBoolean, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateStaffDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string;

  @IsBoolean()
  @IsOptional()
  @Type(() => Boolean)
  isActive?: boolean;

  @IsObject()
  @IsOptional()
  schedule?: Record<string, any> | null;
}
```

- [ ] **Step 3: Create StaffService**

Create `src/staff/staff.service.ts`:

```typescript
import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';

@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(storeId: string) {
    return this.prisma.staff.findMany({
      where:   { storeId, isActive: true },
      orderBy: { createdAt: 'asc' },
      select:  { staffId: true, name: true, isActive: true, schedule: true, createdAt: true },
    });
  }

  create(storeId: string, dto: CreateStaffDto) {
    return this.prisma.staff.create({
      data: {
        storeId,
        name:     dto.name,
        schedule: dto.schedule ?? null,
      },
      select: { staffId: true, name: true, isActive: true, schedule: true, createdAt: true },
    });
  }

  async update(staffId: string, storeId: string, dto: UpdateStaffDto) {
    await this.verifyOwnership(staffId, storeId);
    return this.prisma.staff.update({
      where: { staffId },
      data:  {
        ...(dto.name     !== undefined && { name:     dto.name }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.schedule !== undefined && { schedule: dto.schedule }),
      },
      select: { staffId: true, name: true, isActive: true, schedule: true, createdAt: true },
    });
  }

  async remove(staffId: string, storeId: string) {
    await this.verifyOwnership(staffId, storeId);
    return this.prisma.staff.update({
      where: { staffId },
      data:  { isActive: false },
    });
  }

  private async verifyOwnership(staffId: string, storeId: string) {
    const staff = await this.prisma.staff.findUnique({ where: { staffId } });
    if (!staff)                    throw new NotFoundException('Profesional no encontrado');
    if (staff.storeId !== storeId) throw new ForbiddenException();
  }
}
```

- [ ] **Step 4: Create StaffController**

Create `src/staff/staff.controller.ts`:

```typescript
import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, UseGuards, Request, HttpCode, HttpStatus,
} from '@nestjs/common';
import { StaffService } from './staff.service';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('staff')
@UseGuards(JwtAuthGuard)
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @Get()
  findAll(@Request() req: any) {
    return this.staffService.findAll(req.user.storeId);
  }

  @Post()
  create(@Body() dto: CreateStaffDto, @Request() req: any) {
    return this.staffService.create(req.user.storeId, dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateStaffDto, @Request() req: any) {
    return this.staffService.update(id, req.user.storeId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @Request() req: any) {
    return this.staffService.remove(id, req.user.storeId);
  }
}
```

- [ ] **Step 5: Create StaffModule**

Create `src/staff/staff.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports:     [PrismaModule],
  controllers: [StaffController],
  providers:   [StaffService],
  exports:     [StaffService],
})
export class StaffModule {}
```

- [ ] **Step 6: Register StaffModule in AppModule**

In `src/app.module.ts`, add the import at the top:

```typescript
import { StaffModule } from './staff/staff.module';
```

And add `StaffModule` to the `imports` array (after `RemindersModule`):

```typescript
    ReportsModule,
    StaffModule,
```

- [ ] **Step 7: Verify compile**

```bash
cd C:\Users\alexp\Desktop\proyectos\whatsapp-crm
npm run build 2>&1 | tail -5
```

Expected: `Successfully compiled` (no TypeScript errors).

- [ ] **Step 8: Commit**

```bash
git add src/staff/ src/app.module.ts
git commit -m "feat: add StaffModule with CRUD endpoints"
```

---

## Task 3: AppointmentsService — staffId in DTOs, schedule validation, conflict detection

**Files:**
- Modify: `src/appointments/dto/create-appointment.dto.ts`
- Modify: `src/appointments/dto/update-appointment.dto.ts`
- Modify: `src/appointments/appointments.service.ts`
- Modify: `src/appointments/appointments.controller.ts`

- [ ] **Step 1: Add staffId to CreateAppointmentDto**

In `src/appointments/dto/create-appointment.dto.ts`, add after the `serviceVariantId` field:

```typescript
  @IsUUID()
  @IsOptional()
  staffId?: string;
```

The import line already has `IsUUID` and `IsOptional`.

- [ ] **Step 2: Add staffId to UpdateAppointmentDto**

In `src/appointments/dto/update-appointment.dto.ts`, add after the `type` field:

```typescript
  @IsUUID()
  @IsOptional()
  staffId?: string;
```

Add `IsUUID` to the imports at the top:

```typescript
import {
  IsString, IsOptional, IsEnum, IsDateString,
  IsInt, IsNumber, Min, Max, MaxLength, IsPositive, IsIn, IsUUID,
} from 'class-validator';
```

- [ ] **Step 3: Update APPOINTMENT_INCLUDE to include staff**

In `src/appointments/appointments.service.ts`, find `APPOINTMENT_INCLUDE` (around line 37) and add the `staff` field:

```typescript
const APPOINTMENT_INCLUDE = {
  customer:       { select: CUSTOMER_SELECT },
  service:        { select: SERVICE_SELECT },
  serviceVariant: { select: SERVICE_VARIANT_SELECT },
  staff:          { select: { staffId: true, name: true } },
  timeline: {
    orderBy: { createdAt: 'asc' as const },
    where:   { isPublic: true },
  },
} as const;
```

- [ ] **Step 4: Update findAll to support staffId filter**

In `src/appointments/appointments.service.ts`, update the `findAll` method signature and body:

```typescript
  async findAll(
    storeId: string,
    filters?: {
      status?:           string;
      type?:             string;
      from?:             string;
      to?:               string;
      serviceId?:        string;
      staffId?:          string;
      priority?:         string;
      hasPendingAction?: string;
    },
  ) {
    const where: any = { storeId };

    if (filters?.status)    where.status    = filters.status.toUpperCase();
    if (filters?.type)      where.type      = filters.type;
    if (filters?.serviceId) where.serviceId = filters.serviceId;
    if (filters?.staffId)   where.staffId   = filters.staffId;
    if (filters?.priority)  where.priority  = filters.priority?.toUpperCase();
    if (filters?.hasPendingAction === 'true') where.pendingAction = { not: null };

    if (filters?.from || filters?.to) {
      where.scheduledAt = {};
      if (filters.from) where.scheduledAt.gte = new Date(filters.from);
      if (filters.to)   where.scheduledAt.lte = new Date(filters.to);
    }

    return this.prisma.appointment.findMany({
      where,
      include: APPOINTMENT_INCLUDE,
      orderBy: { scheduledAt: 'asc' },
    });
  }
```

- [ ] **Step 5: Update create method — staff schedule validation + conflict detection**

In `src/appointments/appointments.service.ts`, replace the `create` method's business hours validation block and appointment creation:

Find this section (around line 157):
```typescript
    const store = await this.prisma.store.findUnique({ where: { storeId } });
    if (store?.businessHours) {
      const isAI   = dto.source === AppointmentSource.AI;
      const forced = !!dto.forceSchedule && !isAI;
      if (!forced && !isWithinBusinessHours(scheduledAt, store.businessHours as unknown as BusinessHoursJson)) {
        throw new BadRequestException(
          'La hora solicitada está fuera del horario de atención del negocio.',
        );
      }
    }
```

Replace with:

```typescript
    const [store, staffMember] = await Promise.all([
      this.prisma.store.findUnique({ where: { storeId } }),
      dto.staffId
        ? this.prisma.staff.findUnique({ where: { staffId: dto.staffId } })
        : Promise.resolve(null),
    ]);

    const isAI   = dto.source === AppointmentSource.AI;
    const forced = !!dto.forceSchedule && !isAI;

    // Validate business hours against staff schedule (if staff set) or store hours
    const effectiveHours = staffMember?.schedule ?? store?.businessHours;
    if (effectiveHours && !forced) {
      if (!isWithinBusinessHours(scheduledAt, effectiveHours as unknown as BusinessHoursJson)) {
        throw new BadRequestException(
          'La hora solicitada está fuera del horario de atención.',
        );
      }
    }

    // Detect staff booking conflicts
    if (dto.staffId) {
      const newEndsAt = endsAt ?? new Date(scheduledAt.getTime() + 30 * 60_000);
      const conflict  = await this.prisma.appointment.findFirst({
        where: {
          staffId: dto.staffId,
          status:  { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
          AND: [
            { scheduledAt: { lt: newEndsAt } },
            {
              OR: [
                { endsAt: { gt: scheduledAt } },
                {
                  endsAt:      null,
                  scheduledAt: { gt: new Date(scheduledAt.getTime() - 30 * 60_000) },
                },
              ],
            },
          ],
        },
      });
      if (conflict) {
        throw new BadRequestException(
          'El profesional ya tiene una cita en ese horario. Elige otro horario o profesional.',
        );
      }
    }
```

Also update the `prisma.$transaction` inside `create` to pass `staffId`:

```typescript
      const appointment = await tx.appointment.create({
        data: {
          storeId,
          customerId:       dto.customerId,
          serviceId:        dto.serviceId        ?? null,
          serviceVariantId: dto.serviceVariantId ?? null,
          staffId:          dto.staffId          ?? null,
          type:             dto.type             ?? 'cita',
          status:           AppointmentStatus.PENDING,
          priority:         dto.priority         ?? 'NORMAL',
          source:           dto.source           ?? AppointmentSource.MANUAL,
          scheduledAt,
          endsAt,
          durationMinutes:  dto.durationMinutes  ?? null,
          description:      dto.description      ?? null,
          address:          dto.address          ?? null,
          notes:            dto.notes            ?? null,
          internalNotes:    dto.internalNotes    ?? null,
          agreedPrice:      dto.agreedPrice      ?? null,
        },
        include: APPOINTMENT_INCLUDE,
      });
```

- [ ] **Step 6: Update update method to allow staffId changes**

In `src/appointments/appointments.service.ts`, inside the `update` method's `prisma.$transaction`, find the `tx.appointment.update` call and add `staffId` to the data spread:

```typescript
          ...(dto.staffId         !== undefined && { staffId:        dto.staffId }),
```

Add it after `...(dto.type !== undefined && { type: dto.type }),`.

- [ ] **Step 7: Update AppointmentsController to accept staffId query param**

In `src/appointments/appointments.controller.ts`, update the `findAll` method:

```typescript
  @Get()
  findAll(
    @Request() req: any,
    @Query('status')           status?:           string,
    @Query('type')             type?:             string,
    @Query('from')             from?:             string,
    @Query('to')               to?:               string,
    @Query('serviceId')        serviceId?:        string,
    @Query('staffId')          staffId?:          string,
    @Query('priority')         priority?:         string,
    @Query('hasPendingAction') hasPendingAction?: string,
  ) {
    return this.appointmentsService.findAll(req.user.storeId, {
      status, type, from, to, serviceId, staffId, priority, hasPendingAction,
    });
  }
```

- [ ] **Step 8: Verify compile**

```bash
npm run build 2>&1 | tail -5
```

Expected: no TypeScript errors.

- [ ] **Step 9: Commit**

```bash
git add src/appointments/
git commit -m "feat: add staffId to appointments — schedule validation and conflict detection per staff"
```

---

## Task 4: StoresDto — add staffLabel field

**Files:**
- Modify: `src/stores/dto/create-store.dto.ts`

- [ ] **Step 1: Add staffLabel to CreateStoreDto**

In `src/stores/dto/create-store.dto.ts`, add after the `businessHours` field:

```typescript
  // Cómo se llama el personal en esta tienda (Barbero, Estilista, Técnico, etc.)
  @IsString() @IsOptional() staffLabel?: string;
```

`UpdateStoreDto` extends `PartialType(CreateStoreDto)` so it picks it up automatically.

- [ ] **Step 2: Commit**

```bash
git add src/stores/dto/create-store.dto.ts
git commit -m "feat: add staffLabel field to StoreDto"
```

---

## Task 5: AiService — staff injection into system prompt and extractor

**Files:**
- Modify: `src/ai/ai.service.ts`

- [ ] **Step 1: Add staffId + staffName to AppointmentExtractionResult interface**

Find the `interface AppointmentExtractionResult` (around line 328) and add two fields:

```typescript
interface AppointmentExtractionResult {
  complete: boolean;
  serviceId: string | null;
  serviceVariantId: string | null;
  type: string;
  scheduledDate: string | null;
  scheduledTime: string | null;
  durationMinutes: number | null;
  agreedPrice: number | null;
  description: string | null;
  address: string | null;
  notes: string | null;
  reason: string;
  customerName: string | null;
  customerCedula: string | null;
  staffId: string | null;
  staffName: string | null;
}
```

- [ ] **Step 2: Update mergeAppt to preserve staffId**

Find `function mergeAppt` (around line 270) and add `staffId` and `staffName` to the explicit merge:

```typescript
function mergeAppt(
  base: AppointmentExtractionResult,
  update: AppointmentExtractionResult,
): AppointmentExtractionResult {
  return {
    ...base,
    ...update,
    serviceId:        update.serviceId        ?? base.serviceId,
    serviceVariantId: update.serviceVariantId ?? base.serviceVariantId,
    type:             update.type             || base.type,
    scheduledDate:    update.scheduledDate    ?? base.scheduledDate,
    scheduledTime:    update.scheduledTime    ?? base.scheduledTime,
    durationMinutes:  update.durationMinutes  ?? base.durationMinutes,
    agreedPrice:      update.agreedPrice      ?? base.agreedPrice,
    description:      update.description      ?? base.description,
    address:          update.address          ?? base.address,
    notes:            update.notes            ?? base.notes,
    customerName:     update.customerName     ?? base.customerName,
    customerCedula:   update.customerCedula   ?? base.customerCedula,
    staffId:          update.staffId          ?? base.staffId,
    staffName:        update.staffName        ?? base.staffName,
    complete:         update.complete,
    reason:           update.reason,
  };
}
```

- [ ] **Step 3: Add staffCache field to AiService class**

Find the class fields section (around line 355) and add:

```typescript
  private readonly staffCache = new Map<string, CacheEntry<any[]>>();
```

- [ ] **Step 4: Load staff in generateResponse alongside store**

Find the `Promise.all` in `generateResponse` that loads `conversationRow, orders, appointments, history, store` (around line 562). Replace it with one that also loads staff:

```typescript
      const [conversationRow, orders, appointments, history, store, activeStaff] = await Promise.all([
        this.prisma.conversation.findFirst({
          where:   { conversationId, storeId },
          include: {
            customer: {
              select: {
                customerId: true, name: true, cedula: true, city: true, phone: true,
                lastConversationSummary: true,
              },
            },
          },
        }),
        this.prisma.order.findMany({
          where: { storeId, customer: { conversations: { some: { conversationId } } } },
          include: { orderItems: { include: { product: { select: { name: true, salePrice: true } } } } },
          orderBy: { createdAt: 'desc' },
          take: 5,
        }),
        this.prisma.appointment.findMany({
          where: { storeId, customer: { conversations: { some: { conversationId } } } },
          include: {
            service:        { select: { name: true } },
            serviceVariant: { select: { name: true } },
          },
          orderBy: { scheduledAt: 'asc' },
          take: 5,
        }),
        this.prisma.message.findMany({
          where:   { conversationId },
          orderBy: { createdAt: 'asc' },
          take:    MAX_HISTORY_MESSAGES,
        }),
        this.prisma.store.findUnique({ where: { storeId } }),
        (() => {
          const cached = this.getCached(this.staffCache, storeId);
          if (cached) return Promise.resolve(cached);
          return this.prisma.staff
            .findMany({ where: { storeId, isActive: true }, orderBy: { createdAt: 'asc' }, select: { staffId: true, name: true } })
            .then(list => { this.setCached(this.staffCache, storeId, list, CONFIG_CACHE_TTL_MS); return list; });
        })(),
      ]);
```

- [ ] **Step 5: Pass activeStaff to tryExtractAndCreateAppointment**

Find the call to `tryExtractAndCreateAppointment` (around line 635):

```typescript
        const apptResult = await this.tryExtractAndCreateAppointment(
          provider, apiKey, model, history, userMessage,
          customer, storeId, conversationId, services,
        );
```

Replace with:

```typescript
        const apptResult = await this.tryExtractAndCreateAppointment(
          provider, apiKey, model, history, userMessage,
          customer, storeId, conversationId, services, activeStaff,
        );
```

- [ ] **Step 6: Pass activeStaff and store to buildSystemPrompt**

Find the `buildSystemPrompt` call (around line 673):

```typescript
      const enrichedSystemPrompt = this.buildSystemPrompt(
        config.systemPrompt, customer, orders, appointments,
        products, services, fechaActual, horaActual,
        history, userMessage, addressAlreadyGiven, settings,
        customer.lastConversationSummary ?? null,
        store,
      );
```

Replace with:

```typescript
      const enrichedSystemPrompt = this.buildSystemPrompt(
        config.systemPrompt, customer, orders, appointments,
        products, services, fechaActual, horaActual,
        history, userMessage, addressAlreadyGiven, settings,
        customer.lastConversationSummary ?? null,
        store,
        activeStaff,
      );
```

- [ ] **Step 7: Update buildSystemPrompt signature and add staff section**

Find the `buildSystemPrompt` method signature (around line 1493):

```typescript
  private buildSystemPrompt(
    basePrompt: string,
    customer: any,
    orders: any[],
    appointments: any[],
    products: any[],
    services: any[],
    fechaActual: string,
    horaActual: string,
    history: any[],
    latestMessage: string,
    addressAlreadyGiven: boolean,
    settings: StoreSettings,
    lastConversationSummary: string | null = null,
    store: any = null,
  ): string {
```

Replace with:

```typescript
  private buildSystemPrompt(
    basePrompt: string,
    customer: any,
    orders: any[],
    appointments: any[],
    products: any[],
    services: any[],
    fechaActual: string,
    horaActual: string,
    history: any[],
    latestMessage: string,
    addressAlreadyGiven: boolean,
    settings: StoreSettings,
    lastConversationSummary: string | null = null,
    store: any = null,
    activeStaff: Array<{ staffId: string; name: string }> = [],
  ): string {
```

Then find the `agendamientoSection` const (around line 1677). Replace the entire const with:

```typescript
    const staffLabel = (store?.staffLabel ?? 'profesional').toLowerCase();
    const staffLabelCap = staffLabel.charAt(0).toUpperCase() + staffLabel.slice(1);

    const staffBlock = activeStaff.length > 0
      ? `\nEQUIPO DISPONIBLE (${staffLabelCap}s):\n${activeStaff.map(s => `- ${s.name} (id: ${s.staffId})`).join('\n')}\n\nREGLA OBLIGATORIA DE AGENDAMIENTO CON EQUIPO:\n1. SIEMPRE pregunta: "¿Con qué ${staffLabel} quieres tu cita? Tenemos disponibles: ${activeStaff.map(s => s.name).join(', ')}"\n2. El cliente DEBE elegir un ${staffLabel} antes de confirmar.\n3. Una vez elegido, NO preguntes de nuevo.\n4. Si el ${staffLabel} elegido no está disponible en ese horario, avisa y sugiere otro horario o ${staffLabel} alternativo.`
      : '';

    const agendamientoSection = `FLUJO DE AGENDAMIENTO (CITAS Y SERVICIOS):

Cuando el cliente quiera agendar, necesito:
  a) Qué necesita (tipo de cita o servicio)
  b) Fecha (día, mes y año)
  c) Hora
  d) Descripción breve
  e) Dirección (solo si es a domicilio o visita técnica)
  f) ${clienteDataPendiente ? 'Nombre completo del cliente' : '(nombre ya registrado)'}${staffBlock ? `\n  g) ${staffLabelCap} de preferencia` : ''}
  ${staffBlock ? 'h)' : 'g)'} Confirmación explícita
${staffBlock}
${clienteDataPendiente ? `Si el cliente quiere una cita y no tenemos su nombre, pide:\n"Para agendar necesito tu nombre completo."` : ''}

Cuando tengas todo, muestra el resumen y pide confirmación:
"¿Confirmamos tu cita de [servicio/tipo] para el [fecha] a las [hora]${staffBlock ? ' con [nombre del profesional]' : ''}?"

IMPORTANTE:
- Si el cliente menciona "mañana", calcula la fecha real desde hoy.
- Si la hora es ambigua (ej: "2"), confirma: "¿A las 2pm o 2am?"
- Para servicios VARIABLE, avisa que el precio lo confirma un asesor en la visita.`;
```

- [ ] **Step 8: Update tryExtractAndCreateAppointment signature**

Find the method signature (around line 1052):

```typescript
  private async tryExtractAndCreateAppointment(
    provider: AIProvider,
    apiKey: string,
    model: string,
    history: any[],
    latestMessage: string,
    customer: any,
    storeId: string,
    conversationId: string,
    services: any[],
  ): Promise<{ created: boolean; message?: string }> {
```

Replace with:

```typescript
  private async tryExtractAndCreateAppointment(
    provider: AIProvider,
    apiKey: string,
    model: string,
    history: any[],
    latestMessage: string,
    customer: any,
    storeId: string,
    conversationId: string,
    services: any[],
    activeStaff: Array<{ staffId: string; name: string }> = [],
  ): Promise<{ created: boolean; message?: string }> {
```

- [ ] **Step 9: Inject staff list into extractor prompt**

Find the `servicesCatalog` const (around line 1114) inside `tryExtractAndCreateAppointment`. After it, add:

```typescript
      const staffCatalog = activeStaff.length > 0
        ? `\nEQUIPO DISPONIBLE:\n${activeStaff.map(s => `- "${s.name}" → staffId: "${s.staffId}"`).join('\n')}\n`
        : '';
```

Then find `const appointmentPrompt = \`Eres un extractor...` (around line 1139) and inject `staffCatalog` after the `alreadyCreatedBlock`:

```typescript
      const appointmentPrompt = `Eres un extractor de datos para agendamiento de citas. Lee la conversación y extrae los datos en JSON.

FECHA ACTUAL: ${fechaHoy} (Colombia, zona horaria America/Bogota)
${alreadyCreatedBlock}
${staffCatalog}
${servicesCatalog}

CONVERSACIÓN:
${conversationText}

${customerDataInstruction}

REGLAS ESTRICTAS:
1. "complete":true SOLO si se cumplen TODAS las condiciones:
   a) Fecha específica (día y mes como mínimo)
   b) Hora específica
   c) Descripción de qué necesita el cliente
   d) Confirmación explícita del cliente (sí, confirmo, listo, dale, ok, etc.)
   e) Si se requiere nombre del cliente: debe estar presente
   f) Si hay equipo disponible (staffCatalog no vacío): el cliente debe haber elegido un profesional
2. Si falta CUALQUIER condición → "complete":false
3. "scheduledDate": formato "YYYY-MM-DD". Calcula fechas relativas desde hoy (${fechaHoy}).
   - "mañana" = día siguiente
   - "el martes de la otra semana" = busca el martes de la semana que viene
   - "el lunes" = próximo lunes
4. "scheduledTime": formato "HH:MM" en 24h. "2pm" → "14:00", "4pm" → "16:00"
5. "address": dirección si es visita a domicilio. null si es en el local.
6. "customerCedula": extrae SOLO si el cliente la mencionó explícitamente. Si no → null.
7. "type": texto libre describiendo la cita (ej: "visita_tecnica", "instalación solar", "corte de cabello").
8. "staffId": si el cliente eligió un profesional, usa su ID del EQUIPO DISPONIBLE. Si no hay equipo o no eligió → null.

Responde ÚNICAMENTE con este JSON (sin markdown, sin texto adicional):
{
  "complete": boolean,
  "serviceId": "uuid o null",
  "serviceVariantId": "uuid o null",
  "type": "descripción del tipo de cita",
  "scheduledDate": "YYYY-MM-DD o null",
  "scheduledTime": "HH:MM o null",
  "durationMinutes": number | null,
  "agreedPrice": number | null,
  "description": "descripción de qué se va a hacer o null",
  "address": "dirección si aplica o null",
  "notes": "notas adicionales o null",
  "reason": "por qué complete es true o false",
  "customerName": "nombre completo o null",
  "customerCedula": "número de cédula o null (solo si fue mencionado)",
  "staffId": "uuid del profesional elegido o null",
  "staffName": "nombre del profesional elegido o null"
}`;
```

- [ ] **Step 10: Pass staffId when creating appointment from AI**

Find the `prisma.$transaction` that creates the appointment from AI (around line 1418):

```typescript
          const appt = await tx.appointment.create({
            data: {
              storeId,
              customerId:       customer.customerId,
              serviceId:        extracted.serviceId        ?? null,
              serviceVariantId: extracted.serviceVariantId ?? null,
              type:             extracted.type             ?? 'cita',
```

Replace with:

```typescript
          const appt = await tx.appointment.create({
            data: {
              storeId,
              customerId:       customer.customerId,
              serviceId:        extracted.serviceId        ?? null,
              serviceVariantId: extracted.serviceVariantId ?? null,
              staffId:          extracted.staffId          ?? null,
              type:             extracted.type             ?? 'cita',
```

- [ ] **Step 11: Include staff name in AI confirmation message**

Find the confirmation message return (around line 1473):

```typescript
      return {
        created: true,
        message:
          `¡Cita agendada${nombreCliente}! ✅\n\n` +
          `📆 *Fecha:* ${fechaFormateada}\n` +
          `🕐 *Hora:* ${horaFormateada}` +
          (durationMinutes ? `\n⏱ *Duración estimada:* ${Math.floor(durationMinutes / 60)}h${durationMinutes % 60 > 0 ? ` ${durationMinutes % 60}min` : ''}` : '') +
          (extracted.agreedPrice ? `\n💰 *Precio acordado:* $${Number(extracted.agreedPrice).toLocaleString('es-CO')}` : '') +
          (extracted.address ? `\n📍 *Dirección:* ${extracted.address}` : '') +
          (extracted.description ? `\n📝 *Descripción:* ${extracted.description}` : '') +
          `\n\nUn asesor confirmará tu cita pronto. ¡Gracias! 😊`,
      };
```

Replace with:

```typescript
      const staffLine = extracted.staffName
        ? `\n👤 *Profesional:* ${extracted.staffName}`
        : '';

      return {
        created: true,
        message:
          `¡Cita agendada${nombreCliente}! ✅\n\n` +
          `📆 *Fecha:* ${fechaFormateada}\n` +
          `🕐 *Hora:* ${horaFormateada}` +
          staffLine +
          (durationMinutes ? `\n⏱ *Duración estimada:* ${Math.floor(durationMinutes / 60)}h${durationMinutes % 60 > 0 ? ` ${durationMinutes % 60}min` : ''}` : '') +
          (extracted.agreedPrice ? `\n💰 *Precio acordado:* $${Number(extracted.agreedPrice).toLocaleString('es-CO')}` : '') +
          (extracted.address ? `\n📍 *Dirección:* ${extracted.address}` : '') +
          (extracted.description ? `\n📝 *Descripción:* ${extracted.description}` : '') +
          `\n\nUn asesor confirmará tu cita pronto. ¡Gracias! 😊`,
      };
```

- [ ] **Step 12: Verify compile**

```bash
npm run build 2>&1 | tail -5
```

Expected: no TypeScript errors.

- [ ] **Step 13: Commit**

```bash
git add src/ai/ai.service.ts
git commit -m "feat: inject staff into AI system prompt and appointment extractor"
```

---

## Task 6: Frontend api.ts — staff endpoints + update appointments

**Files:**
- Modify: `src/services/api.ts` in stockup-frontend

- [ ] **Step 1: Add staff CRUD endpoints**

In `src/services/api.ts`, add after the `deleteAppointment` export (around line 314):

```typescript
// ── Staff ─────────────────────────────────────────────────────────────────────
export const getStaff = () =>
  api.get('/staff');

export const createStaff = (data: { name: string; schedule?: Record<string, any> | null }) =>
  api.post('/staff', data);

export const updateStaff = (id: string, data: { name?: string; isActive?: boolean; schedule?: Record<string, any> | null }) =>
  api.patch(`/staff/${id}`, data);

export const deleteStaff = (id: string) =>
  api.delete(`/staff/${id}`);
```

- [ ] **Step 2: Update getAppointments to accept staffId**

Find the `getAppointments` export (around line 274):

```typescript
export const getAppointments = (params?: {
  status?: string;
  type?: string;
  from?: string;
  to?: string;
  serviceId?: string;
  priority?: string;
}) => api.get('/appointments', { params });
```

Replace with:

```typescript
export const getAppointments = (params?: {
  status?: string;
  type?: string;
  from?: string;
  to?: string;
  serviceId?: string;
  staffId?: string;
  priority?: string;
}) => api.get('/appointments', { params });
```

- [ ] **Step 3: Update createAppointment to accept staffId**

Find the `createAppointment` export (around line 292):

```typescript
export const createAppointment = (data: {
  customerId: string;
  serviceId?: string;
  serviceVariantId?: string;
  type?: string;
  priority?: string;
  source?: string;
  scheduledAt: string;
  endsAt?: string;
  durationMinutes?: number;
  description?: string;
  address?: string;
  notes?: string;
  internalNotes?: string;
  agreedPrice?: number;
  forceSchedule?: boolean;
}) => api.post('/appointments', data);
```

Replace with:

```typescript
export const createAppointment = (data: {
  customerId: string;
  serviceId?: string;
  serviceVariantId?: string;
  staffId?: string;
  type?: string;
  priority?: string;
  source?: string;
  scheduledAt: string;
  endsAt?: string;
  durationMinutes?: number;
  description?: string;
  address?: string;
  notes?: string;
  internalNotes?: string;
  agreedPrice?: number;
  forceSchedule?: boolean;
}) => api.post('/appointments', data);
```

- [ ] **Step 4: Commit**

```bash
cd C:\Users\alexp\Desktop\proyectos\stockup-frontend
git add src/services/api.ts
git commit -m "feat: add staff API endpoints and staffId to appointments API"
```

---

## Task 7: Frontend Config.tsx — staffLabel in Negocio + new Equipo tab

**Files:**
- Modify: `src/pages/Config.tsx` in stockup-frontend

- [ ] **Step 1: Add imports**

At the top of `Config.tsx`, add the staff API imports to the existing import from `../services/api`:

```typescript
import {
  getStore, updateStore, getBlockedContacts, addBlockedContact, removeBlockedContact,
  getAiConfig, updateAiConfig, getSubscriptionStatus, createCheckout,
  getStaff, createStaff, updateStaff, deleteStaff,
} from '../services/api';
```

Also add `Users` icon from lucide (for staff tab). Find the lucide import and add `Users`:

```typescript
import { ... , Users } from 'lucide-react';
```

- [ ] **Step 2: Add staffLabel to NegocioSection form state**

In `NegocioSection`, find the `useState` form initialization (around line 50). Add `staffLabel: 'Barbero'` to the form state object. Also add it to the `setForm` call in `useEffect`:

In the `useState`:
```typescript
    staffLabel: 'Barbero' as string,
```

In the `useEffect` setForm:
```typescript
        staffLabel:         d.staffLabel         ?? 'Barbero',
```

In `handleSave`, add to the `updateStore` call:
```typescript
        staffLabel:         form.staffLabel       || undefined,
```

- [ ] **Step 3: Add staffLabel dropdown to NegocioSection form**

Find the card that contains "Horarios de atención" (Card 5, around line 346). Just before that card (after Card 4's closing `</div>`), add a new card for staff label:

```tsx
      {/* Card 5 — Tipo de personal */}
      <div className={card}>
        <CardHeader
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>}
          title="Tipo de personal" sub="¿Cómo se llama el personal en tu negocio?"
        />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {['Barbero', 'Estilista', 'Técnico', 'Asesor'].map(opt => (
            <button
              key={opt}
              type="button"
              onClick={() => setf('staffLabel', opt)}
              className={`py-2 px-4 rounded-xl border text-sm font-medium transition ${
                form.staffLabel === opt
                  ? 'border-lime bg-lime/10 text-lime'
                  : 'border-border-default text-txt-secondary hover:bg-surface-overlay'
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
        {!['Barbero', 'Estilista', 'Técnico', 'Asesor'].includes(form.staffLabel) || (
          <input
            value={form.staffLabel}
            onChange={e => setf('staffLabel', e.target.value)}
            placeholder="Ej: Colorista, Nutricionista..."
            className={`mt-2 ${ic}`}
          />
        )}
        <input
          value={form.staffLabel}
          onChange={e => setf('staffLabel', e.target.value)}
          placeholder="O escribe otro nombre..."
          className={`mt-2 ${ic}`}
        />
      </div>
```

Note: This adds both the buttons AND a free-text input so the admin can always type a custom label. The buttons just pre-fill the input.

Actually, let me simplify this card. The buttons are quick-selects, and below is always a text input showing the current value:

```tsx
      {/* Card 5 — Tipo de personal */}
      <div className={card}>
        <CardHeader
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>}
          title="Tipo de personal" sub="¿Cómo se llama el personal en tu negocio?"
        />
        <div className="flex flex-wrap gap-2 mb-3">
          {['Barbero', 'Estilista', 'Técnico', 'Asesor'].map(opt => (
            <button key={opt} type="button" onClick={() => setf('staffLabel', opt)}
              className={`py-1.5 px-4 rounded-xl border text-sm font-medium transition ${
                form.staffLabel === opt
                  ? 'border-lime bg-lime/10 text-lime'
                  : 'border-border-default text-txt-secondary hover:bg-surface-overlay'
              }`}>
              {opt}
            </button>
          ))}
        </div>
        <input
          value={form.staffLabel}
          onChange={e => setf('staffLabel', e.target.value)}
          placeholder="Nombre del tipo de personal..."
          className={ic}
        />
      </div>
```

- [ ] **Step 4: Add EquipoSection component**

Before the `export default function Config()` line, add the complete `EquipoSection` component:

```tsx
// ── BusinessHoursEditor — reutilizable para staff schedule ───────────────────

function BusinessHoursEditor({
  hours,
  onChange,
}: {
  hours: BusinessHoursJson;
  onChange: (h: BusinessHoursJson) => void;
}) {
  const setDay = (key: string, patch: Partial<DaySchedule>) =>
    onChange({ ...hours, [key]: { ...hours[key as keyof BusinessHoursJson], ...patch } });

  const setShift = (key: string, shift: 'shift1' | 'shift2', field: 'open' | 'close', val: string) => {
    const day = { ...hours[key as keyof BusinessHoursJson] };
    const existing = day[shift] ?? { open: '08:00', close: '18:00' };
    onChange({ ...hours, [key]: { ...day, [shift]: { ...existing, [field]: val } } });
  };

  return (
    <div className="space-y-2">
      {DAY_KEYS.map(key => {
        const day = hours[key];
        return (
          <div key={key} className={`flex flex-wrap items-center gap-3 py-2 px-3 rounded-xl border transition ${day.isOpen ? 'border-border-default bg-surface-elevated' : 'border-border-subtle bg-surface opacity-60'}`}>
            <Toggle value={day.isOpen} onChange={() => setDay(key, { isOpen: !day.isOpen })} />
            <span className="text-sm font-medium text-txt-primary w-20 flex-shrink-0">{DAY_LABELS[key]}</span>
            {day.isOpen ? (
              <>
                <div className="flex items-center gap-1.5">
                  <input type="time" value={day.shift1?.open ?? '08:00'}
                    onChange={e => setShift(key, 'shift1', 'open', e.target.value)}
                    className="px-2 py-1 rounded-lg border border-border-default bg-surface text-sm text-txt-primary" />
                  <span className="text-txt-tertiary text-xs">→</span>
                  <input type="time" value={day.shift1?.close ?? '12:00'}
                    onChange={e => setShift(key, 'shift1', 'close', e.target.value)}
                    className="px-2 py-1 rounded-lg border border-border-default bg-surface text-sm text-txt-primary" />
                </div>
                <button type="button"
                  onClick={() => setDay(key, { shift2: day.shift2 ? null : { open: '14:00', close: '18:00' } })}
                  className={`text-xs px-2 py-1 rounded-lg border transition flex-shrink-0 ${day.shift2 ? 'border-lime text-lime bg-lime/10' : 'border-border-default text-txt-tertiary hover:bg-surface-overlay'}`}>
                  {day.shift2 ? '− Tarde' : '+ Tarde'}
                </button>
                {day.shift2 && (
                  <div className="flex items-center gap-1.5">
                    <input type="time" value={day.shift2.open}
                      onChange={e => setShift(key, 'shift2', 'open', e.target.value)}
                      className="px-2 py-1 rounded-lg border border-border-default bg-surface text-sm text-txt-primary" />
                    <span className="text-txt-tertiary text-xs">→</span>
                    <input type="time" value={day.shift2.close}
                      onChange={e => setShift(key, 'shift2', 'close', e.target.value)}
                      className="px-2 py-1 rounded-lg border border-border-default bg-surface text-sm text-txt-primary" />
                  </div>
                )}
              </>
            ) : (
              <span className="text-xs text-txt-tertiary italic">Cerrado</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── TAB: EQUIPO ────────────────────────────────────────────────────────────────

interface StaffMember {
  staffId: string;
  name: string;
  isActive: boolean;
  schedule: BusinessHoursJson | null;
  createdAt: string;
}

function EquipoSection({ storeId }: { storeId: string }) {
  const [staff,       setStaff]       = useState<StaffMember[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [showModal,   setShowModal]   = useState(false);
  const [editing,     setEditing]     = useState<StaffMember | null>(null);
  const [deleting,    setDeleting]    = useState<string | null>(null);
  const [staffLabel,  setStaffLabel]  = useState('profesional');
  const [error,       setError]       = useState('');

  useEffect(() => {
    Promise.all([getStaff(), getStore(storeId)])
      .then(([sr, storeR]) => {
        setStaff(sr.data);
        setStaffLabel((storeR.data?.staffLabel ?? 'profesional').toLowerCase());
      })
      .catch(() => setError('Error cargando el equipo'))
      .finally(() => setLoading(false));
  }, [storeId]);

  const staffLabelCap = staffLabel.charAt(0).toUpperCase() + staffLabel.slice(1);

  const handleDelete = async (id: string) => {
    if (!window.confirm(`¿Desactivar a este ${staffLabel}?`)) return;
    setDeleting(id);
    try {
      await deleteStaff(id);
      setStaff(p => p.filter(s => s.staffId !== id));
    } catch {
      setError('Error al desactivar');
    } finally {
      setDeleting(null);
    }
  };

  if (loading) return <Spinner />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-txt-secondary">
          {staff.length === 0
            ? `Aún no tienes ${staffLabel}s registrados.`
            : `${staff.length} ${staffLabel}${staff.length !== 1 ? 's' : ''} activo${staff.length !== 1 ? 's' : ''}`}
        </p>
        <button
          onClick={() => { setEditing(null); setShowModal(true); }}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-[#0A0A0F] transition"
          style={{ background: 'linear-gradient(135deg, #D4FF00, #A3CC00)' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Agregar {staffLabelCap}
        </button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {staff.length > 0 && (
        <div className="rounded-2xl border border-border-default overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-elevated">
              <tr>
                <th className="text-left px-4 py-3 text-txt-secondary font-medium">Nombre</th>
                <th className="text-left px-4 py-3 text-txt-secondary font-medium hidden sm:table-cell">Horario</th>
                <th className="text-right px-4 py-3 text-txt-secondary font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {staff.map(s => (
                <tr key={s.staffId} className="bg-surface hover:bg-surface-elevated transition">
                  <td className="px-4 py-3 text-txt-primary font-medium">{s.name}</td>
                  <td className="px-4 py-3 text-txt-secondary hidden sm:table-cell">
                    {s.schedule ? 'Horario propio' : 'Hereda del negocio'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => { setEditing(s); setShowModal(true); }}
                        className="px-3 py-1.5 rounded-lg text-xs border border-border-default text-txt-secondary hover:bg-surface-overlay transition"
                      >
                        Editar
                      </button>
                      <button
                        onClick={() => handleDelete(s.staffId)}
                        disabled={deleting === s.staffId}
                        className="px-3 py-1.5 rounded-lg text-xs border border-red-800/50 text-red-400 hover:bg-red-900/20 transition disabled:opacity-50"
                      >
                        {deleting === s.staffId ? '...' : 'Desactivar'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <StaffModal
          storeId={storeId}
          staffLabel={staffLabelCap}
          editing={editing}
          onClose={() => setShowModal(false)}
          onSaved={(updated) => {
            if (editing) {
              setStaff(p => p.map(s => s.staffId === updated.staffId ? updated : s));
            } else {
              setStaff(p => [...p, updated]);
            }
            setShowModal(false);
          }}
        />
      )}
    </div>
  );
}

function StaffModal({
  storeId, staffLabel, editing, onClose, onSaved,
}: {
  storeId: string;
  staffLabel: string;
  editing: StaffMember | null;
  onClose: () => void;
  onSaved: (s: StaffMember) => void;
}) {
  const [name,          setName]          = useState(editing?.name ?? '');
  const [hasOwnSchedule, setHasOwnSchedule] = useState(!!editing?.schedule);
  const [schedule,      setSchedule]      = useState<BusinessHoursJson>(
    (editing?.schedule as BusinessHoursJson | null) ?? DEFAULT_BUSINESS_HOURS
  );
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('El nombre es obligatorio.'); return; }
    setSaving(true); setError('');
    try {
      const payload = { name: name.trim(), schedule: hasOwnSchedule ? schedule : null };
      let res;
      if (editing) {
        res = await updateStaff(editing.staffId, payload);
      } else {
        res = await createStaff(payload);
      }
      onSaved(res.data);
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const ic = 'w-full px-4 py-3 rounded-xl border border-border-default bg-surface-elevated focus:outline-none focus:ring-2 focus:ring-lime/30 text-sm text-txt-primary placeholder:text-txt-tertiary';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle sticky top-0 bg-surface z-10">
          <h2 className="text-base font-bold text-txt-primary">
            {editing ? `Editar ${staffLabel}` : `Nuevo ${staffLabel}`}
          </h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg text-txt-tertiary hover:bg-surface-overlay">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div>
            <label className="block text-xs font-semibold text-txt-secondary mb-1.5">Nombre *</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder={`Nombre del ${staffLabel.toLowerCase()}`} className={ic} required />
          </div>

          <div className="flex items-center gap-3">
            <Toggle value={hasOwnSchedule} onChange={() => setHasOwnSchedule(p => !p)} />
            <span className="text-sm text-txt-primary">Tiene horario propio</span>
          </div>

          {hasOwnSchedule ? (
            <div>
              <p className="text-xs text-txt-secondary mb-2">Define cuándo atiende este {staffLabel.toLowerCase()}:</p>
              <BusinessHoursEditor hours={schedule} onChange={setSchedule} />
            </div>
          ) : (
            <p className="text-sm text-txt-tertiary italic">Hereda el horario del negocio</p>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-border-default text-sm text-txt-secondary hover:bg-surface-overlay transition">
              Cancelar
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-[#0A0A0F] disabled:opacity-60 transition"
              style={{ background: 'linear-gradient(135deg, #D4FF00, #A3CC00)' }}>
              {saving ? 'Guardando...' : editing ? 'Guardar cambios' : `Crear ${staffLabel}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Add Equipo tab to Config tabs**

In `Config.tsx`, find the tabs type and the `tabs` array (around line 863):

```typescript
const [activeTab, setActiveTab] = useState<'negocio'|'ia'|'excluidos'|'suscripcion'>('negocio');
```

Replace with:

```typescript
const [activeTab, setActiveTab] = useState<'negocio'|'ia'|'excluidos'|'suscripcion'|'equipo'>('negocio');
```

Find the `tabs` array and add Equipo:

```typescript
  const tabs = [
    { id: 'negocio',     label: 'Negocio',      icon: ... },
    { id: 'ia',          label: 'Asistente IA',  icon: ... },
    { id: 'excluidos',   label: 'Excluidos',     icon: ... },
    { id: 'suscripcion', label: 'Suscripción',   icon: ... },
    { id: 'equipo',      label: 'Equipo',        icon: <Users size={16} /> },
  ];
```

Find the tab content render area and add the equipo case:

```typescript
      {activeTab === 'negocio'     && <NegocioSection    storeId={storeId} />}
      {activeTab === 'ia'          && <AiConfigSection   storeId={storeId} />}
      {activeTab === 'excluidos'   && <ExcluidosSection  />}
      {activeTab === 'suscripcion' && <SuscripcionSection storeId={storeId} />}
      {activeTab === 'equipo'      && <EquipoSection     storeId={storeId} />}
```

- [ ] **Step 6: Verify no TypeScript/ESLint errors**

```bash
cd C:\Users\alexp\Desktop\proyectos\stockup-frontend
npm run build 2>&1 | tail -10
```

Expected: compiled successfully.

- [ ] **Step 7: Commit**

```bash
git add src/pages/Config.tsx src/services/api.ts
git commit -m "feat: add staffLabel field and Equipo tab to Config"
```

---

## Task 8: Frontend Appointments.tsx — column, filter, calendar card, modal staff selector

**Files:**
- Modify: `src/pages/Appointments.tsx` in stockup-frontend

- [ ] **Step 1: Add StaffInfo type and update Appointment interface**

Find the types block at the top (around line 22). Add `StaffInfo`:

```typescript
interface StaffInfo    { staffId: string; name: string; }
```

Update the `Appointment` interface to include staff:

```typescript
interface Appointment {
  appointmentId:   string; type: string;
  status:          AppointmentStatus; priority: AppointmentPriority; source: AppointmentSource;
  scheduledAt:     string; endsAt: string | null; durationMinutes: number | null;
  description:     string | null; address: string | null; notes: string | null;
  internalNotes:   string | null; agreedPrice: string | null;
  cancelReason:    string | null; createdAt: string;
  customer:        Customer; service: ServiceInfo | null; serviceVariant: VariantInfo | null;
  staff:           StaffInfo | null;
  // Payment fields
  paymentStatus?:      string | null;
  paymentMethod?:      string | null;
  paymentAmount?:      number | null;
  paymentNotes?:       string | null;
  paymentConfirmedAt?: string | null;
  paymentProofUrl?:    string | null;
  // Pending action fields
  pendingAction?:      string | null;
  pendingActionReason?: string | null;
  pendingActionData?:  Record<string, any> | null;
}
```

- [ ] **Step 2: Add staff state variables**

In the `Appointments` component, after the existing state declarations (around line 1207), add:

```typescript
  const [filterStaffId,  setFilterStaffId]  = useState('');
  const [staffList,      setStaffList]      = useState<StaffInfo[]>([]);
  const [staffLabel,     setStaffLabel]     = useState('Profesional');
```

- [ ] **Step 3: Load staff list and staffLabel**

The component already loads `getStore(storeId)` for business hours (around line 1213). Extend that to also load staff:

```typescript
  useEffect(() => {
    if (!storeId) return;
    Promise.all([
      getStore(storeId as string),
      getStaff(),
    ]).then(([storeRes, staffRes]) => {
      if (storeRes.data?.businessHours) setBusinessHours(storeRes.data.businessHours);
      if (storeRes.data?.staffLabel)    setStaffLabel(storeRes.data.staffLabel);
      setStaffList(staffRes.data ?? []);
    }).catch(() => {});
  }, [storeId]);
```

Add `getStaff` to the imports from `../services/api`:

```typescript
import {
  getAppointments, getAppointmentStats,
  updateAppointment, getAppointmentTimeline,
  createAppointment, getCustomers, getServices,
  getStore, getStaff,
} from '../services/api';
```

- [ ] **Step 4: Pass staffId filter to getAppointments**

Find the `load` callback (around line 1220). Update the params object to include staffId:

```typescript
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const p: Record<string,string> = {};
      if (filterStatus)        p.status           = filterStatus;
      if (filterType)          p.type             = filterType;
      if (filterPendingAction) p.hasPendingAction = filterPendingAction;
      if (filterStaffId)       p.staffId          = filterStaffId;
      const [aR, sR] = await Promise.all([getAppointments(p), getAppointmentStats()]);
      setAppointments(aR.data); setStats(sR.data);
    } catch { setError('Error cargando agendamientos.'); }
    finally { setLoading(false); }
  }, [filterStatus, filterType, filterPendingAction, filterStaffId]);
```

- [ ] **Step 5: Add staff filter to filters bar**

Find the filter selects in the JSX (around line 1335 — the `filterStatus` select). After the status select, add the staff filter:

```tsx
            {staffList.length > 0 && (
              <select
                value={filterStaffId}
                onChange={e => setFilterStaffId(e.target.value)}
                className="px-3 py-2 rounded-xl border border-border-default bg-surface-elevated text-sm text-txt-primary focus:outline-none focus:ring-2 focus:ring-lime/30"
              >
                <option value="">Todos los {staffLabel.toLowerCase()}s</option>
                {staffList.map(s => (
                  <option key={s.staffId} value={s.staffId}>{s.name}</option>
                ))}
              </select>
            )}
```

Also add `filterStaffId` to the "clear filters" condition (around line 1366):

```tsx
            {(search || filterStatus || filterType || filterPendingAction || filterStaffId) && (
              <button onClick={() => { setSearch(''); setFilterStatus(''); setFilterType(''); setFilterPendingAction(''); setFilterStaffId(''); }}
                ...
```

- [ ] **Step 6: Add staff column to list view**

Find the list view table headers. Locate the `<th>` for "Servicio" and add a new `<th>` after it:

```tsx
                <th className="px-4 py-3 text-left text-xs font-medium text-txt-secondary uppercase tracking-wider hidden md:table-cell">
                  {staffLabel}
                </th>
```

In the table body rows, find the service `<td>` cell and add a staff `<td>` after it:

```tsx
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className="text-sm text-txt-secondary">
                          {a.staff?.name ?? '—'}
                        </span>
                      </td>
```

- [ ] **Step 7: Show staff name on calendar cards**

Find the calendar card rendering in the calendar view. Look for where `a.customer.name` or the appointment type is shown on a card. Add the staff name below:

```tsx
                        {a.staff && (
                          <span className="text-[10px] text-txt-tertiary truncate block">
                            {a.staff.name}
                          </span>
                        )}
```

- [ ] **Step 8: Update NewAppointmentModal to accept staff**

Find the `NewAppointmentModal` function signature (around line 677):

```typescript
function NewAppointmentModal({ storeId, businessHours, onCreated, onClose }: {
  storeId: string;
  businessHours: BusinessHoursJson | null;
  onCreated: () => void;
  onClose: () => void;
}) {
```

Replace with:

```typescript
function NewAppointmentModal({ storeId, businessHours, staff, staffLabel, onCreated, onClose }: {
  storeId: string;
  businessHours: BusinessHoursJson | null;
  staff: StaffInfo[];
  staffLabel: string;
  onCreated: () => void;
  onClose: () => void;
}) {
```

Add `staffId: ''` to the form state:

```typescript
  const [form, setForm] = useState({
    customerId:      '',
    serviceId:       '',
    staffId:         '',
    scheduledAt:     defaultDT,
    durationMinutes: '60',
    description:     '',
    address:         '',
    agreedPrice:     '',
    notes:           '',
    priority:        'NORMAL' as AppointmentPriority,
  });
```

Pass `staffId` in the `createAppointment` call inside `doSubmit`:

```typescript
      await createAppointment({
        customerId:      form.customerId,
        serviceId:       form.serviceId       || undefined,
        staffId:         form.staffId         || undefined,
        scheduledAt:     new Date(form.scheduledAt).toISOString(),
        durationMinutes: form.durationMinutes  ? Number(form.durationMinutes) : undefined,
        description:     form.description     || undefined,
        address:         form.address         || undefined,
        agreedPrice:     form.agreedPrice      ? Number(form.agreedPrice) : undefined,
        notes:           form.notes           || undefined,
        priority:        form.priority,
        source:          'MANUAL',
        forceSchedule:   force || undefined,
      });
```

Add the staff selector in the modal form JSX, after the service selector:

```tsx
            {staff.length > 0 && (
              <div>
                <label className="block text-xs font-semibold text-txt-secondary mb-1.5">{staffLabel}</label>
                <select
                  value={form.staffId}
                  onChange={e => setForm(f => ({ ...f, staffId: e.target.value }))}
                  className={ic}
                >
                  <option value="">Sin asignar</option>
                  {staff.map(s => (
                    <option key={s.staffId} value={s.staffId}>{s.name}</option>
                  ))}
                </select>
              </div>
            )}
```

- [ ] **Step 9: Pass staff props to NewAppointmentModal in render**

Find the `<NewAppointmentModal` render (around line 1399):

```tsx
        <NewAppointmentModal
          storeId={storeId as string}
          businessHours={businessHours}
          onCreated={() => { setShowNewAppt(false); load(); }}
          onClose={() => setShowNewAppt(false)}
        />
```

Replace with:

```tsx
        <NewAppointmentModal
          storeId={storeId as string}
          businessHours={businessHours}
          staff={staffList}
          staffLabel={staffLabel}
          onCreated={() => { setShowNewAppt(false); load(); }}
          onClose={() => setShowNewAppt(false)}
        />
```

- [ ] **Step 10: Verify build**

```bash
npm run build 2>&1 | tail -10
```

Expected: compiled successfully, no unused variable errors.

- [ ] **Step 11: Commit**

```bash
git add src/pages/Appointments.tsx
git commit -m "feat: add staff column, filter, calendar label and modal selector to Appointments"
```

---

## Task 9: Deploy backend + frontend

- [ ] **Step 1: Push backend to GitHub (triggers auto-deploy on InstaPods)**

```bash
cd C:\Users\alexp\Desktop\proyectos\whatsapp-crm
git push origin main
```

InstaPods auto-deploy runs: `npm install && npx prisma db push --accept-data-loss && npx prisma generate && npm run build`

- [ ] **Step 2: Verify backend health after deploy**

```bash
curl https://whatsapp-crm.ash-1.instapods.app/health
```

Expected: `{"status":"ok"}` or similar.

- [ ] **Step 3: Test staff endpoints manually**

Use the app or Postman with a valid JWT:
- `GET /staff` → should return `[]` for existing stores
- `POST /staff` with `{ "name": "Carlos" }` → should return the new staff member
- `GET /appointments` → each appointment should have `"staff": null` for existing ones

- [ ] **Step 4: Push frontend to GitHub (triggers Vercel deploy)**

```bash
cd C:\Users\alexp\Desktop\proyectos\stockup-frontend
git push origin main
```

- [ ] **Step 5: Smoke test in production**

1. Open `https://stockup-frontend.vercel.app`
2. Go to Config → Equipo tab → add a barbero
3. Go to Appointments → new appointment → verify staff selector appears
4. Verify staff column visible in list
5. Test filter by staff
