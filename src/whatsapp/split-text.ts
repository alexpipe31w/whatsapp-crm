export const WA_MAX_TEXT_LENGTH = 4096;

/**
 * Trocea un texto para WhatsApp (máx. 4096 por mensaje). Corta por el último salto
 * de línea si cae por encima del 70 % del trozo; si no, corta en seco. Mismo criterio
 * que el antiguo safeSend, salvo que el salto se busca hasta max-1 (safeSend podía
 * devolver un trozo de 4097). Es determinista: un reintento reanuda por el trozo
 * exacto donde se quedó (wa_outbound.provider_message_ids guarda los ya enviados).
 */
export function splitForWhatsapp(
  text: string,
  max = WA_MAX_TEXT_LENGTH,
): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let cut = max;
    if (remaining.length > max) {
      const lastNewline = remaining.lastIndexOf('\n', max - 1);
      if (lastNewline > max * 0.7) cut = lastNewline + 1;
    }
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return parts;
}
