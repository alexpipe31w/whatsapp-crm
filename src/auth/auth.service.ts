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
    const hashed = await bcrypt.hash(dto.password, 10);

    try {
      // Transacción atómica — si falla cualquier paso, todo se revierte
      const result = await this.prisma.$transaction(async (tx) => {
        let storeId: string | null = null;

        if (dto.storeName && dto.storePhone) {
          const store = await tx.store.create({
            data: {
              name: dto.storeName,
              phone: dto.storePhone,
              ownerName: dto.name,
            },
          });
          storeId = store.storeId;
        }

        const user = await tx.user.create({
          data: {
            name: dto.name,
            email: dto.email,
            password: hashed,
            // role siempre 'admin' al registrar — nunca del body
            // Un superadmin puede cambiar roles manualmente en BD si es necesario
            role: 'admin',
            storeId,
          },
        });

        return user;
      });

      return this.signToken(result.userId, result.email, result.role, result.storeId);
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException('Email ya registrado');
      }
      throw err;
    }
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    // Siempre comparar el hash aunque no exista el usuario (evita timing attack)
    const dummyHash = '$2b$10$dummy.hash.to.prevent.timing.attack.xxxxxxxxxxxxxxxxxx';
    const valid = await bcrypt.compare(dto.password, user?.password ?? dummyHash);

    if (!user || !valid) throw new UnauthorizedException('Credenciales inválidas');
    if (!user.isActive) throw new UnauthorizedException('Usuario desactivado');

    return this.signToken(user.userId, user.email, user.role, user.storeId);
  }

  // Solo llamar desde endpoints protegidos con rol admin
  async getUsers() {
    return this.prisma.user.findMany({
      select: {
        userId: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        store: { select: { name: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Solo llamar desde endpoints protegidos con rol admin
  async deleteUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { userId } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    await this.prisma.user.delete({ where: { userId } });
    return { message: 'Usuario eliminado correctamente' };
  }

  private signToken(userId: string, email: string, role: string, storeId: string | null) {
    // ✅ CRÍTICO: storeId y role deben estar en el payload
    // Todos los controllers usan req.user.storeId y req.user.role
    const payload = { sub: userId, email, role, storeId };
    return {
      access_token: this.jwt.sign(payload),
      userId,
      email,
      role,
      storeId,
    };
  }
}