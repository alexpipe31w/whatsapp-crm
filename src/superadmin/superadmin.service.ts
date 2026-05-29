import {
  Injectable,
  UnauthorizedException,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { MfaStore, ResetStore } from './mfa.store';
import * as bcrypt from 'bcrypt';

@Injectable()
export class SuperAdminService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private email: EmailService,
  ) {}

  // ── Paso 1: validar credenciales → enviar código ──────────────────────────

  async login(emailInput: string, password: string): Promise<{ requiresCode: true; sessionId: string }> {
    const user = await this.prisma.user.findUnique({ where: { email: emailInput } });
    const dummyHash = '$2b$10$dummy.hash.to.prevent.timing.attack.xxxxxxxxxxxxxxxxxx';
    const valid = await bcrypt.compare(password, user?.password ?? dummyHash);

    if (!user || !valid) throw new UnauthorizedException('Credenciales inválidas');
    if (user.role !== 'superadmin') throw new UnauthorizedException('Acceso restringido a superadmin');
    if (!user.isActive) throw new UnauthorizedException('Usuario desactivado');

    const { sessionId, code } = MfaStore.createSession(user.userId, user.email);
    await this.email.sendMfaCode(user.email, code);

    return { requiresCode: true, sessionId };
  }

  // ── Paso 2: validar código → emitir JWT ──────────────────────────────────

  async verifyCode(sessionId: string, code: string) {
    const userId = MfaStore.validateSession(sessionId, code);
    if (!userId) throw new UnauthorizedException('Código inválido o expirado');

    const user = await this.prisma.user.findUnique({ where: { userId } });
    if (!user || !user.isActive) throw new UnauthorizedException('Usuario inactivo');

    const payload = { sub: user.userId, email: user.email, role: user.role, storeId: user.storeId };
    return {
      access_token: this.jwt.sign(payload),
      userId: user.userId,
      email: user.email,
      role: user.role,
    };
  }

  // ── Olvidé contraseña: enviar código ──────────────────────────────────────

  async forgotPassword(emailInput: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({ where: { email: emailInput } });
    // Siempre devolver el mismo mensaje aunque el email no exista (evita enumeración)
    if (user && user.role === 'superadmin' && user.isActive) {
      const code = ResetStore.createCode(user.email);
      await this.email.sendResetCode(user.email, code);
    }
    return { message: 'Si el email existe, recibirás un código de restablecimiento' };
  }

  // ── Olvidé contraseña: validar código + nueva contraseña ──────────────────

  async resetPassword(emailInput: string, code: string, newPassword: string): Promise<{ message: string }> {
    if (newPassword.length < 8) throw new BadRequestException('La contraseña debe tener al menos 8 caracteres');

    const valid = ResetStore.validateCode(emailInput, code);
    if (!valid) throw new UnauthorizedException('Código inválido o expirado');

    const user = await this.prisma.user.findUnique({ where: { email: emailInput } });
    if (!user || user.role !== 'superadmin') throw new UnauthorizedException('Usuario no encontrado');

    const hashed = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({ where: { userId: user.userId }, data: { password: hashed } });

    return { message: 'Contraseña actualizada correctamente' };
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  async getDashboard() {
    const [totalStores, activeStores, totalUsers, blockedUsers] = await Promise.all([
      this.prisma.store.count(),
      this.prisma.store.count({ where: { isActive: true } }),
      this.prisma.user.count({ where: { role: { not: 'superadmin' } } }),
      this.prisma.user.count({ where: { role: { not: 'superadmin' }, isActive: false } }),
    ]);

    return {
      totalStores,
      activeStores,
      blockedStores: totalStores - activeStores,
      totalUsers,
      blockedUsers,
    };
  }

  // ── Tiendas ───────────────────────────────────────────────────────────────

  async getStores() {
    return this.prisma.store.findMany({
      select: {
        storeId: true,
        name: true,
        phone: true,
        ownerName: true,
        isActive: true,
        createdAt: true,
        _count: { select: { users: true, conversations: true, orders: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async toggleStore(storeId: string, adminId: string) {
    const store = await this.prisma.store.findUnique({ where: { storeId } });
    if (!store) throw new NotFoundException('Tienda no encontrada');

    const updated = await this.prisma.store.update({
      where: { storeId },
      data: { isActive: !store.isActive },
    });

    await this.prisma.adminAuditLog.create({
      data: {
        adminId,
        action: updated.isActive ? 'STORE_UNBLOCKED' : 'STORE_BLOCKED',
        targetType: 'store',
        targetId: storeId,
        details: { storeName: store.name, phone: store.phone },
      },
    });

    return updated;
  }

  // ── Usuarios ──────────────────────────────────────────────────────────────

  async getUsers() {
    return this.prisma.user.findMany({
      where: { role: { not: 'superadmin' } },
      select: {
        userId: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        store: { select: { storeId: true, name: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async toggleUser(userId: string, adminId: string) {
    const user = await this.prisma.user.findUnique({ where: { userId } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    if (user.role === 'superadmin') throw new ForbiddenException('No puedes modificar otro superadmin');

    const updated = await this.prisma.user.update({
      where: { userId },
      data: { isActive: !user.isActive },
    });

    await this.prisma.adminAuditLog.create({
      data: {
        adminId,
        action: updated.isActive ? 'USER_UNBLOCKED' : 'USER_BLOCKED',
        targetType: 'user',
        targetId: userId,
        details: { email: user.email },
      },
    });

    return updated;
  }

  async deleteUser(userId: string, adminId: string) {
    const user = await this.prisma.user.findUnique({ where: { userId } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    if (user.role === 'superadmin') throw new ForbiddenException('No puedes eliminar a un superadmin');

    await this.prisma.user.delete({ where: { userId } });

    await this.prisma.adminAuditLog.create({
      data: {
        adminId,
        action: 'USER_DELETED',
        targetType: 'user',
        targetId: userId,
        details: { email: user.email, name: user.name },
      },
    });

    return { message: 'Usuario eliminado correctamente' };
  }

  // ── Auditoría ─────────────────────────────────────────────────────────────

  async getAuditLogs() {
    return this.prisma.adminAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  // ── Configuración de suscripción ──────────────────────────────────────────

  async getSubscriptionConfig() {
    const config = await this.prisma.subscriptionConfig.findUnique({ where: { configId: 'singleton' } });
    return config ?? { configId: 'singleton', priceAmount: 24000, currency: 'COP' };
  }

  async updateSubscriptionConfig(priceAmount: number, adminEmail: string) {
    if (priceAmount <= 0) throw new Error('El precio debe ser mayor a 0');
    return this.prisma.subscriptionConfig.upsert({
      where: { configId: 'singleton' },
      create: { configId: 'singleton', priceAmount, updatedBy: adminEmail },
      update: { priceAmount, updatedBy: adminEmail },
    });
  }

  async getSubscriptions() {
    return this.prisma.subscription.findMany({
      include: {
        store: { select: { name: true, phone: true, ownerName: true } },
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }
}
