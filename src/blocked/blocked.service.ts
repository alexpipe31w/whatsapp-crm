import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BlockedService {
  constructor(private prisma: PrismaService) {}

  async getAll(storeId: string) {
    return this.prisma.blockedContact.findMany({
      where: { storeId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async block(storeId: string, phone: string, label?: string) {
    // Normalizar teléfono: asegurar que empieza con +
    const normalized = phone.startsWith('+') ? phone : `+${phone}`;
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

  async isBlocked(storeId: string, phone: string): Promise<boolean> {
    const found = await this.prisma.blockedContact.findUnique({
      where: { storeId_phone: { storeId, phone } },
    });
    return !!found;
  }
}