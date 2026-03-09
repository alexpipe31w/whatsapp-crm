import { Injectable, ConflictException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BlockedService {
  constructor(private prisma: PrismaService) {}

  private normalizeDigits(phone: string): string {
    return phone.replace(/\D/g, '');
  }

  private normalizePhone(phone: string): string {
    return `+${phone.replace(/\D/g, '')}`;
  }

  async getAll(storeId: string) {
    return this.prisma.blockedContact.findMany({
      where: { storeId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async block(storeId: string, phone: string, label?: string) {
    const normalized = this.normalizePhone(phone);
    try {
      return await this.prisma.blockedContact.create({
        data: { storeId, phone: normalized, label },
      });
    } catch (err: any) {
      // Solo atrapar error de unique constraint (P2002), relanzar los demás
      if (err?.code === 'P2002') {
        throw new ConflictException('Este número ya está bloqueado en esta tienda');
      }
      throw err;
    }
  }

  async unblock(blockedId: string, storeId: string) {
    // Verificar que el contacto bloqueado pertenece a esta tienda
    const blocked = await this.prisma.blockedContact.findUnique({
      where: { blockedId },
    });
    if (!blocked) throw new NotFoundException('Contacto bloqueado no encontrado');
    if (blocked.storeId !== storeId)
      throw new ForbiddenException('No puedes desbloquear contactos de otra tienda');

    await this.prisma.blockedContact.delete({ where: { blockedId } });
    return { message: 'Número desbloqueado correctamente' };
  }

  /**
   * Verifica si un número está bloqueado comparando sufijos en la BD.
   * Extrae los últimos 10 dígitos y busca directamente en SQL — no carga
   * toda la lista en memoria.
   */
  async isBlocked(storeId: string, phone: string): Promise<boolean> {
    const digits = this.normalizeDigits(phone);
    const suffix = digits.slice(-10); // últimos 10 dígitos

    // Buscar en BD usando LIKE — eficiente aunque la tabla crezca
    const match = await this.prisma.blockedContact.findFirst({
      where: {
        storeId,
        phone: { endsWith: suffix },
      },
      select: { blockedId: true },
    });

    return match !== null;
  }
}