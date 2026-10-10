import { Module } from '@nestjs/common';
import { loadOutboundConfig } from './outbound-config';
import { OutboundService } from './outbound.service';
import { OutboundSignal } from './outbound.signal';
import { OutboundMaintenanceService } from './outbound-maintenance.service';
import { OUTBOUND_CONFIG } from './outbound.tokens';

export { OUTBOUND_CONFIG };

/** Cola de salida de WhatsApp. PrismaModule es global. */
@Module({
  providers: [
    OutboundService,
    OutboundSignal,
    OutboundMaintenanceService,
    { provide: OUTBOUND_CONFIG, useFactory: () => loadOutboundConfig() },
  ],
  exports: [OutboundService, OutboundSignal, OUTBOUND_CONFIG],
})
export class OutboundModule {}
