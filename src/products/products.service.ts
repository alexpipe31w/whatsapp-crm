import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateProductDto) {
    return this.prisma.product.create({
      data: {
        storeId:     dto.storeId!, // siempre inyectado por el controller desde JWT
        sku:         dto.sku,
        name:        dto.name,
        costPrice:   dto.costPrice,
        salePrice:   dto.salePrice,
        stock:       dto.stock ?? 0,
        description: dto.description,
        imageUrl:    dto.imageUrl ?? null,
        hasShipping: dto.hasShipping ?? false,
      },
      include: { variants: { where: { isActive: true } } },
    });
  }

  async findAllByStore(storeId: string) {
    return this.prisma.product.findMany({
      where: { storeId, isActive: true },
      include: { variants: { where: { isActive: true }, orderBy: { name: 'asc' } } },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(productId: string, storeId?: string) {
    const product = await this.prisma.product.findUnique({
      where: { productId },
      include: { variants: { where: { isActive: true }, orderBy: { name: 'asc' } } },
    });
    if (!product) throw new NotFoundException('Producto no encontrado');
    if (storeId && product.storeId !== storeId)
      throw new ForbiddenException('No tienes acceso a este producto');
    return product;
  }

  async update(productId: string, dto: UpdateProductDto, storeId?: string) {
    await this.findOne(productId, storeId);
    // Excluir storeId del update — no se puede mover un producto a otra tienda
    const { storeId: _ignored, ...safeData } = dto as any;
    return this.prisma.product.update({
      where: { productId },
      data: safeData,
      include: { variants: { where: { isActive: true } } },
    });
  }

  async remove(productId: string, storeId?: string) {
    await this.findOne(productId, storeId);
    return this.prisma.product.update({
      where: { productId },
      data: { isActive: false },
    });
  }

  // ── Variantes ──────────────────────────────────────────────────────────────

  async addVariant(productId: string, data: {
    name: string; sku?: string;
    costPrice: number; salePrice: number; stock?: number;
  }, storeId?: string) {
    // Verificar que el producto pertenece a la tienda antes de agregar variante
    await this.findOne(productId, storeId);
    return this.prisma.productVariant.create({
      data: {
        productId,
        name:      data.name,
        sku:       data.sku ?? null,
        costPrice: data.costPrice,
        salePrice: data.salePrice,
        stock:     data.stock ?? 0,
      },
    });
  }

  async updateVariant(variantId: string, data: {
    name?: string; sku?: string;
    costPrice?: number; salePrice?: number; stock?: number; isActive?: boolean;
  }, storeId?: string) {
    const variant = await this.prisma.productVariant.findUnique({
      where: { variantId },
      include: { product: true },
    });
    if (!variant) throw new NotFoundException('Variante no encontrada');
    // Validar a través del producto padre
    if (storeId && variant.product.storeId !== storeId)
      throw new ForbiddenException('No tienes acceso a esta variante');
    return this.prisma.productVariant.update({ where: { variantId }, data });
  }

  async removeVariant(variantId: string, storeId?: string) {
    const variant = await this.prisma.productVariant.findUnique({
      where: { variantId },
      include: { product: true },
    });
    if (!variant) throw new NotFoundException('Variante no encontrada');
    if (storeId && variant.product.storeId !== storeId)
      throw new ForbiddenException('No tienes acceso a esta variante');
    return this.prisma.productVariant.update({
      where: { variantId },
      data: { isActive: false },
    });
  }

  async getSummaryForAI(storeId: string): Promise<string> {
    const products = await this.findAllByStore(storeId);
    if (products.length === 0) return 'No hay productos disponibles actualmente.';

    return products.map((p: any) => {
      const lines = [
        `Producto: ${p.name}`,
        p.variants?.length ? null : `Precio: $${p.salePrice}`,
        p.variants?.length ? null : `Stock: ${p.stock} unidades`,
        p.description ? `Descripción: ${p.description}` : null,
        `Envío: ${p.hasShipping ? 'Sí' : 'No'}`,
      ];

      const variantLines = p.variants?.length
        ? [`Variantes:\n` + p.variants.map((v: any) =>
            `  - ${v.name}: $${v.salePrice} | Stock: ${v.stock}`
          ).join('\n')]
        : [];

      return [...lines.filter(Boolean), ...variantLines].join('\n');
    }).join('\n\n---\n\n');
  }
}