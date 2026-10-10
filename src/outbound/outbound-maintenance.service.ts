import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { OUTBOUND_CONFIG } from './outbound.tokens';
import { OutboundConfig } from './outbound-config';

const PURGE_LOCK = 'wa-outbound-purge';
const PURGE_BATCH = 5_000;

/** Cierra campañas terminadas y purga lo viejo. Idempotente; la purga, con candado de Postgres. */
@Injectable()
export class OutboundMaintenanceService {
  private readonly logger = new Logger(OutboundMaintenanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OUTBOUND_CONFIG) private readonly cfg: OutboundConfig,
  ) {}

  @Interval('outbound-close-campaigns', 60_000)
  async closeCampaignsTick(): Promise<void> {
    if (!this.cfg.dispatcherEnabled) return;
    await this.closeFinishedCampaigns().catch((err: Error) =>
      this.logger.error(`[outbound] cierre de campañas: ${err.message}`),
    );
  }

  @Cron('15 5 * * *', { name: 'outbound-purge', timeZone: 'UTC' })
  async purgeTick(): Promise<void> {
    if (!this.cfg.dispatcherEnabled) return;
    await this.purge().catch((err: Error) =>
      this.logger.error(`[outbound] purga: ${err.message}`),
    );
  }

  /** sending → sent cuando no le quedan filas pending/sending. sent_count = filas enviadas. */
  async closeFinishedCampaigns(): Promise<number> {
    const n = await this.prisma.$executeRaw`
      UPDATE campaigns c SET status = 'sent',
        sent_count = (SELECT count(*) FROM wa_outbound o WHERE o.group_key = 'campaign:' || c.campaign_id AND o.status = 'sent')
      WHERE c.status = 'sending'
        AND NOT EXISTS (SELECT 1 FROM wa_outbound o
                        WHERE o.group_key = 'campaign:' || c.campaign_id AND o.status IN ('pending', 'sending'))`;
    if (n > 0) this.logger.log(`[outbound] ${n} campaña(s) terminada(s)`);
    return n;
  }

  /** Borra por lotes lo cerrado y viejo. Con dos procesos, solo uno purga (candado). */
  async purge(): Promise<{
    skipped: boolean;
    outbound: number;
    inbound: number;
  }> {
    return this.prisma.$transaction(
      async (tx) => {
        const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${PURGE_LOCK})) AS locked`;
        if (!locked) return { skipped: true, outbound: 0, inbound: 0 };
        let outbound = 0;
        let inbound = 0;
        for (;;) {
          const n = await tx.$executeRaw`
          DELETE FROM wa_outbound WHERE id IN (
            SELECT id FROM wa_outbound
            WHERE status IN ('sent', 'failed', 'skipped')
              AND updated_at < (now() AT TIME ZONE 'UTC') - (${this.cfg.outboundRetentionDays} * interval '1 day')
            LIMIT ${PURGE_BATCH})`;
          outbound += n;
          if (n < PURGE_BATCH) break;
        }
        for (;;) {
          const n = await tx.$executeRaw`
          DELETE FROM wa_inbound WHERE id IN (
            SELECT id FROM wa_inbound
            WHERE created_at < (now() AT TIME ZONE 'UTC') - (${this.cfg.inboundRetentionDays} * interval '1 day')
            LIMIT ${PURGE_BATCH})`;
          inbound += n;
          if (n < PURGE_BATCH) break;
        }
        this.logger.log(
          `[outbound] purga: ${outbound} salientes y ${inbound} entrantes borrados`,
        );
        return { skipped: false, outbound, inbound };
      },
      { timeout: 120_000 },
    );
  }
}
