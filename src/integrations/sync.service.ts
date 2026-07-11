// src/integrations/sync.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { signSyncRequest } from './sync-signing';

// Tx = cliente prisma o cliente transaccional
type Tx = any;

const RETRY_STEPS_MIN = [1, 5, 30, 120]; // backoff en minutos; luego cap 120
const MAX_ATTEMPTS = 10;

// Slug requerido por el schema de Category (unique [storeId, slug]).
// Misma normalización que products.service.ts createCategory.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Mapeo puro CRM → wire ──────────────────────────────────────────────────
export function productToWire(p: any) {
  return {
    sourceId: p.productId,
    targetId: p.stockupProductId ?? null,
    name: p.name,
    description: p.description ?? null,
    sku: p.sku ?? null,
    price: Number(p.salePrice),
    costPrice: Number(p.costPrice ?? 0),
    stock: p.stock,
    images: p.images?.length ? p.images : (p.imageUrl ? [p.imageUrl] : []),
    isActive: p.isActive,
    hasVariants: p.hasVariants,
    category: p.category
      ? { sourceId: p.category.categoryId, targetId: p.category.stockupCategoryId ?? null, name: p.category.name }
      : null,
    variants: (p.variants ?? []).map((v: any) => ({
      sourceId: v.variantId,
      targetId: v.stockupVariantId ?? null,
      name: v.name,
      sku: v.sku ?? null,
      price: v.salePrice != null ? Number(v.salePrice) : null,
      costPrice: Number(v.costPrice ?? 0),
      stock: v.stock,
      image: v.imageUrl ?? null,
      isActive: v.isActive,
    })),
  };
}

// ── Mapeo puro wire → data de escritura CRM (upsert base, sin variantes) ──
export function wireToProductData(w: any) {
  return {
    name: w.name,
    description: w.description ?? null,
    sku: w.sku ?? null,
    salePrice: w.price,
    costPrice: w.costPrice ?? 0,
    stock: w.stock,
    hasVariants: !!w.hasVariants,
    images: w.images ?? [],
    imageUrl: w.images?.[0] ?? null,
    isActive: w.isActive,
    stockupProductId: w.sourceId,
  };
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger('Sync');
  private connCache = new Map<string, { conn: any; at: number }>();

  constructor(private prisma: PrismaService) {}

  // OJO: en cache-miss dentro de una $transaction esta lectura usa `this.prisma`
  // (segunda conexión del pool, fuera de la tx). El riesgo teórico de estancamiento
  // del pool se acepta: el cache de 60 s hace el miss raro y el volumen de tiendas
  // conectadas a StockUp es bajo.
  async getConnection(storeId: string) {
    const hit = this.connCache.get(storeId);
    if (hit && Date.now() - hit.at < 60_000) return hit.conn;
    const conn = await this.prisma.stockupConnection.findUnique({ where: { storeId } });
    const usable = conn?.enabled && conn.secret ? conn : null;
    this.connCache.set(storeId, { conn: usable, at: Date.now() });
    return usable;
  }

  invalidateCache(storeId: string) { this.connCache.delete(storeId); }

  // ── EMISIÓN (llamar DENTRO de la transacción del cambio) ────────────────
  private async enqueue(tx: Tx, storeId: string, type: string, payload: any) {
    if (!(await this.getConnection(storeId))) return; // no-op sin conexión
    await tx.syncOutbox.create({
      data: { id: randomUUID(), storeId, eventId: randomUUID(), type, payload },
    });
  }

  async emitProductUpserted(tx: Tx, storeId: string, productId: string) {
    if (!(await this.getConnection(storeId))) return; // no-op barato: evita el findFirst en el hot path
    const p = await tx.product.findFirst({
      where: { productId, storeId },
      include: { category: true, variants: true },
    });
    if (!p) return;
    await this.enqueue(tx, storeId, 'product.upserted', { product: productToWire(p) });
  }

  async emitProductDeleted(tx: Tx, storeId: string, productId: string, stockupProductId: string | null) {
    await this.enqueue(tx, storeId, 'product.deleted', {
      product: { sourceId: productId, targetId: stockupProductId },
    });
  }

  async emitStockChanged(tx: Tx, storeId: string, ref: { productId?: string; variantId?: string }) {
    if (!(await this.getConnection(storeId))) return; // no-op barato: evita el findFirst en el hot path
    if (ref.variantId) {
      const v = await tx.productVariant.findFirst({
        where: { variantId: ref.variantId, product: { storeId } },
        include: { product: true },
      });
      if (!v) return;
      await this.enqueue(tx, storeId, 'stock.changed', {
        productSourceId: v.product.productId, productTargetId: v.product.stockupProductId,
        variantSourceId: v.variantId, variantTargetId: v.stockupVariantId,
        stock: v.stock,
      });
    } else if (ref.productId) {
      const p = await tx.product.findFirst({ where: { productId: ref.productId, storeId } });
      if (!p) return;
      await this.enqueue(tx, storeId, 'stock.changed', {
        productSourceId: p.productId, productTargetId: p.stockupProductId,
        variantSourceId: null, variantTargetId: null,
        stock: p.stock,
      });
    }
  }

  async emitCategoryUpserted(tx: Tx, storeId: string, categoryId: string) {
    if (!(await this.getConnection(storeId))) return; // no-op barato: evita el findFirst en el hot path
    const c = await tx.category.findFirst({ where: { categoryId, storeId } });
    if (!c) return;
    await this.enqueue(tx, storeId, 'category.upserted', {
      category: { sourceId: c.categoryId, targetId: c.stockupCategoryId, name: c.name },
    });
  }

  async emitCategoryDeleted(tx: Tx, storeId: string, categoryId: string, stockupCategoryId: string | null) {
    await this.enqueue(tx, storeId, 'category.deleted', {
      category: { sourceId: categoryId, targetId: stockupCategoryId },
    });
  }

  // Crea una categoría local para un evento remoto, resolviendo el slug
  // requerido por el schema (colisión → sufijo aleatorio corto).
  private async createCategoryFromWire(storeId: string, name: string, stockupCategoryId: string) {
    const base = slugify(name) || 'categoria';
    const taken = await this.prisma.category.findUnique({
      where: { storeId_slug: { storeId, slug: base } },
    });
    const slug = taken ? `${base}-${randomUUID().slice(0, 6)}` : base;
    return this.prisma.category.create({
      data: { storeId, name, slug, stockupCategoryId },
    });
  }

  // ── APLICACIÓN de eventos remotos (StockUp → CRM). NUNCA emite. ─────────
  async applyRemoteEvent(storeId: string, envelope: any): Promise<{ ok: boolean; mapped?: any; skipped?: boolean }> {
    // dedupe
    try {
      await this.prisma.syncInbox.create({ data: { eventId: envelope.eventId } });
    } catch {
      return { ok: true, skipped: true }; // ya procesado
    }
    const occurredAt = new Date(envelope.occurredAt);
    const mapped: any = {};

    // Si la aplicación falla, liberamos el eventId del inbox para que el
    // reintento del emisor NO se cortocircuite como "ya procesado".
    try {
      return await this.applyEvent(storeId, envelope, occurredAt, mapped);
    } catch (e) {
      await this.prisma.syncInbox
        .delete({ where: { eventId: envelope.eventId } })
        .catch(() => {});
      throw e;
    }
  }

  private async applyEvent(
    storeId: string,
    envelope: any,
    occurredAt: Date,
    mapped: any,
  ): Promise<{ ok: boolean; mapped?: any; skipped?: boolean }> {
    switch (envelope.type) {
      case 'category.upserted': {
        const w = envelope.payload.category;
        const existing = await this.prisma.category.findFirst({
          where: { storeId, stockupCategoryId: w.sourceId },
        });
        if (existing) {
          await this.prisma.category.update({
            where: { categoryId: existing.categoryId }, data: { name: w.name },
          });
        } else {
          const c = await this.createCategoryFromWire(storeId, w.name, w.sourceId);
          mapped.categoryId = c.categoryId;
        }
        break;
      }
      case 'category.deleted': {
        const w = envelope.payload.category;
        await this.prisma.category.deleteMany({ where: { storeId, stockupCategoryId: w.sourceId } });
        break;
      }
      case 'product.upserted': {
        const w = envelope.payload.product;
        // categoría inline
        let categoryId: string | null = null;
        if (w.category) {
          let cat = await this.prisma.category.findFirst({
            where: { storeId, stockupCategoryId: w.category.sourceId },
          });
          if (!cat) {
            cat = await this.createCategoryFromWire(storeId, w.category.name, w.category.sourceId);
            mapped.categoryId = cat.categoryId;
          }
          categoryId = cat.categoryId;
        }
        const data = { ...wireToProductData(w), categoryId };
        let existing = await this.prisma.product.findFirst({
          where: { storeId, stockupProductId: w.sourceId },
        });
        let adopted = false;
        if (!existing && w.sku) {
          // Adopción por SKU: sku es unique [storeId, sku] — si ya existe un
          // producto CRM sin mapear con ese sku, lo vinculamos en vez de
          // reventar con P2002 al crear (escenario onboarding Vida Verde).
          existing = await this.prisma.product.findFirst({
            where: { storeId, sku: w.sku, stockupProductId: null },
          });
          adopted = !!existing;
        }
        let productId: string;
        if (existing) {
          if (existing.updatedAt > occurredAt) return { ok: true, skipped: true }; // evento viejo
          await this.prisma.product.update({ where: { productId: existing.productId }, data });
          productId = existing.productId;
          // adoptado: StockUp debe aprender el mapeo hacia este producto CRM
          if (adopted) mapped.productId = existing.productId;
        } else {
          const p = await this.prisma.product.create({ data: { ...data, storeId } });
          productId = p.productId;
          mapped.productId = p.productId;
        }
        // variantes: upsert por stockupVariantId; desactivar las locales que ya no vienen
        const variantIds: Record<string, string> = {};
        for (const vw of w.variants ?? []) {
          const ev = await this.prisma.productVariant.findFirst({
            where: { productId, stockupVariantId: vw.sourceId },
          });
          const vdata = {
            name: vw.name, sku: vw.sku, salePrice: vw.price, costPrice: vw.costPrice ?? 0,
            stock: vw.stock, imageUrl: vw.image, isActive: vw.isActive,
            stockupVariantId: vw.sourceId,
          };
          if (ev) {
            await this.prisma.productVariant.update({ where: { variantId: ev.variantId }, data: vdata });
          } else {
            const nv = await this.prisma.productVariant.create({
              data: { ...vdata, productId, attributes: {} },
            });
            variantIds[vw.sourceId] = nv.variantId;
          }
        }
        const keepIds = (w.variants ?? []).map((v: any) => v.sourceId);
        await this.prisma.productVariant.updateMany({
          where: { productId, stockupVariantId: { notIn: keepIds.length ? keepIds : ['__none__'] }, NOT: { stockupVariantId: null } },
          data: { isActive: false },
        });
        if (Object.keys(variantIds).length) mapped.variantIds = variantIds;
        break;
      }
      case 'product.deleted': {
        const w = envelope.payload.product;
        await this.prisma.product.updateMany({
          where: { storeId, stockupProductId: w.sourceId }, data: { isActive: false },
        });
        break;
      }
      case 'stock.changed': {
        const p = envelope.payload;
        if (p.variantSourceId) {
          await this.prisma.productVariant.updateMany({
            where: { stockupVariantId: p.variantSourceId, product: { storeId } },
            data: { stock: p.stock },
          });
        } else {
          await this.prisma.product.updateMany({
            where: { storeId, stockupProductId: p.productSourceId },
            data: { stock: p.stock },
          });
        }
        break;
      }
      case 'sync.completed': {
        // fin de sync inicial: desactivar productos sin mapeo (StockUp pisa todo)
        await this.prisma.product.updateMany({
          where: { storeId, stockupProductId: null, isActive: true },
          data: { isActive: false },
        });
        await this.prisma.stockupConnection.update({
          where: { storeId }, data: { lastSyncAt: new Date() },
        });
        break;
      }
      default:
        return { ok: false };
    }
    return { ok: true, mapped: Object.keys(mapped).length ? mapped : undefined };
  }

  // ── DISPATCHER ───────────────────────────────────────────────────────────
  private dispatching = false;

  @Interval(30_000)
  async dispatchPending() {
    if (this.dispatching) return; // evita corridas solapadas del interval
    this.dispatching = true;
    try {
      const events = await this.prisma.syncOutbox.findMany({
        where: { status: 'PENDING', nextRetryAt: { lte: new Date() } },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
      for (const ev of events) await this.dispatchOne(ev);
    } finally {
      this.dispatching = false;
    }
  }

  async dispatchOne(ev: any) {
    const conn = await this.prisma.stockupConnection.findUnique({ where: { storeId: ev.storeId } });
    if (!conn?.enabled || !conn.secret) {
      // conexión muerta/deshabilitada: no dejar filas PENDING huérfanas
      // acaparando el batch global para siempre
      await this.prisma.syncOutbox.update({
        where: { id: ev.id },
        data: { status: 'FAILED' },
      });
      return;
    }
    const base = process.env.STOCKUP_BASE_URL || 'https://stock-up-ashy.vercel.app';
    const body = JSON.stringify({
      eventId: ev.eventId, type: ev.type,
      occurredAt: ev.occurredAt.toISOString(), payload: ev.payload,
    });
    const { timestamp, signature } = signSyncRequest(conn.secret, body);
    try {
      const res = await fetch(`${base}/api/integrations/crm/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-sync-timestamp': timestamp,
          'x-sync-event-id': ev.eventId,
          'x-sync-signature': signature,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.mapped) await this.saveMappings(ev, json.mapped);
      await this.prisma.syncOutbox.update({ where: { id: ev.id }, data: { status: 'SENT' } });
    } catch (e) {
      const attempts = ev.attempts + 1;
      const delayMin = RETRY_STEPS_MIN[Math.min(attempts - 1, RETRY_STEPS_MIN.length - 1)];
      await this.prisma.syncOutbox.update({
        where: { id: ev.id },
        data: {
          attempts,
          status: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
          nextRetryAt: new Date(Date.now() + delayMin * 60_000),
        },
      });
      this.logger.warn(`[sync] evento ${ev.eventId} fallo intento ${attempts}: ${e}`);
    }
  }

  private async saveMappings(ev: any, mapped: any) {
    // el receptor (StockUp) creó entidades; guardamos sus ids en NUESTRAS columnas
    if (mapped.productId && ev.payload?.product?.sourceId) {
      await this.prisma.product.updateMany({
        where: { productId: ev.payload.product.sourceId, storeId: ev.storeId },
        data: { stockupProductId: mapped.productId },
      });
    }
    if (mapped.categoryId) {
      const catSourceId = ev.payload?.category?.sourceId ?? ev.payload?.product?.category?.sourceId;
      if (catSourceId) {
        await this.prisma.category.updateMany({
          where: { categoryId: catSourceId, storeId: ev.storeId },
          data: { stockupCategoryId: mapped.categoryId },
        });
      }
    }
    if (mapped.variantIds) {
      for (const [srcId, remoteId] of Object.entries(mapped.variantIds)) {
        await this.prisma.productVariant.updateMany({
          where: { variantId: srcId, product: { storeId: ev.storeId } },
          data: { stockupVariantId: remoteId as string },
        });
      }
    }
  }

  // Disparo inmediato post-commit (fire and forget)
  kick() { this.dispatchPending().catch((e) => this.logger.warn(`[sync] kick: ${e}`)); }
}
