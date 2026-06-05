import { Controller, Get, Param, Query } from '@nestjs/common';
import { PublicService } from './public.service';

@Controller('public')
export class PublicController {
  constructor(private readonly publicService: PublicService) {}

  @Get(':slug')
  getStore(@Param('slug') slug: string) {
    return this.publicService.getStoreBySlug(slug);
  }

  @Get(':slug/availability')
  getAvailability(@Param('slug') slug: string, @Query('date') date: string): Promise<any> {
    return this.publicService.getAvailability(slug, date);
  }
}
