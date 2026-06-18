import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, UseGuards, Request,
  HttpCode, HttpStatus,
} from '@nestjs/common';
import { AppointmentsService } from './appointments.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { CreateWalkInDto } from './dto/create-walk-in.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('appointments')
@UseGuards(JwtAuthGuard)
export class AppointmentsController {
  constructor(
    private readonly appointmentsService: AppointmentsService,
    private readonly notifications:       NotificationsService,
  ) {}

  @Get('stats')
  getStats(@Request() req: any) {
    return this.appointmentsService.getStats(req.user.storeId);
  }

  @Get()
  findAll(
    @Request() req: any,
    @Query('status')           status?:           string,
    @Query('type')             type?:             string,
    @Query('from')             from?:             string,
    @Query('to')               to?:               string,
    @Query('serviceId')        serviceId?:        string,
    @Query('staffId')          staffId?:          string,
    @Query('priority')         priority?:         string,
    @Query('hasPendingAction') hasPendingAction?: string,
  ) {
    return this.appointmentsService.findAll(req.user.storeId, {
      status, type, from, to, serviceId, staffId, priority, hasPendingAction,
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.appointmentsService.findOne(id, req.user.storeId);
  }

  @Get(':id/timeline')
  getTimeline(@Param('id') id: string, @Request() req: any) {
    return this.appointmentsService.getTimeline(id, req.user.storeId);
  }

  @Post()
  create(@Body() dto: CreateAppointmentDto, @Request() req: any) {
    return this.appointmentsService.create(req.user.storeId, dto, req.user.userId);
  }

  @Post('walk-in')
  createWalkIn(@Body() dto: CreateWalkInDto, @Request() req: any) {
    return this.appointmentsService.createWalkIn(req.user.storeId, dto, req.user.userId);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAppointmentDto,
    @Request() req: any,
  ) {
    const { appointment, notificationTrigger } =
      await this.appointmentsService.update(id, req.user.storeId, dto, req.user.userId);

    if (notificationTrigger) {
      setImmediate(async () => {
        try {
          if (notificationTrigger === 'confirmed') {
            await this.notifications.notifyAppointmentConfirmed(appointment);
          } else if (
            notificationTrigger === 'action_approved_cancel' ||
            notificationTrigger === 'action_approved_reschedule'
          ) {
            const pendingActionForMsg = dto.pendingActionResolution === 'approved'
              ? (appointment.pendingAction ?? 'CANCEL_REQUESTED')
              : null;
            await this.notifications.notifyActionResolved(
              { ...appointment, pendingAction: pendingActionForMsg },
              true,
            );
          } else if (notificationTrigger === 'action_rejected') {
            await this.notifications.notifyActionResolved(
              appointment, false, dto.rejectionReason,
            );
          }
        } catch {
          // Errors already logged inside NotificationsService
        }
      });
    }

    return appointment;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @Request() req: any) {
    return this.appointmentsService.remove(id, req.user.storeId);
  }
}
