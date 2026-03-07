import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';

@Injectable()
export class CampaignsService {
  constructor(
    private prisma: PrismaService,
    private whatsappService: WhatsappService,
  ) {}

  async create(dto: CreateCampaignDto) {
    return this.prisma.campaign.create({
      data: {
        storeId: dto.storeId,
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

  async findOne(campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { campaignId },
    });
    if (!campaign) throw new NotFoundException('Campaña no encontrada');
    return campaign;
  }

  async send(campaignId: string) {
    const campaign = await this.findOne(campaignId);

    if (campaign.status === 'sent') {
      throw new BadRequestException('Esta campaña ya fue enviada');
    }

    // Verificar que WhatsApp esté conectado
    if (!this.whatsappService.isConnected(campaign.storeId)) {
      throw new BadRequestException('WhatsApp no está conectado para esta tienda');
    }

    // Obtener todos los clientes de la tienda
    const customers = await this.prisma.customer.findMany({
      where: { storeId: campaign.storeId },
    });

    if (customers.length === 0) {
      throw new BadRequestException('No hay clientes para enviar la campaña');
    }

    let sentCount = 0;

    for (const customer of customers) {
      try {
        await this.whatsappService.sendMessage(
          campaign.storeId,
          customer.phone,
          campaign.message,
        );
        sentCount++;

        // Esperar 1 segundo entre mensajes para evitar bloqueos
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (err) {
        console.error(`Error enviando a ${customer.phone}: ${err.message}`);
      }
    }

    // Actualizar campaña como enviada
    return this.prisma.campaign.update({
      where: { campaignId },
      data: {
        status: 'sent',
        sentCount,
      },
    });
  }
}
