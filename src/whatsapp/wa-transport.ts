/**
 * Lo único que el despachador necesita de WhatsApp: mandar UN trozo de texto y
 * devolver el id que le dio WhatsApp. Hoy lo implementa WhatsappService (Baileys);
 * en 1c, el gateway; en el bloque 8, Cloud API.
 * Contrato: un solo intento, sin trocear, sin reintentos. Lanza WaNotConnectedError
 * si no hay socket. El timeout lo pone el despachador.
 */
export const WA_TRANSPORT = Symbol('WA_TRANSPORT');

export interface WaTransport {
  sendPart(storeId: string, jid: string, text: string): Promise<string>;
}
