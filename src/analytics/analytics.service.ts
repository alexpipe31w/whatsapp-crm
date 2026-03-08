import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  async askAdvisor(
    storeId: string,
    context: string,
    messages: { role: 'user' | 'assistant'; content: string }[],
  ) {
    // 1. Obtener la API key configurada por la tienda
    const aiConfig = await this.prisma.aIConfiguration.findUnique({
      where: { storeId },
    });

    if (!aiConfig) {
      throw new NotFoundException(
        'No hay configuración de IA para esta tienda. Ve a "Configurar IA" y agrega tu API key de Groq.',
      );
    }
    if (!aiConfig.groqApiKey) {
      throw new BadRequestException(
        'La tienda no tiene una API key de Groq configurada. Ve a "Configurar IA".',
      );
    }

    // 2. Llamar a Groq desde el backend (key nunca llega al navegador)
    const systemPrompt = `Eres un asesor de negocios experto en e-commerce y ventas por WhatsApp.
Analiza los datos del negocio y da recomendaciones específicas, accionables y en español.
Sé directo, usa números concretos y da consejos prácticos.
Cuando hagas listas usa bullet points con •.

${context}`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aiConfig.groqApiKey}`,
      },
      body: JSON.stringify({
        model: aiConfig.model ?? 'llama-3.3-70b-versatile',
        temperature: 0.7,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new BadRequestException(
        err?.error?.message ?? `Error de Groq: ${response.status}`,
      );
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content ?? 'Sin respuesta';
    return { reply };
  }
}
