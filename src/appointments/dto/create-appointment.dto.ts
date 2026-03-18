import {
  IsString, IsOptional, IsEnum, IsDateString,
  IsInt, IsNumber, IsUUID, Min, Max, MaxLength,
  IsPositive,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AppointmentPriority, AppointmentSource } from '../../generated/prisma';

export class CreateAppointmentDto {

  // ── Cliente ──────────────────────────────────────────────────────────────
  @IsUUID()
  customerId: string;

  // ── Vínculo al catálogo (opcional) ───────────────────────────────────────
  @IsUUID()
  @IsOptional()
  serviceId?: string;

  @IsUUID()
  @IsOptional()
  serviceVariantId?: string;

  // ── Clasificación ─────────────────────────────────────────────────────────
  // type es texto libre: "cita", "visita_tecnica", "consulta", "instalacion", etc.
  @IsString()
  @IsOptional()
  @MaxLength(100)
  type?: string;

  @IsEnum(AppointmentPriority)
  @IsOptional()
  priority?: AppointmentPriority;

  @IsEnum(AppointmentSource)
  @IsOptional()
  source?: AppointmentSource;

  // ── Tiempo ────────────────────────────────────────────────────────────────
  // ISO 8601 con timezone: "2025-03-20T14:00:00-05:00"
  @IsDateString()
  scheduledAt: string;

  @IsDateString()
  @IsOptional()
  endsAt?: string;

  @IsInt()
  @IsOptional()
  @Min(5)
  @Max(1440) // máximo 24 horas
  @Type(() => Number)
  durationMinutes?: number;

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

  // ── Precio acordado ───────────────────────────────────────────────────────
  @IsNumber()
  @IsOptional()
  @IsPositive()
  @Type(() => Number)
  agreedPrice?: number;
}