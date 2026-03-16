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

// Intención de compra de producto
const PURCHASE_INTENT_RE = /\b(quiero|deseo|pedir|pido|ordenar|comprar|llevar|encargar|confirm|dale|listo|acepto|perfecto|procede|adelante|claro|exacto|sip|yep|yes|sí|si\b|ok\b|pedido|orden|dirección|entrega|envío|cantidad|unidades?)\b/i;

// Intención de agendar cita o visita
const APPOINTMENT_INTENT_RE = /\b(agendar|agenda|cita|visita|visita técnica|técnico|técnica|programar|reservar|reserva|turno|appointment|quiero una cita|necesito una visita|instalar|instalación|mantenimiento)\b/i;

// El cliente confirma algo
const CONFIRMATION_RE = /\b(confirm|sí|si\b|ok\b|dale|listo|acepto|perfecto|procede|adelante|claro|exacto|sip|yep|yes)\b/i;

// Detecta dirección
const ADDRESS_RE = /\b(calle|carrera|cra|cl\b|av\b|avenida|barrio|#|\d{2,}[-–]\d+|diagonal|transversal|manzana|casa|apto|apartamento)\b/i;

// Detecta cédula colombiana (6-10 dígitos)
const CEDULA_RE = /\b(\d{6,10})\b/;

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
  // Datos del cliente — se recogen al momento de la orden si faltan
  customerName: string | null;
  customerCedula: string | null;
}

interface AppointmentExtractionResult {
  complete: boolean;
  type: 'cita' | 'visita_tecnica' | 'otro';
  scheduledDate: string | null;  // "2024-03-15"
  scheduledTime: string | null;  // "14:00"
  description: string | null;
  address: string | null;
  notes: string | null;
  reason: string;
  // Datos del cliente — se recogen al momento de agendar si faltan
  customerName: string | null;
  customerCedula: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  private readonly groqClients          = new Map<string, Groq>();
  private readonly configCache          = new Map<string, CacheEntry<any>>();
  private readonly catalogCache         = new Map<string, CacheEntry<{ products: any[]; services: any[] }>>();
  private readonly orderInProgress      = new Set<string>();
  private readonly pendingExtractions   = new Map<string, ExtractionResult>();
  private readonly appointmentInProgress = new Set<string>();
  private readonly pendingAppointments  = new Map<string, AppointmentExtractionResult>();

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
            include: {
              variants: { where: { isActive: true }, orderBy: { name: 'asc' } },
            },
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

      // ── 3. Conversación + órdenes + citas + historial EN PARALELO ───────────
      const [conversationRow, orders, appointments, history] = await Promise.all([
        this.prisma.conversation.findFirst({
          where: { conversationId, storeId },
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
          orderBy: { scheduledAt: 'asc' },
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
      const groq     = this.getGroqClient(config.groqApiKey);

      // ── 4. Detección de intención: orden o cita ─────────────────────────────
      const hasCatalog          = products.length > 0 || services.length > 0;
      const hasPurchaseIntent   = PURCHASE_INTENT_RE.test(userMessage);
      const hasAppointmentIntent = APPOINTMENT_INTENT_RE.test(userMessage);
      const hasPendingOrder     = this.pendingExtractions.has(conversationId);
      const hasPendingAppt      = this.pendingAppointments.has(conversationId);

      // ── 4a. Flujo de agendamiento ────────────────────────────────────────────
      if (
        (hasAppointmentIntent || hasPendingAppt) &&
        !this.appointmentInProgress.has(conversationId)
      ) {
        const apptResult = await this.tryExtractAndCreateAppointment(
          groq, config.model, history, userMessage,
          customer, storeId, conversationId,
        );
        if (apptResult.created) return apptResult.message!;
      }

      // ── 4b. Flujo de orden de productos ─────────────────────────────────────
      const shouldTryOrder =
        hasCatalog &&
        history.length >= 2 &&
        (hasPurchaseIntent || hasPendingOrder) &&
        !this.orderInProgress.has(conversationId);

      if (shouldTryOrder) {
        const orderResult = await this.tryExtractAndCreateOrder(
          groq, config.model, history, userMessage,
          products, services, customer, storeId, conversationId,
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
        history, userMessage, addressAlreadyGiven,
      );

      const messages: any[] = [
        { role: 'system', content: enrichedSystemPrompt },
        ...history.map((m: any) => ({
          role: m.isAiResponse ? 'assistant' : 'user',
          content: m.content.trim(),
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

    const cached = this.pendingExtractions.get(conversationId);
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
          `${m.isAiResponse ? 'Asistente' : 'Cliente'}: ${m.content.trim()}`
        ),
        `Cliente: ${latestMessage}`,
      ].join('\n');

      const customerDataInstruction = needsCustomerData
        ? `
DATOS DEL CLIENTE REQUERIDOS:
El cliente aún no tiene nombre o cédula registrados. Extráelos de la conversación si fueron mencionados.
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
3. Para productos CON variantes: variantId es OBLIGATORIO.
4. Para productos SIN variantes: variantId debe ser null.
5. Si el stock de un item es 0, NO lo incluyas y explícalo en "reason".
6. "deliveryAddress": copia textualmente lo que dijo el cliente. Sin dirección válida → null.

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
            model: 'llama-3.1-8b-instant',
            messages: [{ role: 'user', content: extractorPrompt }],
            temperature: 0,
            max_tokens: 900,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Extractor timeout')), GROQ_TIMEOUT_EXT_MS)
          ),
        ]) as any;

        const raw = extractResponse.choices[0]?.message?.content ?? '';
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

    // Validar datos del cliente si son necesarios
    if (needsCustomerData && (!extracted.customerName || !extracted.customerCedula)) {
      return { created: false };
    }

    if (this.orderInProgress.has(conversationId)) {
      this.logger.warn(`Orden ya en progreso para ${conversationId}`);
      return { created: false };
    }
    this.orderInProgress.add(conversationId);

    try {
      // Guardar datos del cliente si se recopilaron ahora
      if (needsCustomerData && extracted.customerName && extracted.customerCedula) {
        await this.prisma.customer.update({
          where: { customerId: customer.customerId },
          data: {
            name: extracted.customerName.replace(/\b\w/g, l => l.toUpperCase()),
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
          const service = (await this.getCached(this.catalogCache, customer.storeId ?? storeId))
            ?.services?.find((s: any) => s.serviceId === item.serviceId);
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
          const catalogData = this.getCached(this.catalogCache, storeId);
          const product = catalogData?.products?.find((p: any) => p.productId === item.productId);
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

      const nombreCliente = extracted.customerName
        ? `, ${extracted.customerName.split(' ')[0]}`
        : customer.name ? `, ${customer.name}` : '';

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

  // ─── Extracción y creación de cita/agendamiento ───────────────────────────────

  private async tryExtractAndCreateAppointment(
    groq: Groq,
    model: string,
    history: any[],
    latestMessage: string,
    customer: any,
    storeId: string,
    conversationId: string,
  ): Promise<{ created: boolean; message?: string }> {

    const cached = this.pendingAppointments.get(conversationId);
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
        ? `
DATOS DEL CLIENTE REQUERIDOS:
El cliente no tiene nombre o cédula registrados. Extráelos si están en la conversación.
La cita NO puede ser "complete":true si faltan nombre o cédula del cliente.`
        : `DATOS DEL CLIENTE: Ya registrados. No es necesario extraerlos.`;

      const now = new Date();
      const fechaHoy = now.toISOString().split('T')[0];

      const appointmentPrompt = `Eres un extractor de datos para agendamiento de citas y visitas técnicas. Lee la conversación y extrae los datos en JSON.

FECHA ACTUAL: ${fechaHoy} (Colombia)

CONVERSACIÓN:
${conversationText}

${customerDataInstruction}

TIPOS DE CITA:
- "cita": cita general, consulta, reunión
- "visita_tecnica": visita técnica, instalación, mantenimiento, reparación
- "otro": cualquier otro tipo de agendamiento

REGLAS ESTRICTAS:
1. "complete":true SOLO si se cumplen TODAS las condiciones:
   a) Fecha específica (día y mes como mínimo)
   b) Hora específica
   c) Descripción de qué tipo de cita/visita es
   d) Confirmación explícita del cliente (sí, confirmo, listo, dale, etc.)
   e) Si se requieren datos del cliente: nombre Y cédula presentes
2. Si falta CUALQUIER condición → "complete":false
3. "scheduledDate": formato "YYYY-MM-DD". Si dicen "mañana" calcula desde hoy.
4. "scheduledTime": formato "HH:MM" en 24h. Si dicen "2pm" → "14:00"
5. "address": dirección si es visita técnica. null si es cita en local.

Responde ÚNICAMENTE con este JSON (sin markdown, sin texto adicional):
{
  "complete": boolean,
  "type": "cita" | "visita_tecnica" | "otro",
  "scheduledDate": "YYYY-MM-DD o null",
  "scheduledTime": "HH:MM o null",
  "description": "descripción de la cita o null",
  "address": "dirección si aplica o null",
  "notes": "notas adicionales o null",
  "reason": "explicación breve de por qué complete es true o false",
  "customerName": "nombre completo del cliente o null",
  "customerCedula": "número de cédula o null"
}`;

      try {
        const extractResponse = await Promise.race([
          groq.chat.completions.create({
            model: 'llama-3.1-8b-instant',
            messages: [{ role: 'user', content: appointmentPrompt }],
            temperature: 0,
            max_tokens: 600,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Appointment extractor timeout')), GROQ_TIMEOUT_EXT_MS)
          ),
        ]) as any;

        const raw = extractResponse.choices[0]?.message?.content ?? '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { created: false };

        extracted = JSON.parse(jsonMatch[0]);
        this.logger.log(`Extracción cita: ${JSON.stringify(extracted)}`);

        // Cachear si hay alguna fecha o descripción
        if (extracted.scheduledDate || extracted.description) {
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
      // Guardar datos del cliente si se recopilaron ahora
      if (needsCustomerData && extracted.customerName && extracted.customerCedula) {
        await this.prisma.customer.update({
          where: { customerId: customer.customerId },
          data: {
            name: extracted.customerName.replace(/\b\w/g, l => l.toUpperCase()),
            cedula: extracted.customerCedula,
          },
        });
      }

      // Combinar fecha y hora en un DateTime
      const scheduledAt = new Date(`${extracted.scheduledDate}T${extracted.scheduledTime}:00-05:00`);

      if (isNaN(scheduledAt.getTime())) {
        this.logger.warn(`Fecha inválida: ${extracted.scheduledDate}T${extracted.scheduledTime}`);
        return { created: false };
      }

      const appointment = await this.prisma.appointment.create({
        data: {
          storeId,
          customerId: customer.customerId,
          type: extracted.type,
          scheduledAt,
          description: extracted.description ?? null,
          address: extracted.address ?? null,
          notes: [
            extracted.notes ? `Notas: ${extracted.notes}` : null,
            `Creado automáticamente por IA`,
          ].filter(Boolean).join(' | ') || null,
          status: 'pending',
        },
      });

      await this.prisma.conversation.update({
        where: { conversationId },
        data: { status: 'pending_human' },
      });

      this.pendingAppointments.delete(conversationId);
      this.logger.log(`✅ Cita ${appointment.appointmentId} agendada para ${extracted.scheduledDate} ${extracted.scheduledTime}`);

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

      const typeLabels: Record<string, string> = {
        cita: '📅 Cita',
        visita_tecnica: '🔧 Visita técnica',
        otro: '📌 Agendamiento',
      };

      const tipoLabel = typeLabels[extracted.type] ?? '📅 Cita';
      const addressLine = extracted.address ? `\n📍 *Dirección:* ${extracted.address}` : '';

      return {
        created: true,
        message:
          `¡${tipoLabel} agendada${nombreCliente}! ✅\n\n` +
          `📆 *Fecha:* ${fechaFormateada}\n` +
          `🕐 *Hora:* ${horaFormateada}` +
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
  ): string {
    const sep = '\n===================================================\n';
    const nombreCliente = customer.name ?? null;

    const clienteSection = `CLIENTE:
- Nombre: ${nombreCliente ?? 'No registrado aún'}
- Cédula: ${customer.cedula ?? 'No registrada aún'}
- Ciudad: ${customer.city ?? 'No registrada'}
- ${nombreCliente
    ? `Llámalo ${nombreCliente} de forma natural (no en cada mensaje).`
    : `No sabes el nombre. No lo inventes. Lo pedirás cuando generes una orden o cita.`}
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
      datosMencionados.push('✅ Dirección: YA FUE DADA — NO LA VUELVAS A PEDIR');
    }

    const datosSection = datosMencionados.length > 0
      ? `DATOS YA RECOPILADOS (NO LOS VUELVAS A PEDIR):\n${datosMencionados.join('\n')}`
      : `DATOS RECOPILADOS: Ninguno aún.`;

    const STATUS_LABELS: Record<string, string> = {
      pending: 'Pendiente', confirmed: 'Confirmado', preparing: 'En preparación',
      ready: 'Listo', delivered: 'Entregado', cancelled: 'Cancelado',
    };

    const APPT_STATUS_LABELS: Record<string, string> = {
      pending: 'Pendiente', confirmed: 'Confirmada',
      completed: 'Completada', cancelled: 'Cancelada',
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
        return `  Cita #${i + 1} — ${fecha} a las ${hora} — ${APPT_STATUS_LABELS[a.status] ?? a.status}${a.description ? `\n    Descripción: ${a.description}` : ''}`;
      }).join('\n\n');
      citasSection = `CITAS/AGENDAMIENTOS:\n${textoCitas}`;
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
            const precioTxt = s.price ? `$${s.price}` : '💡 Precio variable (asesor confirma)';
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
- Si el stock es AGOTADO, avísalo y ofrece alternativa si hay.`;
    }

    const clienteDataPendiente = !customer.name || !customer.cedula;

    const flujoSection = `FLUJO DE TOMA DE ORDEN (PRODUCTOS):

Para crear un pedido necesito EXACTAMENTE estas cosas:
  a) Productos/cantidad
  b) Dirección de entrega completa
  c) ${clienteDataPendiente ? 'Nombre completo y número de cédula del cliente' : '(datos del cliente ya registrados)'}
  d) Confirmación explícita

${clienteDataPendiente ? `IMPORTANTE: Como no tenemos nombre ni cédula del cliente aún, cuando el cliente muestre intención de compra PIDE:
"Para registrar tu pedido necesito: tu nombre completo, número de cédula y dirección de entrega."
Pídelos todos juntos en un solo mensaje para no hacer la conversación tediosa.` : ''}

ANTI-LOOP:
- Si un dato ya está en DATOS YA RECOPILADOS, NO lo vuelvas a pedir.
- Si ya tienes todo, muestra el resumen y pide SOLO confirmación.

SOBRE ENVÍO Y PAGOS:
- NUNCA calcules ni menciones costos de envío.
- NUNCA des datos de cuentas bancarias o métodos de pago.
- Si preguntan: "Un asesor te contactará con esos detalles."

PROHIBIDO:
- Pedir datos que ya tienes.
- Inventar precios o características.
- Mencionar items fuera del catálogo.`;

    const agendamientoSection = `FLUJO DE AGENDAMIENTO (CITAS/VISITAS TÉCNICAS):

Cuando el cliente quiera agendar, necesito:
  a) Tipo de cita (cita general, visita técnica, instalación, etc.)
  b) Fecha (día, mes y año)
  c) Hora
  d) Descripción breve de qué necesita
  e) Dirección (solo si es visita técnica a domicilio)
  f) ${clienteDataPendiente ? 'Nombre completo y cédula del cliente' : '(datos del cliente ya registrados)'}
  g) Confirmación explícita

${clienteDataPendiente ? `Si el cliente quiere una cita y no tenemos sus datos, pide:
"Para agendar tu cita necesito: tu nombre completo y número de cédula."` : ''}

Cuando tengas todo, muestra el resumen y pide confirmación:
"¿Confirmas esta cita para el [fecha] a las [hora]?"

IMPORTANTE:
- Si el cliente menciona "mañana", calcula la fecha real desde hoy.
- Si la hora es ambigua (ej: "2"), confirma: "¿A las 2pm o 2am?"`;

    return [
      basePrompt, sep, clienteSection, sep, datosSection, sep,
      ordenesSection, sep, citasSection, sep, catalogoSection, sep,
      flujoSection, sep, agendamientoSection, sep,
      `FECHA Y HORA: ${fechaActual}, ${horaActual} (Colombia).`,
    ].join('\n');
  }
}