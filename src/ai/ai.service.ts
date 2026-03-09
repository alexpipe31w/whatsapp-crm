import { Injectable, Logger } from '@nestjs/common';
import Groq from 'groq-sdk';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  // Cache de clientes Groq por apiKey
  private groqClients: Map<string, Groq> = new Map();
  // Guard anti-duplicado de orden en curso
  private orderInProgress: Set<string> = new Set();
  // Cache de extracción pendiente — evita re-extraer en "Confirmo"
  private pendingExtractions: Map<string, any> = new Map();

  constructor(private prisma: PrismaService) {}

  private getGroqClient(apiKey: string): Groq {
    if (!this.groqClients.has(apiKey)) {
      this.groqClients.set(apiKey, new Groq({ apiKey }));
    }
    return this.groqClients.get(apiKey)!;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ENTRADA PRINCIPAL
  // ─────────────────────────────────────────────────────────────────────────
  async generateReply(
    storeId: string,
    userMessage: string,
    conversationId: string,
  ): Promise<string | null> {
    try {
      const config = await this.prisma.aIConfiguration.findUnique({
        where: { storeId },
      });
      if (!config) {
        this.logger.warn(`No hay AIConfiguration para store: ${storeId}`);
        return null;
      }

      const conversation = await this.prisma.conversation.findFirst({
        where: { conversationId, storeId },
        include: { customer: true },
      });
      if (!conversation) {
        this.logger.warn(`Conversación ${conversationId} no pertenece a store ${storeId}`);
        return null;
      }
      const customer = conversation.customer;

      const orders = await this.prisma.order.findMany({
        where: { customerId: customer.customerId, storeId },
        include: {
          orderItems: {
            include: { product: { select: { name: true, salePrice: true } } },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });

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

      const history = await this.prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });

      const now = new Date();
      const fechaActual = now.toLocaleDateString('es-CO', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        timeZone: 'America/Bogota',
      });
      const horaActual = now.toLocaleTimeString('es-CO', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
      });

      const groq = this.getGroqClient(config.groqApiKey);

      const shouldTryOrder =
        (products.length > 0 || services.length > 0) &&
        history.length >= 3 &&
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
            setTimeout(() => reject(new Error('Groq timeout')), 30_000)
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

  // ─────────────────────────────────────────────────────────────────────────
  // EXTRACCIÓN Y CREACIÓN DE ORDEN
  // ─────────────────────────────────────────────────────────────────────────
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

    // ── Verificar si el cliente está confirmando una extracción previa ──────
    // Esto evita que el extractor pierda variantId cuando el cliente dice "Confirmo"
    const CONFIRMATION_RE = /\b(confirm|sí|si\b|ok\b|dale|listo|acepto|perfecto|procede|adelante|claro|exacto|sip|yep|yes)\b/i;
    const cached = this.pendingExtractions.get(conversationId);

    let extracted: any;

    if (cached && CONFIRMATION_RE.test(latestMessage.trim())) {
      // Reutilizar extracción cacheada — el cliente solo confirmó
      this.logger.log(`Usando extracción cacheada para ${conversationId}`);
      extracted = cached;
      this.pendingExtractions.delete(conversationId);
    } else {
      // Correr el extractor normalmente
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
        ...history.map((m: any) => `${m.isAiResponse ? 'Asistente' : 'Cliente'}: ${m.content.replace(/__ASK_NAME__|__ASK_CITY__/g, '').trim()}`),
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
- Si el producto tiene variantes, DEBES incluir el variantId correcto según lo que pidió el cliente.

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
            setTimeout(() => reject(new Error('Extractor timeout')), 15_000)
          ),
        ]) as any;

        const raw = extractResponse.choices[0]?.message?.content ?? '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { created: false };

        extracted = JSON.parse(jsonMatch[0]);
        this.logger.log(`Extracción de orden: ${JSON.stringify(extracted)}`);

        // Si está completa, cachear para el próximo "Confirmo"
        if (extracted.complete && extracted.quantity && extracted.deliveryAddress) {
          this.pendingExtractions.set(conversationId, extracted);
          // TTL de 10 minutos — limpiar si no se confirma
          setTimeout(() => this.pendingExtractions.delete(conversationId), 10 * 60 * 1000);
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

    // Guard anti-duplicado
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
        // ✅ Usar connect para Prisma
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
          // ✅ Usar connect para Prisma — fix del bug "Unknown argument productId"
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
          // ✅ Usar connect para Prisma
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

      // Limpiar cache después de crear la orden
      this.pendingExtractions.delete(conversationId);
      this.logger.log(`✅ Orden creada: ${order.orderId} | Total: $${total}`);

      const nombreCliente = customer.name ? `, ${customer.name}` : '';
      const precioTexto = unitPrice === 0
        ? 'Por confirmar (precio variable)'
        : `$${total.toLocaleString('es-CO')}`;

      const confirmMessage =
        `¡Perfecto${nombreCliente}! 🎉 Tu pedido fue registrado.\n\n` +
        `📦 *Resumen:*\n` +
        `• ${itemName}\n` +
        `• Cantidad: ${extracted.quantity}\n` +
        `• Total: ${precioTexto}\n` +
        `• Dirección: ${extracted.deliveryAddress}\n\n` +
        `Un asesor te contactará pronto para coordinar el pago y confirmar el envío. ¡Gracias! 😊`;

      return { created: true, message: confirmMessage };

    } finally {
      this.orderInProgress.delete(conversationId);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CONSTRUCCIÓN DEL SYSTEM PROMPT
  // ─────────────────────────────────────────────────────────────────────────
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
    const tieneDir = /calle|carrera|avenida|cra|cl |av |#|barrio|dirección|entrega/.test(allClientText);
    if (tieneDir) datosMencionados.push('✅ Dirección: ya fue proporcionada');
    const cantMatch = allClientText.match(/\b(una?|dos|tres|cuatro|cinco|\d+)\s*(unidad|unidades|)/i);
    if (cantMatch) datosMencionados.push(`✅ Cantidad: ya fue mencionada`);

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