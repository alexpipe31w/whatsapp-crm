import {
  IsString, IsOptional, IsEnum, IsDateString,
  IsInt, IsNumber, IsUUID, Min, Max, MaxLength, IsPositive, IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AppointmentStatus, AppointmentPriority } from '../../generated/prisma/enums';

const PAYMENT_STATUSES   = ['PENDING', 'PAID', 'PARTIAL', 'REFUNDED'] as const;
const PAYMENT_METHODS    = ['efectivo', 'transferencia', 'tarjeta', 'nequi', 'daviplata', 'otro'] as const;
const ACTION_RESOLUTIONS = ['approved', 'rejected'] as const;

export class UpdateAppointmentDto {

  @IsEnum(AppointmentStatus)
  @IsOptional()
  status?: AppointmentStatus;

  @IsEnum(AppointmentPriority)
  @IsOptional()
  priority?: AppointmentPriority;

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

  @IsString()
  @IsOptional()
  @MaxLength(100)
  type?: string;

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

  @IsNumber()
  @IsOptional()
  @IsPositive()
  @Type(() => Number)
  agreedPrice?: number;

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

  // ── Resolución de acción pendiente ─────────────────────────────────────────
  @IsIn(ACTION_RESOLUTIONS)
  @IsOptional()
  pendingActionResolution?: typeof ACTION_RESOLUTIONS[number];

  @IsString()
  @IsOptional()
  @MaxLength(500)
  rejectionReason?: string;

  @IsUUID()
  @IsOptional()
  staffId?: string;
}
