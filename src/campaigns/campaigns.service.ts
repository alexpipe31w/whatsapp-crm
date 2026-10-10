import { Injectable, NotFoundException, BadRequestException, ForbiddenException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { OutboundService } from '../outbound/outbound.service';
import { outboundGroups, outboundKeys } from '../outbound/outbound-keys';

@Injectable()
export class CampaignsService {
  constructor(
    private prisma: PrismaService,
    private whatsappService: WhatsappService,
    private outbound: OutboundService,
  ) {}

  async create(dto: CreateCampaignDto, storeId: string) {
    // storeId siempre del JWT, nunca del body
    return this.prisma.campaign.create({
      data: {
        storeId,
        name: dto.name,
        message: dto.message,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
      },
    });
  }

  async findAllByStore(storeId: string) {
    return this.prisma.campaign.findMany({
      where: { storeId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(campaignId: string, storeId?: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { campaignId },
    });
    if (!campaign) throw new NotFoundException('Campaña no encontrada');
    if (storeId && campaign.storeId !== storeId)
      throw new ForbiddenException('No tienes acceso a esta campaña');
    return campaign;
  }

  /**
   * Envío fuera de la petición HTTP: reclama la campaña (draft → sending, atómico: un
   * doble clic da 409) y encola una fila por destinatario en la MISMA transacción. Sale
   * el despachador, con el hueco entre mensajes; pasa a 'sent' al terminar
   * (OutboundMaintenanceService). Antes el bucle iba dentro de la petición: doble clic o
   * reinicio = reenvío total, y a clientes que nunca escribieron.
   */
  async send(campaignId: string, storeId: string) {
    await this.findOne(campaignId, storeId);
    if (!this.whatsappService.isConnected(storeId)) {
      throw new BadRequestException('WhatsApp no está conectado para esta tienda');
    }
    const campaign = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.campaign.updateMany({ where: { campaignId, storeId, status: 'draft' }, data: { status: 'sending' } });
      if (claimed.count === 0) throw new ConflictException('Esta campaña ya se está enviando o ya se envió');
      const c = await tx.campaign.findUniqueOrThrow({ where: { campaignId } });
      // Solo a quien ya nos escribió (spec: Baileys), acepta marketing y no está bloqueado
      // (mismo criterio que BlockedService.isBlocked: últimos 10 dígitos).
      const recipients = await tx.$queryRaw<{ customer_id: string; phone: string }[]>`
        SELECT c.customer_id, c.phone FROM customers c
        WHERE c.store_id = ${storeId} AND c.last_inbound_at IS NOT NULL AND c.accepts_marketing = true
          AND NOT EXISTS (
            SELECT 1 FROM blocked_contacts b
            WHERE b.store_id = c.store_id
              AND length(regexp_replace(c.phone, '[^0-9]', '', 'g')) > 0
              AND b.phone LIKE '%' || right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10))`;
      if (recipients.length === 0) {
        throw new BadRequestException('No hay clientes que te hayan escrito y acepten mensajes');
      }
      await this.outbound.enqueueMany(
        recipients.map((r) => ({
          storeId, to: r.phone, text: c.message, kind: 'campaign' as const,
          key: outboundKeys.campaign(campaignId, r.customer_id), groupKey: outboundGroups.campaign(campaignId),
        })),
        tx,
      );
      return c;
    }, { timeout: 30_000 });
    this.outbound.wake();
    return campaign;
  }
}
