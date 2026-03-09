import { Injectable, NotFoundException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStoreDto } from './dto/create-store.dto';
import { UpdateStoreDto } from './dto/update-store.dto';

@Injectable()
export class StoresService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateStoreDto) {
    try {
      return await this.prisma.store.create({ data: dto });
    } catch (err: any) {
      // P2002 = unique constraint (phone duplicado)
      if (err?.code === 'P2002') {
        throw new ConflictException('Ya existe una tienda con ese teléfono');
      }
      throw err;
    }
  }

  /**
   * Solo para admins — excluye aiConfig (contiene groqApiKey).
   * El controller debe proteger este endpoint con rol admin.
   */
  async findAll() {
    return this.prisma.store.findMany({
      where: { isActive: true },
      select: {
        storeId: true,
        name: true,
        phone: true,
        isActive: true,
        createdAt: true,
        _count: { select: { customers: true, orders: true } },
        // aiConfig excluido intencionalmente — contiene groqApiKey
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(storeId: string, requestingStoreId?: string) {
    // Si se pasa requestingStoreId, solo puede ver su propia tienda
    if (requestingStoreId && requestingStoreId !== storeId) {
      throw new ForbiddenException('No puedes ver la información de otra tienda');
    }

    const store = await this.prisma.store.findUnique({
      where: { storeId },
      include: {
        // aiConfig solo se incluye si es la propia tienda (requestingStoreId coincide)
        aiConfig: requestingStoreId === storeId ? true : false,
        products: { where: { isActive: true } },
        services: { where: { isActive: true } },
        _count: { select: { customers: true, orders: true, messages: true } },
      },
    });
    if (!store) throw new NotFoundException('Tienda no encontrada');
    return store;
  }

  async update(storeId: string, dto: UpdateStoreDto, requestingStoreId: string) {
    // Solo puede actualizar su propia tienda
    if (requestingStoreId !== storeId) {
      throw new ForbiddenException('No puedes modificar otra tienda');
    }
    await this.findOne(storeId);

    // Excluir storeId del update por seguridad
    const { storeId: _ignored, ...safeData } = dto as any;
    return this.prisma.store.update({
      where: { storeId },
      data: safeData,
    });
  }

  async remove(storeId: string, requestingStoreId: string) {
    if (requestingStoreId !== storeId) {
      throw new ForbiddenException('No puedes desactivar otra tienda');
    }
    await this.findOne(storeId);
    return this.prisma.store.update({
      where: { storeId },
      data: { isActive: false },
    });
  }
}
