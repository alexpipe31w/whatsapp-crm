import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto, CreateVariantInlineDto } from './dto/create-product.dto';
import { UpdateProductDto, UpdateVariantInlineDto } from './dto/update-product.dto';

// ─── Selector reutilizable ────────────────────────────────────────────────────

const VARIANTS_INCLUDE = {
  variants: {
    where:   { isActive: true },
    orderBy: { sortOrder: 'asc' as const },
  },
} as const;

const PRODUCT_INCLUDE = {
  ...VARIANTS_INCLUDE,
  category: { select: { categoryId: true, name: true, slug: true } },
} as const;

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Helpers privados ─────────────────────────────────────────────────────

  /**
   * Calcula el margen de ganancia.
   * Retorna null si no hay costPrice o salePrice es 0.
   */
  private calcProfitMargin(salePrice: number, costPrice?: number): number | null {
    if (!costPrice || costPrice <= 0 || salePrice <= 0) return null;
    return Number((((salePrice - costPrice) / salePrice) * 100).toFixed(2));
  }

  /**
   * Verifica que el producto exista y pertenezca a la tienda.
   */
  private async findAndVerify(productId: string, storeId?: string) {
    const product = await this.prisma.product.findUnique({
      where: { productId },
    });
    if (!product) throw new NotFoundException('Producto no encontrado');
    if (storeId && product.storeId !== storeId)
      throw new ForbiddenException('No tienes acceso a este producto');
    return product;
  }

  /**
   * Construye el objeto de datos de una variante a partir del DTO.
   */
  private buildVariantData(v: CreateVariantInlineDto | UpdateVariantInlineDto, productId: string) {
    const salePrice  = v.salePrice  ?? null;
    const costPrice  = v.costPrice  ?? null;
    const profitMargin = salePrice && costPrice
      ? this.calcProfitMargin(salePrice, costPrice)
      : null;

    return {
      productId,
      name:          v.name,
      sku:           v.sku          ?? null,
      salePrice:     salePrice,
      costPrice:     costPrice      ?? 0,
      profitMargin,
      stock:         v.stock        ?? 0,
      attributes:    v.attributes   ?? {},
      imageUrl:      v.imageUrl     ?? null,
      weight:        v.weight       ?? null,
      sortOrder:     v.sortOrder    ?? 0,
      isActive:      v.isActive     ?? true,
    };
  }

  // ─── Crear ────────────────────────────────────────────────────────────────

  async create(dto: CreateProductDto) {
    const profitMargin = this.calcProfitMargin(dto.salePrice, dto.costPrice);

    // Si viene con variantes, el stock del producto padre = suma de variantes
    const stockTotal = dto.hasVariants && dto.variants?.length
      ? dto.variants.reduce((sum, v) => sum + (v.stock ?? 0), 0)
      : (dto.stock ?? 0);

    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          storeId:         dto.storeId!,
          categoryId:      dto.categoryId      ?? null,
          sku:             dto.sku             ?? null,
          name:            dto.name,
          description:     dto.description     ?? null,
          salePrice:       dto.salePrice,
          costPrice:       dto.costPrice        ?? 0,
          profitMargin,
          stock:           stockTotal,
          hasVariants:     dto.hasVariants      ?? false,
          imageUrl:        dto.imageUrl         ?? null,
          hasShipping:     dto.hasShipping      ?? false,
          weight:          dto.weight           ?? null,
          shippingStandard: dto.shippingStandard ?? 0,
          shippingExpress:  dto.shippingExpress  ?? 0,
        },
        include: PRODUCT_INCLUDE,
      });

      // Crear variantes si vienen en el payload
      if (dto.hasVariants && dto.variants?.length) {
        await tx.productVariant.createMany({
          data: dto.variants.map(v => this.buildVariantData(v, product.productId)),
        });
      }

      // Retornar con variantes incluidas
      return tx.product.findUnique({
        where: { productId: product.productId },
        include: PRODUCT_INCLUDE,
      });
    });
  }

  // ─── Listar por tienda ────────────────────────────────────────────────────

  async findAllByStore(storeId: string) {
    return this.prisma.product.findMany({
      where:   { storeId, isActive: true },
      include: PRODUCT_INCLUDE,
      orderBy: { name: 'asc' },
    });
  }

  // ─── Detalle ──────────────────────────────────────────────────────────────

  async findOne(productId: string, storeId?: string) {
    const product = await this.prisma.product.findUnique({
      where:   { productId },
      include: {
        ...PRODUCT_INCLUDE,
        // En detalle mostramos TODAS las variantes (incluso inactivas)
        variants: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!product) throw new NotFoundException('Producto no encontrado');
    if (storeId && product.storeId !== storeId)
      throw new ForbiddenException('No tienes acceso a este producto');
    return product;
  }

  // ─── Actualizar ───────────────────────────────────────────────────────────

  async update(productId: string, dto: UpdateProductDto, storeId?: string) {
    await this.findAndVerify(productId, storeId);

    const profitMargin = dto.salePrice !== undefined
      ? this.calcProfitMargin(dto.salePrice, dto.costPrice)
      : undefined;

    return this.prisma.$transaction(async (tx) => {
      // Actualizar producto
      const updated = await tx.product.update({
        where: { productId },
        data: {
          ...(dto.categoryId       !== undefined && { categoryId:       dto.categoryId }),
          ...(dto.sku              !== undefined && { sku:              dto.sku }),
          ...(dto.name             !== undefined && { name:             dto.name }),
          ...(dto.description      !== undefined && { description:      dto.description }),
          ...(dto.salePrice        !== undefined && { salePrice:        dto.salePrice }),
          ...(dto.costPrice        !== undefined && { costPrice:        dto.costPrice }),
          ...(profitMargin         !== undefined && { profitMargin }),
          ...(dto.stock            !== undefined && { stock:            dto.stock }),
          ...(dto.hasVariants      !== undefined && { hasVariants:      dto.hasVariants }),
          ...(dto.imageUrl         !== undefined && { imageUrl:         dto.imageUrl }),
          ...(dto.hasShipping      !== undefined && { hasShipping:      dto.hasShipping }),
          ...(dto.weight           !== undefined && { weight:           dto.weight }),
          ...(dto.shippingStandard !== undefined && { shippingStandard: dto.shippingStandard }),
          ...(dto.shippingExpress  !== undefined && { shippingExpress:  dto.shippingExpress }),
          ...(dto.isActive         !== undefined && { isActive:         dto.isActive }),
          // Incrementar version para optimistic locking
          version: { increment: 1 },
        },
        include: PRODUCT_INCLUDE,
      });

      // Sincronizar variantes si vienen en el payload
      if (dto.variants !== undefined) {
        await this.syncVariants(tx, productId, dto.variants);

        // Recalcular stock total del producto padre
        const activeVariants = await tx.productVariant.findMany({
          where: { productId, isActive: true },
          select: { stock: true },
        });
        const totalStock = activeVariants.reduce((sum, v) => sum + v.stock, 0);
        await tx.product.update({
          where: { productId },
          data:  { stock: totalStock },
        });
      }

      return tx.product.findUnique({
        where:   { productId },
        include: PRODUCT_INCLUDE,
      });
    });
  }

  /**
   * Sincroniza variantes en una transacción:
   *   - Crea las nuevas (sin variantId)
   *   - Actualiza las existentes (con variantId)
   *   - Desactiva las que ya no están en el array
   */
  private async syncVariants(
    tx: any,
    productId: string,
    variants: UpdateVariantInlineDto[],
  ) {
    const incomingIds = variants
      .filter(v => v.variantId)
      .map(v => v.variantId!);

    // Desactivar las que no vienen en el array
    await tx.productVariant.updateMany({
      where: {
        productId,
        variantId: { notIn: incomingIds },
      },
      data: { isActive: false },
    });

    // Crear o actualizar cada variante
    for (const v of variants) {
      const data = this.buildVariantData(v, productId);

      if (v.variantId) {
        await tx.productVariant.update({
          where: { variantId: v.variantId },
          data,
        });
      } else {
        await tx.productVariant.create({ data });
      }
    }
  }

  // ─── Eliminar (soft delete) ───────────────────────────────────────────────

  async remove(productId: string, storeId?: string) {
    await this.findAndVerify(productId, storeId);
    return this.prisma.product.update({
      where: { productId },
      data:  { isActive: false },
    });
  }

  // ─── Variantes individuales ───────────────────────────────────────────────

  async addVariant(
    productId: string,
    data: CreateVariantInlineDto,
    storeId?: string,
  ) {
    await this.findAndVerify(productId, storeId);
    const variantData = this.buildVariantData(data, productId);
    return this.prisma.productVariant.create({ data: variantData });
  }

  async updateVariant(
    variantId: string,
    data: UpdateVariantInlineDto,
    storeId?: string,
  ) {
    const variant = await this.prisma.productVariant.findUnique({
      where:   { variantId },
      include: { product: true },
    });
    if (!variant) throw new NotFoundException('Variante no encontrada');
    if (storeId && variant.product.storeId !== storeId)
      throw new ForbiddenException('No tienes acceso a esta variante');

    const salePrice    = data.salePrice  ?? Number(variant.salePrice)  ?? undefined;
    const costPrice    = data.costPrice  ?? Number(variant.costPrice)  ?? undefined;
    const profitMargin = salePrice && costPrice
      ? this.calcProfitMargin(salePrice, costPrice)
      : null;

    return this.prisma.productVariant.update({
      where: { variantId },
      data: {
        ...(data.name       !== undefined && { name:       data.name }),
        ...(data.sku        !== undefined && { sku:        data.sku }),
        ...(data.salePrice  !== undefined && { salePrice:  data.salePrice }),
        ...(data.costPrice  !== undefined && { costPrice:  data.costPrice }),
        ...(profitMargin    !== null      && { profitMargin }),
        ...(data.stock      !== undefined && { stock:      data.stock }),
        ...(data.attributes !== undefined && { attributes: data.attributes }),
        ...(data.imageUrl   !== undefined && { imageUrl:   data.imageUrl }),
        ...(data.weight     !== undefined && { weight:     data.weight }),
        ...(data.sortOrder  !== undefined && { sortOrder:  data.sortOrder }),
        ...(data.isActive   !== undefined && { isActive:   data.isActive }),
      },
    });
  }

  async removeVariant(variantId: string, storeId?: string) {
    const variant = await this.prisma.productVariant.findUnique({
      where:   { variantId },
      include: { product: true },
    });
    if (!variant) throw new NotFoundException('Variante no encontrada');
    if (storeId && variant.product.storeId !== storeId)
      throw new ForbiddenException('No tienes acceso a esta variante');

    return this.prisma.productVariant.update({
      where: { variantId },
      data:  { isActive: false },
    });
  }

  // ─── Categorías ───────────────────────────────────────────────────────────

  async getCategories(storeId: string) {
    return this.prisma.category.findMany({
      where:   { storeId },
      orderBy: { name: 'asc' },
    });
  }

  async createCategory(storeId: string, name: string) {
    const slug = name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    // Verificar unicidad del slug en la tienda
    const existing = await this.prisma.category.findUnique({
      where: { storeId_slug: { storeId, slug } },
    });
    if (existing) throw new BadRequestException(`Ya existe una categoría con el nombre "${name}"`);

    return this.prisma.category.create({
      data: { storeId, name, slug },
    });
  }

  async removeCategory(categoryId: string, storeId: string) {
    const category = await this.prisma.category.findUnique({
      where: { categoryId },
    });
    if (!category) throw new NotFoundException('Categoría no encontrada');
    if (category.storeId !== storeId) throw new ForbiddenException();

    // Desvincular productos de la categoría antes de eliminarla
    await this.prisma.product.updateMany({
      where: { categoryId },
      data:  { categoryId: null },
    });

    return this.prisma.category.delete({ where: { categoryId } });
  }

  // ─── Resumen para la IA ───────────────────────────────────────────────────

  async getSummaryForAI(storeId: string): Promise<string> {
    const products = await this.prisma.product.findMany({
      where:   { storeId, isActive: true },
      include: {
        variants:  { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
        category:  { select: { name: true } },
      },
      orderBy: { name: 'asc' },
    });

    if (!products.length) return 'No hay productos disponibles actualmente.';

    return products.map((p: any) => {
      const lines: string[] = [
        `Producto: ${p.name}`,
        p.category ? `Categoría: ${p.category.name}` : null,
      ].filter(Boolean) as string[];

      if (p.hasVariants && p.variants?.length) {
        lines.push(`Variantes:`);
        p.variants.forEach((v: any) => {
          const precio = v.salePrice ? `$${Number(v.salePrice).toLocaleString('es-CO')}` : 'Precio base';
          const attrs  = Object.keys(v.attributes ?? {}).length
            ? ` (${Object.entries(v.attributes).map(([k, val]) => `${k}: ${val}`).join(', ')})`
            : '';
          lines.push(`  - ${v.name}${attrs}: ${precio} | Stock: ${v.stock}`);
        });
      } else {
        lines.push(`Precio: $${Number(p.salePrice).toLocaleString('es-CO')}`);
        lines.push(`Stock: ${p.stock} unidades`);
      }

      if (p.description) {
        // Remover HTML para el resumen de la IA
        const plainText = p.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (plainText) lines.push(`Descripción: ${plainText.slice(0, 300)}`);
      }

      if (p.hasShipping) {
        lines.push(`Envío: Sí${p.shippingStandard ? ` | Estándar: $${p.shippingStandard}` : ''}${p.shippingExpress ? ` | Express: $${p.shippingExpress}` : ''}`);
      }

      return lines.join('\n');
    }).join('\n\n---\n\n');
  }
}