import { normalizeCartridgeModel, PROVIDER_CONFIG } from './providers';

describe('normalizeCartridgeModel', () => {
  const GROQ_LIVE   = PROVIDER_CONFIG.groq.defaultModel;
  const GEMINI_LIVE = PROVIDER_CONFIG.gemini.defaultModel;

  it('remapea los modelos groq decomisionados al default vivo', () => {
    for (const dead of [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'llama3-70b-8192',
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'mixtral-8x7b-32768',
      'gemma2-9b-it',
    ]) {
      expect(normalizeCartridgeModel('groq', dead)).toBe(GROQ_LIVE);
    }
  });

  it('deja pasar los modelos groq vivos', () => {
    for (const live of ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.6-27b', 'groq/compound']) {
      expect(normalizeCartridgeModel('groq', live)).toBe(live);
    }
  });

  it('no toca meta-llama/llama-prompt-guard-2-*, que sigue vivo', () => {
    expect(normalizeCartridgeModel('groq', 'meta-llama/llama-prompt-guard-2-86m'))
      .toBe('meta-llama/llama-prompt-guard-2-86m');
  });

  it('usa el default cuando el modelo viene vacío', () => {
    expect(normalizeCartridgeModel('groq', '')).toBe(GROQ_LIVE);
    expect(normalizeCartridgeModel('groq', null)).toBe(GROQ_LIVE);
    expect(normalizeCartridgeModel('gemini', undefined)).toBe(GEMINI_LIVE);
  });

  it('mantiene el comportamiento de gemini', () => {
    expect(normalizeCartridgeModel('gemini', 'gemini-2.0-flash')).toBe(GEMINI_LIVE);
    expect(normalizeCartridgeModel('gemini', 'gemini-1.5-flash')).toBe(GEMINI_LIVE);
    expect(normalizeCartridgeModel('gemini', 'gemini-2.5-pro')).toBe('gemini-2.5-pro');
  });

  it('no toca los demás proveedores', () => {
    expect(normalizeCartridgeModel('together', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'))
      .toBe('meta-llama/Llama-3.3-70B-Instruct-Turbo');
    expect(normalizeCartridgeModel('openai', 'gpt-4o')).toBe('gpt-4o');
  });
});
