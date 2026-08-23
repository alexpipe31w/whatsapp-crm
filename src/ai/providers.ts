import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

export type AIProvider = 'groq' | 'openai' | 'together' | 'mistral' | 'anthropic' | 'gemini';

interface ProviderMeta {
  baseURL?: string;
  whisperSupported: boolean;
  whisperBaseURL: string;
  defaultModel: string;
  defaultFastModel: string;
}

export const PROVIDER_CONFIG: Record<AIProvider, ProviderMeta> = {
  groq: {
    baseURL:          'https://api.groq.com/openai/v1',
    whisperSupported: true,
    whisperBaseURL:   'https://api.groq.com/openai/v1',
    // Groq decomisionó toda la familia llama en agosto de 2026 (404 "model does not
    // exist"): llama-3.3-70b-versatile y llama-3.1-8b-instant están muertos. Verificado
    // 2026-08-20 contra GET /openai/v1/models con la key de la tienda: los únicos chat
    // models vivos son openai/gpt-oss-*, qwen/qwen3.6-27b, groq/compound* y allam-2-7b.
    // Whisper NO está afectado (whisper-large-v3 sigue vivo).
    defaultModel:     'openai/gpt-oss-120b',
    defaultFastModel: 'openai/gpt-oss-20b',
  },
  openai: {
    whisperSupported: true,
    whisperBaseURL:   'https://api.openai.com/v1',
    defaultModel:     'gpt-4o',
    defaultFastModel: 'gpt-4o-mini',
  },
  together: {
    baseURL:          'https://api.together.xyz/v1',
    whisperSupported: false,
    whisperBaseURL:   '',
    defaultModel:     'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    defaultFastModel: 'meta-llama/Llama-3.1-8B-Instruct-Turbo',
  },
  mistral: {
    baseURL:          'https://api.mistral.ai/v1',
    whisperSupported: false,
    whisperBaseURL:   '',
    defaultModel:     'mistral-large-latest',
    defaultFastModel: 'mistral-small-latest',
  },
  anthropic: {
    whisperSupported: false,
    whisperBaseURL:   '',
    defaultModel:     'claude-sonnet-4-6',
    defaultFastModel: 'claude-haiku-4-5-20251001',
  },
  gemini: {
    baseURL:          'https://generativelanguage.googleapis.com/v1beta/openai/',
    whisperSupported: false,
    whisperBaseURL:   '',
    // gemini-2.0-flash perdió la cuota free tier (Google devuelve 429 "limit: 0") y
    // gemini-1.5-flash ya no existe (404). La serie 2.5 sí tiene free tier (TPM ~250k,
    // mucho mayor que groq) — verificado 2026-06-20 por el endpoint OpenAI-compat.
    defaultModel:     'gemini-2.5-flash',
    defaultFastModel: 'gemini-2.5-flash-lite',
  },
};

// Modelos gemini que Google capó (429 "limit: 0" sin free tier) o eliminó (404).
// Cuando se guarda una key gemini con uno de estos —o sin modelo—, se normaliza al
// default vivo (gemini-2.5-flash) para que el pool no vuelva a fallar. Ver la nota en
// PROVIDER_CONFIG.gemini. Solo afecta a gemini; el resto de proveedores pasa intacto.
const DEAD_GEMINI_MODEL_RE = /^gemini-(2\.0|1\.5|1\.0|pro)\b/i;

// Modelos groq que Groq decomisionó (404 "The model ... does not exist"): toda la
// familia llama (llama-3.x, meta-llama/llama-3|4-*), mixtral y gemma. Se remapean al
// default vivo (openai/gpt-oss-120b) al guardar el cartucho y al construir el pool,
// para que una config vieja en BD no queme todas las keys en llamadas fallidas. OJO:
// meta-llama/llama-prompt-guard-2-* sigue vivo y NO matchea (no lleva dígito tras
// "llama-"); tampoco se usa como modelo de chat.
const DEAD_GROQ_MODEL_RE = /^(llama[-\d]|meta-llama\/llama-[34]|mixtral|gemma)/i;

/**
 * Devuelve el modelo a persistir para un cartucho. Para gemini, garantiza un modelo
 * con free tier vivo: si viene vacío o es uno de los modelos capados/eliminados, lo
 * reemplaza por PROVIDER_CONFIG.gemini.defaultModel. Para groq hace lo mismo con la
 * familia llama decomisionada (→ PROVIDER_CONFIG.groq.defaultModel). Para los demás
 * proveedores devuelve el modelo tal cual lo envió el usuario (sin tocarlo).
 */
export function normalizeCartridgeModel(provider: string, model?: string | null): string | undefined {
  if (provider === 'gemini') {
    const m = (model ?? '').trim();
    if (!m || DEAD_GEMINI_MODEL_RE.test(m)) return PROVIDER_CONFIG.gemini.defaultModel;
    return m;
  }
  if (provider === 'groq') {
    const m = (model ?? '').trim();
    if (!m || DEAD_GROQ_MODEL_RE.test(m)) return PROVIDER_CONFIG.groq.defaultModel;
    return m;
  }
  return model ?? undefined;
}

export interface CompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Module-level caches — one client per (provider+apiKey)
const openaiCache    = new Map<string, OpenAI>();
const anthropicCache = new Map<string, Anthropic>();

function getOpenAIClient(provider: AIProvider, apiKey: string): OpenAI {
  const key  = `${provider}:${apiKey}`;
  if (!openaiCache.has(key)) {
    const meta = PROVIDER_CONFIG[provider];
    openaiCache.set(key, new OpenAI({
      apiKey,
      ...(meta.baseURL ? { baseURL: meta.baseURL } : {}),
    }));
  }
  return openaiCache.get(key)!;
}

function getAnthropicClient(apiKey: string): Anthropic {
  const key  = `anthropic:${apiKey}`;
  if (!anthropicCache.has(key)) {
    anthropicCache.set(key, new Anthropic({ apiKey }));
  }
  return anthropicCache.get(key)!;
}

export async function createCompletion(
  provider:    AIProvider,
  apiKey:      string,
  model:       string,
  messages:    CompletionMessage[],
  temperature: number,
  maxTokens:   number,
): Promise<string> {
  if (provider === 'anthropic') {
    const client    = getAnthropicClient(apiKey);
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');
    const response  = await client.messages.create({
      model,
      max_tokens:  maxTokens,
      temperature,
      ...(systemMsg ? { system: systemMsg.content } : {}),
      messages: nonSystem as any,
    });
    const block = response.content[0];
    return block.type === 'text' ? block.text : '';
  }

  const client   = getOpenAIClient(provider, apiKey);
  // Los gpt-oss de groq son modelos de razonamiento: el reasoning gasta tokens del
  // mismo presupuesto max_tokens y viaja aparte, en message.reasoning. Con effort
  // "low" baja de ~210 a ~60 tokens (medido contra la API el 2026-08-20), que es lo
  // que evita truncar respuestas y, sobre todo, el JSON de los extractores (700-900).
  const isGroqReasoning = provider === 'groq' && model.startsWith('openai/gpt-oss');
  const response = await client.chat.completions.create({
    model,
    messages:    messages as any,
    temperature,
    max_tokens:  maxTokens,
    ...(isGroqReasoning ? { reasoning_effort: 'low' as const } : {}),
  });

  // Un corte por presupuesto salía mudo: el cliente recibía media frase y en el log no
  // quedaba rastro. Con modelos de razonamiento pasa fácil — el reasoning gasta del
  // mismo max_tokens — así que se avisa con cuánto se gastó en pensar.
  const choice = response.choices[0];
  if (choice?.finish_reason === 'length') {
    const usage     = response.usage as any;
    const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
    console.warn(
      `[AI] Respuesta TRUNCADA por max_tokens=${maxTokens} — modelo=${model} ` +
      `completion=${usage?.completion_tokens ?? '?'} razonamiento=${reasoning ?? '?'} ` +
      `texto=${choice.message?.content?.length ?? 0} chars`,
    );
  }

  return choice?.message?.content ?? '';
}
