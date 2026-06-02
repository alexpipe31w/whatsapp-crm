import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

export type AIProvider = 'groq' | 'openai' | 'together' | 'mistral' | 'anthropic';

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
    defaultModel:     'llama-3.3-70b-versatile',
    defaultFastModel: 'llama-3.1-8b-instant',
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
};

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
  if (!anthropicCache.has(apiKey)) {
    anthropicCache.set(apiKey, new Anthropic({ apiKey }));
  }
  return anthropicCache.get(apiKey)!;
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
  const response = await client.chat.completions.create({
    model,
    messages:    messages as any,
    temperature,
    max_tokens:  maxTokens,
  });
  return response.choices[0]?.message?.content ?? '';
}
