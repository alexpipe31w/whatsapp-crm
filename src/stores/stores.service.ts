import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStoreDto } from './dto/create-store.dto';
import { UpdateStoreDto } from './dto/update-store.dto';

@Injectable()
export class StoresService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateStoreDto) {
    const exists = await this.prisma.store.findUnique({
      where: { phone: dto.phone },
    });
    if (exists) throw new ConflictException('Ya existe una tienda con ese teléfono');

    return this.prisma.store.create({ data: dto });
  }

  async findAll() {
    return this.prisma.store.findMany({
      where: { isActive: true },
      include: { aiConfig: true, _count: { select: { customers: true, orders: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(storeId: string) {
    const store = await this.prisma.store.findUnique({
      where: { storeId },
      include: {
        aiConfig: true,
        products: { where: { isActive: true } },
        services: { where: { isActive: true } },
        _count: { select: { customers: true, orders: true, messages: true } },
      },
    });
    if (!store) throw new NotFoundException('Tienda no encontrada');
    return store;
  }

  async update(storeId: string, dto: UpdateStoreDto) {
    await this.findOne(storeId);
    return this.prisma.store.update({
      where: { storeId },
      data: dto,
    });
  }

  async remove(storeId: string) {
    await this.findOne(storeId);
    return this.prisma.store.update({
      where: { storeId },
      data: { isActive: false },
    });
  }
}
