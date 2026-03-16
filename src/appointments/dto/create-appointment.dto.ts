// ─── dto/create-appointment.dto.ts ───────────────────────────────────────────
 
export class CreateAppointmentDto {
  customerId: string;
  type?: 'cita' | 'visita_tecnica' | 'otro';
  scheduledAt: string; // ISO 8601: "2024-03-15T14:00:00-05:00"
  description?: string;
  address?: string;
  notes?: string;
}