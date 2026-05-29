import { Controller, Post, Get, Delete, Body, Param, Request, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard, Roles } from './guards/roles.guard';
import { AuthRateLimitGuard } from './guards/auth-rate-limit.guard';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('send-verification')
  @UseGuards(AuthRateLimitGuard)
  @HttpCode(HttpStatus.OK)
  sendVerification(@Body() body: {
    name: string; email: string; password: string;
    storeName: string; storePhone: string;
  }) {
    return this.authService.sendVerificationCode(body);
  }

  @Post('verify-and-register')
  @UseGuards(AuthRateLimitGuard)
  @HttpCode(HttpStatus.OK)
  verifyAndRegister(@Body() body: { sessionId: string; code: string }) {
    return this.authService.verifyAndRegister(body.sessionId, body.code);
  }

  @Post('register')
  @UseGuards(AuthRateLimitGuard)
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @UseGuards(AuthRateLimitGuard)
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Get('users')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'superadmin')
  getUsers(@Request() req: any) {
    const isSuperAdmin = req.user.role === 'superadmin';
    return this.authService.getUsers(isSuperAdmin ? null : req.user.storeId);
  }

  @Delete('users/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'superadmin')
  deleteUser(@Param('id') id: string, @Request() req: any) {
    const isSuperAdmin = req.user.role === 'superadmin';
    return this.authService.deleteUser(id, isSuperAdmin ? null : req.user.storeId);
  }
}