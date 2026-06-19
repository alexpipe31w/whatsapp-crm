import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, UseGuards, Request, HttpCode, HttpStatus,
} from '@nestjs/common';
import { StaffService } from './staff.service';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('staff')
@UseGuards(JwtAuthGuard)
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @Get()
  findAll(@Request() req: any) {
    return this.staffService.findAll(req.user.storeId);
  }

  @Post()
  create(@Body() dto: CreateStaffDto, @Request() req: any) {
    return this.staffService.create(req.user.storeId, dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateStaffDto, @Request() req: any) {
    return this.staffService.update(id, req.user.storeId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @Request() req: any) {
    return this.staffService.remove(id, req.user.storeId);
  }

  // Borrado permanente (hard delete) — elimina el registro de la BD.
  @Delete(':id/permanent')
  @HttpCode(HttpStatus.NO_CONTENT)
  removePermanent(@Param('id') id: string, @Request() req: any) {
    return this.staffService.removePermanent(id, req.user.storeId);
  }
}
