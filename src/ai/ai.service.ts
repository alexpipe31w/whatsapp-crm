import { Injectable, Logger } from '@nestjs/common';
import Groq from 'groq-sdk';
import { PrismaService } from '../prisma/prisma.service';

// ─── Constantes ───────────────────────────────────────────────────────────────

const CONFIG_CACHE_TTL_MS  = 60_000;
const CATALOG_CACHE_TTL_MS = 120_000;
const GROQ_TIMEOUT_MAIN_MS = 30_000;
const GROQ_TIMEOUT_EXT_MS  = 20_000;
const ORDER_GUARD_TTL_MS   = 10 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 20;

// Intención de compra de producto
const PURCHASE_INTENT_RE = /\b(quiero|deseo|pedir|pido|ordenar|comprar|llevar|encargar|confirm|dale|listo|acepto|perfecto|procede|adelante|claro|exacto|sip|yep|yes|sí|si\b|ok\b|pedido|orden|dirección|entrega|envío|cantidad|unidades?)\b/i;

// Intención de agendar cita o visita
const APPOINTMENT_INTENT_RE = /\b(agendar|agenda|cita|visita|visita técnica|técnico|técnica|programar|reservar|reserva|turno|appointment|quiero una cita|necesito una visita|instalar|instalación|mantenimiento|corte|sesión|servicio)\b/i;

// El cliente confirma algo
const CONFIRMATION_RE = /\b(confirm|sí|si\b|ok\b|dale|listo|acepto|perfecto|procede|adelante|claro|exacto|sip|yep|yes)\b/i;

// Detecta dirección
const ADDRESS_RE = /\b(calle|carrera|cra|cl\b|av\b|avenida|barrio|#|\d{2,}[-–]\d+|diagonal|transversal|manzana|casa|apto|apartamento)\b/i;

// ─── Etiquetas legibles por tipo de precio ────────────────────────────────────

const PRICE_TYPE_LABELS: Record<string, string> = {
  FIXED:    'Precio fijo',
  PER_HOUR: 'por hora',
  PER_DAY:  'por día',
  PER_UNIT: 'por unidad',
  VARIABLE: 'Precio variable — cotización',
};

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface ExtractedItem {
  itemType: 'producto' | 'servicio';
  productId: string | null;
  serviceId: string | null;
  variantId: string | null;          // variante de producto
  serviceVariantId: string | null;   // variante de servicio
  quantity: number;
  description?: string | null;
}

interface ExtractionResult {
  complete: boolean;
  items: ExtractedItem[];
  deliveryAddress: string | null;
  notes: string | null;
  reason: string;
  customerName: string | null;
  customerCedula: string | null;
}

interface AppointmentExtractionResult {
  complete: boolean;
  // Vínculo al catálogo de servicios (opcional)
  serviceId: string | null;
  serviceVariantId: string | null;
  // Clasificación libre cuando no hay servicio vinculado
  type: string;                      // texto libre: "cita", "visita_tecnica", "corte", etc.
  scheduledDate: string | null;      // "YYYY-MM-DD"
  scheduledTime: string | null;      // "HH:MM"
  durationMinutes: number | null;    // duración estimada en minutos
  agreedPrice: number | null;        // precio acordado snapshot
  description: string | null;
  address: string | null;
  notes: string | null;
  reason: string;
  customerName: string | null;
  customerCedula: string | null;
}

/**
 * Estructura del campo `settings` en AIConfiguration.
 * Cada store configura sus propios valores. Todo es opcional.
 */
interface StoreSettings {
  paymentMethods?: Array<{ label: string; value: string }>;
  paymentNote?: string;
  orderClosingMessage?: string;
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  private readonly groqClients           = new Map<string, Groq>();
  private readonly configCache           = new Map<string, CacheEntry<any>>();
  private readonly catalogCache          = new Map<string, CacheEntry<{ products: any[]; services: any[] }>>();
  private readonly orderInProgress       = new Set<string>();
  private readonly pendingExtractions    = new Map<string, ExtractionResult>();
  private readonly appointmentInProgress = new Set<string>();
  private readonly pendingAppointments   = new Map<string, AppointmentExtractionResult>();

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

  private setCached<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    value: T,
    ttlMs: number,
  ): void {
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  invalidateCatalogCache(storeId: string): void {
    this.catalogCache.delete(storeId);
  }

  // ─── Settings helpers ─────────────────────────────────────────────────────────

  private parseSettings(raw: any): StoreSettings {
    if (!raw) return {};
    try {
      if (typeof raw === 'string') return JSON.parse(raw);
      if (typeof raw === 'object') return raw as StoreSettings;
    } catch {
      this.logger.warn('No se pudo parsear AIConfiguration.settings');
    }
    return {};
  }

  private buildPaymentBlock(settings: StoreSettings): string | null {
    const methods = settings.paymentMethods;
    if (!methods?.length) return null;
    const lines = methods.map(m => `• *${m.label}:* ${m.value}`).join('\n');
    const note   = settings.paymentNote
      ? `\n\n${settings.paymentNote}`
      : '\n\nCuando realices el pago, compártenos el comprobante por aquí.';
    return `💳 *Información de pago:*\n${lines}${note}`;
  }

  // ─── Helpers de precio para servicios ────────────────────────────────────────

  /**
   * Calcula el precio unitario de un servicio para una orden según su priceType.
   * Para servicios VARIABLE retorna 0 (precio a confirmar por el admin).
   */
  private resolveServicePrice(service: any, variant?: any): number {
    if (variant?.priceOverride != null) return Number(variant.priceOverride);

    const base = service.basePrice ? Number(service.basePrice) : 0;

    if (variant?.priceModifier != null) {
      return Number((base * (1 + Number(variant.priceModifier) / 100)).toFixed(2));
    }
    return base;
  }

  /**
   * Construye la etiqueta de precio legible para un servicio.
   */
  private buildServicePriceLabel(service: any): string {
    if (service.priceType === 'VARIABLE') {
      const rango = service.minPrice && service.maxPrice
        ? ` (rango: $${Number(service.minPrice).toLocaleString('es-CO')} – $${Number(service.maxPrice).toLocaleString('es-CO')})`
        : '';
      return `Cotización${rango}`;
    }
    if (!service.basePrice) return 'Precio a confirmar';
    const unidad = service.unitLabel ? `/${service.unitLabel}` : '';
    const label  = PRICE_TYPE_LABELS[service.priceType] ?? '';
    return `$${Number(service.basePrice).toLocaleString('es-CO')}${unidad}${label !== 'Precio fijo' ? ` (${label})` : ''}`;
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

      // ── 2. Catálogo (cacheado) — incluye variantes de servicios ────────────
      let catalog = this.getCached(this.catalogCache, storeId);
      if (!catalog) {
        const [products, services] = await Promise.all([
          this.prisma.product.findMany({
            where:   { storeId, isActive: true },
            include: { variants: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } },
            orderBy: { name: 'asc' },
          }),
          this.prisma.service.findMany({
            where:   { storeId, isActive: true },
            include: { variants: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } },
            orderBy: { name: 'asc' },
          }),
        ]);
        catalog = { products, services };
        this.setCached(this.catalogCache, storeId, catalog, CATALOG_CACHE_TTL_MS);
      }
      const { products, services } = catalog;

      // ── 3. Conversación + órdenes + citas + historial EN PARALELO ───────────
      const [conversationRow, orders, appointments, history] = await Promise.all([
        this.prisma.conversation.findFirst({
          where:   { conversationId, storeId },
          include: { customer: true },
        }),
        this.prisma.order.findMany({
          where: {
            storeId,
            customer: { conversations: { some: { conversationId } } },
          },
          include: {
            orderItems: {
              include: { product: { select: { name: true, salePrice: true } } },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 5,
        }),
        this.prisma.appointment.findMany({
          where: {
            storeId,
            customer: { conversations: { some: { conversationId } } },
          },
          include: {
            service: { select: { name: true } },
            serviceVariant: { select: { name: true } },
          },
          orderBy: { scheduledAt: 'asc' },
          take: 5,
        }),
        this.prisma.message.findMany({
          where:   { conversationId },
          orderBy: { createdAt: 'asc' },
          take:    MAX_HISTORY_MESSAGES,
        }),
      ]);

      if (!conversationRow) {
        this.logger.warn(`Conversación ${conversationId} no pertenece a store ${storeId}`);
        return null;
      }

      const customer = conversationRow.customer;
      const groq     = this.getGroqClient(config.groqApiKey);
      const settings = this.parseSettings(config.settings);

      // ── 4. Detección de intención ────────────────────────────────────────────
      const hasCatalog           = products.length > 0 || services.length > 0;
      const hasPurchaseIntent    = PURCHASE_INTENT_RE.test(userMessage);
      const hasAppointmentIntent = APPOINTMENT_INTENT_RE.test(userMessage);
      const hasPendingOrder      = this.pendingExtractions.has(conversationId);
      const hasPendingAppt       = this.pendingAppointments.has(conversationId);

      // ── 4a. Flujo de agendamiento ────────────────────────────────────────────
      if (
        (hasAppointmentIntent || hasPendingAppt) &&
        !this.appointmentInProgress.has(conversationId)
      ) {
        const apptResult = await this.tryExtractAndCreateAppointment(
          groq, config.model, history, userMessage,
          customer, storeId, conversationId, services,
        );
        if (apptResult.created) return apptResult.message!;
      }

      // ── 4b. Flujo de orden de productos/servicios ────────────────────────────
      const shouldTryOrder =
        hasCatalog &&
        history.length >= 2 &&
        (hasPurchaseIntent || hasPendingOrder) &&
        !this.orderInProgress.has(conversationId);

      if (shouldTryOrder) {
        const orderResult = await this.tryExtractAndCreateOrder(
          groq, config.model, history, userMessage,
          products, services, customer, storeId, conversationId, settings,
        );
        if (orderResult.created) return orderResult.message!;
      }

      // ── 5. Respuesta principal de la IA ──────────────────────────────────────
      const now = new Date();
      const fechaActual = now.toLocaleDateString('es-CO', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        timeZone: 'America/Bogota',
      });
      const horaActual = now.toLocaleTimeString('es-CO', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
      });

      const allClientText = [
        ...history.filter((m: any) => !m.isAiResponse).map((m: any) => m.content),
        userMessage,
      ].join(' ');
      const addressAlreadyGiven = ADDRESS_RE.test(allClientText);

      const enrichedSystemPrompt = this.buildSystemPrompt(
        config.systemPrompt, customer, orders, appointments,
        products, services, fechaActual, horaActual,
        history, userMessage, addressAlreadyGiven, settings,
      );

      const messages: any[] = [
        { role: 'system', content: enrichedSystemPrompt },
        ...history.map((m: any) => ({
          role:    m.isAiResponse ? 'assistant' : 'user',
          content: m.content.trim(),
        })),
        { role: 'user', content: userMessage },
      ];

      let response: any;
      try {
        response = await Promise.race([
          groq.chat.completions.create({
            model:       config.model,
            messages,
            temperature: Number(config.temperature),
            max_tokens:  config.maxTokens,
          } as any),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Groq timeout')), GROQ_TIMEOUT_MAIN_MS)
          ),
        ]) as any;
      } catch (modelErr: any) {
        this.logger.warn(`Modelo ${config.model} falló, fallback: ${modelErr.message?.slice(0, 80)}`);
        response = await groq.chat.completions.create({
          model:       'llama-3.3-70b-versatile',
          messages,
          temperature: Number(config.temperature),
          max_tokens:  config.maxTokens,
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
    settings: StoreSettings,
  ): Promise<{ created: boolean; message?: string }> {

    const cached           = this.pendingExtractions.get(conversationId);
    let extracted: ExtractionResult;
    const needsCustomerData = !customer.name || !customer.cedula;

    // ── Caso 1: extracción completa cacheada + cliente confirma ───────────────
    if (
      cached?.complete &&
      cached.deliveryAddress &&
      (!needsCustomerData || (cached.customerName && cached.customerCedula)) &&
      CONFIRMATION_RE.test(latestMessage.trim())
    ) {
      this.logger.log(`Usando extracción completa cacheada para ${conversationId}`);
      extracted = cached;
      this.pendingExtractions.delete(conversationId);

    // ── Caso 2: había items pero faltaba dirección, y ahora llega ────────────
    } else if (cached?.items?.length && !cached.deliveryAddress && ADDRESS_RE.test(latestMessage)) {
      this.logger.log(`Completando extracción con dirección para ${conversationId}`);
      extracted = { ...cached, deliveryAddress: latestMessage.trim(), complete: true };
      this.pendingExtractions.delete(conversationId);

    // ── Caso 3: correr el extractor ───────────────────────────────────────────
    } else {
      const productLines = products.flatMap((p: any) => {
        if (p.variants?.length > 0) {
          return p.variants.map((v: any) =>
            `- "${p.name} - ${v.name}" | tipo:producto | productId:${p.productId} | variantId:${v.variantId} | serviceVariantId:null | precio:${v.salePrice} | stock:${v.stock}`
          );
        }
        return [`- "${p.name}" | tipo:producto | productId:${p.productId} | variantId:null | serviceVariantId:null | precio:${p.salePrice} | stock:${p.stock}`];
      });

      const serviceLines = services.flatMap((s: any) => {
        const precioBase = this.buildServicePriceLabel(s);
        if (s.variants?.length > 0) {
          return s.variants.map((v: any) => {
            const precio = v.priceOverride
              ? `$${Number(v.priceOverride).toLocaleString('es-CO')}`
              : precioBase;
            return `- "${s.name} - ${v.name}" | tipo:servicio | serviceId:${s.serviceId} | variantId:null | serviceVariantId:${v.variantId} | precio:${precio}`;
          });
        }
        return [`- "${s.name}" | tipo:servicio | serviceId:${s.serviceId} | variantId:null | serviceVariantId:null | precio:${precioBase}`];
      });

      const catalogSummary = [...productLines, ...serviceLines].join('\n');

      const conversationText = [
        ...history.map((m: any) =>
          `${m.isAiResponse ? 'Asistente' : 'Cliente'}: ${m.content.trim()}`
        ),
        `Cliente: ${latestMessage}`,
      ].join('\n');

      const customerDataInstruction = needsCustomerData
        ? `DATOS DEL CLIENTE REQUERIDOS:
El cliente aún no tiene nombre o cédula registrados. Extráelos si fueron mencionados.
Si no aparecen → null. La orden NO puede ser "complete":true si faltan nombre o cédula.`
        : `DATOS DEL CLIENTE: Ya registrados. No es necesario extraerlos.`;

      const extractorPrompt = `Eres un extractor de datos de órdenes de compra. Tu única tarea es leer la conversación y extraer los datos del pedido en JSON.

CATÁLOGO DISPONIBLE (usa EXACTAMENTE estos IDs):
${catalogSummary}

CONVERSACIÓN:
${conversationText}

${customerDataInstruction}

REGLAS ESTRICTAS:
1. "complete":true SOLO si se cumplen TODAS las condiciones simultáneamente:
   a) Al menos un producto/servicio del catálogo con cantidad
   b) Dirección con calle, carrera, barrio o similar (solo ciudad NO es suficiente)
   c) Confirmación explícita del cliente (sí, confirmo, listo, dale, ok, etc.)
   d) Si se requieren datos del cliente: nombre Y cédula presentes
2. Si falta CUALQUIER condición → "complete":false.
3. Para productos CON variantes: variantId es OBLIGATORIO, serviceVariantId debe ser null.
4. Para servicios CON variantes: serviceVariantId es OBLIGATORIO, variantId debe ser null.
5. Para productos/servicios SIN variantes: variantId y serviceVariantId deben ser null.
6. Si el stock de un item es 0, NO lo incluyas y explícalo en "reason".
7. "deliveryAddress": copia textualmente lo que dijo el cliente. Sin dirección válida → null.

Responde ÚNICAMENTE con este JSON (sin markdown, sin texto adicional):
{
  "complete": boolean,
  "items": [
    {
      "itemType": "producto" | "servicio",
      "productId": "uuid o null",
      "serviceId": "uuid o null",
      "variantId": "uuid o null",
      "serviceVariantId": "uuid o null",
      "quantity": number,
      "description": "nombre legible del item"
    }
  ],
  "deliveryAddress": "string o null",
  "notes": "string o null",
  "reason": "explicación breve",
  "customerName": "nombre completo del cliente o null",
  "customerCedula": "número de cédula o null"
}`;

      try {
        const extractResponse = await Promise.race([
          groq.chat.completions.create({
            model:      'llama-3.1-8b-instant',
            messages:   [{ role: 'user', content: extractorPrompt }],
            temperature: 0,
            max_tokens:  900,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Extractor timeout')), GROQ_TIMEOUT_EXT_MS)
          ),
        ]) as any;

        const raw       = extractResponse.choices[0]?.message?.content ?? '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { created: false };

        extracted = JSON.parse(jsonMatch[0]);
        this.logger.log(`Extracción orden: ${JSON.stringify(extracted)}`);

        if (extracted.items?.length > 0) {
          this.pendingExtractions.set(conversationId, extracted);
          setTimeout(() => this.pendingExtractions.delete(conversationId), ORDER_GUARD_TTL_MS);
        }

      } catch (err: any) {
        this.logger.error(`Error en extractor orden: ${err.message}`);
        return { created: false };
      }
    }

    // ── Validación final ───────────────────────────────────────────────────────
    if (!extracted?.complete)       return { created: false };
    if (!extracted.items?.length)   return { created: false };
    if (!extracted.deliveryAddress) return { created: false };
    if (needsCustomerData && (!extracted.customerName || !extracted.customerCedula)) {
      return { created: false };
    }
    if (this.orderInProgress.has(conversationId)) {
      this.logger.warn(`Orden ya en progreso para ${conversationId}`);
      return { created: false };
    }

    this.orderInProgress.add(conversationId);

    try {
      if (needsCustomerData && extracted.customerName && extracted.customerCedula) {
        await this.prisma.customer.update({
          where: { customerId: customer.customerId },
          data: {
            name:   extracted.customerName.replace(/\b\w/g, l => l.toUpperCase()),
            cedula: extracted.customerCedula,
          },
        });
        this.logger.log(`✅ Cliente actualizado: ${extracted.customerName} — CC ${extracted.customerCedula}`);
      }

      const orderItemsData: any[]       = [];
      const orderItemsSummary: string[] = [];
      let total = 0;

      for (const item of extracted.items) {
        if (item.itemType === 'servicio' && item.serviceId) {
          const catalogData = this.getCached(this.catalogCache, storeId);
          const service     = catalogData?.services?.find((s: any) => s.serviceId === item.serviceId);
          if (!service) { this.logger.warn(`Servicio no encontrado: ${item.serviceId}`); continue; }

          const variant   = item.serviceVariantId
            ? service.variants?.find((v: any) => v.variantId === item.serviceVariantId)
            : null;
          const unitPrice = this.resolveServicePrice(service, variant);
          const subtotal  = unitPrice * item.quantity;
          total += subtotal;

          orderItemsData.push({
            service:        { connect: { serviceId: item.serviceId } },
            ...(item.serviceVariantId && {
              serviceVariant: { connect: { variantId: item.serviceVariantId } },
            }),
            description: item.description ?? (variant ? `${service.name} - ${variant.name}` : service.name),
            quantity:    item.quantity,
            unitPrice,
          });
          orderItemsSummary.push(
            `• ${item.description ?? service.name}${variant ? ` - ${variant.name}` : ''} x${item.quantity}` +
            (unitPrice > 0 ? ` — $${subtotal.toLocaleString('es-CO')}` : ' — Precio a confirmar'),
          );

        } else if (item.productId) {
          const catalogData = this.getCached(this.catalogCache, storeId);
          const product     = catalogData?.products?.find((p: any) => p.productId === item.productId);
          if (!product) { this.logger.warn(`Producto no encontrado: ${item.productId}`); continue; }

          if (item.variantId) {
            const variant = product.variants?.find((v: any) => v.variantId === item.variantId);
            if (!variant)                     { this.logger.warn(`Variante no encontrada: ${item.variantId}`); continue; }
            if (variant.stock < item.quantity) { this.logger.warn(`Stock insuficiente variante ${variant.name}`); continue; }
            const unitPrice = Number(variant.salePrice);
            const subtotal  = unitPrice * item.quantity;
            total += subtotal;
            orderItemsData.push({
              product: { connect: { productId: item.productId } },
              variant: { connect: { variantId: item.variantId } },
              description: item.description ?? `${product.name} - ${variant.name}`,
              quantity:    item.quantity,
              unitPrice,
            });
            orderItemsSummary.push(`• ${item.description ?? `${product.name} - ${variant.name}`} x${item.quantity} — $${subtotal.toLocaleString('es-CO')}`);
          } else {
            if (product.stock < item.quantity) { this.logger.warn(`Stock insuficiente: ${product.name}`); continue; }
            const unitPrice = Number(product.salePrice);
            const subtotal  = unitPrice * item.quantity;
            total += subtotal;
            orderItemsData.push({
              product:     { connect: { productId: item.productId } },
              description: item.description ?? product.name,
              quantity:    item.quantity,
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
          customerId:      customer.customerId,
          status:          'pending',
          total,
          deliveryAddress: extracted.deliveryAddress,
          notes: [
            extracted.notes ? `Notas: ${extracted.notes}` : null,
            'Creado automáticamente por IA',
          ].filter(Boolean).join(' | '),
          orderItems: { create: orderItemsData },
        },
      });

      await this.prisma.conversation.update({
        where: { conversationId },
        data:  { status: 'pending_human' },
      });

      this.pendingExtractions.delete(conversationId);
      this.logger.log(`✅ Orden ${order.orderId} — ${orderItemsData.length} items — Total: $${total}`);

      const nombreCliente = extracted.customerName
        ? `, ${extracted.customerName.split(' ')[0]}`
        : customer.name ? `, ${customer.name}` : '';

      const paymentBlock   = this.buildPaymentBlock(settings);
      const paymentSection = paymentBlock
        ? `\n\n${paymentBlock}`
        : `\n\nUn asesor te contactará pronto para coordinar el pago y confirmar el envío.`;

      const closingMessage = settings.orderClosingMessage ?? '';

      const confirmationMessage =
        `¡Pedido registrado${nombreCliente}! 🎉\n\n` +
        `📦 *Resumen:*\n` +
        orderItemsSummary.join('\n') +
        `\n\n💰 *Total: $${total.toLocaleString('es-CO')}*\n` +
        `📍 *Dirección de entrega:* ${extracted.deliveryAddress}` +
        paymentSection +
        (closingMessage ? `\n\n${closingMessage}` : '');

      return { created: true, message: confirmationMessage };

    } finally {
      this.orderInProgress.delete(conversationId);
    }
  }

  // ─── Extracción y creación de cita/agendamiento ───────────────────────────────

  private async tryExtractAndCreateAppointment(
    groq: Groq,
    model: string,
    history: any[],
    latestMessage: string,
    customer: any,
    storeId: string,
    conversationId: string,
    services: any[],
  ): Promise<{ created: boolean; message?: string }> {

    const cached           = this.pendingAppointments.get(conversationId);
    let extracted: AppointmentExtractionResult;
    const needsCustomerData = !customer.name || !customer.cedula;

    // ── Caso 1: extracción completa cacheada + cliente confirma ───────────────
    if (
      cached?.complete &&
      (!needsCustomerData || (cached.customerName && cached.customerCedula)) &&
      CONFIRMATION_RE.test(latestMessage.trim())
    ) {
      this.logger.log(`Usando cita cacheada para ${conversationId}`);
      extracted = cached;
      this.pendingAppointments.delete(conversationId);

    // ── Caso 2: correr el extractor ───────────────────────────────────────────
    } else {
      const conversationText = [
        ...history.map((m: any) =>
          `${m.isAiResponse ? 'Asistente' : 'Cliente'}: ${m.content.trim()}`
        ),
        `Cliente: ${latestMessage}`,
      ].join('\n');

      const customerDataInstruction = needsCustomerData
        ? `DATOS DEL CLIENTE REQUERIDOS:
El cliente no tiene nombre o cédula. Extráelos si están en la conversación.
La cita NO puede ser "complete":true si faltan nombre o cédula.`
        : `DATOS DEL CLIENTE: Ya registrados. No es necesario extraerlos.`;

      // Catálogo de servicios para que el extractor vincule serviceId
      const servicesCatalog = services.length > 0
        ? `CATÁLOGO DE SERVICIOS DISPONIBLES (usa EXACTAMENTE estos IDs si el cliente menciona uno):
${services.flatMap((s: any) => {
  const precio = this.buildServicePriceLabel(s);
  const dur    = s.estimatedMinutes
    ? ` | duración: ${Math.floor(s.estimatedMinutes / 60)}h${s.estimatedMinutes % 60 > 0 ? ` ${s.estimatedMinutes % 60}min` : ''}`
    : '';
  if (s.variants?.length > 0) {
    return s.variants.map((v: any) => {
      const precioV = v.priceOverride
        ? `$${Number(v.priceOverride).toLocaleString('es-CO')}`
        : precio;
      const durV = v.estimatedMinutes
        ? ` | duración: ${Math.floor(v.estimatedMinutes / 60)}h${v.estimatedMinutes % 60 > 0 ? ` ${v.estimatedMinutes % 60}min` : ''}`
        : dur;
      return `- "${s.name} - ${v.name}" | serviceId:${s.serviceId} | serviceVariantId:${v.variantId} | precio:${precioV}${durV}`;
    });
  }
  return [`- "${s.name}" | serviceId:${s.serviceId} | serviceVariantId:null | precio:${precio}${dur}`];
}).join('\n')}`
        : `CATÁLOGO DE SERVICIOS: No hay servicios registrados.`;

      const now      = new Date();
      const fechaHoy = now.toISOString().split('T')[0];

      const appointmentPrompt = `Eres un extractor de datos para agendamiento de citas. Lee la conversación y extrae los datos en JSON.

FECHA ACTUAL: ${fechaHoy} (Colombia, zona horaria America/Bogota)

${servicesCatalog}

CONVERSACIÓN:
${conversationText}

${customerDataInstruction}

REGLAS ESTRICTAS:
1. "complete":true SOLO si se cumplen TODAS las condiciones:
   a) Fecha específica (día y mes como mínimo)
   b) Hora específica
   c) Descripción de qué necesita el cliente
   d) Confirmación explícita del cliente (sí, confirmo, listo, dale, ok, etc.)
   e) Si se requieren datos del cliente: nombre Y cédula presentes
2. Si falta CUALQUIER condición → "complete":false
3. "scheduledDate": formato "YYYY-MM-DD". Si dicen "mañana" calcula desde hoy (${fechaHoy}).
4. "scheduledTime": formato "HH:MM" en 24h. "2pm" → "14:00", "10am" → "10:00"
5. "address": dirección si es visita a domicilio. null si es en el local.
6. "serviceId" y "serviceVariantId": si el cliente menciona un servicio del catálogo, usa sus IDs exactos. null si no coincide.
7. "agreedPrice": precio acordado si fue mencionado explícitamente. null si no.
8. "durationMinutes": duración si fue mencionada o si se vincula un servicio con duración conocida. null si no.
9. "type": texto libre que describe la cita. Usa el nombre del servicio si hay uno vinculado, o describe libremente (ej: "visita_tecnica", "corte de cabello", "consulta", "instalación").

Responde ÚNICAMENTE con este JSON (sin markdown, sin texto adicional):
{
  "complete": boolean,
  "serviceId": "uuid o null",
  "serviceVariantId": "uuid o null",
  "type": "descripción del tipo de cita",
  "scheduledDate": "YYYY-MM-DD o null",
  "scheduledTime": "HH:MM o null",
  "durationMinutes": number | null,
  "agreedPrice": number | null,
  "description": "descripción de qué se va a hacer o null",
  "address": "dirección si aplica o null",
  "notes": "notas adicionales o null",
  "reason": "por qué complete es true o false",
  "customerName": "nombre completo o null",
  "customerCedula": "número de cédula o null"
}`;

      try {
        const extractResponse = await Promise.race([
          groq.chat.completions.create({
            model:       'llama-3.1-8b-instant',
            messages:    [{ role: 'user', content: appointmentPrompt }],
            temperature: 0,
            max_tokens:  700,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Appointment extractor timeout')), GROQ_TIMEOUT_EXT_MS)
          ),
        ]) as any;

        const raw       = extractResponse.choices[0]?.message?.content ?? '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { created: false };

        extracted = JSON.parse(jsonMatch[0]);
        this.logger.log(`Extracción cita: ${JSON.stringify(extracted)}`);

        if (extracted.scheduledDate || extracted.description || extracted.serviceId) {
          this.pendingAppointments.set(conversationId, extracted);
          setTimeout(() => this.pendingAppointments.delete(conversationId), ORDER_GUARD_TTL_MS);
        }

      } catch (err: any) {
        this.logger.error(`Error en extractor cita: ${err.message}`);
        return { created: false };
      }
    }

    // ── Validación final ───────────────────────────────────────────────────────
    if (!extracted?.complete)     return { created: false };
    if (!extracted.scheduledDate) return { created: false };
    if (!extracted.scheduledTime) return { created: false };
    if (needsCustomerData && (!extracted.customerName || !extracted.customerCedula)) {
      return { created: false };
    }
    if (this.appointmentInProgress.has(conversationId)) {
      this.logger.warn(`Cita ya en progreso para ${conversationId}`);
      return { created: false };
    }

    this.appointmentInProgress.add(conversationId);

    try {
      if (needsCustomerData && extracted.customerName && extracted.customerCedula) {
        await this.prisma.customer.update({
          where: { customerId: customer.customerId },
          data: {
            name:   extracted.customerName.replace(/\b\w/g, l => l.toUpperCase()),
            cedula: extracted.customerCedula,
          },
        });
      }

      const scheduledAt = new Date(`${extracted.scheduledDate}T${extracted.scheduledTime}:00-05:00`);
      if (isNaN(scheduledAt.getTime())) {
        this.logger.warn(`Fecha inválida: ${extracted.scheduledDate}T${extracted.scheduledTime}`);
        return { created: false };
      }

      // Calcular endsAt si tenemos duración
      const durationMinutes = extracted.durationMinutes ?? null;
      const endsAt = durationMinutes
        ? new Date(scheduledAt.getTime() + durationMinutes * 60_000)
        : null;

      // Crear cita + timeline en una transacción
      const appointment = await this.prisma.$transaction(async (tx) => {
        const appt = await tx.appointment.create({
          data: {
            storeId,
            customerId:       customer.customerId,
            serviceId:        extracted.serviceId        ?? null,
            serviceVariantId: extracted.serviceVariantId ?? null,
            type:             extracted.type             ?? 'cita',
            status:           'PENDING',
            priority:         'NORMAL',
            source:           'AI',
            scheduledAt,
            endsAt,
            durationMinutes,
            description:      extracted.description ?? null,
            address:          extracted.address     ?? null,
            notes:            extracted.notes       ?? null,
            agreedPrice:      extracted.agreedPrice  ?? null,
          },
        });

        // Entrada inicial en el timeline
        await tx.appointmentTimeline.create({
          data: {
            appointmentId: appt.appointmentId,
            action:        'CREATED',
            newStatus:     'PENDING',
            note:          'Cita creada automáticamente por el asistente de WhatsApp',
            isPublic:      true,
            performedById: null,
          },
        });

        return appt;
      });

      await this.prisma.conversation.update({
        where: { conversationId },
        data:  { status: 'pending_human' },
      });

      this.pendingAppointments.delete(conversationId);
      this.logger.log(`✅ Cita ${appointment.appointmentId} — ${extracted.scheduledDate} ${extracted.scheduledTime}${extracted.serviceId ? ` — servicio: ${extracted.serviceId}` : ''}`);

      const nombreCliente = extracted.customerName
        ? `, ${extracted.customerName.split(' ')[0]}`
        : customer.name ? `, ${customer.name}` : '';

      const fechaFormateada = scheduledAt.toLocaleDateString('es-CO', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        timeZone: 'America/Bogota',
      });
      const horaFormateada = scheduledAt.toLocaleTimeString('es-CO', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
      });

      const duracionLine = durationMinutes
        ? `\n⏱ *Duración estimada:* ${Math.floor(durationMinutes / 60)}h${durationMinutes % 60 > 0 ? ` ${durationMinutes % 60}min` : ''}`
        : '';

      const precioLine = extracted.agreedPrice
        ? `\n💰 *Precio acordado:* $${Number(extracted.agreedPrice).toLocaleString('es-CO')}`
        : '';

      const addressLine = extracted.address
        ? `\n📍 *Dirección:* ${extracted.address}`
        : '';

      return {
        created: true,
        message:
          `¡Cita agendada${nombreCliente}! ✅\n\n` +
          `📆 *Fecha:* ${fechaFormateada}\n` +
          `🕐 *Hora:* ${horaFormateada}` +
          duracionLine +
          precioLine +
          addressLine +
          (extracted.description ? `\n📝 *Descripción:* ${extracted.description}` : '') +
          `\n\nUn asesor confirmará tu cita pronto. ¡Gracias! 😊`,
      };

    } finally {
      this.appointmentInProgress.delete(conversationId);
    }
  }

  // ─── Construcción del system prompt ──────────────────────────────────────────

  private buildSystemPrompt(
    basePrompt: string,
    customer: any,
    orders: any[],
    appointments: any[],
    products: any[],
    services: any[],
    fechaActual: string,
    horaActual: string,
    history: any[],
    latestMessage: string,
    addressAlreadyGiven: boolean,
    settings: StoreSettings,
  ): string {
    const sep           = '\n===================================================\n';
    const nombreCliente = customer.name ?? null;

    // ── Cliente ───────────────────────────────────────────────────────────────
    const clienteSection = `CLIENTE:
- Nombre: ${nombreCliente ?? 'No registrado aún'}
- Cédula: ${customer.cedula ?? 'No registrada aún'}
- Ciudad: ${customer.city ?? 'No registrada'}
- ${nombreCliente
    ? `Llámalo ${nombreCliente} de forma natural (no en cada mensaje).`
    : `No sabes el nombre. No lo inventes. Lo pedirás cuando generes una orden o cita.`}
- NUNCA menciones datos de otros clientes.`;

    // ── Datos ya recopilados ──────────────────────────────────────────────────
    const clientMessages = [
      ...history.filter((m: any) => !m.isAiResponse).map((m: any) => m.content),
      latestMessage,
    ];
    const allClientText   = clientMessages.join(' ').toLowerCase();
    const datosMencionados: string[] = [];

    [...products, ...services].forEach((item: any) => {
      if (allClientText.includes(item.name.toLowerCase())) {
        datosMencionados.push(`✅ Item mencionado: "${item.name}"`);
      }
    });
    if (addressAlreadyGiven) {
      datosMencionados.push('✅ Dirección: YA FUE DADA — NO LA VUELVAS A PEDIR');
    }

    const datosSection = datosMencionados.length > 0
      ? `DATOS YA RECOPILADOS (NO LOS VUELVAS A PEDIR):\n${datosMencionados.join('\n')}`
      : `DATOS RECOPILADOS: Ninguno aún.`;

    // ── Órdenes anteriores ────────────────────────────────────────────────────
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

    // ── Citas anteriores ──────────────────────────────────────────────────────
    const APPT_STATUS_LABELS: Record<string, string> = {
      PENDING:     'Pendiente de confirmar',
      CONFIRMED:   'Confirmada',
      IN_PROGRESS: 'En curso',
      COMPLETED:   'Completada',
      CANCELLED:   'Cancelada',
      NO_SHOW:     'No se presentó',
      RESCHEDULED: 'Reagendada',
    };

    let citasSection: string;
    if (appointments.length === 0) {
      citasSection = `CITAS/AGENDAMIENTOS ANTERIORES: Ninguno.`;
    } else {
      const textoCitas = appointments.map((a: any, i: number) => {
        const fecha = new Date(a.scheduledAt).toLocaleDateString('es-CO', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
          timeZone: 'America/Bogota',
        });
        const hora = new Date(a.scheduledAt).toLocaleTimeString('es-CO', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
        });
        const servicioNombre = a.service?.name
          ? ` — ${a.service.name}${a.serviceVariant ? ` (${a.serviceVariant.name})` : ''}`
          : '';
        return (
          `  Cita #${i + 1}${servicioNombre} — ${fecha} a las ${hora}\n` +
          `  Estado: ${APPT_STATUS_LABELS[a.status] ?? a.status}` +
          (a.description ? `\n  Descripción: ${a.description}` : '')
        );
      }).join('\n\n');
      citasSection = `CITAS/AGENDAMIENTOS:\n${textoCitas}`;
    }

    // ── Catálogo ──────────────────────────────────────────────────────────────
    const hasItems = products.length > 0 || services.length > 0;
    let catalogoSection: string;

    if (!hasItems) {
      catalogoSection = `CATÁLOGO: Sin productos ni servicios registrados.`;
    } else {
      const productosTxt = products.length > 0
        ? products.map((p: any) => {
            const lines = [`  · ${p.name}`];
            if (p.variants?.length > 0) {
              p.variants.forEach((v: any) => {
                const st = v.stock === 0 ? '⚠️ AGOTADO' : `${v.stock} disp.`;
                lines.push(`    - ${v.name}: $${Number(v.salePrice).toLocaleString('es-CO')} | ${st}`);
              });
            } else {
              const st = p.stock === 0 ? '⚠️ AGOTADO' : `${p.stock} disp.`;
              lines.push(`    Precio: $${Number(p.salePrice).toLocaleString('es-CO')} | ${st}`);
              if (p.hasShipping) lines.push(`    Incluye envío`);
            }
            return lines.join('\n');
          }).join('\n\n')
        : null;

      const serviciosTxt = services.length > 0
        ? services.map((s: any) => {
            const precioTxt = this.buildServicePriceLabel(s);
            const lines     = [`  · ${s.name} — ${precioTxt}`];
            if (s.estimatedMinutes) {
              const h = Math.floor(s.estimatedMinutes / 60);
              const m = s.estimatedMinutes % 60;
              lines.push(`    Duración: ${h > 0 ? `${h}h` : ''}${m > 0 ? ` ${m}min` : ''}`);
            }
            if (s.hasVariants && s.variants?.length > 0) {
              lines.push(`    Variantes:`);
              s.variants.forEach((v: any) => {
                const pv = v.priceOverride
                  ? `$${Number(v.priceOverride).toLocaleString('es-CO')}`
                  : v.priceModifier
                    ? `${v.priceModifier > 0 ? '+' : ''}${v.priceModifier}% sobre base`
                    : 'Precio base';
                lines.push(`      - ${v.name}: ${pv}`);
              });
            }
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
- Para servicios VARIABLE, explica que el precio se cotiza y un asesor confirmará.`;
    }

    // ── Flujo de ordenes ──────────────────────────────────────────────────────
    const clienteDataPendiente = !customer.name || !customer.cedula;
    const hasPaymentMethods    = (settings.paymentMethods?.length ?? 0) > 0;
    const paymentInstruction   = hasPaymentMethods
      ? `- NUNCA des información de pago antes de que el pedido esté confirmado y registrado. Los datos se envían automáticamente al crear el pedido.
- Si el cliente pregunta por métodos de pago antes de confirmar: "Te envío los datos de pago en cuanto confirmemos tu pedido."`
      : `- Si el cliente pregunta por métodos de pago: "Un asesor te contactará con esa información."`;

    const flujoSection = `FLUJO DE TOMA DE ORDEN (PRODUCTOS Y SERVICIOS):

Para crear un pedido necesito:
  a) Productos o servicios con cantidad
  b) Dirección de entrega completa
  c) ${clienteDataPendiente ? 'Nombre completo y número de cédula del cliente' : '(datos del cliente ya registrados)'}
  d) Confirmación explícita

${clienteDataPendiente ? `IMPORTANTE: Cuando el cliente muestre intención de compra PIDE todos de una:
"Para registrar tu pedido necesito: tu nombre completo, número de cédula y dirección de entrega."` : ''}

ANTI-LOOP:
- Si un dato ya está en DATOS YA RECOPILADOS, NO lo vuelvas a pedir.
- Si ya tienes todo, muestra el resumen y pide SOLO confirmación.

SOBRE ENVÍO Y PAGOS:
- NUNCA calcules ni menciones costos de envío.
${paymentInstruction}

PROHIBIDO:
- Pedir datos que ya tienes.
- Inventar precios o características.
- Mencionar items fuera del catálogo.`;

    // ── Flujo de agendamiento ─────────────────────────────────────────────────
    const agendamientoSection = `FLUJO DE AGENDAMIENTO (CITAS Y SERVICIOS):

Cuando el cliente quiera agendar, necesito:
  a) Qué necesita (tipo de cita o servicio del catálogo)
  b) Fecha (día, mes y año)
  c) Hora
  d) Descripción breve
  e) Dirección (solo si es a domicilio)
  f) ${clienteDataPendiente ? 'Nombre completo y cédula del cliente' : '(datos del cliente ya registrados)'}
  g) Confirmación explícita

${clienteDataPendiente ? `Si el cliente quiere una cita y no tenemos sus datos, pide:
"Para agendar necesito: tu nombre completo y número de cédula."` : ''}

Cuando tengas todo, muestra el resumen COMPLETO y pide confirmación:
"¿Confirmamos tu cita de [servicio] para el [fecha] a las [hora]?"

IMPORTANTE:
- Si el cliente menciona un servicio del catálogo, preséntalo con su precio y duración.
- Si el cliente menciona "mañana", calcula la fecha real desde hoy.
- Si la hora es ambigua (ej: "2"), confirma: "¿A las 2pm o 2am?"
- Para servicios VARIABLE, avisa que el precio exacto lo confirma un asesor.`;

    return [
      basePrompt, sep, clienteSection, sep, datosSection, sep,
      ordenesSection, sep, citasSection, sep, catalogoSection, sep,
      flujoSection, sep, agendamientoSection, sep,
      `FECHA Y HORA ACTUAL: ${fechaActual}, ${horaActual} (Colombia).`,
    ].join('\n');
  }
}