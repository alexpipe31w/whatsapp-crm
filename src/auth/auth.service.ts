import { Injectable, Logger, UnauthorizedException, ConflictException, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { RegistrationStore } from './registration.store';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private email: EmailService,
  ) {}

  // ── Paso 1: enviar código de verificación ─────────────────────────────────

  async sendVerificationCode(data: {
    name: string; email: string; password: string;
    storeName: string; storePhone: string;
  }): Promise<{ sessionId: string }> {
    // Verificar que el email no esté ya registrado
    const existing = await this.prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw new ConflictException('Email ya registrado');

    // Verificar que el teléfono no esté en uso
    const existingStore = await this.prisma.store.findUnique({ where: { phone: data.storePhone } });
    if (existingStore) throw new ConflictException('Ese número de WhatsApp ya está registrado');

    const { sessionId, code } = RegistrationStore.create(data);
    await this.email.sendEmailVerification(data.email, code);

    return { sessionId };
  }

  // ── Paso 2: verificar código → crear cuenta ───────────────────────────────

  async verifyAndRegister(sessionId: string, code: string) {
    const reg = RegistrationStore.validate(sessionId, code);
    if (!reg) throw new BadRequestException('Código inválido o expirado');

    return this.register({
      name: reg.name, email: reg.email, password: reg.password,
      storeName: reg.storeName, storePhone: reg.storePhone,
    });
  }

  // ── Registro interno (llamado tras verificar email) ───────────────────────

  async register(dto: RegisterDto) {
    const hashed = await bcrypt.hash(dto.password, 10);

    let storeNameSaved = dto.storeName;
    let storePhoneSaved = dto.storePhone;

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        let storeId: string | null = null;

        if (dto.storeName && dto.storePhone) {
          const store = await tx.store.create({
            data: {
              name: dto.storeName,
              phone: dto.storePhone,
              ownerName: dto.name,
              subscriptionStatus: 'pending',
            },
          });
          storeId = store.storeId;
        }

        const user = await tx.user.create({
          data: {
            name: dto.name,
            email: dto.email,
            password: hashed,
            role: 'admin',
            storeId,
          },
        });

        return user;
      });

      // Enviar emails en background (no bloquea la respuesta)
      if (storeNameSaved && storePhoneSaved) {
        this.sendRegistrationEmails(dto.name, dto.email, storeNameSaved, storePhoneSaved).catch(
          err => this.logger.error(`Error enviando emails de bienvenida: ${err.message}`),
        );
      }

      return this.signToken(result.userId, result.email, result.role, result.storeId);
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException('Email ya registrado');
      }
      throw err;
    }
  }

  private async sendRegistrationEmails(
    ownerName: string, ownerEmail: string,
    storeName: string, storePhone: string,
  ): Promise<void> {
    await Promise.allSettled([
      this.email.sendWelcome(ownerEmail, ownerName, storeName),
      this.email.sendNewAccountAlert(ownerName, ownerEmail, storeName, storePhone),
    ]);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    const dummyHash = '$2b$10$dummy.hash.to.prevent.timing.attack.xxxxxxxxxxxxxxxxxx';
    const valid = await bcrypt.compare(dto.password, user?.password ?? dummyHash);

    if (!user || !valid) throw new UnauthorizedException('Credenciales inválidas');
    if (!user.isActive) throw new UnauthorizedException('Usuario desactivado');

    return this.signToken(user.userId, user.email, user.role, user.storeId);
  }

  async getUsers(storeId: string | null) {
    return this.prisma.user.findMany({
      where: storeId ? { storeId } : undefined,
      select: {
        userId: true, name: true, email: true, role: true,
        isActive: true, createdAt: true,
        store: { select: { name: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteUser(userId: string, requesterStoreId: string | null) {
    const user = await this.prisma.user.findUnique({ where: { userId } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    if (requesterStoreId && user.storeId !== requesterStoreId) {
      throw new ForbiddenException('No puedes eliminar usuarios de otras tiendas');
    }
    await this.prisma.user.delete({ where: { userId } });
    return { message: 'Usuario eliminado correctamente' };
  }

  private signToken(userId: string, email: string, role: string, storeId: string | null) {
    const payload = { sub: userId, email, role, storeId };
    return { access_token: this.jwt.sign(payload), userId, email, role, storeId };
  }
}
