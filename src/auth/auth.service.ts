import { Injectable, UnauthorizedException, ConflictException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const exists = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (exists) throw new ConflictException('Email ya registrado');

    const hashed = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        password: hashed,
        role: dto.role || 'admin',
        storeId: dto.storeId,
      },
    });

    return this.signToken(user.userId, user.email, user.role, user.storeId);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (!user) throw new UnauthorizedException('Credenciales inválidas');

    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid) throw new UnauthorizedException('Credenciales inválidas');

    return this.signToken(user.userId, user.email, user.role, user.storeId);
  }

  async getUsers(storeId: string) {
    return this.prisma.user.findMany({
      where: { storeId },
      select: {
        userId: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { userId } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    await this.prisma.user.delete({ where: { userId } });
    return { message: 'Usuario eliminado correctamente' };
  }

  private signToken(userId: string, email: string, role: string, storeId: string | null) {
    const payload = { sub: userId, email };
    return {
      access_token: this.jwt.sign(payload),
      userId,
      email,
      role,
      storeId,
    };
  }
}