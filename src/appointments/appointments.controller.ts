import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, UseGuards, Request,
  HttpCode, HttpStatus,
} from '@nestjs/common';
import { AppointmentsService } from './appointments.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('appointments')
@UseGuards(JwtAuthGuard)
export class AppointmentsController {
  constructor(private readonly appointmentsService: AppointmentsService) {}

  // ─── Stats — antes de :id para que no colisione ───────────────────────────

  @Get('stats')
  getStats(@Request() req: any) {
    return this.appointmentsService.getStats(req.user.storeId);
  }

  // ─── Listar ───────────────────────────────────────────────────────────────

  @Get()
  findAll(
    @Request() req: any,
    @Query('status')    status?:    string,
    @Query('type')      type?:      string,
    @Query('from')      from?:      string,
    @Query('to')        to?:        string,
    @Query('serviceId') serviceId?: string,
    @Query('priority')  priority?:  string,
  ) {
    return this.appointmentsService.findAll(req.user.storeId, {
      status, type, from, to, serviceId, priority,
    });
  }

  // ─── Detalle ──────────────────────────────────────────────────────────────

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.appointmentsService.findOne(id, req.user.storeId);
  }

  // ─── Timeline de una cita ─────────────────────────────────────────────────

  @Get(':id/timeline')
  getTimeline(@Param('id') id: string, @Request() req: any) {
    return this.appointmentsService.getTimeline(id, req.user.storeId);
  }

  // ─── Crear ────────────────────────────────────────────────────────────────

  @Post()
  create(@Body() dto: CreateAppointmentDto, @Request() req: any) {
    return this.appointmentsService.create(
      req.user.storeId,
      dto,
      req.user.userId,
    );
  }

  // ─── Actualizar ───────────────────────────────────────────────────────────

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAppointmentDto,
    @Request() req: any,
  ) {
    return this.appointmentsService.update(
      id,
      req.user.storeId,
      dto,
      req.user.userId,
    );
  }

  // ─── Eliminar ─────────────────────────────────────────────────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @Request() req: any) {
    return this.appointmentsService.remove(id, req.user.storeId);
  }
}