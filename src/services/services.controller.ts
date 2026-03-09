import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, Request } from '@nestjs/common';
import { ServicesService } from './services.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('services')
export class ServicesController {
  constructor(private servicesService: ServicesService) {}

  @Post()
  create(@Body() dto: CreateServiceDto, @Request() req: any) {
    return this.servicesService.create({ ...dto, storeId: req.user.storeId });
  }

  @Get('store/:storeId')
  findAllByStore(@Param('storeId') storeId: string) {
    return this.servicesService.findAllByStore(storeId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.servicesService.findOne(id, req.user.storeId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateServiceDto, @Request() req: any) {
    return this.servicesService.update(id, dto, req.user.storeId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: any) {
    return this.servicesService.remove(id, req.user.storeId);
  }
}