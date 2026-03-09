import { Controller, Get, Post, Body, Param, UseGuards, Request } from '@nestjs/common';
import { CampaignsService } from './campaigns.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('campaigns')
export class CampaignsController {
  constructor(private campaignsService: CampaignsService) {}

  @Post()
  create(@Body() dto: CreateCampaignDto, @Request() req: any) {
    return this.campaignsService.create(dto, req.user.storeId);
  }

  @Get('store/:storeId')
  findAllByStore(@Param('storeId') storeId: string) {
    return this.campaignsService.findAllByStore(storeId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.campaignsService.findOne(id, req.user.storeId);
  }

  @Post(':id/send')
  send(@Param('id') id: string, @Request() req: any) {
    return this.campaignsService.send(id, req.user.storeId);
  }
}