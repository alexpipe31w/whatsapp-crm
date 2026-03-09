import { Controller, Post, Get, Delete, Param, UseGuards, Request, Res, ForbiddenException } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { Response } from 'express';

@UseGuards(JwtAuthGuard)
@Controller('whatsapp')
export class WhatsappController {
  constructor(private whatsappService: WhatsappService) {}

  @Post('connect/:storeId')
  async connect(@Param('storeId') storeId: string, @Request() req: any) {
    if (req.user.storeId !== storeId)
      throw new ForbiddenException('No puedes conectar una tienda que no es la tuya');
    await this.whatsappService.connectStore(storeId);
    return { message: 'Conectando... escanea el QR con GET /whatsapp/qr/:storeId' };
  }

  @Get('qr/:storeId')
  getQR(@Param('storeId') storeId: string, @Request() req: any, @Res() res: Response) {
    if (req.user.storeId !== storeId)
      throw new ForbiddenException('No puedes ver el QR de otra tienda');
    const qr = this.whatsappService.getQR(storeId);
    if (!qr) {
      return res.json({ message: 'No hay QR disponible. Usa POST /whatsapp/connect/:storeId primero' });
    }
    return res.json({ qr });
  }

  @Get('status/:storeId')
  getStatus(@Param('storeId') storeId: string, @Request() req: any) {
    if (req.user.storeId !== storeId)
      throw new ForbiddenException('No puedes ver el estado de otra tienda');
    const connected = this.whatsappService.isConnected(storeId);
    return { storeId, connected };
  }

  @Delete('disconnect/:storeId')
  async disconnect(@Param('storeId') storeId: string, @Request() req: any) {
    if (req.user.storeId !== storeId)
      throw new ForbiddenException('No puedes desconectar una tienda que no es la tuya');
    await this.whatsappService.disconnectStore(storeId);
    return { message: 'Desconectado exitosamente' };
  }
}