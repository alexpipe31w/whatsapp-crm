import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createCompletion, AIProvider } from '../ai/providers';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private prisma: PrismaService) {}

  // ─── Helpers internos ────────────────────────────────────────────────────────

  private async getAiConfig(storeId: string) {
    const aiConfig = await this.prisma.aIConfiguration.findUnique({ where: { storeId } });
    if (!aiConfig || !aiConfig.apiKey)
      throw new BadRequestException('No hay configuración de IA. Ve a Configuración → pestaña Asistente IA y guarda tu API key.');
    return aiConfig;
  }

  private async callAI(
    provider:    AIProvider,
    apiKey:      string,
    model:       string,
    messages:   { role: string; content: string }[],
    maxTokens  = 1024,
    temperature = 0.7,
  ): Promise<string> {
    return createCompletion(provider, apiKey, model, messages as any, temperature, maxTokens);
  }

  // ─── AI Advisor ───────────────────────────────────────────────────────────────

  async askAdvisor(
    storeId:  string,
    context:  string,
    messages: { role: 'user' | 'assistant'; content: string }[],
  ) {
    const aiConfig = await this.getAiConfig(storeId);

    const systemPrompt = `Eres un asesor de negocios experto en e-commerce, ventas por WhatsApp y atención al cliente.
Analiza los datos del negocio y da recomendaciones específicas, accionables y en español colombiano.
Sé directo, usa números concretos y da consejos prácticos.
Cuando hagas listas usa bullet points con •.
NO uses asteriscos para negritas.

${context}`;

    const reply = await this.callAI((aiConfig.aiProvider ?? 'groq') as AIProvider,
      aiConfig.apiKey,
      aiConfig.model ?? 'llama-3.3-70b-versatile',
      [{ role: 'system', content: systemPrompt }, ...messages],
      1024,
      0.7,
    );
    return { reply };
  }

  // ─── Análisis de satisfacción desde summaries ─────────────────────────────────

  async getConversationInsights(storeId: string) {
    const aiConfig = await this.getAiConfig(storeId);

    // Tomar clientes con resumen reciente (últimos 60 días, máx 60 summaries)
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 60);

    const customers = await this.prisma.customer.findMany({
      where: {
        storeId,
        lastConversationSummary: { not: null },
        updatedAt: { gte: cutoff },
      },
      select: {
        lastConversationSummary: true,
        name:                    true,
        totalOrders:             true,
      },
      orderBy: { updatedAt: 'desc' },
      take:    60,
    });

    if (customers.length === 0) {
      return {
        analyzed:   0,
        satisfied:  0,
        neutral:    0,
        frustrated: 0,
        topics:     [],
        alerts:     [],
        positives:  [],
        summary:    'Aún no hay conversaciones archivadas para analizar. El sistema genera resúmenes automáticamente cada noche.',
      };
    }

    // Construir lista de summaries (truncados para no exceder tokens)
    const summariesText = customers
      .map((c, i) => {
        const summary = (c.lastConversationSummary ?? '').slice(0, 150);
        const orders  = c.totalOrders > 0 ? ` [${c.totalOrders} pedido(s)]` : '';
        return `${i + 1}. ${summary}${orders}`;
      })
      .join('\n');

    const prompt = `Eres un analista de satisfacción de clientes. Analiza estos resúmenes de conversaciones de WhatsApp de un negocio colombiano.

RESÚMENES (${customers.length} clientes, últimos 60 días):
${summariesText}

Analiza el sentimiento general y los patrones. Devuelve ÚNICAMENTE este JSON (sin markdown, sin texto extra):
{
  "satisfied": <porcentaje 0-100 de clientes claramente satisfechos>,
  "neutral": <porcentaje 0-100 de clientes con experiencia normal>,
  "frustrated": <porcentaje 0-100 de clientes con problemas o quejas>,
  "topics": ["tema más frecuente 1", "tema 2", "tema 3", "tema 4", "tema 5"],
  "alerts": ["alerta o problema detectado 1", "alerta 2", "alerta 3"],
  "positives": ["aspecto positivo recurrente 1", "aspecto positivo 2"],
  "summary": "resumen ejecutivo en 2 oraciones sobre el estado general de satisfacción"
}`;

    try {
      const raw = await this.callAI((aiConfig.aiProvider ?? 'groq') as AIProvider,
        aiConfig.apiKey,
        'llama-3.3-70b-versatile',
        [{ role: 'user', content: prompt }],
        512,
        0.3,
      );

      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON en respuesta');

      const parsed = JSON.parse(jsonMatch[0]);

      // Normalizar porcentajes para que sumen 100
      const total = (parsed.satisfied ?? 0) + (parsed.neutral ?? 0) + (parsed.frustrated ?? 0);
      if (total > 0 && total !== 100) {
        const factor = 100 / total;
        parsed.satisfied  = Math.round((parsed.satisfied  ?? 0) * factor);
        parsed.neutral    = Math.round((parsed.neutral    ?? 0) * factor);
        parsed.frustrated = 100 - parsed.satisfied - parsed.neutral;
      }

      return { analyzed: customers.length, ...parsed };

    } catch (err: any) {
      this.logger.error(`Error en insights: ${err.message}`);
      return {
        analyzed:   customers.length,
        satisfied:  0, neutral: 0, frustrated: 0,
        topics: [], alerts: [], positives: [],
        summary: 'Error al procesar los resúmenes. Intenta de nuevo.',
      };
    }
  }

  // ─── Tendencias de ingresos en el tiempo ──────────────────────────────────────

  async getRevenueTrends(storeId: string, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const orders = await this.prisma.order.findMany({
      where: {
        storeId,
        status:    { not: 'cancelled' },
        createdAt: { gte: since },
      },
      select: { total: true, createdAt: true, status: true },
      orderBy: { createdAt: 'asc' },
    });

    // Agrupar por día
    const byDay: Record<string, { revenue: number; count: number; delivered: number }> = {};

    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - (days - 1 - i));
      const key = d.toISOString().slice(0, 10);
      byDay[key] = { revenue: 0, count: 0, delivered: 0 };
    }

    orders.forEach((o) => {
      const key = o.createdAt.toISOString().slice(0, 10);
      if (byDay[key]) {
        byDay[key].revenue   += Number(o.total);
        byDay[key].count     += 1;
        if (o.status === 'delivered') byDay[key].delivered += 1;
      }
    });

    const entries = Object.entries(byDay);

    // Agrupar en semanas si el período es > 14 días
    if (days > 14) {
      const weeks: Record<string, { revenue: number; count: number; label: string }> = {};
      entries.forEach(([dateStr, data]) => {
        const d      = new Date(dateStr);
        const week   = `Sem ${Math.ceil((d.getDate()) / 7)} ${d.toLocaleString('es-CO', { month: 'short' })}`;
        // Usar año+semana como clave de agrupación real
        const year   = d.getFullYear();
        const startOfYear = new Date(year, 0, 1);
        const weekNum = Math.ceil(((d.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
        const key    = `${year}-W${weekNum}`;
        if (!weeks[key]) weeks[key] = { revenue: 0, count: 0, label: week };
        weeks[key].revenue += data.revenue;
        weeks[key].count   += data.count;
      });

      const weekEntries = Object.values(weeks);
      return {
        period: 'weekly',
        labels:  weekEntries.map(w => w.label),
        revenue: weekEntries.map(w => Math.round(w.revenue)),
        orders:  weekEntries.map(w => w.count),
        total:   orders.reduce((s, o) => s + Number(o.total), 0),
        totalOrders: orders.length,
      };
    }

    return {
      period: 'daily',
      labels:  entries.map(([k]) => {
        const d = new Date(k + 'T12:00:00');
        return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
      }),
      revenue: entries.map(([, v]) => Math.round(v.revenue)),
      orders:  entries.map(([, v]) => v.count),
      total:   orders.reduce((s, o) => s + Number(o.total), 0),
      totalOrders: orders.length,
    };
  }

  async getSummary(storeId: string, period: string) {
    const now = new Date();
    // Colombia = UTC-5. Los límites de día/semana/mes se calculan en hora de Colombia
    // (no en hora del servidor, normalmente UTC) — si no, entre las 19:00 y medianoche
    // hora Colombia el servidor ya está "al día siguiente" en UTC y las órdenes de esa
    // franja caen en el período equivocado del reporte.
    const tzOffset    = -5 * 60;
    const localNow    = new Date(now.getTime() + tzOffset * 60 * 1000);
    const colMidnight = (y: number, m: number, d: number) =>
      new Date(Date.UTC(y, m, d, 5, 0, 0, 0)); // 00:00 Colombia == 05:00 UTC

    const Y = localNow.getUTCFullYear();
    const M = localNow.getUTCMonth();
    const D = localNow.getUTCDate();

    let from: Date;
    let to: Date = new Date(now);

    switch (period) {
      case 'today':
        from = colMidnight(Y, M, D);
        to   = new Date(from.getTime() + 24 * 60 * 60 * 1000 - 1);
        break;
      case 'week': {
        const day = localNow.getUTCDay();
        from = colMidnight(Y, M, D - (day === 0 ? 6 : day - 1));
        break;
      }
      case 'last_month':
        from = colMidnight(Y, M - 1, 1);
        to   = new Date(colMidnight(Y, M, 1).getTime() - 1);
        break;
      case 'month':
      default:
        from = colMidnight(Y, M, 1);
        break;
    }

    const [orders, customers, staffList] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          storeId,
          createdAt: { gte: from, lte: to },
          status:    { not: 'cancelled' },
        },
        include: {
          orderItems: { include: { product: { select: { name: true } }, service: { select: { name: true } } } },
          customer:   { select: { customerId: true } },
        },
      }),
      this.prisma.customer.findMany({
        where:  { storeId, createdAt: { gte: from, lte: to } },
        select: { customerId: true },
      }),
      this.prisma.staff.findMany({
        where:  { storeId, isActive: true },
        select: { staffId: true, name: true },
      }),
    ]);

    const productOrders = orders.filter(o => o.type !== 'service');
    const serviceOrders = orders.filter(o => o.type === 'service');

    const productRevenue = productOrders.reduce((s, o) => s + Number(o.total), 0);
    const serviceRevenue = serviceOrders.reduce((s, o) => s + Number(o.total), 0);

    // Payment method breakdown
    const methodMap: Record<string, { label: string; amount: number; count: number }> = {};
    const METHOD_LABELS: Record<string, string> = {
      CASH: 'Efectivo', TRANSFER: 'Transferencia', CARD: 'Tarjeta',
      efectivo: 'Efectivo', transferencia: 'Transferencia', nequi: 'Nequi',
      daviplata: 'Daviplata', OTHER: 'Otro',
    };
    for (const o of orders) {
      const m = (o.manualPaymentMethod ?? 'OTHER').toUpperCase();
      if (!methodMap[m]) methodMap[m] = { label: METHOD_LABELS[m] ?? m, amount: 0, count: 0 };
      methodMap[m].amount += Number(o.total);
      methodMap[m].count  += 1;
    }
    const byPaymentMethod = Object.entries(methodMap)
      .map(([method, v]) => ({ method, ...v }))
      .sort((a, b) => b.amount - a.amount);

    // Top products
    const productQty: Record<string, { name: string; quantity: number; revenue: number }> = {};
    for (const o of productOrders) {
      for (const item of o.orderItems) {
        const name = item.product?.name ?? item.description ?? 'Desconocido';
        if (!productQty[name]) productQty[name] = { name, quantity: 0, revenue: 0 };
        productQty[name].quantity += item.quantity;
        productQty[name].revenue  += item.quantity * Number(item.unitPrice);
      }
    }
    const topProducts = Object.values(productQty).sort((a, b) => b.quantity - a.quantity).slice(0, 5);

    // Top services
    const serviceQty: Record<string, { name: string; quantity: number; revenue: number }> = {};
    for (const o of serviceOrders) {
      for (const item of o.orderItems) {
        const name = item.service?.name ?? item.description ?? 'Servicio';
        if (!serviceQty[name]) serviceQty[name] = { name, quantity: 0, revenue: 0 };
        serviceQty[name].quantity += item.quantity;
        serviceQty[name].revenue  += item.quantity * Number(item.unitPrice);
      }
    }
    const topServices = Object.values(serviceQty).sort((a, b) => b.quantity - a.quantity).slice(0, 5);

    // By staff: count appointments + revenue from service orders linked via appointmentId
    const byStaff: { staffId: string; name: string; appointments: number; revenue: number }[] = [];
    if (staffList.length > 0) {
      const staffAppts = await this.prisma.appointment.findMany({
        where: {
          storeId,
          staffId:     { in: staffList.map(s => s.staffId) },
          scheduledAt: { gte: from, lte: to },
          status:      { in: ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED'] },
        },
        select: { staffId: true, agreedPrice: true },
      });

      for (const member of staffList) {
        const memberAppts = staffAppts.filter(a => a.staffId === member.staffId);
        const revenue     = memberAppts.reduce((s, a) => s + (a.agreedPrice ? Number(a.agreedPrice) : 0), 0);
        byStaff.push({
          staffId:      member.staffId,
          name:         member.name,
          appointments: memberAppts.length,
          revenue,
        });
      }
      byStaff.sort((a, b) => b.appointments - a.appointments);
    }

    // Recent orders (last 50, combined)
    const recentOrders = orders
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 50)
      .map(o => ({
        orderId:       o.orderId,
        createdAt:     o.createdAt,
        type:          o.type,
        customerName:  null as string | null,  // not included to keep query light
        description:   o.orderItems[0]?.product?.name ?? o.orderItems[0]?.service?.name ?? o.orderItems[0]?.description ?? '—',
        amount:        Number(o.total),
        paymentMethod: o.manualPaymentMethod ?? 'OTHER',
      }));

    // Total customers
    const totalCustomers = await this.prisma.customer.count({ where: { storeId } });

    return {
      period,
      from:      from.toISOString().slice(0, 10),
      to:        to.toISOString().slice(0, 10),
      revenue: {
        total:    productRevenue + serviceRevenue,
        products: productRevenue,
        services: serviceRevenue,
      },
      orders: {
        total:    orders.length,
        products: productOrders.length,
        services: serviceOrders.length,
      },
      customers: {
        total: totalCustomers,
        new:   customers.length,
      },
      byPaymentMethod,
      topProducts,
      topServices,
      byStaff,
      recentOrders,
    };
  }
}
