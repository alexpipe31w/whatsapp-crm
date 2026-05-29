import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards, Request } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Get('store/:storeId')
  findAll(@Param('storeId') storeId: string, @Request() req: any) {
    // Multi-tenant: solo puede ver su propia tienda (superadmin ve todas)
    const effectiveStoreId = req.user.role === 'superadmin' ? storeId : req.user.storeId;
    return this.conversationsService.findAllByStore(effectiveStoreId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.conversationsService.findOne(id, req.user.storeId);
  }

  @Post()
  create(@Body() body: { customerId: string }, @Request() req: any) {
    // storeId viene del JWT, no del body — el cliente no puede falsificarlo
    return this.conversationsService.findOrCreate(body.customerId, req.user.storeId);
  }

  @Patch(':id/takeover')
  takeover(@Param('id') id: string, @Request() req: any) {
    return this.conversationsService.takeover(id, req.user.storeId);
  }

  @Patch(':id/release')
  release(@Param('id') id: string, @Request() req: any) {
    return this.conversationsService.release(id, req.user.storeId);
  }

  @Patch(':id/close')
  close(@Param('id') id: string, @Request() req: any) {
    return this.conversationsService.close(id, req.user.storeId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: any) {
    return this.conversationsService.remove(id, req.user.storeId);
  }
}