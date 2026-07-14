// src/integrations/sync.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { signSyncRequest } from './sync-signing';
import { Prisma } from '../generated/prisma/client';

// Tx = cliente prisma o cliente transaccional
type Tx = any;

const RETRY_STEPS_MIN = [1, 5, 30, 120]; // backoff en minutos; luego cap 120
const MAX_ATTEMPTS = 10;

// Tipos de evento soportados por el receptor — se valida ANTES de tocar el
// inbox o abrir transacción para no quemar recursos en tipos desconocidos.
// Debe ir 1:1 con el switch de applyEvent (su default lanza si divergen).
const KNOWN_EVENT_TYPES = new Set([
  'category.upserted',
  'category.deleted',
  'product.upserted',
  'product.deleted',
  'stock.changed',
  'sync.completed',
]);

// P2002 del syncInbox.create dentro de la tx = carrera entre dos instancias
// procesando el mismo evento: la otra ya lo aplicó → tratar como skipped, no
// como error real (que sí debe propagar para que el emisor reintente).
//
// Trade-off deliberado: NO se amplía a "cualquier P2002 = skipped" — un P2002
// genuino (p.ej. sku duplicado de Product/ProductVariant) marcaría el evento
// como procesado en StockUp y se perdería para siempre. Si un redelivery
// CONCURRENTE del mismo evento choca en Product/ProductVariant antes de llegar
// al inbox, propaga como 500 y se auto-cura en el siguiente retry: el
// fast-path encuentra el inbox commiteado por el ganador. La ventana es rara
// porque el dispatcher de StockUp es serial por conexión.
function isInboxDuplicate(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
  const meta = e.meta as { modelName?: string; target?: unknown } | undefined;
  if (meta?.modelName === 'SyncInbox') return true;
  const target = meta?.target;
  if (Array.isArray(target)) return (target as string[]).includes('eventId');
  if (typeof target === 'string') return target.includes('eventId') || target.includes('sync_inbox');
  return false;
}

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
  private async createCategoryFromWire(tx: Tx, storeId: string, name: string, stockupCategoryId: string) {
    const base = slugify(name) || 'categoria';
    const taken = await tx.category.findUnique({
      where: { storeId_slug: { storeId, slug: base } },
    });
    const slug = taken ? `${base}-${randomUUID().slice(0, 6)}` : base;
    return tx.category.create({
      data: { storeId, name, slug, stockupCategoryId },
    });
  }

  // Recompone `mapped` desde la BD para el fast-path de retry: si el CRM ya
  // aplicó y commiteó el evento pero la respuesta original se perdió (timeout
  // del lado StockUp), StockUp reintenta y necesitamos re-entregarle el mapeo
  // igual, sin volver a aplicar nada.
  private async recomputeMapped(storeId: string, envelope: any): Promise<any> {
    const mapped: any = {};
    if (envelope.type === 'product.upserted') {
      const w = envelope.payload.product;
      const p = await this.prisma.product.findFirst({
        where: { storeId, stockupProductId: w.sourceId },
        include: { variants: true },
      });
      if (p) {
        mapped.productId = p.productId;
        const variantIds: Record<string, string> = {};
        for (const vw of w.variants ?? []) {
          const v = p.variants.find((x: any) => x.stockupVariantId === vw.sourceId);
          if (v) variantIds[vw.sourceId] = v.variantId;
        }
        if (Object.keys(variantIds).length) mapped.variantIds = variantIds;
      }
      if (w.category) {
        const c = await this.prisma.category.findFirst({
          where: { storeId, stockupCategoryId: w.category.sourceId },
        });
        if (c) mapped.categoryId = c.categoryId;
      }
    } else if (envelope.type === 'category.upserted') {
      const w = envelope.payload.category;
      const c = await this.prisma.category.findFirst({ where: { storeId, stockupCategoryId: w.sourceId } });
      if (c) mapped.categoryId = c.categoryId;
    }
    return Object.keys(mapped).length ? mapped : undefined;
  }

  // ── APLICACIÓN de eventos remotos (StockUp → CRM). NUNCA emite. ─────────
  //
  // Atomicidad: el apply y la fila de dedupe (syncInbox) se escriben en la
  // MISMA transacción, inbox al final. Si la tx falla o el proceso muere a
  // mitad, TODO rollbackea (incluido el inbox) y el reintento del emisor
  // re-aplica desde cero — nunca queda un evento "fantasma" marcado como
  // procesado sin haberse aplicado.
  //
  // Orden: los reintentos del dispatcher no garantizan orden, así que el skip
  // de eventos viejos se decide evento-contra-evento con `stockupSyncedAt`
  // (occurredAt del último evento StockUp aplicado a esa entidad), NUNCA
  // contra `updatedAt` local (que cambia también por escrituras ajenas al
  // sync y colapsaría un backlog reordenado a su estado más viejo).
  async applyRemoteEvent(storeId: string, envelope: any): Promise<{ ok: boolean; mapped?: any; skipped?: boolean }> {
    if (!KNOWN_EVENT_TYPES.has(envelope.type)) return { ok: false }; // no tocar inbox/tx por tipos desconocidos

    // Fast-path: evento ya procesado y commiteado → skipped, re-entregando
    // `mapped` por si la respuesta original se perdió (timeout del emisor).
    const seen = await this.prisma.syncInbox.findUnique({ where: { eventId: envelope.eventId } });
    if (seen) {
      const mapped = await this.recomputeMapped(storeId, envelope);
      return { ok: true, skipped: true, ...(mapped ? { mapped } : {}) };
    }

    const occurredAt = new Date(envelope.occurredAt);
    try {
      return await this.prisma.$transaction(
        async (tx: Tx) => {
          const mapped: any = {};
          const result = await this.applyEvent(tx, storeId, envelope, occurredAt, mapped);
          // Último paso: si algo antes falló, esto nunca se ejecuta y la tx
          // entera rollbackea (incluido el inbox).
          await tx.syncInbox.create({ data: { eventId: envelope.eventId } });
          return result;
        },
        // product.upserted con muchas variantes es una cadena secuencial de
        // queries: el default de 5s puede reventar con P2028 y reintentar en
        // loop. Mismo timeout que el receptor de referencia de StockUp.
        { timeout: 15_000 },
      );
    } catch (e) {
      if (isInboxDuplicate(e)) return { ok: true, skipped: true }; // carrera con otra instancia
      throw e; // fallo real: propaga para que el controller responda 500 y el emisor reintente
    }
  }

  private async applyEvent(
    tx: Tx,
    storeId: string,
    envelope: any,
    occurredAt: Date,
    mapped: any,
  ): Promise<{ ok: boolean; mapped?: any; skipped?: boolean }> {
    switch (envelope.type) {
      case 'category.upserted': {
        // categorías: last-write-wins, sin skip evento-contra-evento
        const w = envelope.payload.category;
        const existing = await tx.category.findFirst({
          where: { storeId, stockupCategoryId: w.sourceId },
        });
        if (existing) {
          await tx.category.update({
            where: { categoryId: existing.categoryId }, data: { name: w.name },
          });
        } else {
          const c = await this.createCategoryFromWire(tx, storeId, w.name, w.sourceId);
          mapped.categoryId = c.categoryId;
        }
        break;
      }
      case 'category.deleted': {
        const w = envelope.payload.category;
        await tx.category.deleteMany({ where: { storeId, stockupCategoryId: w.sourceId } });
        break;
      }
      case 'product.upserted': {
        const w = envelope.payload.product;
        let existing = await tx.product.findFirst({
          where: { storeId, stockupProductId: w.sourceId },
        });
        let adopted = false;
        if (!existing && w.sku) {
          // Adopción por SKU: sku es unique [storeId, sku] — si ya existe un
          // producto CRM sin mapear con ese sku, lo vinculamos en vez de
          // reventar con P2002 al crear (escenario onboarding Vida Verde).
          existing = await tx.product.findFirst({
            where: { storeId, sku: w.sku, stockupProductId: null },
          });
          adopted = !!existing;
        }
        // Skip evento-contra-evento: solo si YA se aplicó un evento StockUp
        // más nuevo a esta entidad. stockupSyncedAt null (nunca sincronizada,
        // o recién adoptada por sku) nunca se skipea. Se decide ANTES de
        // tocar la categoría para no crearla/actualizarla desde un evento viejo.
        // El <= en empate de timestamps es deliberado: gana el primero
        // commiteado y se evita re-aplicar un duplicado.
        if (existing?.stockupSyncedAt && occurredAt <= existing.stockupSyncedAt) {
          return { ok: true, skipped: true };
        }
        // categoría inline
        let categoryId: string | null = null;
        if (w.category) {
          let cat = await tx.category.findFirst({
            where: { storeId, stockupCategoryId: w.category.sourceId },
          });
          if (!cat) {
            cat = await this.createCategoryFromWire(tx, storeId, w.category.name, w.category.sourceId);
            mapped.categoryId = cat.categoryId;
          }
          categoryId = cat.categoryId;
        }
        const data = { ...wireToProductData(w), categoryId, stockupSyncedAt: occurredAt };
        let productId: string;
        if (existing) {
          await tx.product.update({ where: { productId: existing.productId }, data });
          productId = existing.productId;
          // adoptado: StockUp debe aprender el mapeo hacia este producto CRM
          if (adopted) mapped.productId = existing.productId;
        } else {
          const p = await tx.product.create({ data: { ...data, storeId } });
          productId = p.productId;
          mapped.productId = p.productId;
        }
        // variantes: upsert por stockupVariantId; desactivar las locales que ya no vienen
        const variantIds: Record<string, string> = {};
        for (const vw of w.variants ?? []) {
          const ev = await tx.productVariant.findFirst({
            where: { productId, stockupVariantId: vw.sourceId },
          });
          const vdata = {
            name: vw.name, sku: vw.sku, salePrice: vw.price, costPrice: vw.costPrice ?? 0,
            stock: vw.stock, imageUrl: vw.image, isActive: vw.isActive,
            stockupVariantId: vw.sourceId, stockupSyncedAt: occurredAt,
          };
          if (ev) {
            await tx.productVariant.update({ where: { variantId: ev.variantId }, data: vdata });
          } else {
            const nv = await tx.productVariant.create({
              data: { ...vdata, productId, attributes: {} },
            });
            variantIds[vw.sourceId] = nv.variantId;
          }
        }
        const keepIds = (w.variants ?? []).map((v: any) => v.sourceId);
        await tx.productVariant.updateMany({
          where: { productId, stockupVariantId: { notIn: keepIds.length ? keepIds : ['__none__'] }, NOT: { stockupVariantId: null } },
          data: { isActive: false },
        });
        if (Object.keys(variantIds).length) mapped.variantIds = variantIds;
        break;
      }
      case 'product.deleted': {
        const w = envelope.payload.product;
        await tx.product.updateMany({
          where: { storeId, stockupProductId: w.sourceId }, data: { isActive: false },
        });
        break;
      }
      case 'stock.changed': {
        // Skip evento-contra-evento (stockupSyncedAt), no contra reloj local:
        // un retry con stock viejo no debe pisar un evento StockUp más nuevo
        // ya aplicado, pero una escritura LOCAL reciente no debe bloquear el evento.
        // El <= en empate de timestamps es deliberado: gana el primero
        // commiteado y se evita re-aplicar un duplicado.
        const p = envelope.payload;
        if (p.variantSourceId) {
          const v = await tx.productVariant.findFirst({
            where: { stockupVariantId: p.variantSourceId, product: { storeId } },
          });
          if (!v) return { ok: true, skipped: true };
          if (v.stockupSyncedAt && occurredAt <= v.stockupSyncedAt) return { ok: true, skipped: true };
          await tx.productVariant.update({
            where: { variantId: v.variantId },
            data: { stock: p.stock, stockupSyncedAt: occurredAt },
          });
        } else {
          const prod = await tx.product.findFirst({ where: { storeId, stockupProductId: p.productSourceId } });
          if (!prod) return { ok: true, skipped: true };
          if (prod.stockupSyncedAt && occurredAt <= prod.stockupSyncedAt) return { ok: true, skipped: true };
          await tx.product.update({
            where: { productId: prod.productId },
            data: { stock: p.stock, stockupSyncedAt: occurredAt },
          });
        }
        break;
      }
      case 'sync.completed': {
        // fin de sync inicial: desactivar productos sin mapeo (StockUp pisa todo)
        await tx.product.updateMany({
          where: { storeId, stockupProductId: null, isActive: true },
          data: { isActive: false },
        });
        await tx.stockupConnection.update({
          where: { storeId }, data: { lastSyncAt: new Date() },
        });
        break;
      }
      default:
        // Inalcanzable: el tipo se valida contra KNOWN_EVENT_TYPES antes de
        // abrir la tx (si agregas un case aquí, agrégalo también al Set, y
        // viceversa). Throw y no { ok: false }: devolver "ok" commitearía el
        // inbox para un evento NO manejado y el retry se cortocircuitaría.
        throw new Error(`[sync] tipo de evento no manejado: ${envelope.type}`);
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
