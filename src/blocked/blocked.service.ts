import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BlockedService {
  constructor(private prisma: PrismaService) {}

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Retorna solo los dígitos del teléfono */
  private normalizeDigits(phone: string): string {
    return phone.replace(/\D/g, '');
  }

  /** Normaliza a formato +[dígitos] */
  private normalizePhone(phone: string): string {
    return `+${phone.replace(/\D/g, '')}`;
  }

  // ── Métodos públicos ──────────────────────────────────────────────────────

  async getAll(storeId: string) {
    return this.prisma.blockedContact.findMany({
      where: { storeId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async block(storeId: string, phone: string, label?: string) {
    // Siempre guardar en formato +[dígitos] para consistencia
    const normalized = this.normalizePhone(phone);
    try {
      return await this.prisma.blockedContact.create({
        data: { storeId, phone: normalized, label },
      });
    } catch {
      throw new ConflictException('Este número ya está bloqueado');
    }
  }

  async unblock(blockedId: string) {
    await this.prisma.blockedContact.delete({ where: { blockedId } });
    return { message: 'Número desbloqueado correctamente' };
  }

  /**
   * Verifica si un número está bloqueado comparando los últimos 10 dígitos.
   * Esto cubre el caso donde uno tiene código de país (+57) y el otro no,
   * o donde WhatsApp entrega el número con prefijo diferente al guardado.
   */
  async isBlocked(storeId: string, phone: string): Promise<boolean> {
    const incomingDigits = this.normalizeDigits(phone);

    const allBlocked = await this.prisma.blockedContact.findMany({
      where: { storeId },
      select: { phone: true },
    });

    return allBlocked.some((b) => {
      const storedDigits = this.normalizeDigits(b.phone);
      // Compara los últimos 10 dígitos (número local sin código de país)
      return (
        incomingDigits.endsWith(storedDigits.slice(-10)) ||
        storedDigits.endsWith(incomingDigits.slice(-10))
      );
    });
  }
}