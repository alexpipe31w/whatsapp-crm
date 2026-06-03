# Appointment Notifications, Payments & Reports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement complete appointment lifecycle notifications (WA + email), payment tracking with AI proof detection, cancel/reschedule flows with admin approval, automated reminders (8h/2h/1h), and daily sales reports.

**Architecture:** Three new NestJS modules (NotificationsModule, RemindersModule, ReportsModule) + AI enhancements + frontend payment/pending-actions UI. NotificationsService is the single hub for all WA+email events — all other services inject it. Circular dep WhatsApp↔Notifications broken via `forwardRef`.

**Tech Stack:** NestJS 11, Prisma 6, PostgreSQL/Neon, Baileys v7 (WA), Brevo (email), React 19 + Tailwind (frontend)

---

## File Map

### Create
- `src/notifications/notifications.module.ts`
- `src/notifications/notifications.service.ts`
- `src/reminders/reminders.module.ts`
- `src/reminders/reminders.service.ts`
- `src/reports/reports.module.ts`
- `src/reports/reports.service.ts`
- `src/reports/reports.controller.ts`

### Modify
- `prisma/schema.prisma` — Appointment new fields, DailyReport model, Store.adminPhone
- `src/appointments/dto/update-appointment.dto.ts` — payment fields + pendingAction resolution
- `src/appointments/appointments.service.ts` — handle payment + pendingAction in update()
- `src/appointments/appointments.module.ts` — import NotificationsModule
- `src/appointments/appointments.controller.ts` — inject NotificationsService, trigger notifications
- `src/ai/ai.service.ts` — payment proof detection + cancel/reschedule flow
- `src/ai/ai.module.ts` — import NotificationsModule
- `src/app.module.ts` — import RemindersModule, ReportsModule
- `stockup-frontend/src/pages/Appointments.tsx` — payment tab + pending actions UI
- `stockup-frontend/src/pages/Analytics.tsx` — daily report section
- `stockup-frontend/src/services/api.ts` — new API calls

---

## Task 1: Prisma Schema — New Fields

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add fields to Appointment model**

In `prisma/schema.prisma`, inside `model Appointment`, replace the existing reminder block and add after `reminderSentAt`:

```prisma
  // ── Recordatorios granulares ──────────────────────────────────────────────
  reminderSentAt   DateTime? @map("reminder_sent_at")   // legacy — keep for compat
  reminder8hSentAt DateTime? @map("reminder_8h_sent_at")
  reminder2hSentAt DateTime? @map("reminder_2h_sent_at")
  reminder1hSentAt DateTime? @map("reminder_1h_sent_at")

  // ── Pagos ─────────────────────────────────────────────────────────────────
  paymentStatus      String    @default("PENDING") @map("payment_status") @db.VarChar(20)
  paymentMethod      String?   @map("payment_method")  @db.VarChar(50)
  paymentAmount      Decimal?  @map("payment_amount")  @db.Decimal(10, 2)
  paymentProofUrl    String?   @map("payment_proof_url") @db.Text
  paymentNotes       String?   @map("payment_notes")   @db.Text
  paymentConfirmedAt DateTime? @map("payment_confirmed_at")

  // ── Acciones pendientes (cancelar/reprogramar esperando aprobación) ────────
  pendingAction       String?   @map("pending_action")        @db.VarChar(50)
  pendingActionAt     DateTime? @map("pending_action_at")
  pendingActionData   Json?     @map("pending_action_data")
  pendingActionReason String?   @map("pending_action_reason") @db.Text
```

- [ ] **Step 2: Add adminPhone to Store model**

In `model Store`, after `ownerName`:
```prisma
  adminPhone  String?  @map("admin_phone") @db.VarChar(20)
```

Also add to the Store relations:
```prisma
  dailyReports    DailyReport[]
```

- [ ] **Step 3: Add DailyReport model**

After the `AppointmentTimeline` model, add:

```prisma
// ─── DailyReport ─────────────────────────────────────────────────────────────

model DailyReport {
  reportId         String   @id @default(uuid()) @map("report_id")
  storeId          String   @map("store_id")
  date             DateTime @map("date")
  appointmentsData Json     @map("appointments_data")
  paymentsData     Json     @map("payments_data")
  clientsData      Json     @map("clients_data")
  createdAt        DateTime @default(now()) @map("created_at")

  store Store @relation(fields: [storeId], references: [storeId])

  @@unique([storeId, date])
  @@index([storeId, date])
  @@map("daily_reports")
}
```

- [ ] **Step 4: Push schema to DB**

```bash
cd C:\Users\alexp\Desktop\proyectos\whatsapp-crm
npx prisma db push
```

Expected output: `Your database is now in sync with your Prisma schema.`

- [ ] **Step 5: Verify generated types**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(schema): add payment, pendingAction, reminders fields + DailyReport model"
```

---

## Task 2: NotificationService

**Files:**
- Create: `src/notifications/notifications.module.ts`
- Create: `src/notifications/notifications.service.ts`

- [ ] **Step 1: Create notifications.service.ts**

```typescript
// src/notifications/notifications.service.ts
import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';

type Appt = {
  appointmentId: string;
  storeId: string;
  scheduledAt: Date;
  endsAt?: Date | null;
  type: string;
  description?: string | null;
  address?: string | null;
  agreedPrice?: any;
  pendingAction?: string | null;
  pendingActionReason?: string | null;
  pendingActionData?: any;
  customer: { name?: string | null; phone: string; };
  service?: { name: string } | null;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma:    PrismaService,
    private readonly email:     EmailService,
    @Inject(forwardRef(() => WhatsappService))
    private readonly whatsapp:  WhatsappService,
  ) {}

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private formatDate(d: Date): string {
    return d.toLocaleDateString('es-CO', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: 'America/Bogota',
    });
  }

  private formatTime(d: Date): string {
    return d.toLocaleTimeString('es-CO', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
    });
  }

  private formatMoney(n: any): string {
    return `$${Number(n).toLocaleString('es-CO')}`;
  }

  private serviceName(appt: Appt): string {
    return appt.service?.name ?? appt.type ?? 'Cita';
  }

  private async getAdminEmail(storeId: string): Promise<string | null> {
    const user = await this.prisma.user.findFirst({
      where:  { storeId, role: 'admin' },
      select: { email: true },
    });
    return user?.email ?? null;
  }

  private async getAdminPhone(storeId: string): Promise<string | null> {
    const store = await this.prisma.store.findUnique({
      where:  { storeId },
      select: { adminPhone: true },
    });
    return store?.adminPhone ?? null;
  }

  private async sendWA(storeId: string, phone: string, msg: string): Promise<void> {
    try {
      await this.whatsapp.sendMessage(storeId, phone, msg);
    } catch (err: any) {
      this.logger.warn(`WA send failed to ${phone}: ${err.message}`);
    }
  }

  private async sendEmail(to: string, subject: string, html: string): Promise<void> {
    try {
      await this.email.send(to, subject, html);
    } catch (err: any) {
      this.logger.warn(`Email send failed to ${to}: ${err.message}`);
    }
  }

  private async withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T | null> {
    for (let i = 0; i < attempts; i++) {
      try { return await fn(); } catch (err: any) {
        if (i < attempts - 1) await new Promise(r => setTimeout(r, 1000));
        else this.logger.error(`Retry exhausted: ${err.message}`);
      }
    }
    return null;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /** IA creó una cita → notifica admin */
  async notifyAppointmentCreated(appt: Appt): Promise<void> {
    const cliente   = appt.customer.name ?? appt.customer.phone;
    const servicio  = this.serviceName(appt);
    const fecha     = this.formatDate(appt.scheduledAt);
    const hora      = this.formatTime(appt.scheduledAt);

    const waMsg = `📅 *Nueva cita agendada por IA*\n\n` +
      `👤 Cliente: ${cliente}\n` +
      `✂️ Servicio: ${servicio}\n` +
      `📆 Fecha: ${fecha}\n` +
      `🕐 Hora: ${hora}` +
      (appt.address ? `\n📍 Dirección: ${appt.address}` : '') +
      (appt.agreedPrice ? `\n💰 Precio: ${this.formatMoney(appt.agreedPrice)}` : '') +
      `\n\nConfirma desde el panel.`;

    const htmlEmail = `<p>Nueva cita creada automáticamente por el asistente IA.</p>
      <ul>
        <li><b>Cliente:</b> ${cliente}</li>
        <li><b>Servicio:</b> ${servicio}</li>
        <li><b>Fecha:</b> ${fecha}</li>
        <li><b>Hora:</b> ${hora}</li>
        ${appt.address ? `<li><b>Dirección:</b> ${appt.address}</li>` : ''}
        ${appt.agreedPrice ? `<li><b>Precio:</b> ${this.formatMoney(appt.agreedPrice)}</li>` : ''}
      </ul>
      <p>Confirma o gestiona desde el panel de citas.</p>`;

    const [adminEmail, adminPhone] = await Promise.all([
      this.getAdminEmail(appt.storeId),
      this.getAdminPhone(appt.storeId),
    ]);

    await Promise.allSettled([
      adminPhone ? this.withRetry(() => this.sendWA(appt.storeId, adminPhone, waMsg)) : Promise.resolve(),
      adminEmail ? this.withRetry(() => this.sendEmail(adminEmail, `Nueva cita: ${cliente} — ${fecha}`, htmlEmail)) : Promise.resolve(),
    ]);
  }

  /** Admin confirmó la cita → notifica cliente */
  async notifyAppointmentConfirmed(appt: Appt): Promise<void> {
    const servicio = this.serviceName(appt);
    const fecha    = this.formatDate(appt.scheduledAt);
    const hora     = this.formatTime(appt.scheduledAt);

    const waMsg = `✅ *¡Tu cita está confirmada!*\n\n` +
      `✂️ ${servicio}\n` +
      `📆 ${fecha}\n` +
      `🕐 ${hora}` +
      (appt.address ? `\n📍 ${appt.address}` : '') +
      (appt.agreedPrice ? `\n💰 Precio: ${this.formatMoney(appt.agreedPrice)}` : '') +
      `\n\n¡Te esperamos! 😊`;

    await this.withRetry(() => this.sendWA(appt.storeId, appt.customer.phone, waMsg));
  }

  /** Cron de recordatorios → notifica cliente */
  async notifyReminder(appt: Appt, window: '8h' | '2h' | '1h'): Promise<void> {
    const servicio = this.serviceName(appt);
    const fecha    = this.formatDate(appt.scheduledAt);
    const hora     = this.formatTime(appt.scheduledAt);
    const cuando   = window === '8h' ? 'en 8 horas' : window === '2h' ? 'en 2 horas' : 'en 1 hora';

    const waMsg = `⏰ *Recordatorio de cita*\n\n` +
      `Tienes una cita *${cuando}*.\n\n` +
      `✂️ ${servicio}\n` +
      `📆 ${fecha}\n` +
      `🕐 ${hora}` +
      (appt.address ? `\n📍 ${appt.address}` : '') +
      `\n\nSi necesitas cancelar o reprogramar, escríbenos con anticipación.`;

    await this.withRetry(() => this.sendWA(appt.storeId, appt.customer.phone, waMsg));
  }

  /** IA detectó solicitud de cancelar/reprogramar → notifica admin */
  async notifyPendingAction(appt: Appt, action: 'cancel' | 'reschedule'): Promise<void> {
    const cliente  = appt.customer.name ?? appt.customer.phone;
    const fecha    = this.formatDate(appt.scheduledAt);
    const tipo     = action === 'cancel' ? 'cancelar' : 'reprogramar';
    const motivo   = appt.pendingActionReason ?? 'Sin motivo especificado';
    let nuevaFecha = '';
    if (action === 'reschedule' && appt.pendingActionData) {
      const d = appt.pendingActionData as any;
      nuevaFecha = d.newDate ? ` para el ${d.newDate}${d.newTime ? ' a las ' + d.newTime : ''}` : '';
    }

    const waMsg = `⚠️ *Solicitud de ${tipo}*\n\n` +
      `👤 ${cliente} quiere ${tipo} su cita del ${fecha}${nuevaFecha}.\n` +
      `📝 Motivo: ${motivo}\n\n` +
      `Aprueba o rechaza desde el panel de citas.`;

    const htmlEmail = `<p><b>${cliente}</b> solicita ${tipo} su cita del <b>${fecha}</b>${nuevaFecha}.</p>
      <p><b>Motivo:</b> ${motivo}</p>
      <p>Ingresa al panel para aprobar o rechazar.</p>`;

    const [adminEmail, adminPhone] = await Promise.all([
      this.getAdminEmail(appt.storeId),
      this.getAdminPhone(appt.storeId),
    ]);

    await Promise.allSettled([
      adminPhone ? this.withRetry(() => this.sendWA(appt.storeId, adminPhone, waMsg)) : Promise.resolve(),
      adminEmail ? this.withRetry(() => this.sendEmail(adminEmail, `Solicitud de ${tipo}: ${cliente}`, htmlEmail)) : Promise.resolve(),
    ]);
  }

  /** Admin aprobó/rechazó → notifica cliente */
  async notifyActionResolved(appt: Appt, approved: boolean, reason?: string): Promise<void> {
    const action = appt.pendingAction === 'CANCEL_REQUESTED' ? 'cancelación' : 'reprogramación';
    let waMsg: string;
    if (approved) {
      waMsg = appt.pendingAction === 'CANCEL_REQUESTED'
        ? `✅ Tu solicitud de cancelación fue aprobada. Hasta pronto.`
        : `✅ Tu reprogramación fue aprobada.\n\n📆 ${this.formatDate(appt.scheduledAt)}\n🕐 ${this.formatTime(appt.scheduledAt)}`;
    } else {
      waMsg = `❌ Tu solicitud de ${action} no pudo ser procesada.` +
        (reason ? `\n\nMotivo: ${reason}` : '') +
        `\n\nContacta directamente si necesitas ayuda.`;
    }
    await this.withRetry(() => this.sendWA(appt.storeId, appt.customer.phone, waMsg));
  }

  /** IA detectó comprobante de pago → notifica admin */
  async notifyPaymentProofDetected(appt: Appt, proofExcerpt: string): Promise<void> {
    const cliente = appt.customer.name ?? appt.customer.phone;
    const fecha   = this.formatDate(appt.scheduledAt);

    const waMsg = `💳 *Comprobante de pago recibido*\n\n` +
      `👤 ${cliente} indica que pagó su cita del ${fecha}.\n` +
      `📝 "${proofExcerpt.slice(0, 100)}"\n\n` +
      `Verifica y confirma el pago en el panel.`;

    const htmlEmail = `<p><b>${cliente}</b> indica que realizó el pago de su cita del <b>${fecha}</b>.</p>
      <p><b>Texto del cliente:</b> ${proofExcerpt}</p>
      <p>Verifica el comprobante y confirma el pago desde el panel.</p>`;

    const [adminEmail, adminPhone] = await Promise.all([
      this.getAdminEmail(appt.storeId),
      this.getAdminPhone(appt.storeId),
    ]);

    await Promise.allSettled([
      adminPhone ? this.withRetry(() => this.sendWA(appt.storeId, adminPhone, waMsg)) : Promise.resolve(),
      adminEmail ? this.withRetry(() => this.sendEmail(adminEmail, `Comprobante de pago: ${cliente}`, htmlEmail)) : Promise.resolve(),
    ]);
  }
}
```

- [ ] **Step 2: Create notifications.module.ts**

```typescript
// src/notifications/notifications.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [
    PrismaModule,
    EmailModule,
    forwardRef(() => WhatsappModule),
  ],
  providers:  [NotificationsService],
  exports:    [NotificationsService],
})
export class NotificationsModule {}
```

- [ ] **Step 3: Verify TypeScript**

```bash
cd C:\Users\alexp\Desktop\proyectos\whatsapp-crm
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/notifications/
git commit -m "feat(notifications): NotificationsService — WA + email hub for appointment events"
```

---

## Task 3: UpdateAppointmentDto — Payment + PendingAction Fields

**Files:**
- Modify: `src/appointments/dto/update-appointment.dto.ts`

- [ ] **Step 1: Update the DTO**

Replace the entire contents of `src/appointments/dto/update-appointment.dto.ts`:

```typescript
import {
  IsString, IsOptional, IsEnum, IsDateString,
  IsInt, IsNumber, Min, Max, MaxLength, IsPositive, IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AppointmentStatus, AppointmentPriority } from '../../generated/prisma/enums';

const PAYMENT_STATUSES  = ['PENDING', 'PAID', 'PARTIAL', 'REFUNDED'] as const;
const PAYMENT_METHODS   = ['efectivo', 'transferencia', 'tarjeta', 'nequi', 'daviplata', 'otro'] as const;
const ACTION_RESOLUTIONS = ['approved', 'rejected'] as const;

export class UpdateAppointmentDto {

  // ── Estado ────────────────────────────────────────────────────────────────
  @IsEnum(AppointmentStatus)
  @IsOptional()
  status?: AppointmentStatus;

  @IsEnum(AppointmentPriority)
  @IsOptional()
  priority?: AppointmentPriority;

  // ── Tiempo ────────────────────────────────────────────────────────────────
  @IsDateString()
  @IsOptional()
  scheduledAt?: string;

  @IsDateString()
  @IsOptional()
  endsAt?: string;

  @IsInt()
  @IsOptional()
  @Min(5)
  @Max(1440)
  @Type(() => Number)
  durationMinutes?: number;

  // ── Clasificación ─────────────────────────────────────────────────────────
  @IsString()
  @IsOptional()
  @MaxLength(100)
  type?: string;

  // ── Contenido ─────────────────────────────────────────────────────────────
  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  address?: string;

  @IsString()
  @IsOptional()
  notes?: string;

  @IsString()
  @IsOptional()
  internalNotes?: string;

  // ── Precio ────────────────────────────────────────────────────────────────
  @IsNumber()
  @IsOptional()
  @IsPositive()
  @Type(() => Number)
  agreedPrice?: number;

  // ── Cancelación ───────────────────────────────────────────────────────────
  @IsString()
  @IsOptional()
  @MaxLength(500)
  cancelReason?: string;

  // ── Pagos ─────────────────────────────────────────────────────────────────
  @IsIn(PAYMENT_STATUSES)
  @IsOptional()
  paymentStatus?: typeof PAYMENT_STATUSES[number];

  @IsIn(PAYMENT_METHODS)
  @IsOptional()
  paymentMethod?: typeof PAYMENT_METHODS[number];

  @IsNumber()
  @IsOptional()
  @IsPositive()
  @Type(() => Number)
  paymentAmount?: number;

  @IsString()
  @IsOptional()
  paymentNotes?: string;

  @IsString()
  @IsOptional()
  paymentProofUrl?: string;

  // ── Resolución de acción pendiente (cancelar/reprogramar) ─────────────────
  @IsIn(ACTION_RESOLUTIONS)
  @IsOptional()
  pendingActionResolution?: typeof ACTION_RESOLUTIONS[number];

  @IsString()
  @IsOptional()
  @MaxLength(500)
  rejectionReason?: string;
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/appointments/dto/update-appointment.dto.ts
git commit -m "feat(appointments): add payment + pendingAction resolution fields to UpdateAppointmentDto"
```

---

## Task 4: AppointmentsService + Controller — Payment & PendingAction Logic

**Files:**
- Modify: `src/appointments/appointments.service.ts`
- Modify: `src/appointments/appointments.module.ts`
- Modify: `src/appointments/appointments.controller.ts`

- [ ] **Step 1: Update appointments.service.ts — update() method**

In `src/appointments/appointments.service.ts`, replace the `update()` method (lines 192–251) with:

```typescript
async update(
  appointmentId: string,
  storeId: string,
  dto: UpdateAppointmentDto,
  performedById?: string,
): Promise<{ appointment: any; notificationTrigger?: string }> {
  const current = await this.findAndVerify(appointmentId, storeId);

  if (dto.status === AppointmentStatus.CANCELLED && !dto.cancelReason && !current.pendingAction) {
    throw new BadRequestException('Se requiere cancelReason al cancelar una cita');
  }

  // ── Resolución de acción pendiente ────────────────────────────────────────
  let resolvedStatus: AppointmentStatus | undefined = dto.status;
  let newScheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : current.scheduledAt;
  let notificationTrigger: string | undefined;

  if (dto.pendingActionResolution === 'approved') {
    if (current.pendingAction === 'CANCEL_REQUESTED') {
      resolvedStatus = AppointmentStatus.CANCELLED;
      notificationTrigger = 'action_approved_cancel';
    } else if (current.pendingAction === 'RESCHEDULE_REQUESTED') {
      const data = current.pendingActionData as any;
      if (data?.newDate) {
        const [year, month, day] = data.newDate.split('-').map(Number);
        const d = new Date(year, month - 1, day);
        if (data.newTime) {
          const [h, m] = data.newTime.split(':').map(Number);
          d.setHours(h, m, 0, 0);
        }
        newScheduledAt = d;
      }
      notificationTrigger = 'action_approved_reschedule';
    }
  } else if (dto.pendingActionResolution === 'rejected') {
    notificationTrigger = 'action_rejected';
  }

  // ── Status notification trigger ───────────────────────────────────────────
  if (!notificationTrigger && dto.status === AppointmentStatus.CONFIRMED) {
    notificationTrigger = 'confirmed';
  }

  // ── Payment notification trigger ──────────────────────────────────────────
  if (dto.paymentStatus === 'PAID' && current.paymentStatus !== 'PAID') {
    notificationTrigger = notificationTrigger ?? 'payment_confirmed';
  }

  const endsAt = this.computeEndsAt(
    newScheduledAt,
    dto.durationMinutes ?? current.durationMinutes ?? undefined,
    dto.endsAt,
  );
  const statusTimestamps = this.resolveStatusTimestamps(resolvedStatus, current);

  const appointment = await this.prisma.$transaction(async (tx) => {
    const updated = await tx.appointment.update({
      where: { appointmentId },
      data: {
        ...(resolvedStatus     !== undefined && { status:      resolvedStatus }),
        ...(dto.priority       !== undefined && { priority:    dto.priority }),
        ...(dto.type           !== undefined && { type:        dto.type }),
        scheduledAt: newScheduledAt,
        endsAt,
        ...(dto.durationMinutes !== undefined && { durationMinutes: dto.durationMinutes }),
        ...(dto.description    !== undefined && { description:    dto.description }),
        ...(dto.address        !== undefined && { address:        dto.address }),
        ...(dto.notes          !== undefined && { notes:          dto.notes }),
        ...(dto.internalNotes  !== undefined && { internalNotes:  dto.internalNotes }),
        ...(dto.agreedPrice    !== undefined && { agreedPrice:    dto.agreedPrice }),
        ...(dto.cancelReason   !== undefined && { cancelReason:   dto.cancelReason }),
        // Payment
        ...(dto.paymentStatus  !== undefined && { paymentStatus:  dto.paymentStatus }),
        ...(dto.paymentMethod  !== undefined && { paymentMethod:  dto.paymentMethod }),
        ...(dto.paymentAmount  !== undefined && { paymentAmount:  dto.paymentAmount }),
        ...(dto.paymentNotes   !== undefined && { paymentNotes:   dto.paymentNotes }),
        ...(dto.paymentProofUrl !== undefined && { paymentProofUrl: dto.paymentProofUrl }),
        ...(dto.paymentStatus === 'PAID' && { paymentConfirmedAt: new Date() }),
        // Clear pending action after resolution
        ...(dto.pendingActionResolution !== undefined && {
          pendingAction:       null,
          pendingActionAt:     null,
          pendingActionData:   null,
          pendingActionReason: null,
        }),
        ...statusTimestamps,
      },
      include: APPOINTMENT_INCLUDE,
    });

    const dtoForTimeline = { ...dto, status: resolvedStatus };
    const action = this.resolveTimelineAction(dtoForTimeline as any, current.status as AppointmentStatus);
    if (action) {
      await tx.appointmentTimeline.create({
        data: {
          appointmentId,
          action,
          previousStatus: resolvedStatus ? (current.status as AppointmentStatus) : undefined,
          newStatus:      resolvedStatus as AppointmentStatus | undefined,
          note:           this.resolveTimelineNote(dtoForTimeline as any, current.status as AppointmentStatus),
          isPublic:       this.isPublicAction(action),
          performedById:  performedById ?? null,
        },
      });
    }

    return updated;
  });

  return { appointment, notificationTrigger };
}
```

Also add the `rejectionReason?: string` parameter to `resolveTimelineNote` if needed. Check what it currently does:

- [ ] **Step 2: Update appointments.controller.ts — inject NotificationsService and trigger**

Replace `src/appointments/appointments.controller.ts`:

```typescript
import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, UseGuards, Request,
  HttpCode, HttpStatus,
} from '@nestjs/common';
import { AppointmentsService } from './appointments.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('appointments')
@UseGuards(JwtAuthGuard)
export class AppointmentsController {
  constructor(
    private readonly appointmentsService:  AppointmentsService,
    private readonly notifications:        NotificationsService,
  ) {}

  @Get('stats')
  getStats(@Request() req: any) {
    return this.appointmentsService.getStats(req.user.storeId);
  }

  @Get()
  findAll(
    @Request() req: any,
    @Query('status')    status?:    string,
    @Query('type')      type?:      string,
    @Query('from')      from?:      string,
    @Query('to')        to?:        string,
    @Query('serviceId') serviceId?: string,
    @Query('priority')  priority?:  string,
    @Query('hasPendingAction') hasPendingAction?: string,
  ) {
    return this.appointmentsService.findAll(req.user.storeId, {
      status, type, from, to, serviceId, priority, hasPendingAction,
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.appointmentsService.findOne(id, req.user.storeId);
  }

  @Get(':id/timeline')
  getTimeline(@Param('id') id: string, @Request() req: any) {
    return this.appointmentsService.getTimeline(id, req.user.storeId);
  }

  @Post()
  create(@Body() dto: CreateAppointmentDto, @Request() req: any) {
    return this.appointmentsService.create(req.user.storeId, dto, req.user.userId);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAppointmentDto,
    @Request() req: any,
  ) {
    const { appointment, notificationTrigger } =
      await this.appointmentsService.update(id, req.user.storeId, dto, req.user.userId);

    // Fire notifications asynchronously — don't block the HTTP response
    if (notificationTrigger) {
      setImmediate(async () => {
        try {
          if (notificationTrigger === 'confirmed') {
            await this.notifications.notifyAppointmentConfirmed(appointment);
          } else if (notificationTrigger === 'action_approved_cancel' ||
                     notificationTrigger === 'action_approved_reschedule') {
            // Pass the pre-clear pendingAction for the message logic
            await this.notifications.notifyActionResolved(
              { ...appointment, pendingAction: dto.pendingActionResolution === 'approved'
                ? (appointment.pendingAction ?? 'CANCEL_REQUESTED') : null },
              true,
            );
          } else if (notificationTrigger === 'action_rejected') {
            await this.notifications.notifyActionResolved(
              appointment, false, dto.rejectionReason,
            );
          }
        } catch (err: any) {
          // Already logged inside NotificationsService
        }
      });
    }

    return appointment;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @Request() req: any) {
    return this.appointmentsService.remove(id, req.user.storeId);
  }
}
```

- [ ] **Step 3: Add hasPendingAction filter to findAll in appointments.service.ts**

In `AppointmentsService.findAll()`, add to the `where` clause after existing filters:

```typescript
// Inside the options parameter, add:
hasPendingAction?: string;

// Inside findAll(), add to the where object:
...(options.hasPendingAction === 'true' && { pendingAction: { not: null } }),
```

- [ ] **Step 4: Update appointments.module.ts**

```typescript
// src/appointments/appointments.module.ts
import { Module } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [AppointmentsController],
  providers: [AppointmentsService],
  exports: [AppointmentsService],
})
export class AppointmentsModule {}
```

- [ ] **Step 5: Verify TypeScript**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/appointments/
git commit -m "feat(appointments): payment tracking + pendingAction resolution + notifications on confirm"
```

---

## Task 5: RemindersService

**Files:**
- Create: `src/reminders/reminders.module.ts`
- Create: `src/reminders/reminders.service.ts`

- [ ] **Step 1: Create reminders.service.ts**

```typescript
// src/reminders/reminders.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

const BATCH_SIZE = 50;

@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  constructor(
    private readonly prisma:         PrismaService,
    private readonly notifications:  NotificationsService,
  ) {}

  // Runs every 30 minutes
  @Cron('0,30 * * * *', { name: 'appointment-reminders', timeZone: 'UTC' })
  async runReminders(): Promise<void> {
    const now     = new Date();
    const in9h    = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const in8h30m = new Date(now.getTime() + 8.5 * 60 * 60 * 1000);
    const in2h30m = new Date(now.getTime() + 2.5 * 60 * 60 * 1000);
    const in1h30m = new Date(now.getTime() + 1.5 * 60 * 60 * 1000);

    const appointments = await this.prisma.appointment.findMany({
      where: {
        status:      { in: ['CONFIRMED', 'IN_PROGRESS'] },
        scheduledAt: { gt: now, lte: in9h },
        store:       { subscriptionStatus: 'active' },
        OR: [
          { reminder8hSentAt: null, scheduledAt: { lte: in8h30m } },
          { reminder2hSentAt: null, scheduledAt: { lte: in2h30m } },
          { reminder1hSentAt: null, scheduledAt: { lte: in1h30m } },
        ],
      },
      include: {
        customer:       { select: { name: true, phone: true } },
        service:        { select: { name: true } },
        serviceVariant: { select: { name: true } },
      },
      take: BATCH_SIZE,
    });

    if (appointments.length === 0) return;
    this.logger.log(`🔔 Procesando ${appointments.length} recordatorios...`);

    for (const appt of appointments) {
      try {
        await this.processReminders(appt, now, in8h30m, in2h30m, in1h30m);
      } catch (err: any) {
        this.logger.error(`Error recordatorio cita ${appt.appointmentId}: ${err.message}`);
      }
    }
  }

  private async processReminders(
    appt: any,
    now: Date,
    in8h30m: Date,
    in2h30m: Date,
    in1h30m: Date,
  ): Promise<void> {
    const windows: Array<{ field: '8h' | '2h' | '1h'; dbField: string; limit: Date; sentAt: Date | null }> = [
      { field: '8h', dbField: 'reminder8hSentAt', limit: in8h30m, sentAt: appt.reminder8hSentAt },
      { field: '2h', dbField: 'reminder2hSentAt', limit: in2h30m, sentAt: appt.reminder2hSentAt },
      { field: '1h', dbField: 'reminder1hSentAt', limit: in1h30m, sentAt: appt.reminder1hSentAt },
    ];

    for (const w of windows) {
      if (w.sentAt !== null) continue;
      if (appt.scheduledAt > w.limit) continue;

      // Atomic update — only proceed if sentAt is still null
      const updated = await this.prisma.appointment.updateMany({
        where: { appointmentId: appt.appointmentId, [w.dbField]: null },
        data:  { [w.dbField]: now },
      });

      if (updated.count === 0) continue; // Another process already sent it

      await this.notifications.notifyReminder(appt, w.field);
      this.logger.log(`✅ Recordatorio ${w.field} enviado — cita ${appt.appointmentId}`);
    }
  }

  async runManual(): Promise<{ message: string }> {
    this.runReminders().catch(err =>
      this.logger.error(`Error en reminders manual: ${err.message}`)
    );
    return { message: 'Recordatorios iniciados en segundo plano' };
  }
}
```

- [ ] **Step 2: Create reminders.module.ts**

```typescript
// src/reminders/reminders.module.ts
import { Module } from '@nestjs/common';
import { RemindersService } from './reminders.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, NotificationsModule],
  providers: [RemindersService],
  exports: [RemindersService],
})
export class RemindersModule {}
```

- [ ] **Step 3: Verify TypeScript**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/reminders/
git commit -m "feat(reminders): RemindersService cron every 30min — 8h/2h/1h windows, atomic dedup"
```

---

## Task 6: ReportsService + Controller

**Files:**
- Create: `src/reports/reports.module.ts`
- Create: `src/reports/reports.service.ts`
- Create: `src/reports/reports.controller.ts`

- [ ] **Step 1: Create reports.service.ts**

```typescript
// src/reports/reports.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../email/email.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly prisma:         PrismaService,
    private readonly notifications:  NotificationsService,
    private readonly email:          EmailService,
    private readonly whatsapp:       WhatsappService,
  ) {}

  // 9pm Colombia = 02:00 UTC
  @Cron('0 2 * * *', { name: 'daily-report', timeZone: 'UTC' })
  async runDailyReports(): Promise<void> {
    this.logger.log('📊 Generando reportes diarios...');

    const stores = await this.prisma.store.findMany({
      where:  { subscriptionStatus: 'active', isActive: true },
      select: { storeId: true, name: true, phone: true, adminPhone: true },
    });

    await Promise.allSettled(
      stores.map(store => this.generateAndSendReport(store.storeId))
    );

    this.logger.log(`✅ Reportes enviados a ${stores.length} tiendas`);
  }

  async generateAndSendReport(storeId: string): Promise<void> {
    try {
      const now       = new Date();
      const tzOffset  = -5 * 60; // Colombia UTC-5
      const localNow  = new Date(now.getTime() + tzOffset * 60 * 1000);
      const todayStart = new Date(Date.UTC(
        localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(),
        5, 0, 0, 0, // 5am UTC = midnight Colombia
      ));
      const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

      const [appointments, customers, store] = await Promise.all([
        this.prisma.appointment.findMany({
          where: { storeId, createdAt: { gte: todayStart, lt: todayEnd } },
          select: {
            status: true, paymentStatus: true, paymentMethod: true,
            paymentAmount: true, customerId: true,
          },
        }),
        this.prisma.customer.findMany({
          where: { storeId, createdAt: { gte: todayStart, lt: todayEnd } },
          select: { customerId: true },
        }),
        this.prisma.store.findUnique({
          where: { storeId },
          select: { name: true, adminPhone: true },
        }),
      ]);

      if (!store) return;

      // Aggregate appointments
      const apptData = {
        total:     appointments.length,
        completed: appointments.filter(a => a.status === 'COMPLETED').length,
        confirmed: appointments.filter(a => a.status === 'CONFIRMED').length,
        cancelled: appointments.filter(a => a.status === 'CANCELLED').length,
        noShow:    appointments.filter(a => a.status === 'NO_SHOW').length,
        pending:   appointments.filter(a => a.status === 'PENDING').length,
      };

      // Aggregate payments
      const paidAppts = appointments.filter(a => a.paymentStatus === 'PAID');
      const byMethod: Record<string, number> = {};
      let totalConfirmed = 0;
      for (const a of paidAppts) {
        const amt = Number(a.paymentAmount ?? 0);
        totalConfirmed += amt;
        const m = a.paymentMethod ?? 'otro';
        byMethod[m] = (byMethod[m] ?? 0) + amt;
      }
      const pendingPayment = appointments
        .filter(a => a.status === 'COMPLETED' && a.paymentStatus !== 'PAID')
        .reduce((sum, a) => sum + Number(a.paymentAmount ?? 0), 0);

      const paymentsData = { confirmed: totalConfirmed, pending: pendingPayment, byMethod };

      // New clients today (all customers created today are "new")
      const clientsData = { new: customers.length, recurring: apptData.total - customers.length };

      // Save to DB (upsert in case of re-run)
      await this.prisma.dailyReport.upsert({
        where:  { storeId_date: { storeId, date: todayStart } },
        update: { appointmentsData: apptData, paymentsData, clientsData },
        create: { storeId, date: todayStart, appointmentsData: apptData, paymentsData, clientsData },
      });

      // Format messages
      const fmt = (n: number) => n.toLocaleString('es-CO');
      const fmtMoney = (n: number) => `$${fmt(n)}`;

      const waMsg = `📊 *Reporte del día — ${store.name}*\n\n` +
        `📅 *CITAS*\n` +
        `Total: ${apptData.total}  |  ✅ ${apptData.completed}  |  📅 ${apptData.confirmed}\n` +
        `❌ Canceladas: ${apptData.cancelled}  |  👻 No show: ${apptData.noShow}\n\n` +
        `💳 *PAGOS*\n` +
        `Confirmados: ${fmtMoney(totalConfirmed)}\n` +
        (byMethod['efectivo']     ? `  • Efectivo: ${fmtMoney(byMethod['efectivo'])}\n` : '') +
        (byMethod['transferencia']? `  • Transferencia: ${fmtMoney(byMethod['transferencia'])}\n` : '') +
        (byMethod['nequi']        ? `  • Nequi: ${fmtMoney(byMethod['nequi'])}\n` : '') +
        (byMethod['daviplata']    ? `  • Daviplata: ${fmtMoney(byMethod['daviplata'])}\n` : '') +
        `Pendientes: ${fmtMoney(pendingPayment)}\n\n` +
        `👥 *CLIENTES*\n` +
        `Nuevos hoy: ${clientsData.new}`;

      const htmlEmail = `<h2>Reporte del día — ${store.name}</h2>
        <h3>Citas</h3>
        <ul>
          <li>Total: ${apptData.total}</li>
          <li>Completadas: ${apptData.completed}</li>
          <li>Confirmadas: ${apptData.confirmed}</li>
          <li>Canceladas: ${apptData.cancelled}</li>
          <li>No show: ${apptData.noShow}</li>
        </ul>
        <h3>Pagos confirmados: ${fmtMoney(totalConfirmed)}</h3>
        <ul>${Object.entries(byMethod).map(([m, v]) => `<li>${m}: ${fmtMoney(v)}</li>`).join('')}</ul>
        <p>Pagos pendientes: ${fmtMoney(pendingPayment)}</p>
        <h3>Clientes nuevos hoy: ${clientsData.new}</h3>`;

      // Send
      const adminEmail = await this.prisma.user
        .findFirst({ where: { storeId, role: 'admin' }, select: { email: true } })
        .then(u => u?.email ?? null);

      await Promise.allSettled([
        store.adminPhone
          ? this.whatsapp.sendMessage(storeId, store.adminPhone, waMsg).catch(() => {})
          : Promise.resolve(),
        adminEmail
          ? this.email.send(adminEmail, `Reporte del día — ${store.name}`, htmlEmail).catch(() => {})
          : Promise.resolve(),
      ]);

      this.logger.log(`📊 Reporte enviado: ${store.name} (${storeId})`);
    } catch (err: any) {
      this.logger.error(`Error reporte tienda ${storeId}: ${err.message}`);
    }
  }
}
```

- [ ] **Step 2: Create reports.controller.ts**

```typescript
// src/reports/reports.controller.ts
import { Controller, Post, Get, Query, UseGuards, Request, HttpCode } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly prisma:  PrismaService,
  ) {}

  @Post('generate')
  @HttpCode(202)
  async generate(@Request() req: any) {
    const storeId = req.user.storeId;
    // Fire async — don't wait
    this.reports.generateAndSendReport(storeId).catch(() => {});
    return { message: 'Reporte en generación, recibirás el resultado por email y WA.' };
  }

  @Get('daily')
  async getDailyReports(
    @Request() req: any,
    @Query('limit') limit?: string,
  ) {
    const storeId = req.user.storeId;
    return this.prisma.dailyReport.findMany({
      where:   { storeId },
      orderBy: { date: 'desc' },
      take:    parseInt(limit ?? '30'),
    });
  }
}
```

- [ ] **Step 3: Create reports.module.ts**

```typescript
// src/reports/reports.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailModule } from '../email/email.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    EmailModule,
    forwardRef(() => WhatsappModule),
  ],
  controllers: [ReportsController],
  providers:  [ReportsService],
  exports:    [ReportsService],
})
export class ReportsModule {}
```

- [ ] **Step 4: Verify TypeScript**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/reports/
git commit -m "feat(reports): ReportsService daily cron 9pm Colombia + manual endpoint + Analytics API"
```

---

## Task 7: AI Enhancements — Payment Proof + Cancel/Reschedule

**Files:**
- Modify: `src/ai/ai.service.ts`
- Modify: `src/ai/ai.module.ts`

- [ ] **Step 1: Add import to ai.service.ts**

At the top of `src/ai/ai.service.ts`, add:

```typescript
import { NotificationsService } from '../notifications/notifications.service';
```

Add `NotificationsService` to the constructor:

```typescript
constructor(
  private readonly prisma:         PrismaService,
  private readonly notifications:  NotificationsService,
) {}
```

- [ ] **Step 2: Add regex constants for new flows (top of file, after existing constants)**

```typescript
const PAYMENT_PROOF_RE = /\b(pagu[eé]|transfer[ií]|te mand[eé]|comprobante|transacci[oó]n|consign[eé]|listo el pago|ya pagu[eé]|hice el pago)\b/i;
const CANCEL_RESCHEDULE_RE = /\b(cancelar|no puedo ir|no puedo asistir|cambiar la cita|reprogramar|mover la cita|otro d[ií]a|otra hora|posponer|aplazar)\b/i;
const MIN_ADVANCE_RE = /m[ií]nimo\s+(\d+)\s*(hora|horas|h\b)/i;
```

- [ ] **Step 3: Add private helper to extract cancellation window from systemPrompt**

Add this private method to `AiService`:

```typescript
private extractMinAdvanceHours(systemPrompt: string): number {
  const match = MIN_ADVANCE_RE.exec(systemPrompt);
  if (match) return parseInt(match[1]);
  return 2; // default: 2 hours
}
```

- [ ] **Step 4: Add tryDetectPaymentProof method**

Add this private method to `AiService` (before `generateReply`):

```typescript
private async tryDetectPaymentProof(
  storeId: string,
  customerId: string,
  userMessage: string,
): Promise<string | null> {
  if (!PAYMENT_PROOF_RE.test(userMessage)) return null;

  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const appt = await this.prisma.appointment.findFirst({
    where: {
      storeId,
      customerId,
      status:    { in: ['CONFIRMED', 'PENDING'] },
      createdAt: { gte: cutoff },
    },
    orderBy: { scheduledAt: 'asc' },
    include: {
      customer:       { select: { name: true, phone: true } },
      service:        { select: { name: true } },
      serviceVariant: { select: { name: true } },
    },
  });
  if (!appt) return null;

  const excerpt = userMessage.slice(0, 200);
  await this.prisma.appointment.update({
    where: { appointmentId: appt.appointmentId },
    data:  { paymentProofUrl: excerpt },
  });

  this.notifications.notifyPaymentProofDetected(appt as any, excerpt).catch(() => {});
  return 'Recibido ✅ Tu comprobante fue enviado al admin para verificación. Te confirmaremos en breve.';
}
```

- [ ] **Step 5: Add tryHandleCancelOrReschedule method**

Add this private method to `AiService`:

```typescript
private async tryHandleCancelOrReschedule(
  storeId: string,
  customerId: string,
  userMessage: string,
  systemPrompt: string,
  provider: any,
  apiKey: string,
): Promise<string | null> {
  if (!CANCEL_RESCHEDULE_RE.test(userMessage)) return null;

  const appt = await this.prisma.appointment.findFirst({
    where: {
      storeId,
      customerId,
      status:        { in: ['PENDING', 'CONFIRMED'] },
      pendingAction: null,
    },
    orderBy: { scheduledAt: 'asc' },
    include: {
      customer:       { select: { name: true, phone: true } },
      service:        { select: { name: true } },
      serviceVariant: { select: { name: true } },
    },
  });
  if (!appt) return null;

  // Check minimum advance notice
  const minHours = this.extractMinAdvanceHours(systemPrompt);
  const hoursUntil = (appt.scheduledAt.getTime() - Date.now()) / (1000 * 60 * 60);
  if (hoursUntil < minHours) {
    return `Lo sentimos, solo podemos procesar cambios con al menos ${minHours} horas de anticipación. Contacta directamente a la barbería para más información.`;
  }

  // Detect intent and extract new date/time for reschedule
  const isReschedule = /reprogramar|cambiar|mover|otro d[ií]a|otra hora|posponer/i.test(userMessage);
  const action = isReschedule ? 'RESCHEDULE_REQUESTED' : 'CANCEL_REQUESTED';

  let pendingActionData: any = null;
  if (isReschedule) {
    const newDate = parseFechaEspanol(userMessage);
    const timeMatch = userMessage.match(/\b(\d{1,2})[:\s]?(\d{2})?\s*(am|pm|a\.?m\.?|p\.?m\.?)?\b/i);
    const newTime = timeMatch ? timeMatch[0] : null;
    pendingActionData = { newDate, newTime };
  }

  await this.prisma.appointment.update({
    where: { appointmentId: appt.appointmentId },
    data: {
      pendingAction:       action,
      pendingActionAt:     new Date(),
      pendingActionData:   pendingActionData,
      pendingActionReason: userMessage.slice(0, 500),
    },
  });

  const actionType: 'cancel' | 'reschedule' = isReschedule ? 'reschedule' : 'cancel';
  this.notifications.notifyPendingAction(appt as any, actionType).catch(() => {});

  return isReschedule
    ? 'Tu solicitud de reprogramación fue enviada al admin. Te confirmaremos la nueva fecha en breve ✅'
    : 'Tu solicitud de cancelación fue enviada al admin. Te confirmaremos en breve ✅';
}
```

- [ ] **Step 6: Call new flows from generateReply**

In `generateReply()`, after the line `const customer = conversationRow.customer;` and before the `hasCatalog` check, add:

```typescript
// ── Pago detectado ────────────────────────────────────────────────────────
const paymentReply = await this.tryDetectPaymentProof(storeId, customer.customerId, userMessage);
if (paymentReply) return paymentReply;

// ── Cancelar / Reprogramar ────────────────────────────────────────────────
const cancelRescheduleReply = await this.tryHandleCancelOrReschedule(
  storeId, customer.customerId, userMessage, config.systemPrompt, provider, apiKey,
);
if (cancelRescheduleReply) return cancelRescheduleReply;
```

- [ ] **Step 7: Update ai.module.ts to import NotificationsModule**

```typescript
// src/ai/ai.module.ts
import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [AiController],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
```

- [ ] **Step 8: Call notifyAppointmentCreated at the end of tryExtractAndCreateAppointment**

In `ai.service.ts`, inside `tryExtractAndCreateAppointment()`, after the `prisma.$transaction` that creates the appointment (after the `this.logger.log('✅ Cita creada...')` line), add:

```typescript
this.notifications.notifyAppointmentCreated(newAppointment as any).catch(() => {});
```

Where `newAppointment` is the result returned from the transaction include.

- [ ] **Step 9: Verify TypeScript**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/ai/
git commit -m "feat(ai): payment proof detection + cancel/reschedule flow with admin approval"
```

---

## Task 8: Wire All Modules in AppModule

**Files:**
- Modify: `src/app.module.ts`

- [ ] **Step 1: Add new module imports**

In `src/app.module.ts`, add imports:

```typescript
import { NotificationsModule } from './notifications/notifications.module';
import { RemindersModule } from './reminders/reminders.module';
import { ReportsModule } from './reports/reports.module';
```

Add to the `imports` array in `@Module`:

```typescript
NotificationsModule,
RemindersModule,
ReportsModule,
```

- [ ] **Step 2: Verify TypeScript and boot test**

```bash
npx tsc --noEmit
```

Then start the server:
```bash
npm run build && node dist/main.js
```

Expected: server starts, logs show all modules initialized including `NotificationsService`, `RemindersService`, `ReportsService`. No circular dependency errors.

- [ ] **Step 3: Commit**

```bash
git add src/app.module.ts
git commit -m "feat(app): register NotificationsModule, RemindersModule, ReportsModule"
```

---

## Task 9: Frontend — Payment Tab + Pending Actions

**Files:**
- Modify: `stockup-frontend/src/pages/Appointments.tsx`
- Modify: `stockup-frontend/src/services/api.ts`

- [ ] **Step 1: Add new API calls to api.ts**

In `src/services/api.ts`, add after the existing appointment functions:

```typescript
export const updateAppointment = (id: string, data: Record<string, any>) =>
  api.patch(`/appointments/${id}`, data);

export const getDailyReports = (limit = 30) =>
  api.get(`/reports/daily?limit=${limit}`);

export const generateReport = () =>
  api.post('/reports/generate');
```

(Check if `updateAppointment` already exists and update its type if so.)

- [ ] **Step 2: Update Appointments.tsx — add payment badge and pending count to header**

Find the stats section in `Appointments.tsx`. Add a pending actions count query and display. In the component state/data fetching area, add:

```typescript
const pendingCount = appointments.filter((a: any) => a.pendingAction).length;
```

In the header/filter bar, add next to existing filters:

```tsx
{pendingCount > 0 && (
  <button
    onClick={() => setFilters(f => ({ ...f, hasPendingAction: f.hasPendingAction === 'true' ? undefined : 'true' }))}
    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition ${
      filters.hasPendingAction === 'true'
        ? 'bg-red-500 text-white'
        : 'bg-red-50 text-red-600 border border-red-200 hover:bg-red-100'
    }`}
  >
    <span className="w-4 h-4 bg-red-500 text-white rounded-full flex items-center justify-center text-[10px] font-bold">
      {pendingCount}
    </span>
    Solicitudes pendientes
  </button>
)}
```

Also pass `hasPendingAction` to the API call when filtering.

- [ ] **Step 3: Add "Pago" tab to the detail panel**

In the existing detail panel slide-in component, add a tab selector with "Detalle" and "Pago" tabs. When "Pago" tab is active, render:

```tsx
{/* Payment Tab */}
{activeDetailTab === 'pago' && (
  <div className="space-y-4 p-4">
    {/* Payment status badge */}
    <div className="flex items-center gap-2">
      <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
        selectedAppt.paymentStatus === 'PAID'    ? 'bg-green-100 text-green-700' :
        selectedAppt.paymentStatus === 'PARTIAL' ? 'bg-yellow-100 text-yellow-700' :
        selectedAppt.paymentStatus === 'REFUNDED'? 'bg-blue-100 text-blue-700' :
                                                    'bg-slate-100 text-slate-600'
      }`}>
        {selectedAppt.paymentStatus === 'PAID'    ? '✅ Pagado' :
         selectedAppt.paymentStatus === 'PARTIAL' ? '⚠️ Parcial' :
         selectedAppt.paymentStatus === 'REFUNDED'? '↩️ Reembolsado' : '⏳ Pendiente'}
      </span>
      {selectedAppt.paymentConfirmedAt && (
        <span className="text-xs text-slate-400">
          Confirmado el {new Date(selectedAppt.paymentConfirmedAt).toLocaleDateString('es-CO')}
        </span>
      )}
    </div>

    {/* Payment form */}
    <div className="space-y-3">
      <div>
        <label className="text-xs font-medium text-slate-600 mb-1 block">Método de pago</label>
        <select
          value={paymentForm.paymentMethod}
          onChange={e => setPaymentForm(f => ({ ...f, paymentMethod: e.target.value }))}
          className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Seleccionar...</option>
          {['efectivo','transferencia','tarjeta','nequi','daviplata','otro'].map(m => (
            <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-xs font-medium text-slate-600 mb-1 block">Monto pagado</label>
        <input
          type="number"
          value={paymentForm.paymentAmount}
          onChange={e => setPaymentForm(f => ({ ...f, paymentAmount: e.target.value }))}
          placeholder="0"
          className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <div>
        <label className="text-xs font-medium text-slate-600 mb-1 block">Notas</label>
        <textarea
          rows={2}
          value={paymentForm.paymentNotes}
          onChange={e => setPaymentForm(f => ({ ...f, paymentNotes: e.target.value }))}
          placeholder="Referencia, número de transacción..."
          className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      {selectedAppt.paymentProofUrl && (
        <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-700">
          💳 Comprobante detectado por IA: "{selectedAppt.paymentProofUrl.slice(0, 100)}"
        </div>
      )}
      <button
        onClick={() => handleConfirmPayment()}
        className="w-full py-2.5 rounded-xl text-white text-sm font-semibold"
        style={{ background: 'linear-gradient(135deg, #059669, #10b981)' }}
      >
        Confirmar pago
      </button>
    </div>
  </div>
)}
```

Add state and handler:

```typescript
const [activeDetailTab, setActiveDetailTab] = useState<'detalle' | 'pago'>('detalle');
const [paymentForm, setPaymentForm] = useState({
  paymentMethod: '', paymentAmount: '', paymentNotes: '',
});

const handleConfirmPayment = async () => {
  await updateAppointment(selectedAppt.appointmentId, {
    paymentStatus: 'PAID',
    paymentMethod: paymentForm.paymentMethod || undefined,
    paymentAmount: paymentForm.paymentAmount ? Number(paymentForm.paymentAmount) : undefined,
    paymentNotes:  paymentForm.paymentNotes  || undefined,
  });
  // Refresh list
  loadAppointments();
  setPaymentForm({ paymentMethod: '', paymentAmount: '', paymentNotes: '' });
};
```

- [ ] **Step 4: Add pending action card to detail panel**

Inside the detail panel (when `selectedAppt.pendingAction` is set), add before the status buttons:

```tsx
{selectedAppt.pendingAction && (
  <div className="mx-4 mb-3 p-3 bg-amber-50 border border-amber-200 rounded-xl">
    <p className="text-sm font-semibold text-amber-800 mb-1">
      ⚠️ Solicitud de {selectedAppt.pendingAction === 'CANCEL_REQUESTED' ? 'cancelación' : 'reprogramación'}
    </p>
    {selectedAppt.pendingActionReason && (
      <p className="text-xs text-amber-700 mb-2">Motivo: "{selectedAppt.pendingActionReason}"</p>
    )}
    {selectedAppt.pendingAction === 'RESCHEDULE_REQUESTED' && selectedAppt.pendingActionData?.newDate && (
      <p className="text-xs text-amber-700 mb-2">
        Nueva fecha propuesta: {selectedAppt.pendingActionData.newDate}
        {selectedAppt.pendingActionData.newTime ? ` a las ${selectedAppt.pendingActionData.newTime}` : ''}
      </p>
    )}
    <div className="flex gap-2 mt-2">
      <button
        onClick={() => handleResolveAction('approved')}
        className="flex-1 py-1.5 rounded-lg bg-green-500 text-white text-xs font-semibold hover:bg-green-600 transition"
      >
        ✅ Aprobar
      </button>
      <button
        onClick={() => handleResolveAction('rejected')}
        className="flex-1 py-1.5 rounded-lg bg-red-500 text-white text-xs font-semibold hover:bg-red-600 transition"
      >
        ❌ Rechazar
      </button>
    </div>
  </div>
)}
```

Add handler:

```typescript
const handleResolveAction = async (resolution: 'approved' | 'rejected') => {
  await updateAppointment(selectedAppt.appointmentId, {
    pendingActionResolution: resolution,
    ...(resolution === 'rejected' && { rejectionReason: 'Solicitud rechazada por el admin' }),
  });
  loadAppointments();
  setSelectedAppt(null);
};
```

- [ ] **Step 5: Verify TypeScript**

```bash
cd C:\Users\alexp\Desktop\proyectos\stockup-frontend
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Appointments.tsx src/services/api.ts
git commit -m "feat(appointments-ui): payment tab, pending actions badge + approve/reject panel"
```

---

## Task 10: Frontend — Daily Report in Analytics

**Files:**
- Modify: `stockup-frontend/src/pages/Analytics.tsx`

- [ ] **Step 1: Add DailyReport section to Analytics.tsx**

Import the new API functions at the top:

```typescript
import { getDailyReports, generateReport } from '../services/api';
```

Add state:

```typescript
const [dailyReports, setDailyReports] = useState<any[]>([]);
const [loadingReport, setLoadingReport] = useState(false);
const [generatingReport, setGeneratingReport] = useState(false);
```

Add data fetch in `useEffect`:

```typescript
getDailyReports(30).then(r => setDailyReports(r.data ?? [])).catch(() => {});
```

Add section at the bottom of the Analytics page:

```tsx
{/* Daily Report Section */}
<div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100">
  <div className="flex items-center justify-between mb-5">
    <div className="flex items-center gap-3">
      <div className="w-9 h-9 rounded-xl bg-emerald-50 flex items-center justify-center">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2">
          <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
        </svg>
      </div>
      <div>
        <h2 className="font-semibold text-slate-800">Reporte del Día</h2>
        <p className="text-xs text-slate-400">Enviado a las 9pm Colombia vía WA y email</p>
      </div>
    </div>
    <button
      onClick={async () => {
        setGeneratingReport(true);
        try { await generateReport(); } finally { setGeneratingReport(false); }
      }}
      disabled={generatingReport}
      className="px-4 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-60 transition"
      style={{ background: 'linear-gradient(135deg, #059669, #10b981)' }}
    >
      {generatingReport ? 'Generando...' : 'Generar ahora'}
    </button>
  </div>

  {dailyReports.length === 0 ? (
    <p className="text-sm text-slate-400 text-center py-8">
      Aún no hay reportes generados. El primero se enviará automáticamente esta noche a las 9pm.
    </p>
  ) : (
    <div className="space-y-3">
      {dailyReports.slice(0, 10).map((r: any) => {
        const d = r.appointmentsData ?? {};
        const p = r.paymentsData ?? {};
        const fmt = (n: number) => `$${n.toLocaleString('es-CO')}`;
        const date = new Date(r.date).toLocaleDateString('es-CO', {
          weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
        });
        return (
          <div key={r.reportId} className="p-3 bg-slate-50 rounded-xl border border-slate-100">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-slate-700">{date}</span>
              <span className="text-sm font-bold text-emerald-600">{fmt(p.confirmed ?? 0)}</span>
            </div>
            <div className="flex gap-4 text-xs text-slate-500">
              <span>✅ {d.completed ?? 0} completadas</span>
              <span>❌ {d.cancelled ?? 0} canceladas</span>
              <span>👻 {d.noShow ?? 0} no-show</span>
            </div>
          </div>
        );
      })}
    </div>
  )}
</div>
```

- [ ] **Step 2: Verify TypeScript**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Analytics.tsx
git commit -m "feat(analytics): daily report section with history + manual generate button"
```

---

## Task 11: Push Both Repos to Production

- [ ] **Step 1: Push backend**

```bash
cd C:\Users\alexp\Desktop\proyectos\whatsapp-crm
git push
```

Render auto-deploys. Watch logs for startup errors (circular dep, missing module, etc.).

- [ ] **Step 2: Push frontend**

```bash
cd C:\Users\alexp\Desktop\proyectos\stockup-frontend
git push
```

Vercel auto-deploys. Confirm build passes (no ESLint errors).

- [ ] **Step 3: Verify production health**

```bash
curl https://whatsapp-crm-37t2.onrender.com/health
```

Expected: `{"status":"ok","db":"connected"}`

- [ ] **Step 4: Smoke test — confirm appointment flow**

1. In the frontend `/appointments`, verify the new "Pago" tab appears in the detail panel
2. Verify the "Solicitudes pendientes" badge appears (if any exist)
3. In `/analytics`, verify the "Reporte del Día" section appears
4. Click "Generar ahora" — should respond `202 Accepted` and trigger email/WA
5. Check the cron logs in Render dashboard to confirm RemindersService registered

---

## Self-Review Checklist

- [x] **Schema**: All fields from spec covered — payment (6 fields), pendingAction (4 fields), reminders (3 fields), DailyReport model, adminPhone on Store
- [x] **NotificationsService**: All 6 methods from spec — created, confirmed, reminder, pendingAction, resolved, paymentProof
- [x] **RemindersService**: Cron 30min, 3 windows (8h/2h/1h), atomic dedup, batch 50, per-item error isolation
- [x] **ReportsService**: Cron 02:00 UTC (9pm Colombia), DB save, WA + email, manual endpoint, GET history
- [x] **AI — payment proof**: PAYMENT_PROOF_RE trigger, 48h window, update paymentProofUrl, notify admin, return confirmation to client
- [x] **AI — cancel/reschedule**: CANCEL_RESCHEDULE_RE trigger, min advance check from systemPrompt (default 2h), pendingAction set, notify admin
- [x] **AppointmentsService.update()**: Returns `{ appointment, notificationTrigger }` to controller, handles pendingActionResolution logic
- [x] **AppointmentsController**: Fires notifications async with `setImmediate`, hasPendingAction query param
- [x] **Frontend Appointments**: Payment tab with form + confirm button, pending actions card + approve/reject, pending count badge
- [x] **Frontend Analytics**: DailyReport section, history list, generate button
- [x] **Circular dep**: NotificationsModule uses `forwardRef(() => WhatsappModule)`, ReportsModule same
- [x] **Multi-tenant**: All DB queries scoped by storeId
- [x] **Subscription gate**: RemindersService and ReportsService filter by `subscriptionStatus: 'active'`
- [x] **WA fallback**: sendWA catches and logs instead of throwing
