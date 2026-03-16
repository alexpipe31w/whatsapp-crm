// ─── dto/update-appointment.dto.ts ───────────────────────────────────────────
 
export class UpdateAppointmentDto {
  status?: 'pending' | 'confirmed' | 'completed' | 'cancelled';
  type?: 'cita' | 'visita_tecnica' | 'otro';
  scheduledAt?: string;
  description?: string;
  address?: string;
  notes?: string;
}