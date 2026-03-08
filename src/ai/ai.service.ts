import { Injectable, Logger } from '@nestjs/common';
import Groq from 'groq-sdk';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(private prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────────────────────
  // ENTRADA PRINCIPAL
  // ─────────────────────────────────────────────────────────────────────────
  async generateReply(
    storeId: string,
    userMessage: string,
    conversationId: string,
  ): Promise<string | null> {
    try {
      // 1. Config de IA
      const config = await this.prisma.aIConfiguration.findUnique({
        where: { storeId },
      });
      if (!config) {
        this.logger.warn(`No hay AIConfiguration para store: ${storeId}`);
        return null;
      }

      // 2. Conversación + cliente (seguridad: conversationId + storeId juntos)
      const conversation = await this.prisma.conversation.findFirst({
        where: { conversationId, storeId },
        include: { customer: true },
      });
      if (!conversation) {
        this.logger.warn(`Conversación ${conversationId} no pertenece a store ${storeId}`);
        return null;
      }
      const customer = conversation.customer;

      // 3. Órdenes del cliente (solo las de este cliente en esta tienda)
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

      // 4. Catálogo activo
      const products = await this.prisma.product.findMany({
        where: { storeId, isActive: true },
        include: { variants: { where: { isActive: true }, orderBy: { name: 'asc' } } },
        orderBy: { name: 'asc' },
      });

      // 5. Historial de conversación (últimos 20 para mejor memoria)
      const history = await this.prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });

      // 6. Fecha y hora
      const now = new Date();
      const fechaActual = now.toLocaleDateString('es-CO', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        timeZone: 'America/Bogota',
      });
      const horaActual = now.toLocaleTimeString('es-CO', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
      });

      const groq = new Groq({ apiKey: config.groqApiKey });

      // ── PASO A: Intentar extraer orden completa del historial ─────────────
      const orderResult = await this.tryExtractAndCreateOrder(
        groq,
        config.model,
        history,
        userMessage,
        products,
        customer,
        storeId,
        conversationId,
      );

      // Si se creó una orden → devolver mensaje de confirmación (no generar reply normal)
      if (orderResult.created) {
        return orderResult.message!;
      }

      // ── PASO B: Generar respuesta normal ──────────────────────────────────
      const enrichedSystemPrompt = this.buildSystemPrompt(
        config.systemPrompt,
        customer,
        orders,
        products,
        fechaActual,
        horaActual,
        history,
        userMessage,
      );

      const messages: any[] = [
        { role: 'system', content: enrichedSystemPrompt },
        ...history.map((m: any) => ({
          role: m.isAiResponse ? 'assistant' : 'user',
          content: m.content,
        })),
        { role: 'user', content: userMessage },
      ];

      let response: any;
      try {
        response = await groq.chat.completions.create({
          model: config.model,
          messages,
          temperature: Number(config.temperature),
          max_tokens: config.maxTokens,
          // Evita que modelos como gpt-oss invoquen tools automáticamente
          ...(config.model.startsWith('openai/') ? { tool_choice: 'none' } : {}),
        } as any);
      } catch (modelErr: any) {
        // Fallback a llama si el modelo falla por tool_use_failed u otro error
        this.logger.warn(`Modelo ${config.model} falló, usando llama-3.3-70b-versatile: ${modelErr.message?.slice(0, 80)}`);
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
    customer: any,
    storeId: string,
    conversationId: string,
  ): Promise<{ created: boolean; message?: string }> {
    if (products.length === 0) return { created: false };

    // Construir resumen del catálogo para el extractor
    const catalogSummary = products.map((p: any) => {
      if (p.variants?.length > 0) {
        return p.variants.map((v: any) => (
          `- "${p.name} - ${v.name}" | productId:${p.productId} | variantId:${v.variantId} | precio:${v.salePrice} | stock:${v.stock}`
        )).join('\n');
      }
      return `- "${p.name}" | productId:${p.productId} | precio:${p.salePrice} | stock:${p.stock}`;
    }).join('\n');

    // Construir historial legible para el extractor
    const conversationText = [
      ...history.map((m: any) => `${m.isAiResponse ? 'Asistente' : 'Cliente'}: ${m.content}`),
      `Cliente: ${latestMessage}`,
    ].join('\n');

    const extractorPrompt = `Eres un extractor de datos de órdenes de compra. Analiza la conversación y determina si el cliente ya confirmó TODOS los datos necesarios para crear una orden.

CATÁLOGO DISPONIBLE:
${catalogSummary}

CONVERSACIÓN:
${conversationText}

DATOS REQUERIDOS PARA CREAR ORDEN:
1. productId (debe coincidir con el catálogo)
2. variantId (si el producto tiene variantes, es obligatorio; si no tiene variantes, pon null)
3. quantity (número entero positivo, mínimo 1)
4. deliveryAddress (dirección completa de entrega)

REGLAS DE EXTRACCIÓN:
- Solo marca complete:true si el cliente CONFIRMÓ todos los datos en esta conversación.
- Si el cliente pidió un producto pero no hay en catálogo, pon complete:false.
- Si el stock del producto es 0, pon complete:false.
- La dirección debe ser específica (ciudad + calle o similar). "Bogotá" solo no es suficiente.
- Si el cliente mencionó la dirección más de una vez, usa la más reciente.
- NO extraigas datos de mensajes del asistente, solo del cliente.
- Si el cliente preguntó por métodos de pago pero no está confirmando una compra, pon complete:false.

Responde ÚNICAMENTE con este JSON (sin explicaciones, sin markdown):
{
  "complete": boolean,
  "productId": "string o null",
  "variantId": "string o null",
  "quantity": number,
  "deliveryAddress": "string o null",
  "notes": "string o null",
  "reason": "string explicando por qué complete es true o false"
}`;

    try {
      const extractResponse = await groq.chat.completions.create({
        model: 'llama-3.1-8b-instant', // modelo rápido y barato para extracción
        messages: [{ role: 'user', content: extractorPrompt }],
        temperature: 0,
        max_tokens: 300,
      });

      const raw = extractResponse.choices[0]?.message?.content ?? '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { created: false };

      const extracted = JSON.parse(jsonMatch[0]);
      this.logger.log(`Extracción de orden: ${JSON.stringify(extracted)}`);

      if (!extracted.complete || !extracted.productId || !extracted.deliveryAddress || !extracted.quantity) {
        return { created: false };
      }

      // Verificar que el producto existe y tiene stock
      const product = products.find((p: any) => p.productId === extracted.productId);
      if (!product) return { created: false };

      let unitPrice: number;
      let stockDisponible: number;

      if (extracted.variantId) {
        const variant = product.variants?.find((v: any) => v.variantId === extracted.variantId);
        if (!variant) return { created: false };
        unitPrice = Number(variant.salePrice);
        stockDisponible = variant.stock;
      } else {
        unitPrice = Number(product.salePrice);
        stockDisponible = product.stock;
      }

      if (stockDisponible < extracted.quantity) {
        this.logger.warn(`Stock insuficiente: ${stockDisponible} disponible, ${extracted.quantity} solicitado`);
        return { created: false };
      }

      const total = unitPrice * extracted.quantity;

      // Crear la orden en BD
      const order = await this.prisma.order.create({
        data: {
          storeId,
          customerId: customer.customerId,
          status: 'pending',
          total,
          notes: [
            `Dirección: ${extracted.deliveryAddress}`,
            extracted.notes ? `Notas: ${extracted.notes}` : null,
            `Creado automáticamente por IA`,
          ].filter(Boolean).join(' | '),
          orderItems: {
            create: [{
              productId: extracted.productId,
              quantity: extracted.quantity,
              unitPrice,
            }],
          },
        },
        include: { orderItems: { include: { product: true } } },
      });

      // Pasar conversación a pending_human
      await this.prisma.conversation.update({
        where: { conversationId },
        data: { status: 'pending_human' },
      });

      this.logger.log(`✅ Orden creada: ${order.orderId} | Total: $${total}`);

      const nombreCliente = customer.name ? `, ${customer.name}` : '';
      const confirmMessage =
        `¡Perfecto${nombreCliente}! 🎉 Tu pedido fue registrado exitosamente.\n\n` +
        `📦 *Resumen de tu orden:*\n` +
        `• Producto: ${product.name}${extracted.variantId ? ` - ${product.variants?.find((v: any) => v.variantId === extracted.variantId)?.name ?? ''}` : ''}\n` +
        `• Cantidad: ${extracted.quantity} unidad(es)\n` +
        `• Total: $${total.toLocaleString('es-CO')}\n` +
        `• Dirección: ${extracted.deliveryAddress}\n\n` +
        `Un asesor se pondrá en contacto contigo en breve para coordinar el pago y confirmar el envío. ¡Gracias por tu compra! 😊`;

      return { created: true, message: confirmMessage };
    } catch (err: any) {
      this.logger.error(`Error en extracción de orden: ${err.message}`);
      return { created: false };
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
    fechaActual: string,
    horaActual: string,
    history: any[],
    latestMessage: string,
  ): string {
    const sep = '\n===================================================\n';

    // ── Cliente ────────────────────────────────────────────────────────────
    const nombreCliente = customer.name ?? null;
    const tratoNombre = nombreCliente
      ? `Llama al cliente ${nombreCliente} de forma natural (no en cada mensaje).`
      : `No sabes el nombre del cliente. No lo inventes.`;

    const clienteSection = `CLIENTE CON QUIEN HABLAS:
- Nombre: ${nombreCliente ?? 'No registrado aún'}
- Ciudad: ${customer.city ?? 'No registrada'}
- Cliente desde: ${new Date(customer.createdAt).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' })}
- ${tratoNombre}
- Adapta tu tono al del cliente: formal si escribe formal, cercano si es casual.
- NUNCA menciones datos de otros clientes.`;

    // ── Datos ya recopilados en esta conversación ──────────────────────────
    // Esto es clave para que la IA no vuelva a pedir lo que ya tiene
    const clientMessages = [
      ...history.filter((m: any) => !m.isAiResponse).map((m: any) => m.content),
      latestMessage,
    ];
    const allClientText = clientMessages.join(' ').toLowerCase();

    const datosMencionados: string[] = [];

    // Detectar producto mencionado
    products.forEach((p: any) => {
      if (allClientText.includes(p.name.toLowerCase())) {
        datosMencionados.push(`✅ Producto mencionado: "${p.name}"`);
      }
    });

    // Detectar dirección (heurística simple)
    const tieneDir = /calle|carrera|avenida|cra|cl |av |#|dirección|entrega/.test(allClientText);
    if (tieneDir) datosMencionados.push('✅ Dirección de entrega: ya fue proporcionada en la conversación');

    // Detectar cantidad
    const cantidadMatch = allClientText.match(/\b(una?|dos|tres|cuatro|cinco|\d+)\s*(unidad|unidades|)/i);
    if (cantidadMatch) datosMencionados.push(`✅ Cantidad: ya fue mencionada (${cantidadMatch[0]})`);

    const datosSection = datosMencionados.length > 0
      ? `DATOS YA RECOPILADOS EN ESTA CONVERSACIÓN (NO LOS VUELVAS A PEDIR):
${datosMencionados.join('\n')}`
      : `DATOS RECOPILADOS: Ninguno aún.`;

    // ── Órdenes previas ────────────────────────────────────────────────────
    const STATUS_LABELS: Record<string, string> = {
      pending: 'Pendiente', confirmed: 'Confirmado', preparing: 'En preparación',
      ready: 'Listo para entrega', delivered: 'Entregado', cancelled: 'Cancelado',
    };

    let ordenesSection: string;
    if (orders.length === 0) {
      ordenesSection = `PEDIDOS ANTERIORES: Este cliente no tiene pedidos registrados.`;
    } else {
      const textoOrdenes = orders.map((o: any, i: number) => {
        const fecha = new Date(o.createdAt).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
        const items = o.orderItems.map((it: any) =>
          `      · ${it.product?.name ?? 'Producto'} x${it.quantity} — $${it.unitPrice}`
        ).join('\n');
        return `  Pedido #${i + 1} (${fecha}) — ${STATUS_LABELS[o.status] ?? o.status} — Total: $${o.total}\n${items}`;
      }).join('\n\n');
      ordenesSection = `PEDIDOS ANTERIORES DEL CLIENTE:\n${textoOrdenes}\nREGLA: Solo muestra estos pedidos. Si pregunta por uno que no aparece, remite a un asesor.`;
    }

    // ── Catálogo ───────────────────────────────────────────────────────────
    let catalogoSection: string;
    if (products.length === 0) {
      catalogoSection = `CATÁLOGO: La tienda no tiene productos registrados actualmente.`;
    } else {
      const textoCatalogo = products.map((p: any) => {
        const lines: string[] = [`  · ${p.name}`];
        if (p.description) lines.push(`    ${p.description}`);
        if (p.variants?.length > 0) {
          (p.variants as any[]).forEach((v: any) => {
            const st = v.stock === 0 ? 'AGOTADO' : `${v.stock} disponibles`;
            lines.push(`    - ${v.name}: $${v.salePrice} | ${st}`);
          });
        } else {
          const st = p.stock === 0 ? 'AGOTADO' : `${p.stock} disponibles`;
          lines.push(`    Precio: $${p.salePrice} | ${st}`);
        }
        if (p.hasShipping) lines.push(`    Con envío`);
        return lines.join('\n');
      }).join('\n\n');

      catalogoSection = `CATÁLOGO DE PRODUCTOS:
${textoCatalogo}
REGLAS:
- Habla SOLO de estos productos. Si piden algo que no está, dilo y sugiere lo más cercano.
- No inventes precios, modelos ni características.
- No inventes reseñas, opiniones externas ni comparativas — no es tu función.
- Si el stock es AGOTADO, avísalo y ofrece alternativas.`;
    }

    // ── Flujo de toma de orden ─────────────────────────────────────────────
    const flujoSection = `FLUJO DE TOMA DE ORDEN — SIGUE ESTO AL PIE DE LA LETRA:

1. Para crear una orden necesitas recopilar EXACTAMENTE estos datos del cliente:
   a) Producto (y variante si aplica) — del catálogo
   b) Cantidad
   c) Dirección de entrega completa

2. REGLAS CRÍTICAS:
   - Si ya tienes un dato, NO lo vuelvas a pedir. Revisa "DATOS YA RECOPILADOS" arriba.
   - Pide los datos faltantes DE UNO EN UNO, no todos juntos.
   - Una vez tengas los 3 datos, confirma el resumen al cliente y espera su "sí" o confirmación.
   - El sistema creará la orden automáticamente cuando detecte todos los datos confirmados.

3. MÉTODOS DE PAGO — MUY IMPORTANTE:
   - NUNCA des información de métodos de pago, cuentas bancarias, ni procedimientos de pago.
   - Si el cliente pregunta por formas de pago, responde: "Un asesor te contactará para los detalles del pago."
   - El manejo del pago es EXCLUSIVO del equipo humano.

4. PROHIBIDO:
   - Inventar reseñas, artículos o fuentes externas.
   - Pedir datos que el cliente ya proporcionó.
   - Dar información bancaria o de pago.
   - Mencionar productos fuera del catálogo.`;

    return [
      basePrompt,
      sep,
      clienteSection,
      sep,
      datosSection,
      sep,
      ordenesSection,
      sep,
      catalogoSection,
      sep,
      flujoSection,
      sep,
      `FECHA Y HORA: Hoy es ${fechaActual}, hora: ${horaActual} (Colombia). Respóndela si te preguntan.`,
    ].join('\n');
  }
}
