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
        storeId:     dto.storeId,
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

  async findOne(productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { productId },
      include: { variants: { where: { isActive: true }, orderBy: { name: 'asc' } } },
    });
    if (!product) throw new NotFoundException('Producto no encontrado');
    return product;
  }

  async update(productId: string, dto: UpdateProductDto) {
    await this.findOne(productId);
    return this.prisma.product.update({
      where: { productId },
      data: dto,
      include: { variants: { where: { isActive: true } } },
    });
  }

  async remove(productId: string) {
    await this.findOne(productId);
    return this.prisma.product.update({
      where: { productId },
      data: { isActive: false },
    });
  }

  // ── Variantes ──────────────────────────────────────────────────────────────
  async addVariant(productId: string, data: {
    name: string; sku?: string;
    costPrice: number; salePrice: number; stock?: number;
  }) {
    await this.findOne(productId);
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
  }) {
    const variant = await this.prisma.productVariant.findUnique({ where: { variantId } });
    if (!variant) throw new NotFoundException('Variante no encontrada');
    return this.prisma.productVariant.update({ where: { variantId }, data });
  }

  async removeVariant(variantId: string) {
    const variant = await this.prisma.productVariant.findUnique({ where: { variantId } });
    if (!variant) throw new NotFoundException('Variante no encontrada');
    return this.prisma.productVariant.update({
      where: { variantId },
      data: { isActive: false },
    });
  }

  /**
   * Resumen para la IA — excluye precio de costo (información interna).
   */
  async getSummaryForAI(storeId: string): Promise<string> {
    const products = await this.findAllByStore(storeId);
    if (products.length === 0) return 'No hay productos disponibles actualmente.';

    return products.map((p: any) => {
      const lines = [
        `Producto: ${p.name}`,
        `SKU: ${p.sku ?? 'N/A'}`,
        p.variants?.length
          ? null // precios en variantes
          : `Precio: $${p.salePrice}`,
        p.variants?.length
          ? null
          : `Stock disponible: ${p.stock} unidades`,
        p.description ? `Descripción: ${p.description}` : null,
        `Envío disponible: ${p.hasShipping ? 'Sí' : 'No'}`,
        p.imageUrl ? `Imagen: ${p.imageUrl}` : null,
      ];

      const variantLines = p.variants?.length
        ? [`Variantes disponibles:\n` + p.variants.map((v: any) =>
            `  - ${v.name}: $${v.salePrice} | Stock: ${v.stock}`
          ).join('\n')]
        : [];

      return [...lines.filter(Boolean), ...variantLines].join('\n');
    }).join('\n\n---\n\n');
  }
}
