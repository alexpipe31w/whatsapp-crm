import { Injectable } from '@nestjs/common';

/**
 * Timbre entre quien encola y el despachador (hoy en el mismo proceso). Encolar sin
 * transacción toca el timbre al momento; quien encola dentro de una transacción llama a
 * OutboundService.wake() DESPUÉS del commit (antes, el despachador no vería la fila).
 * Si nadie toca, el sondeo de respaldo la recoge. En el bloque 1c pasa a LISTEN/NOTIFY.
 */
@Injectable()
export class OutboundSignal {
  private listener: (() => void) | null = null;

  onWake(listener: () => void): void {
    this.listener = listener;
  }

  wake(): void {
    this.listener?.();
  }
}
