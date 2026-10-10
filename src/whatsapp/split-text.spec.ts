import { splitForWhatsapp, WA_MAX_TEXT_LENGTH } from './split-text';

describe('splitForWhatsapp', () => {
  it('un texto corto va entero', () => {
    expect(splitForWhatsapp('hola')).toEqual(['hola']);
  });

  it('sin saltos de línea corta en seco a 4096', () => {
    const parts = splitForWhatsapp('a'.repeat(5000));
    expect(parts.map((p) => p.length)).toEqual([4096, 904]);
  });

  it('corta por el último salto de línea si está por encima del 70 %', () => {
    const text = 'a'.repeat(3500) + '\n' + 'b'.repeat(1500);
    const parts = splitForWhatsapp(text);
    expect(parts[0]).toBe('a'.repeat(3500) + '\n');
    expect(parts[1]).toBe('b'.repeat(1500));
  });

  it('ignora un salto de línea por debajo del 70 %', () => {
    const text = 'a'.repeat(1000) + '\n' + 'b'.repeat(4000);
    expect(splitForWhatsapp(text)[0].length).toBe(4096);
  });

  it('nunca pasa de 4096 aunque el salto caiga justo en la posición 4096 (safeSend daba 4097)', () => {
    const text = 'a'.repeat(4096) + '\n' + 'b'.repeat(10);
    for (const p of splitForWhatsapp(text))
      expect(p.length).toBeLessThanOrEqual(WA_MAX_TEXT_LENGTH);
  });

  it('es determinista y no pierde ni un carácter', () => {
    const text = Array.from(
      { length: 900 },
      (_, i) => `línea ${i} con texto`,
    ).join('\n');
    const a = splitForWhatsapp(text);
    expect(splitForWhatsapp(text)).toEqual(a);
    expect(a.join('')).toBe(text);
  });
});
