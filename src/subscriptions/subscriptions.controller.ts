import {
  Controller, Post, Get, Body, Request, Query, Headers,
  UseGuards, HttpCode, HttpStatus, Param,
} from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthRateLimitGuard } from '../auth/guards/auth-rate-limit.guard';

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  // Máx 5 checkouts por minuto por IP — evita spam de preferencias en MP
  @Post('checkout')
  @UseGuards(JwtAuthGuard, AuthRateLimitGuard)
  checkout(@Request() req: any) {
    return this.subscriptionsService.checkout(req.user.storeId);
  }

  // MP puede enviar el paymentId en el body O en query params — pasamos ambos
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  webhook(
    @Body() body: any,
    @Query() query: Record<string, string>,
    @Headers() headers: Record<string, string>,
  ) {
    return this.subscriptionsService.handleWebhook(body, query, headers);
  }

  @Get('my')
  @UseGuards(JwtAuthGuard)
  getMySubscription(@Request() req: any) {
    return this.subscriptionsService.getMySubscription(req.user.storeId);
  }

  // Máx 10 intentos por minuto — evita fuerza bruta de payment IDs
  @Post('process-payment/:paymentId')
  @UseGuards(JwtAuthGuard, AuthRateLimitGuard)
  processPayment(@Param('paymentId') paymentId: string, @Request() req: any) {
    return this.subscriptionsService.processPaymentById(paymentId, req.user.storeId);
  }
}
