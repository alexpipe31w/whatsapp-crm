import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SuperAdminGuard } from './guards/superadmin.guard';
import { SuperAdminRateLimitGuard } from './guards/superadmin-rate-limit.guard';
import { SuperAdminService } from './superadmin.service';

@Controller('superadmin')
@UseGuards(SuperAdminRateLimitGuard)
export class SuperAdminController {
  constructor(private readonly superAdminService: SuperAdminService) {}

  // ── Auth pública ──────────────────────────────────────────────────────────

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() body: { email: string; password: string }) {
    return this.superAdminService.login(body.email, body.password);
  }

  @Post('verify-code')
  @HttpCode(HttpStatus.OK)
  verifyCode(@Body() body: { sessionId: string; code: string }) {
    return this.superAdminService.verifyCode(body.sessionId, body.code);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  forgotPassword(@Body() body: { email: string }) {
    return this.superAdminService.forgotPassword(body.email);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(@Body() body: { email: string; code: string; newPassword: string }) {
    return this.superAdminService.resetPassword(body.email, body.code, body.newPassword);
  }

  // ── Protegidos con JWT + SuperAdminGuard ─────────────────────────────────

  @Get('dashboard')
  @UseGuards(JwtAuthGuard, SuperAdminGuard)
  getDashboard() {
    return this.superAdminService.getDashboard();
  }

  @Get('stores')
  @UseGuards(JwtAuthGuard, SuperAdminGuard)
  getStores() {
    return this.superAdminService.getStores();
  }

  @Patch('stores/:id/toggle')
  @UseGuards(JwtAuthGuard, SuperAdminGuard)
  toggleStore(@Param('id') id: string, @Request() req: any) {
    return this.superAdminService.toggleStore(id, req.user.userId);
  }

  @Get('users')
  @UseGuards(JwtAuthGuard, SuperAdminGuard)
  getUsers() {
    return this.superAdminService.getUsers();
  }

  @Patch('users/:id/toggle')
  @UseGuards(JwtAuthGuard, SuperAdminGuard)
  toggleUser(@Param('id') id: string, @Request() req: any) {
    return this.superAdminService.toggleUser(id, req.user.userId);
  }

  @Delete('users/:id')
  @UseGuards(JwtAuthGuard, SuperAdminGuard)
  deleteUser(@Param('id') id: string, @Request() req: any) {
    return this.superAdminService.deleteUser(id, req.user.userId);
  }

  @Get('audit')
  @UseGuards(JwtAuthGuard, SuperAdminGuard)
  getAuditLogs() {
    return this.superAdminService.getAuditLogs();
  }

  // ── Suscripciones ─────────────────────────────────────────────────────────

  @Get('subscription-config')
  @UseGuards(JwtAuthGuard, SuperAdminGuard)
  getSubscriptionConfig() {
    return this.superAdminService.getSubscriptionConfig();
  }

  @Patch('subscription-config')
  @UseGuards(JwtAuthGuard, SuperAdminGuard)
  updateSubscriptionConfig(@Body() body: { priceAmount: number }, @Request() req: any) {
    return this.superAdminService.updateSubscriptionConfig(body.priceAmount, req.user.email);
  }

  @Get('subscriptions')
  @UseGuards(JwtAuthGuard, SuperAdminGuard)
  getSubscriptions() {
    return this.superAdminService.getSubscriptions();
  }
}
