import { Injectable, Logger } from '@nestjs/common';
import Groq from 'groq-sdk';
import { PrismaService } from '../prisma/prisma.service';

// ─── Constantes ───────────────────────────────────────────────────────────────

// TTL del caché de configuración y catálogo (no cambian entre mensajes)
const CONFIG_CACHE_TTL_MS = 60_000;       // 1 minuto
const CATALOG_CACHE_TTL_MS = 120_000;     // 2 minutos

// Timeout de llamadas a Groq
const GROQ_TIMEOUT_MAIN_MS = 30_000;
const GROQ_TIMEOUT_EXTRACTOR_MS = 15_000;

// Historial máximo a enviar al modelo principal
const MAX_HISTORY_MESSAGES = 20;

// TTL del guard anti-duplicado de orden y de extracción cacheada
const ORDER_GUARD_TTL_MS = 10 * 60 * 1000;

// Palabras clave que indican intención de compra — solo en estos casos
// se corre el extractor para ahorrar una llamada a Groq innecesaria.
const PURCHASE_INTENT_RE = /\b(quiero|deseo|pedir|pido|ordenar|comprar|llevar|encargar|confirmo?|dale|listo|sí|si\b|ok\b|pedido|orden|dirección|entrega|envío|cantidad|unidades?)\b/i;

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  // Cache de clientes Groq por apiKey
  private readonly groqClients = new Map<string, Groq>();

  // Cache de configuración IA por storeId (evita query por cada mensaje)
  private readonly configCache = new Map<string, CacheEntry<any>>();

  // Cache de catálogo por storeId (productos + servicios cambian poco)
  private readonly catalogCache = new Map<string, CacheEntry<{ products: any[]; services: any[] }>>();

  // Guard anti-duplicado de orden en curso por conversationId
  private readonly orderInProgress = new Set<string>();

  // Cache de extracción pendiente — evita re-extraer cuando el cliente confirma
  private readonly pendingExtractions = new Map<string, any>();

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
    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return null;
    }
    return entry.value;
  }

  private setCached<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    value: T,
    ttlMs: number,
  ): void {
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /**
   * Invalida el cache de catálogo de una tienda.
   * Llamar desde ProductsService/ServicesService cuando se modifica el catálogo.
   */
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
      // ── 1. Cargar config (con cache) ────────────────────────────────────────
      let config = this.getCached(this.configCache, storeId);
      if (!config) {
        config = await this.prisma.aIConfiguration.findUnique({ where: { storeId } });
        if (!config) {
          this.logger.warn(`No hay AIConfiguration para store: ${storeId}`);
          return null;
        }
        this.setCached(this.configCache, storeId, config, CONFIG_CACHE_TTL_MS);
      }

      // ── 2. Cargar catálogo (con cache) ──────────────────────────────────────
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

      // ── 3. Cargar conversación, órdenes e historial EN PARALELO ─────────────
      // Estas 3 queries no dependen entre sí — las corremos simultáneamente.
      const [conversationWithCustomer, orders, history] = await Promise.all([
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

      if (!conversationWithCustomer) {
        this.logger.warn(`Conversación ${conversationId} no pertenece a store ${storeId}`);
        return null;
      }
      const customer = conversationWithCustomer.customer;

      const groq = this.getGroqClient(config.groqApiKey);

      // ── 4. Extractor de orden (solo si hay intención de compra) ─────────────
      // Evita desperdiciar una llamada a Groq en mensajes que claramente
      // no son una compra (preguntas de precio, saludos, dudas, etc.).
      const hasCatalog = products.length > 0 || services.length > 0;
      const hasPurchaseIntent = PURCHASE_INTENT_RE.test(userMessage);
      const shouldTryOrder =
        hasCatalog &&
        history.length >= 3 &&
        (hasPurchaseIntent || this.pendingExtractions.has(conversationId)) &&
        !this.orderInProgress.has(conversationId);

      if (shouldTryOrder) {
        const orderResult = await this.tryExtractAndCreateOrder(
          groq, config.model, history, userMessage,
          products, services, customer, storeId, conversationId,
        );
        if (orderResult.created) {
          return orderResult.message!;
        }
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

      const enrichedSystemPrompt = this.buildSystemPrompt(
        config.systemPrompt, customer, orders, products, services,
        fechaActual, horaActual, history, userMessage,
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
        this.logger.warn(`Modelo ${config.model} falló, usando fallback: ${modelErr.message?.slice(0, 80)}`);
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

  // ─── Extracción y creación de orden ──────────────────────────────────────────

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

    const CONFIRMATION_RE = /\b(confirm|sí|si\b|ok\b|dale|listo|acepto|perfecto|procede|adelante|claro|exacto|sip|yep|yes)\b/i;
    const cached = this.pendingExtractions.get(conversationId);

    let extracted: any;

    if (cached && CONFIRMATION_RE.test(latestMessage.trim())) {
      this.logger.log(`Usando extracción cacheada para ${conversationId}`);
      extracted = cached;
      this.pendingExtractions.delete(conversationId);
    } else {
      const productLines = products.map((p: any) => {
        if (p.variants?.length > 0) {
          return p.variants.map((v: any) =>
            `- "${p.name} - ${v.name}" | tipo:producto | productId:${p.productId} | variantId:${v.variantId} | precio:${v.salePrice} | stock:${v.stock}`
          ).join('\n');
        }
        return `- "${p.name}" | tipo:producto | productId:${p.productId} | precio:${p.salePrice} | stock:${p.stock}`;
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

      const extractorPrompt = `Eres un extractor de datos de órdenes. Analiza la conversación y determina si el cliente YA CONFIRMÓ todos los datos para crear una orden.

CATÁLOGO:
${catalogSummary}

CONVERSACIÓN:
${conversationText}

DATOS REQUERIDOS:
1. productId o serviceId (según tipo)
2. variantId (solo si el producto tiene variantes, sino null)
3. quantity (entero positivo)
4. deliveryAddress (dirección completa — solo ciudad NO es suficiente)

REGLAS:
- complete:true SOLO si el cliente confirmó TODOS los datos en esta conversación.
- Si el stock es 0, complete:false.
- Si es un servicio con precio variable, quantity puede ser 1.
- Dirección debe tener calle/carrera/barrio + ciudad o similar.
- No extraigas datos de mensajes del asistente.
- Si solo preguntó por precio o métodos de pago, complete:false.
- Si el producto tiene variantes, DEBES incluir el variantId correcto.

Responde ÚNICAMENTE con este JSON (sin markdown):
{
  "complete": boolean,
  "itemType": "producto" | "servicio",
  "productId": "string o null",
  "serviceId": "string o null",
  "variantId": "string o null",
  "quantity": number,
  "deliveryAddress": "string o null",
  "notes": "string o null",
  "reason": "string"
}`;

      try {
        const extractResponse = await Promise.race([
          groq.chat.completions.create({
            model: 'llama-3.1-8b-instant',
            messages: [{ role: 'user', content: extractorPrompt }],
            temperature: 0,
            max_tokens: 350,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Extractor timeout')), GROQ_TIMEOUT_EXTRACTOR_MS)
          ),
        ]) as any;

        const raw = extractResponse.choices[0]?.message?.content ?? '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { created: false };

        extracted = JSON.parse(jsonMatch[0]);
        this.logger.log(`Extracción de orden: ${JSON.stringify(extracted)}`);

        if (extracted.complete && extracted.quantity && extracted.deliveryAddress) {
          this.pendingExtractions.set(conversationId, extracted);
          setTimeout(() => this.pendingExtractions.delete(conversationId), ORDER_GUARD_TTL_MS);
        }

      } catch (err: any) {
        this.orderInProgress.delete(conversationId);
        this.logger.error(`Error en extracción de orden: ${err.message}`);
        return { created: false };
      }
    }

    if (!extracted?.complete || !extracted.quantity || !extracted.deliveryAddress) {
      return { created: false };
    }

    if (this.orderInProgress.has(conversationId)) {
      this.logger.warn(`Orden ya en progreso para ${conversationId}`);
      return { created: false };
    }
    this.orderInProgress.add(conversationId);

    try {
      let unitPrice: number;
      let orderItemData: any;
      let itemName: string;

      if (extracted.itemType === 'servicio' && extracted.serviceId) {
        const service = services.find((s: any) => s.serviceId === extracted.serviceId);
        if (!service) return { created: false };
        unitPrice = service.price ? Number(service.price) : 0;
        itemName = service.name;
        orderItemData = {
          service: { connect: { serviceId: extracted.serviceId } },
          quantity: extracted.quantity,
          unitPrice,
        };
      } else {
        if (!extracted.productId) return { created: false };
        const product = products.find((p: any) => p.productId === extracted.productId);
        if (!product) return { created: false };

        if (extracted.variantId) {
          const variant = product.variants?.find((v: any) => v.variantId === extracted.variantId);
          if (!variant) return { created: false };
          if (variant.stock < extracted.quantity) {
            this.logger.warn(`Stock insuficiente: ${variant.stock} < ${extracted.quantity}`);
            return { created: false };
          }
          unitPrice = Number(variant.salePrice);
          itemName = `${product.name} - ${variant.name}`;
          orderItemData = {
            product: { connect: { productId: extracted.productId } },
            variant: { connect: { variantId: extracted.variantId } },
            quantity: extracted.quantity,
            unitPrice,
          };
        } else {
          if (product.stock < extracted.quantity) {
            this.logger.warn(`Stock insuficiente: ${product.stock} < ${extracted.quantity}`);
            return { created: false };
          }
          unitPrice = Number(product.salePrice);
          itemName = product.name;
          orderItemData = {
            product: { connect: { productId: extracted.productId } },
            quantity: extracted.quantity,
            unitPrice,
          };
        }
      }

      const total = unitPrice * extracted.quantity;

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
          orderItems: { create: [orderItemData] },
        },
      });

      await this.prisma.conversation.update({
        where: { conversationId },
        data: { status: 'pending_human' },
      });

      this.pendingExtractions.delete(conversationId);
      this.logger.log(`✅ Orden creada: ${order.orderId} | Total: $${total}`);

      const nombreCliente = customer.name ? `, ${customer.name}` : '';
      const precioTexto = unitPrice === 0
        ? 'Por confirmar (precio variable)'
        : `$${total.toLocaleString('es-CO')}`;

      return {
        created: true,
        message:
          `¡Perfecto${nombreCliente}! 🎉 Tu pedido fue registrado.\n\n` +
          `📦 *Resumen:*\n` +
          `• ${itemName}\n` +
          `• Cantidad: ${extracted.quantity}\n` +
          `• Total: ${precioTexto}\n` +
          `• Dirección: ${extracted.deliveryAddress}\n\n` +
          `Un asesor te contactará pronto para coordinar el pago y confirmar el envío. ¡Gracias! 😊`,
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
  ): string {
    const sep = '\n===================================================\n';

    const nombreCliente = customer.name ?? null;

    const clienteSection = `CLIENTE:
- Nombre: ${nombreCliente ?? 'No registrado'}
- Ciudad: ${customer.city ?? 'No registrada'}
- ${nombreCliente
    ? `Llámalo ${nombreCliente} de forma natural (no en cada mensaje).`
    : `No sabes el nombre. No lo inventes.`}
- Adapta el tono al del cliente: formal si escribe formal, cercano si es casual.
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
    if (/calle|carrera|avenida|cra|cl |av |#|barrio|dirección|entrega/.test(allClientText)) {
      datosMencionados.push('✅ Dirección: ya fue proporcionada');
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
- Habla SOLO de estos items. Si piden algo que no está, dilo y sugiere lo más cercano.
- No inventes precios ni características.
- Si el stock es AGOTADO, avísalo y ofrece alternativa si hay.
- Para servicios con precio variable, di que un asesor confirmará el precio.`;
    }

    const flujoSection = `FLUJO DE TOMA DE ORDEN:

1. Datos necesarios: a) item del catálogo  b) cantidad  c) dirección de entrega completa
2. Si ya tienes un dato (ver DATOS YA RECOPILADOS), NO lo pidas de nuevo.
3. Pide los datos faltantes DE UNO EN UNO.
4. Cuando tengas los 3, confirma el resumen y espera confirmación del cliente.
5. El sistema creará la orden automáticamente.

PAGOS — MUY IMPORTANTE:
- NUNCA des información de cuentas, nequi, bancolombia, ni métodos de pago.
- Si preguntan por pago: "Un asesor te contactará con los detalles del pago."

PROHIBIDO:
- Inventar reseñas, artículos o fuentes externas.
- Pedir datos ya proporcionados.
- Dar información de pago.
- Mencionar items fuera del catálogo.`;

    return [
      basePrompt, sep, clienteSection, sep, datosSection, sep,
      ordenesSection, sep, catalogoSection, sep, flujoSection, sep,
      `FECHA Y HORA: ${fechaActual}, ${horaActual} (Colombia).`,
    ].join('\n');
  }
}