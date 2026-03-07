import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateProductDto) {
    return this.prisma.product.create({
      data: {
        storeId: dto.storeId,
        sku: dto.sku,
        name: dto.name,
        variant: dto.variant,
        costPrice: dto.costPrice,
        salePrice: dto.salePrice,
        stock: dto.stock ?? 0,
        description: dto.description,
      },
    });
  }

  async findAllByStore(storeId: string) {
    return this.prisma.product.findMany({
      where: { storeId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { productId },
    });
    if (!product) throw new NotFoundException('Producto no encontrado');
    return product;
  }

  async update(productId: string, dto: UpdateProductDto) {
    await this.findOne(productId);
    return this.prisma.product.update({
      where: { productId },
      data: dto,
    });
  }

  async remove(productId: string) {
    await this.findOne(productId);
    return this.prisma.product.update({
      where: { productId },
      data: { isActive: false },
    });
  }
}
