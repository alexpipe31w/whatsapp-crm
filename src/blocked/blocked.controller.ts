import { Controller, Get, Post, Delete, Body, Param, UseGuards, Request } from '@nestjs/common';
import { BlockedService } from './blocked.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('blocked')
@UseGuards(JwtAuthGuard)
export class BlockedController {
  constructor(private blockedService: BlockedService) {}

  @Get()
  getAll(@Request() req: any) {
    return this.blockedService.getAll(req.user.storeId);
  }

  @Post()
  block(@Request() req: any, @Body() body: { phone: string; label?: string }) {
    return this.blockedService.block(req.user.storeId, body.phone, body.label);
  }

  @Delete(':id')
  unblock(@Param('id') id: string, @Request() req: any) {
    return this.blockedService.unblock(id, req.user.storeId);
  }
}