import { Module } from '@nestjs/common';
import { CampaignsService } from './campaigns.service';
import { CampaignsController } from './campaigns.controller';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { OutboundModule } from '../outbound/outbound.module';

@Module({
  imports: [WhatsappModule, OutboundModule],
  controllers: [CampaignsController],
  providers: [CampaignsService],
})
export class CampaignsModule {}
