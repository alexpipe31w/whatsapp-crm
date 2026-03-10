import { Injectable, Logger } from '@nestjs/common';
import Groq from 'groq-sdk';
import { PrismaService } from '../prisma/prisma.service';

// ─── Constantes ───────────────────────────────────────────────────────────────

const CONFIG_CACHE_TTL_MS   = 60_000;
const CATALOG_CACHE_TTL_MS  = 120_000;
const GROQ_TIMEOUT_MAIN_MS  = 30_000;
const GROQ_TIMEOUT_EXT_MS   = 20_000;
const ORDER_GUARD_TTL_MS    = 10 * 60 * 1000;
const MAX_HISTORY_MESSAGES  = 20;

// Solo corre el extractor si el mensaje tiene señales de compra
const PURCHASE_INTENT_RE = /\b(quiero|deseo|pedir|pido|ordenar|comprar|llevar|encargar|confirm|dale|listo|acepto|perfecto|procede|adelante|claro|exacto|sip|yep|yes|sí|si\b|ok\b|pedido|orden|dirección|entrega|envío|cantidad|unidades?)\b/i;

// Detecta si el cliente está confirmando un resumen previo
const CONFIRMATION_RE = /\b(confirm|sí|si\b|ok\b|dale|listo|acepto|perfecto|procede|adelante|claro|exacto|sip|yep|yes)\b/i;

// Detecta dirección en texto del cliente
const ADDRESS_RE = /\b(calle|carrera|cra|cl\b|av\b|avenida|barrio|#|\d{2,}[-–]\d+|diagonal|transversal|manzana|casa|apto|apartamento)\b/i;

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface ExtractedItem {
  itemType: 'producto' | 'servicio';
  productId: string | null;
  serviceId: string | null;
  variantId: string | null;
  quantity: number;
  description?: string | null;
}

interface ExtractionResult {
  complete: boolean;
  items: ExtractedItem[];
  deliveryAddress: string | null;
  notes: string | null;
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  private readonly groqClients        = new Map<string, Groq>();
  private readonly configCache        = new Map<string, CacheEntry<any>>();
  private readonly catalogCache       = new Map<string, CacheEntry<{ products: any[]; services: any[] }>>();
  private readonly orderInProgress    = new Set<string>();
  private readonly pendingExtractions = new Map<string, ExtractionResult>();

  constructor(private readonly prisma: PrismaService) {}

  // ─── Groq client ─────────────────────────────────────────────────────────────

  private getGroqClient(apiKey: string): Groq {
    if (!this.groqClients.has(apiKey)) {
      this.groqClients.set(apiKey, new Groq({ apiKey }));
    }
    return this.groqClients.get(apiKey)!;
  }

  // ─── Cache helpers ────────────────────────────────────────────────────────────

  private getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
    return entry.value;
  }

  private setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  invalidateCatalogCache(storeId: string): void {
    this.catalogCache.delete(storeId);
  }

  // ─── Entrada principal ────────────────────────────────────────────────────────

  async generateReply(
    storeId: string,
    userMessage: string,
    conversationId: string,
  ): Promise<string | null> {
    try {
      // ── 1. Config (cacheada) ────────────────────────────────────────────────
      let config = this.getCached(this.configCache, storeId);
      if (!config) {
        config = await this.prisma.aIConfiguration.findUnique({ where: { storeId } });
        if (!config) {
          this.logger.warn(`No hay AIConfiguration para store: ${storeId}`);
          return null;
        }
        this.setCached(this.configCache, storeId, config, CONFIG_CACHE_TTL_MS);
      }

      // ── 2. Catálogo (cacheado) ──────────────────────────────────────────────
      let catalog = this.getCached(this.catalogCache, storeId);
      if (!catalog) {
        const [products, services] = await Promise.all([
          this.prisma.product.findMany({
            where: { storeId, isActive: true },
            include: { variants: { where: { isActive: true }, orderBy: { name: 'asc' } } },
            orderBy: { name: 'asc' },
          }),
          this.prisma.service.findMany({
            where: { storeId, isActive: true },
            orderBy: { name: 'asc' },
          }),
        ]);
        catalog = { products, services };
        this.setCached(this.catalogCache, storeId, catalog, CATALOG_CACHE_TTL_MS);
      }
      const { products, services } = catalog;

      // ── 3. Conversación + órdenes + historial EN PARALELO ───────────────────
      const [conversationRow, orders, history] = await Promise.all([
        this.prisma.conversation.findFirst({
          where: { conversationId, storeId },
          include: { customer: true },
        }),
        this.prisma.order.findMany({
          where: { storeId, customer: { conversations: { some: { conversationId } } } },
          include: {
            orderItems: {
              include: { product: { select: { name: true, salePrice: true } } },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 5,
        }),
        this.prisma.message.findMany({
          where: { conversationId },
          orderBy: { createdAt: 'asc' },
          take: MAX_HISTORY_MESSAGES,
        }),
      ]);

      if (!conversationRow) {
        this.logger.warn(`Conversación ${conversationId} no pertenece a store ${storeId}`);
        return null;
      }
      const customer = conversationRow.customer;
      const groq = this.getGroqClient(config.groqApiKey);

      // ── 4. Extractor (solo con intención de compra) ─────────────────────────
      const hasCatalog          = products.length > 0 || services.length > 0;
      const hasPurchaseIntent   = PURCHASE_INTENT_RE.test(userMessage);
      const hasPendingExtraction = this.pendingExtractions.has(conversationId);

      const shouldTryOrder =
        hasCatalog &&
        history.length >= 3 &&
        (hasPurchaseIntent || hasPendingExtraction) &&
        !this.orderInProgress.has(conversationId);

      if (shouldTryOrder) {
        const orderResult = await this.tryExtractAndCreateOrder(
          groq, config.model, history, userMessage,
          products, services, customer, storeId, conversationId,
        );
        if (orderResult.created) return orderResult.message!;
      }

      // ── 5. Respuesta principal ───────────────────────────────────────────────
      const now = new Date();
      const fechaActual = now.toLocaleDateString('es-CO', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        timeZone: 'America/Bogota',
      });
      const horaActual = now.toLocaleTimeString('es-CO', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
      });

      // Detectar si la dirección ya fue dada en el historial
      const allClientText = [
        ...history.filter((m: any) => !m.isAiResponse).map((m: any) => m.content),
        userMessage,
      ].join(' ');
      const addressAlreadyGiven = ADDRESS_RE.test(allClientText);

      const enrichedSystemPrompt = this.buildSystemPrompt(
        config.systemPrompt, customer, orders, products, services,
        fechaActual, horaActual, history, userMessage, addressAlreadyGiven,
      );

      const messages: any[] = [
        { role: 'system', content: enrichedSystemPrompt },
        ...history.map((m: any) => ({
          role: m.isAiResponse ? 'assistant' : 'user',
          content: m.content.replace(/__ASK_NAME__|__ASK_CITY__/g, '').trim(),
        })),
        { role: 'user', content: userMessage },
      ];

      let response: any;
      try {
        response = await Promise.race([
          groq.chat.completions.create({
            model: config.model,
            messages,
            temperature: Number(config.temperature),
            max_tokens: config.maxTokens,
          } as any),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Groq timeout')), GROQ_TIMEOUT_MAIN_MS)
          ),
        ]) as any;
      } catch (modelErr: any) {
        this.logger.warn(`Modelo ${config.model} falló, fallback: ${modelErr.message?.slice(0, 80)}`);
        response = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages,
          temperature: Number(config.temperature),
          max_tokens: config.maxTokens,
        });
      }

      return response.choices[0]?.message?.content ?? null;

    } catch (err: any) {
      this.logger.error(`Error generando respuesta IA: ${err.message}`);
      return null;
    }
  }

  // ─── Extracción y creación de orden multi-item ────────────────────────────────

  private async tryExtractAndCreateOrder(
    groq: Groq,
    model: string,
    history: any[],
    latestMessage: string,
    products: any[],
    services: any[],
    customer: any,
    storeId: string,
    conversationId: string,
  ): Promise<{ created: boolean; message?: string }> {

    const cached = this.pendingExtractions.get(conversationId);
    let extracted: ExtractionResult;

    // ── Caso 1: extracción completa cacheada + cliente confirma ───────────────
    if (cached?.complete && cached.deliveryAddress && CONFIRMATION_RE.test(latestMessage.trim())) {
      this.logger.log(`Usando extracción completa cacheada para ${conversationId}`);
      extracted = cached;
      this.pendingExtractions.delete(conversationId);

    // ── Caso 2: había items pero faltaba dirección, y ahora llega ────────────
    } else if (cached?.items?.length && !cached.deliveryAddress && ADDRESS_RE.test(latestMessage)) {
      this.logger.log(`Completando extracción con dirección para ${conversationId}`);
      extracted = { ...cached, deliveryAddress: latestMessage.trim(), complete: true };
      this.pendingExtractions.delete(conversationId);

    // ── Caso 3: correr el extractor normalmente ───────────────────────────────
    } else {
      const productLines = products.flatMap((p: any) => {
        if (p.variants?.length > 0) {
          return p.variants.map((v: any) =>
            `- "${p.name} - ${v.name}" | tipo:producto | productId:${p.productId} | variantId:${v.variantId} | precio:${v.salePrice} | stock:${v.stock}`
          );
        }
        return [`- "${p.name}" | tipo:producto | productId:${p.productId} | variantId:null | precio:${p.salePrice} | stock:${p.stock}`];
      });

      const serviceLines = services.map((s: any) =>
        `- "${s.name}" | tipo:servicio | serviceId:${s.serviceId} | precio:${s.price ?? 'variable'}`
      );

      const catalogSummary = [...productLines, ...serviceLines].join('\n');

      const conversationText = [
        ...history.map((m: any) =>
          `${m.isAiResponse ? 'Asistente' : 'Cliente'}: ${m.content.replace(/__ASK_NAME__|__ASK_CITY__/g, '').trim()}`
        ),
        `Cliente: ${latestMessage}`,
      ].join('\n');

      const extractorPrompt = `Eres un extractor de datos de órdenes de compra. Tu única tarea es leer la conversación y extraer los datos del pedido en JSON.

CATÁLOGO DISPONIBLE (usa EXACTAMENTE estos IDs):
${catalogSummary}

CONVERSACIÓN:
${conversationText}

REGLAS ESTRICTAS:
1. "complete":true SOLO si se cumplen LAS 3 CONDICIONES SIMULTÁNEAMENTE:
   a) El cliente especificó al menos un producto/servicio del catálogo con cantidad
   b) El cliente proporcionó una dirección con calle, carrera, barrio o similar (solo decir una ciudad NO es suficiente)
   c) El cliente confirmó explícitamente (dijo sí, confirmo, listo, dale, ok, etc.)
2. Si falta CUALQUIERA de las 3 condiciones → "complete":false sin excepción.
3. Para productos CON variantes: el variantId es OBLIGATORIO. Identifícalo por el tamaño o nombre que pidió el cliente.
4. Para productos SIN variantes: variantId debe ser null.
5. Si el cliente pide múltiples productos, inclúyelos TODOS en el array "items".
6. Si el stock de un item es 0, NO lo incluyas y explícalo en "reason".
7. "deliveryAddress": copia textualmente lo que dijo el cliente. Si no hay dirección válida → null.
8. Si hay varios mensajes con dirección, usa el más reciente.

Responde ÚNICAMENTE con este JSON (sin markdown, sin texto adicional):
{
  "complete": boolean,
  "items": [
    {
      "itemType": "producto" | "servicio",
      "productId": "uuid o null",
      "serviceId": "uuid o null",
      "variantId": "uuid o null",
      "quantity": number,
      "description": "nombre legible del item para mostrar al cliente"
    }
  ],
  "deliveryAddress": "string o null",
  "notes": "string o null",
  "reason": "explicación de por qué complete es true o false"
}`;

      try {
        const extractResponse = await Promise.race([
          groq.chat.completions.create({
            model: 'llama-3.1-8b-instant',
            messages: [{ role: 'user', content: extractorPrompt }],
            temperature: 0,
            max_tokens: 800,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Extractor timeout')), GROQ_TIMEOUT_EXT_MS)
          ),
        ]) as any;

        const raw = extractResponse.choices[0]?.message?.content ?? '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { created: false };

        extracted = JSON.parse(jsonMatch[0]);
        this.logger.log(`Extracción: ${JSON.stringify(extracted)}`);

        // Cachear siempre que haya items aunque falten otros datos
        if (extracted.items?.length > 0) {
          this.pendingExtractions.set(conversationId, extracted);
          setTimeout(() => this.pendingExtractions.delete(conversationId), ORDER_GUARD_TTL_MS);
        }

      } catch (err: any) {
        this.logger.error(`Error en extractor: ${err.message}`);
        return { created: false };
      }
    }

    // ── Validación final ───────────────────────────────────────────────────────
    if (!extracted?.complete)           return { created: false };
    if (!extracted.items?.length)       return { created: false };
    if (!extracted.deliveryAddress)     return { created: false };

    if (this.orderInProgress.has(conversationId)) {
      this.logger.warn(`Orden ya en progreso para ${conversationId}`);
      return { created: false };
    }
    this.orderInProgress.add(conversationId);

    try {
      const orderItemsData: any[]    = [];
      const orderItemsSummary: string[] = [];
      let total = 0;

      for (const item of extracted.items) {
        if (item.itemType === 'servicio' && item.serviceId) {
          const service = services.find((s: any) => s.serviceId === item.serviceId);
          if (!service) { this.logger.warn(`Servicio no encontrado: ${item.serviceId}`); continue; }
          const unitPrice = service.price ? Number(service.price) : 0;
          const subtotal  = unitPrice * item.quantity;
          total += subtotal;
          orderItemsData.push({
            service: { connect: { serviceId: item.serviceId } },
            description: item.description ?? service.name,
            quantity: item.quantity,
            unitPrice,
          });
          orderItemsSummary.push(`• ${item.description ?? service.name} x${item.quantity} — $${subtotal.toLocaleString('es-CO')}`);

        } else if (item.productId) {
          const product = products.find((p: any) => p.productId === item.productId);
          if (!product) { this.logger.warn(`Producto no encontrado: ${item.productId}`); continue; }

          if (item.variantId) {
            const variant = product.variants?.find((v: any) => v.variantId === item.variantId);
            if (!variant) { this.logger.warn(`Variante no encontrada: ${item.variantId}`); continue; }
            if (variant.stock < item.quantity) { this.logger.warn(`Stock insuficiente variante ${variant.name}`); continue; }
            const unitPrice = Number(variant.salePrice);
            const subtotal  = unitPrice * item.quantity;
            total += subtotal;
            orderItemsData.push({
              product: { connect: { productId: item.productId } },
              description: item.description ?? `${product.name} - ${variant.name}`,
              quantity: item.quantity,
              unitPrice,
            });
            orderItemsSummary.push(`• ${item.description ?? `${product.name} - ${variant.name}`} x${item.quantity} — $${subtotal.toLocaleString('es-CO')}`);

          } else {
            if (product.stock < item.quantity) { this.logger.warn(`Stock insuficiente: ${product.name}`); continue; }
            const unitPrice = Number(product.salePrice);
            const subtotal  = unitPrice * item.quantity;
            total += subtotal;
            orderItemsData.push({
              product: { connect: { productId: item.productId } },
              description: item.description ?? product.name,
              quantity: item.quantity,
              unitPrice,
            });
            orderItemsSummary.push(`• ${item.description ?? product.name} x${item.quantity} — $${subtotal.toLocaleString('es-CO')}`);
          }
        }
      }

      if (orderItemsData.length === 0) {
        this.logger.warn(`Sin items válidos para crear la orden`);
        return { created: false };
      }

      const order = await this.prisma.order.create({
        data: {
          storeId,
          customerId: customer.customerId,
          status: 'pending',
          total,
          deliveryAddress: extracted.deliveryAddress,
          notes: [
            extracted.notes ? `Notas: ${extracted.notes}` : null,
            `Creado automáticamente por IA`,
          ].filter(Boolean).join(' | '),
          orderItems: { create: orderItemsData },
        },
      });

      await this.prisma.conversation.update({
        where: { conversationId },
        data: { status: 'pending_human' },
      });

      this.pendingExtractions.delete(conversationId);
      this.logger.log(`✅ Orden ${order.orderId} — ${orderItemsData.length} items — Total: $${total}`);

      const nombreCliente = customer.name ? `, ${customer.name}` : '';

      return {
        created: true,
        message:
          `¡Perfecto${nombreCliente}! 🎉 Tu pedido fue registrado exitosamente.\n\n` +
          `📦 *Resumen del pedido:*\n` +
          orderItemsSummary.join('\n') +
          `\n\n💰 *Total: $${total.toLocaleString('es-CO')}*\n` +
          `📍 *Dirección:* ${extracted.deliveryAddress}\n\n` +
          `Un asesor te contactará pronto para coordinar el pago y confirmar el envío. ¡Gracias por tu compra! 😊`,
      };

    } finally {
      this.orderInProgress.delete(conversationId);
    }
  }

  // ─── Construcción del system prompt ──────────────────────────────────────────

  private buildSystemPrompt(
    basePrompt: string,
    customer: any,
    orders: any[],
    products: any[],
    services: any[],
    fechaActual: string,
    horaActual: string,
    history: any[],
    latestMessage: string,
    addressAlreadyGiven: boolean,
  ): string {
    const sep = '\n===================================================\n';
    const nombreCliente = customer.name ?? null;

    const clienteSection = `CLIENTE:
- Nombre: ${nombreCliente ?? 'No registrado'}
- Ciudad: ${customer.city ?? 'No registrada'}
- ${nombreCliente
    ? `Llámalo ${nombreCliente} de forma natural (no en cada mensaje).`
    : `No sabes el nombre. No lo inventes.`}
- Adapta el tono al del cliente.
- NUNCA menciones datos de otros clientes.`;

    const clientMessages = [
      ...history.filter((m: any) => !m.isAiResponse).map((m: any) => m.content),
      latestMessage,
    ];
    const allClientText = clientMessages.join(' ').toLowerCase();

    const datosMencionados: string[] = [];
    [...products, ...services].forEach((item: any) => {
      if (allClientText.includes(item.name.toLowerCase())) {
        datosMencionados.push(`✅ Item mencionado: "${item.name}"`);
      }
    });
    if (addressAlreadyGiven) {
      datosMencionados.push('✅ Dirección de entrega: YA FUE PROPORCIONADA — NO LA VUELVAS A PEDIR BAJO NINGUNA CIRCUNSTANCIA');
    }
    if (/\b(una?|dos|tres|cuatro|cinco|\d+)\s*(unidad|unidades|)/i.test(allClientText)) {
      datosMencionados.push('✅ Cantidad: ya fue mencionada');
    }

    const datosSection = datosMencionados.length > 0
      ? `DATOS YA RECOPILADOS (NO LOS VUELVAS A PEDIR):\n${datosMencionados.join('\n')}`
      : `DATOS RECOPILADOS: Ninguno aún.`;

    const STATUS_LABELS: Record<string, string> = {
      pending: 'Pendiente', confirmed: 'Confirmado', preparing: 'En preparación',
      ready: 'Listo', delivered: 'Entregado', cancelled: 'Cancelado',
    };

    let ordenesSection: string;
    if (orders.length === 0) {
      ordenesSection = `PEDIDOS ANTERIORES: Ninguno.`;
    } else {
      const textoOrdenes = orders.map((o: any, i: number) => {
        const fecha = new Date(o.createdAt).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
        const items = o.orderItems.map((it: any) =>
          `    · ${it.product?.name ?? 'Item'} x${it.quantity} — $${it.unitPrice}`
        ).join('\n');
        return `  Pedido #${i + 1} (${fecha}) — ${STATUS_LABELS[o.status] ?? o.status} — $${o.total}\n${items}`;
      }).join('\n\n');
      ordenesSection = `PEDIDOS ANTERIORES:\n${textoOrdenes}\nREGLA: Solo muestra estos. Si pregunta por uno que no aparece, remite a asesor.`;
    }

    const hasItems = products.length > 0 || services.length > 0;
    let catalogoSection: string;
    if (!hasItems) {
      catalogoSection = `CATÁLOGO: Sin productos ni servicios registrados.`;
    } else {
      const productosTxt = products.length > 0
        ? products.map((p: any) => {
            const lines = [`  · ${p.name}`];
            if (p.description) lines.push(`    ${p.description}`);
            if (p.variants?.length > 0) {
              p.variants.forEach((v: any) => {
                const st = v.stock === 0 ? '⚠️ AGOTADO' : `${v.stock} disp.`;
                lines.push(`    - ${v.name}: $${v.salePrice} | ${st}`);
              });
            } else {
              const st = p.stock === 0 ? '⚠️ AGOTADO' : `${p.stock} disp.`;
              lines.push(`    Precio: $${p.salePrice} | ${st}`);
              if (p.hasShipping) lines.push(`    Incluye envío`);
            }
            return lines.join('\n');
          }).join('\n\n')
        : null;

      const serviciosTxt = services.length > 0
        ? services.map((s: any) => {
            const precioTxt = s.price ? `$${s.price}` : '💡 Precio variable (asesor lo confirma)';
            const lines = [`  · ${s.name} — ${precioTxt}`];
            if (s.description) lines.push(`    ${s.description}`);
            return lines.join('\n');
          }).join('\n\n')
        : null;

      const partes = [
        productosTxt ? `PRODUCTOS:\n${productosTxt}` : null,
        serviciosTxt ? `SERVICIOS:\n${serviciosTxt}` : null,
      ].filter(Boolean).join('\n\n');

      catalogoSection = `CATÁLOGO:\n${partes}
REGLAS:
- Habla SOLO de estos items.
- No inventes precios ni características.
- Si el stock es AGOTADO, avísalo y ofrece alternativa si hay.
- Para servicios con precio variable, di que un asesor confirmará el precio.`;
    }

    const flujoSection = `FLUJO DE TOMA DE ORDEN:

Para crear un pedido necesito EXACTAMENTE 3 cosas:
  a) Qué productos quiere y en qué cantidad (puede ser múltiples productos)
  b) Dirección de entrega completa (calle/carrera + número + barrio + ciudad)
  c) Confirmación explícita del cliente ("sí", "confirmo", "listo", etc.)

REGLAS ANTI-LOOP — MUY IMPORTANTE:
- Si un dato ya está en DATOS YA RECOPILADOS, NO lo vuelvas a pedir. NUNCA.
- Si la dirección ya fue proporcionada, pasa al siguiente paso.
- Si ya tienes (a) y (b), muestra el resumen con todos los productos y precios, y pide SOLO confirmación.
- Cuando el cliente confirme, el sistema crea la orden automáticamente y cierra el pedido.
- NO hagas preguntas innecesarias después de que el cliente confirme.

SOBRE ENVÍO Y PAGOS — MUY IMPORTANTE:
- NUNCA calcules ni menciones costos de envío. No tienes esa información.
- NUNCA des datos de cuentas bancarias, Nequi, Bancolombia ni métodos de pago.
- Si preguntan: "Un asesor te contactará con esos detalles."

COTIZACIÓN: Si el cliente pide cotización antes de confirmar, muéstrala con los precios del catálogo sin inventar costos adicionales.

PROHIBIDO absolutamente:
- Pedir datos que ya tienes.
- Calcular o mencionar costos de envío.
- Dar información de métodos de pago.
- Mencionar items fuera del catálogo.`;

    return [
      basePrompt, sep, clienteSection, sep, datosSection, sep,
      ordenesSection, sep, catalogoSection, sep, flujoSection, sep,
      `FECHA Y HORA: ${fechaActual}, ${horaActual} (Colombia).`,
    ].join('\n');
  }
}