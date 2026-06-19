import { Controller, Get, Post, Param, Query, Body, UseGuards } from '@nestjs/common';
import { PublicService } from './public.service';
import { PublicBookingDto } from './dto/public-booking.dto';
import { PublicOrderDto } from './dto/public-order.dto';
import { PublicBookingRateLimitGuard } from '../auth/guards/public-booking-rate-limit.guard';

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

  // Auto-agendamiento público — plan de emergencia si la IA falla o se agotan los tokens
  @UseGuards(PublicBookingRateLimitGuard)
  @Post(':slug/book')
  book(@Param('slug') slug: string, @Body() dto: PublicBookingDto) {
    return this.publicService.bookAppointment(slug, dto);
  }

  // Tienda pública — productos publicables de la tienda resuelta por slug
  @Get(':slug/products')
  getProducts(@Param('slug') slug: string) {
    return this.publicService.getProductsBySlug(slug);
  }

  // Pedido público — plan de emergencia si la IA falla (mismo guard de rate-limit que book)
  @UseGuards(PublicBookingRateLimitGuard)
  @Post(':slug/order')
  order(@Param('slug') slug: string, @Body() dto: PublicOrderDto) {
    return this.publicService.createOrder(slug, dto);
  }
}
