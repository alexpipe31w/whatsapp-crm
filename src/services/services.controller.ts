import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, UseGuards, Request, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ServicesService } from './services.service';
import { CreateServiceDto, CreateServiceVariantDto } from './dto/create-service.dto';
import { UpdateServiceDto, UpdateServiceVariantDto } from './dto/update-service.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('services')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  // ─── Servicios ────────────────────────────────────────────────────────────

  @Post()
  create(@Body() dto: CreateServiceDto, @Request() req: any) {
    // storeId del JWT — nunca del body
    return this.servicesService.create({ ...dto, storeId: req.user.storeId });
  }

  @Get()
  findAll(@Request() req: any) {
    return this.servicesService.findAllByStore(req.user.storeId);
  }

  // Mantener compatibilidad con ruta anterior
  @Get('store/:storeId')
  findAllByStore(@Param('storeId') storeId: string) {
    return this.servicesService.findAllByStore(storeId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.servicesService.findOne(id, req.user.storeId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateServiceDto,
    @Request() req: any,
  ) {
    return this.servicesService.update(id, dto, req.user.storeId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @Request() req: any) {
    return this.servicesService.remove(id, req.user.storeId);
  }

  // ─── Variantes individuales ───────────────────────────────────────────────

  @Post(':id/variants')
  addVariant(
    @Param('id') serviceId: string,
    @Body() dto: CreateServiceVariantDto,
    @Request() req: any,
  ) {
    return this.servicesService.addVariant(serviceId, dto, req.user.storeId);
  }

  @Patch('variants/:variantId')
  updateVariant(
    @Param('variantId') variantId: string,
    @Body() dto: UpdateServiceVariantDto,
    @Request() req: any,
  ) {
    return this.servicesService.updateVariant(variantId, dto, req.user.storeId);
  }

  @Delete('variants/:variantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeVariant(
    @Param('variantId') variantId: string,
    @Request() req: any,
  ) {
    return this.servicesService.removeVariant(variantId, req.user.storeId);
  }
}