import {
  IsString, IsOptional, IsEnum, IsDateString,
  IsInt, IsNumber, Min, Max, MaxLength, IsPositive,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AppointmentStatus, AppointmentPriority } from '../../generated/prisma';

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
  // Solo requerido cuando status = CANCELLED
  @IsString()
  @IsOptional()
  @MaxLength(500)
  cancelReason?: string;
}