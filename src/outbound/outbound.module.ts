import { Module } from '@nestjs/common';
import { OutboundService } from './outbound.service';
import { OutboundSignal } from './outbound.signal';

/** Cola de salida de WhatsApp. PrismaModule es global. */
@Module({
  providers: [OutboundService, OutboundSignal],
  exports: [OutboundService, OutboundSignal],
})
export class OutboundModule {}
