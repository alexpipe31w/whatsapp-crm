// src/integrations/integrations.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  RawBodyRequest,
  Req,
  Request,
  UseGuards,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SyncService } from './sync.service';
import { verifySyncRequest } from './sync-signing';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('integrations/stockup')
export class IntegrationsController {
  constructor(private prisma: PrismaService, private sync: SyncService) {}

  // ── Gestión (JWT, la llama el FE del CRM) ────────────────────────────────
  @UseGuards(JwtAuthGuard)
  @Post('link-code')
  async generateLinkCode(@Request() req: any) {
    const storeId = req.user.storeId;
    const code = randomBytes(4).toString('hex').toUpperCase(); // 8 chars
    await this.prisma.stockupConnection.upsert({
      where: { storeId },
      update: { linkCode: code, linkCodeExpiresAt: new Date(Date.now() + 10 * 60_000) },
      create: { storeId, linkCode: code, linkCodeExpiresAt: new Date(Date.now() + 10 * 60_000) },
    });
    return { code, expiresInMinutes: 10 };
  }

  @UseGuards(JwtAuthGuard)
  @Get('connection')
  async getConnectionStatus(@Request() req: any) {
    const conn = await this.prisma.stockupConnection.findUnique({
      where: { storeId: req.user.storeId },
    });
    return {
      connected: !!conn?.enabled,
      stockupTenantId: conn?.stockupTenantId ?? null,
      lastSyncAt: conn?.lastSyncAt ?? null,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Delete('connection')
  async disconnect(@Request() req: any) {
    // purga outbox pendiente para no dejar filas que ahoguen el batch global del dispatcher
    await this.prisma.syncOutbox.deleteMany({
      where: { storeId: req.user.storeId, status: 'PENDING' },
    });
    await this.prisma.stockupConnection.deleteMany({ where: { storeId: req.user.storeId } });
    this.sync.invalidateCache(req.user.storeId);
    return { ok: true };
  }

  // ── Pairing (lo llama StockUp con el código; público) ───────────────────
  @Post('link')
  @HttpCode(200)
  async link(@Body() body: { code: string; stockupTenantId: string }) {
    if (!body?.code || !body?.stockupTenantId) {
      throw new HttpException('code y stockupTenantId requeridos', HttpStatus.BAD_REQUEST);
    }
    const conn = await this.prisma.stockupConnection.findFirst({
      where: { linkCode: body.code, linkCodeExpiresAt: { gte: new Date() } },
    });
    if (!conn) throw new HttpException('Codigo invalido o vencido', HttpStatus.UNAUTHORIZED);
    const secret = randomBytes(32).toString('hex');
    await this.prisma.stockupConnection.update({
      where: { connectionId: conn.connectionId },
      data: {
        secret,
        enabled: true,
        stockupTenantId: body.stockupTenantId,
        linkCode: null,
        linkCodeExpiresAt: null,
      },
    });
    this.sync.invalidateCache(conn.storeId);
    return { storeId: conn.storeId, secret };
  }

  // ── Receptor de eventos (StockUp → CRM; HMAC) ────────────────────────────
  @Post('events')
  @HttpCode(200)
  async receiveEvent(
    @Req() req: RawBodyRequest<any>,
    @Headers('x-sync-timestamp') ts: string,
    @Headers('x-sync-signature') sig: string,
    @Body() envelope: any,
  ) {
    const rawBody: string = req.rawBody?.toString('utf8') ?? JSON.stringify(envelope);
    const match = await this.findSignedConnection(rawBody, ts, sig);
    if (!match) throw new HttpException('Firma invalida', HttpStatus.UNAUTHORIZED);

    const result = await this.sync.applyRemoteEvent(match.storeId, envelope);
    if (!result.ok) throw new HttpException('No se pudo aplicar', HttpStatus.UNPROCESSABLE_ENTITY);
    return { ok: true, mapped: result.mapped };
  }

  // ── Catálogo compacto para reconciliación (HMAC) ─────────────────────────
  @Post('catalog')
  @HttpCode(200)
  async catalog(
    @Req() req: RawBodyRequest<any>,
    @Headers('x-sync-timestamp') ts: string,
    @Headers('x-sync-signature') sig: string,
    @Body() body: any,
  ) {
    const rawBody: string = req.rawBody?.toString('utf8') ?? JSON.stringify(body);
    const match = await this.findSignedConnection(rawBody, ts, sig);
    if (!match) throw new HttpException('Firma invalida', HttpStatus.UNAUTHORIZED);

    const products = await this.prisma.product.findMany({
      where: { storeId: match.storeId },
      select: {
        productId: true,
        stockupProductId: true,
        stock: true,
        updatedAt: true,
        name: true,
        salePrice: true,
        isActive: true,
      },
    });
    const categories = await this.prisma.category.findMany({
      where: { storeId: match.storeId },
      select: { categoryId: true, stockupCategoryId: true, name: true },
    });
    return {
      products: products.map((p) => ({
        sourceId: p.productId,
        targetId: p.stockupProductId,
        stock: p.stock,
        updatedAt: p.updatedAt.toISOString(),
        fingerprint: `${p.name}|${Number(p.salePrice)}|${p.isActive}`,
      })),
      categories: categories.map((c) => ({
        sourceId: c.categoryId,
        targetId: c.stockupCategoryId,
        name: c.name,
      })),
    };
  }

  // Resolución de conexión por firma: hay 1 conexión por store y el volumen de
  // tiendas conectadas es bajo, así que probar contra todas las enabled es barato.
  private async findSignedConnection(rawBody: string, ts: string, sig: string) {
    if (!ts || !sig) return null;
    const conns = await this.prisma.stockupConnection.findMany({ where: { enabled: true } });
    return conns.find((c) => c.secret && verifySyncRequest(c.secret, rawBody, ts, sig)) ?? null;
  }
}
