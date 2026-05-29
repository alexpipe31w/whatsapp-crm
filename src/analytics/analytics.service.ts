import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private prisma: PrismaService) {}

  // ─── Helpers internos ────────────────────────────────────────────────────────

  private async getAiConfig(storeId: string) {
    const aiConfig = await this.prisma.aIConfiguration.findUnique({ where: { storeId } });
    if (!aiConfig)
      throw new NotFoundException('No hay configuración de IA. Ve a "Configuración" → pestaña "Asistente IA".');
    if (!aiConfig.groqApiKey)
      throw new BadRequestException('Falta la API key de Groq. Ve a "Configuración" → pestaña "Asistente IA".');
    return aiConfig;
  }

  private async callGroq(
    apiKey:     string,
    model:      string,
    messages:   { role: string; content: string }[],
    maxTokens = 1024,
    temperature = 0.7,
  ): Promise<string> {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body:    JSON.stringify({ model, temperature, max_tokens: maxTokens, messages }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new BadRequestException(err?.error?.message ?? `Error Groq: ${response.status}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? '';
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

    const reply = await this.callGroq(
      aiConfig.groqApiKey,
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
      const raw = await this.callGroq(
        aiConfig.groqApiKey,
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
}
