import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';

// Delay entre mensajes: aumenta cada 10 enviados para imitar comportamiento humano
const BASE_DELAY_MS = 1500;
const BATCH_EXTRA_MS = 2000; // extra cada 10 mensajes

@Injectable()
export class CampaignsService {
  constructor(
    private prisma: PrismaService,
    private whatsappService: WhatsappService,
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

  async send(campaignId: string, storeId: string) {
    // storeId del JWT — valida que la campaña pertenece a esta tienda
    const campaign = await this.findOne(campaignId, storeId);

    if (campaign.status === 'sent') {
      throw new BadRequestException('Esta campaña ya fue enviada');
    }

    if (!this.whatsappService.isConnected(campaign.storeId)) {
      throw new BadRequestException('WhatsApp no está conectado para esta tienda');
    }

    // Obtener clientes excluyendo los bloqueados
    const [customers, blockedContacts] = await Promise.all([
      this.prisma.customer.findMany({ where: { storeId: campaign.storeId } }),
      this.prisma.blockedContact.findMany({
        where: { storeId: campaign.storeId },
        select: { phone: true },
      }),
    ]);

    const blockedPhones = new Set(blockedContacts.map((b: any) => b.phone));
    const eligible = customers.filter((c: any) => !blockedPhones.has(c.phone));

    if (eligible.length === 0) {
      throw new BadRequestException('No hay clientes elegibles para enviar la campaña');
    }

    let sentCount = 0;
    let failCount = 0;

    for (let i = 0; i < eligible.length; i++) {
      const customer = eligible[i];
      try {
        await this.whatsappService.sendMessage(
          campaign.storeId,
          customer.phone,
          campaign.message,
        );
        sentCount++;
      } catch (err: any) {
        failCount++;
        console.error(`Error enviando a ${customer.phone}: ${err.message}`);
      }

      // Delay progresivo: base + extra cada 10 mensajes para no disparar antispam de WA
      const extra = Math.floor(i / 10) * BATCH_EXTRA_MS;
      const jitter = Math.floor(Math.random() * 500); // hasta 500ms aleatorio
      await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS + extra + jitter));
    }

    return this.prisma.campaign.update({
      where: { campaignId },
      data: { status: 'sent', sentCount },
    });
  }
}