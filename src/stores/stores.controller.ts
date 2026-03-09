import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, Request } from '@nestjs/common';
import { StoresService } from './stores.service';
import { CreateStoreDto } from './dto/create-store.dto';
import { UpdateStoreDto } from './dto/update-store.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('stores')
export class StoresController {
  constructor(private storesService: StoresService) {}

  // Solo admins deberían llamar este endpoint
  // TODO: agregar RolesGuard cuando implementes roles
  @Post()
  create(@Body() dto: CreateStoreDto) {
    return this.storesService.create(dto);
  }

  // Solo admins — lista todas las tiendas sin groqApiKey
  @Get()
  findAll() {
    return this.storesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.storesService.findOne(id, req.user.storeId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateStoreDto, @Request() req: any) {
    return this.storesService.update(id, dto, req.user.storeId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: any) {
    return this.storesService.remove(id, req.user.storeId);
  }
}