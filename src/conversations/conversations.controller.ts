import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Get('store/:storeId')
  findAll(@Param('storeId') storeId: string) {
    return this.conversationsService.findAllByStore(storeId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.conversationsService.findOne(id);
  }

  @Post()
  create(@Body() body: { customerId: string; storeId: string }) {
    return this.conversationsService.findOrCreate(body.customerId, body.storeId);
  }

  @Patch(':id/takeover')
  takeover(@Param('id') id: string) {
    return this.conversationsService.takeover(id);
  }

  @Patch(':id/release')
  release(@Param('id') id: string) {
    return this.conversationsService.release(id);
  }

  @Patch(':id/close')
  close(@Param('id') id: string) {
    return this.conversationsService.close(id);
  }

  /**
   * Elimina la conversación y sus mensajes.
   * Solo permitido cuando status = 'closed'.
   * NO elimina el customer ni sus pedidos.
   */
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.conversationsService.remove(id);
  }
}
