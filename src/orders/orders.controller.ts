import { Controller, Get, Post, Patch, Body, Param, UseGuards, Request } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('orders')
export class OrdersController {
  constructor(private ordersService: OrdersService) {}

  @Post()
  create(@Body() dto: CreateOrderDto, @Request() req: any) {
    return this.ordersService.create({ ...dto, storeId: req.user.storeId });
  }

  @Get('store/:storeId')
  findAllByStore(@Param('storeId') storeId: string) {
    return this.ordersService.findAllByStore(storeId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.ordersService.findOne(id, req.user.storeId);
  }

  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateOrderDto, @Request() req: any) {
    return this.ordersService.updateStatus(id, dto, req.user.storeId);
  }
}