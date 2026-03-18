import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateServiceDto, CreateServiceVariantDto } from './dto/create-service.dto';
import { UpdateServiceDto, UpdateServiceVariantDto } from './dto/update-service.dto';

// ─── Selectores reutilizables ─────────────────────────────────────────────────

const VARIANTS_INCLUDE = {
  variants: {
    where:   { isActive: true },
    orderBy: { sortOrder: 'asc' as const },
  },
} as const;

const SERVICE_INCLUDE = VARIANTS_INCLUDE;

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class ServicesService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Helpers privados ─────────────────────────────────────────────────────

  /**
   * Verifica que el servicio exista y pertenezca a la tienda.
   */
  private async findAndVerify(serviceId: string, storeId?: string) {
    const service = await this.prisma.service.findUnique({
      where: { serviceId },
    });
    if (!service) throw new NotFoundException('Servicio no encontrado');
    if (storeId && service.storeId !== storeId)
      throw new ForbiddenException('No tienes acceso a este servicio');
    return service;
  }

  /**
   * Valida que la combinación priceType / basePrice sea coherente.
   * VARIABLE puede no tener basePrice.
   * El resto requieren basePrice > 0.
   */
  private validatePricing(priceType: string, basePrice?: number | null): void {
    if (priceType !== 'VARIABLE' && (basePrice == null || basePrice <= 0)) {
      throw new BadRequestException(
        `El tipo de precio ${priceType} requiere un basePrice mayor a 0`,
      );
    }
  }

  /**
   * Valida que una variante no tenga priceOverride y priceModifier al mismo tiempo.
   */
  private validateVariantPricing(variant: CreateServiceVariantDto | UpdateServiceVariantDto): void {
    if (variant.priceOverride != null && variant.priceModifier != null) {
      throw new BadRequestException(
        `La variante "${variant.name}" no puede tener priceOverride y priceModifier simultáneamente`,
      );
    }
  }

  /**
   * Construye el objeto de datos de una variante.
   */
  private buildVariantData(
    v: CreateServiceVariantDto | UpdateServiceVariantDto,
    serviceId: string,
  ) {
    this.validateVariantPricing(v);
    return {
      serviceId,
      name:             v.name,
      description:      v.description      ?? null,
      priceOverride:    v.priceOverride     ?? null,
      priceModifier:    v.priceModifier     ?? null,
      estimatedMinutes: v.estimatedMinutes  ?? null,
      sortOrder:        v.sortOrder         ?? 0,
      isActive:         v.isActive          ?? true,
    };
  }

  // ─── Crear ────────────────────────────────────────────────────────────────

  async create(dto: CreateServiceDto) {
    const storeId    = dto.storeId!;
    const priceType  = dto.priceType ?? 'FIXED';

    this.validatePricing(priceType, dto.basePrice);

    return this.prisma.$transaction(async (tx) => {
      const service = await tx.service.create({
        data: {
          storeId,
          name:             dto.name,
          description:      dto.description      ?? null,
          category:         dto.category         ?? null,
          imageUrl:         dto.imageUrl          ?? null,
          priceType:        priceType as any,
          basePrice:        dto.basePrice         ?? null,
          minPrice:         dto.minPrice          ?? null,
          maxPrice:         dto.maxPrice          ?? null,
          costPrice:        dto.costPrice         ?? null,
          unitLabel:        dto.unitLabel         ?? null,
          hasVariants:      dto.hasVariants        ?? false,
          estimatedMinutes: dto.estimatedMinutes  ?? null,
          customFields:     dto.customFields      ?? {},
        },
        include: SERVICE_INCLUDE,
      });

      if (dto.hasVariants && dto.variants?.length) {
        await tx.serviceVariant.createMany({
          data: dto.variants.map(v => this.buildVariantData(v, service.serviceId)),
        });
      }

      return tx.service.findUnique({
        where:   { serviceId: service.serviceId },
        include: SERVICE_INCLUDE,
      });
    });
  }

  // ─── Listar por tienda ────────────────────────────────────────────────────

  async findAllByStore(storeId: string) {
    return this.prisma.service.findMany({
      where:   { storeId, isActive: true },
      include: SERVICE_INCLUDE,
      orderBy: { name: 'asc' },
    });
  }

  // ─── Detalle ──────────────────────────────────────────────────────────────

  async findOne(serviceId: string, storeId?: string) {
    const service = await this.prisma.service.findUnique({
      where:   { serviceId },
      include: {
        // En detalle mostramos TODAS las variantes (incluso inactivas)
        variants: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!service) throw new NotFoundException('Servicio no encontrado');
    if (storeId && service.storeId !== storeId)
      throw new ForbiddenException('No tienes acceso a este servicio');
    return service;
  }

  // ─── Actualizar ───────────────────────────────────────────────────────────

  async update(serviceId: string, dto: UpdateServiceDto, storeId?: string) {
    const current = await this.findAndVerify(serviceId, storeId);

    // Validar pricing con el nuevo tipo (o el actual si no cambia)
    const priceType = dto.priceType ?? (current.priceType as string);
    const basePrice = dto.basePrice !== undefined ? dto.basePrice : Number(current.basePrice);
    this.validatePricing(priceType, basePrice);

    return this.prisma.$transaction(async (tx) => {
      await tx.service.update({
        where: { serviceId },
        data: {
          ...(dto.name             !== undefined && { name:             dto.name }),
          ...(dto.description      !== undefined && { description:      dto.description }),
          ...(dto.category         !== undefined && { category:         dto.category }),
          ...(dto.imageUrl         !== undefined && { imageUrl:         dto.imageUrl }),
          ...(dto.priceType        !== undefined && { priceType:        dto.priceType as any }),
          ...(dto.basePrice        !== undefined && { basePrice:        dto.basePrice }),
          ...(dto.minPrice         !== undefined && { minPrice:         dto.minPrice }),
          ...(dto.maxPrice         !== undefined && { maxPrice:         dto.maxPrice }),
          ...(dto.costPrice        !== undefined && { costPrice:        dto.costPrice }),
          ...(dto.unitLabel        !== undefined && { unitLabel:        dto.unitLabel }),
          ...(dto.hasVariants      !== undefined && { hasVariants:      dto.hasVariants }),
          ...(dto.estimatedMinutes !== undefined && { estimatedMinutes: dto.estimatedMinutes }),
          ...(dto.customFields     !== undefined && { customFields:     dto.customFields }),
          ...(dto.isActive         !== undefined && { isActive:         dto.isActive }),
        },
      });

      if (dto.variants !== undefined) {
        await this.syncVariants(tx, serviceId, dto.variants);
      }

      return tx.service.findUnique({
        where:   { serviceId },
        include: SERVICE_INCLUDE,
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
    serviceId: string,
    variants: UpdateServiceVariantDto[],
  ) {
    const incomingIds = variants
      .filter(v => v.variantId)
      .map(v => v.variantId!);

    // Desactivar las que no vienen en el array
    await tx.serviceVariant.updateMany({
      where: { serviceId, variantId: { notIn: incomingIds } },
      data:  { isActive: false },
    });

    for (const v of variants) {
      const data = this.buildVariantData(v, serviceId);
      if (v.variantId) {
        await tx.serviceVariant.update({ where: { variantId: v.variantId }, data });
      } else {
        await tx.serviceVariant.create({ data });
      }
    }
  }

  // ─── Eliminar (soft delete) ───────────────────────────────────────────────

  async remove(serviceId: string, storeId?: string) {
    await this.findAndVerify(serviceId, storeId);
    return this.prisma.service.update({
      where: { serviceId },
      data:  { isActive: false },
    });
  }

  // ─── Variantes individuales ───────────────────────────────────────────────

  async addVariant(
    serviceId: string,
    data: CreateServiceVariantDto,
    storeId?: string,
  ) {
    await this.findAndVerify(serviceId, storeId);
    return this.prisma.serviceVariant.create({
      data: this.buildVariantData(data, serviceId),
    });
  }

  async updateVariant(
    variantId: string,
    data: UpdateServiceVariantDto,
    storeId?: string,
  ) {
    const variant = await this.prisma.serviceVariant.findUnique({
      where:   { variantId },
      include: { service: true },
    });
    if (!variant) throw new NotFoundException('Variante no encontrada');
    if (storeId && variant.service.storeId !== storeId)
      throw new ForbiddenException('No tienes acceso a esta variante');

    this.validateVariantPricing(data);

    return this.prisma.serviceVariant.update({
      where: { variantId },
      data: {
        ...(data.name             !== undefined && { name:             data.name }),
        ...(data.description      !== undefined && { description:      data.description }),
        ...(data.priceOverride    !== undefined && { priceOverride:    data.priceOverride }),
        ...(data.priceModifier    !== undefined && { priceModifier:    data.priceModifier }),
        ...(data.estimatedMinutes !== undefined && { estimatedMinutes: data.estimatedMinutes }),
        ...(data.sortOrder        !== undefined && { sortOrder:        data.sortOrder }),
        ...(data.isActive         !== undefined && { isActive:         data.isActive }),
      },
    });
  }

  async removeVariant(variantId: string, storeId?: string) {
    const variant = await this.prisma.serviceVariant.findUnique({
      where:   { variantId },
      include: { service: true },
    });
    if (!variant) throw new NotFoundException('Variante no encontrada');
    if (storeId && variant.service.storeId !== storeId)
      throw new ForbiddenException('No tienes acceso a esta variante');

    return this.prisma.serviceVariant.update({
      where: { variantId },
      data:  { isActive: false },
    });
  }

  // ─── Resumen para la IA ───────────────────────────────────────────────────

  async getSummaryForAI(storeId: string): Promise<string> {
    const services = await this.prisma.service.findMany({
      where:   { storeId, isActive: true },
      include: { variants: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } },
      orderBy: { name: 'asc' },
    });

    if (!services.length) return 'No hay servicios disponibles actualmente.';

    const PRICE_TYPE_LABELS: Record<string, string> = {
      FIXED:    'Precio fijo',
      PER_HOUR: 'Por hora',
      PER_DAY:  'Por día',
      PER_UNIT: 'Por unidad',
      VARIABLE: 'Precio variable (cotización)',
    };

    return services.map((s: any) => {
      const lines: string[] = [`Servicio: ${s.name}`];

      if (s.category) lines.push(`Categoría: ${s.category}`);

      // Descripción sin HTML
      if (s.description) {
        const plain = s.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (plain) lines.push(`Descripción: ${plain.slice(0, 300)}`);
      }

      // Precio
      const priceLabel = PRICE_TYPE_LABELS[s.priceType] ?? s.priceType;
      if (s.priceType === 'VARIABLE') {
        const rango = s.minPrice && s.maxPrice
          ? ` (rango: $${Number(s.minPrice).toLocaleString('es-CO')} – $${Number(s.maxPrice).toLocaleString('es-CO')})`
          : '';
        lines.push(`Precio: ${priceLabel}${rango} — se cotiza caso a caso`);
      } else if (s.basePrice) {
        const unidad = s.unitLabel ? `/${s.unitLabel}` : '';
        lines.push(`Precio: $${Number(s.basePrice).toLocaleString('es-CO')}${unidad} (${priceLabel})`);
      }

      // Duración
      if (s.estimatedMinutes) {
        const horas   = Math.floor(s.estimatedMinutes / 60);
        const minutos = s.estimatedMinutes % 60;
        const duracion = horas > 0
          ? `${horas}h${minutos > 0 ? ` ${minutos}min` : ''}`
          : `${minutos}min`;
        lines.push(`Duración estimada: ${duracion}`);
      }

      // Variantes
      if (s.hasVariants && s.variants?.length) {
        lines.push('Variantes/Paquetes:');
        s.variants.forEach((v: any) => {
          let precioVariante = '';
          if (v.priceOverride) {
            precioVariante = ` — $${Number(v.priceOverride).toLocaleString('es-CO')}`;
          } else if (v.priceModifier) {
            precioVariante = ` — ${v.priceModifier > 0 ? '+' : ''}${v.priceModifier}% sobre base`;
          }
          const durVariante = v.estimatedMinutes
            ? ` (${Math.floor(v.estimatedMinutes / 60)}h${v.estimatedMinutes % 60 > 0 ? ` ${v.estimatedMinutes % 60}min` : ''})`
            : '';
          lines.push(`  - ${v.name}${precioVariante}${durVariante}`);
        });
      }

      return lines.join('\n');
    }).join('\n\n---\n\n');
  }
}