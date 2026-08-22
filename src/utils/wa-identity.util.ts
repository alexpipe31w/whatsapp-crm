/**
 * Identidad de un cliente de WhatsApp.
 *
 * Normalmente es su teléfono ("+573001112233"), pero WhatsApp está migrando el
 * direccionamiento a LID y en ese modo el número no viaja en el mensaje: llega
 * `remoteJid = "<user>@lid"` y nada más. No existe consulta inversa LID→PN
 * (getPNForLID solo lee la caché local de la sesión; pnFromLIDUSync va PN→LID),
 * así que para esos clientes el LID ES la identidad, y se guarda como
 * "lid:<user>" en customers.phone.
 *
 * Las dos identidades se cruzan más tarde, cuando WhatsApp llega a entregar el
 * número — ver CustomersService.linkLidIdentity.
 */

export const LID_IDENTITY_PREFIX = 'lid:';

/** Identidad de cliente a partir de un usuario LID. */
export function lidIdentity(waLid: string): string {
  return `${LID_IDENTITY_PREFIX}${waLid}`;
}

/** true si la identidad es un LID sin teléfono conocido. */
export function isLidIdentity(identity: string): boolean {
  return identity.startsWith(LID_IDENTITY_PREFIX);
}

/** Usuario LID contenido en una identidad "lid:<user>", o null si es un teléfono. */
export function lidFromIdentity(identity: string): string | null {
  return isLidIdentity(identity) ? identity.slice(LID_IDENTITY_PREFIX.length) : null;
}

// ─── Direcciones de WhatsApp (jid) ───────────────────────────────────────────

/**
 * Jid del chat. Cuando WhatsApp direcciona por LID pero además entrega el número,
 * viene en remoteJidAlt y se prefiere ese: el teléfono es mejor identidad.
 */
export function resolveJid(key: { remoteJid?: string; remoteJidAlt?: string }): string {
  const rawJid = key.remoteJid ?? '';
  if (rawJid.endsWith('@lid') && key.remoteJidAlt) return key.remoteJidAlt;
  return rawJid;
}

/** Teléfono de un jid "<num>[:device]@s.whatsapp.net", o null si el jid no lo lleva. */
export function phoneFromJid(jid: string): string | null {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
  // El jid puede traer sufijo de dispositivo ("573001112233:26@s.whatsapp.net");
  // el teléfono del cliente es solo la parte anterior a los dos puntos.
  const raw = jid.replace('@s.whatsapp.net', '').split(':')[0];
  return raw ? `+${raw}` : null;
}

/** Usuario LID de un jid "<user>[:device]@lid", o null si no es un jid LID. */
export function lidUserFromJid(jid: string): string | null {
  if (!jid || !jid.endsWith('@lid')) return null;
  const user = jid.replace('@lid', '').split(':')[0];
  return /^\d{5,25}$/.test(user) ? user : null;
}

/**
 * Dirección a la que se envía. La identidad del cliente es normalmente su teléfono,
 * pero cuando WhatsApp no lo entrega es "lid:<user>" y hay que responder al propio
 * LID. Baileys 7 soporta la conversación @lid de primera clase (Socket/messages-send:
 * isLid → targetUserServer 'lid').
 */
export function jidFromPhone(phone: string): string {
  const waLid = lidFromIdentity(phone);
  if (waLid) return `${waLid}@lid`;
  return `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
}
