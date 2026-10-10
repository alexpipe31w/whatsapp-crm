import { Module } from '@nestjs/common';
import { loadOutboundConfig } from './outbound-config';
import { OutboundService } from './outbound.service';
import { OutboundSignal } from './outbound.signal';

/** Token de la configuración de la cola (los tests lo sustituyen con overrideProvider). */
export const OUTBOUND_CONFIG = Symbol('OUTBOUND_CONFIG');

/** Cola de salida de WhatsApp. PrismaModule es global. */
@Module({
  providers: [
    OutboundService,
    OutboundSignal,
    { provide: OUTBOUND_CONFIG, useFactory: () => loadOutboundConfig() },
  ],
  exports: [OutboundService, OutboundSignal, OUTBOUND_CONFIG],
})
export class OutboundModule {}
