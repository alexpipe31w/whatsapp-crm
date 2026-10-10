/* eslint-disable @typescript-eslint/require-await -- doble: imita la interfaz async de WhatsappService */
import { WaNotConnectedError } from '../../src/whatsapp/send-errors';
import type { WaTransport } from '../../src/whatsapp/wa-transport';

export interface SentMessage {
  storeId: string;
  /** jid de destino tal cual lo recibió el transporte. */
  jid: string;
  message: string;
}

/**
 * Doble de WhatsappService y de WA_TRANSPORT: nunca abre sockets, registra lo que
 * se habría enviado y permite programar fallos (`failNext`) o desconexión (`disconnect`).
 */
export class FakeWhatsapp implements WaTransport {
  readonly sent: SentMessage[] = [];
  private readonly connected = new Set<string>();
  private readonly offline = new Set<string>();
  private failures: (Error | null)[] = [];
  private seq = 0;

  async onModuleInit(): Promise<void> {}

  async sendPart(storeId: string, jid: string, text: string): Promise<string> {
    if (this.offline.has(storeId)) throw new WaNotConnectedError(storeId);
    if (this.failures.length > 0) {
      const failure = this.failures.shift();
      if (failure) throw failure;
    }
    this.sent.push({ storeId, jid, message: text });
    return `FAKE-${++this.seq}`;
  }

  /** Los próximos envíos fallan con estos errores, en orden (`null` = ese envío pasa). */
  failNext(...errors: (Error | null)[]): void {
    this.failures.push(...errors);
  }

  /** La tienda queda sin socket hasta `reconnect`. */
  disconnect(storeId: string): void {
    this.offline.add(storeId);
  }

  reconnect(storeId: string): void {
    this.offline.delete(storeId);
  }

  /** Compatibilidad hasta la Task 15 (sitios aún no migrados a la cola). */
  async sendMessage(
    storeId: string,
    phone: string,
    message: string,
  ): Promise<void> {
    this.sent.push({ storeId, jid: phone, message });
  }

  async connectStore(storeId: string): Promise<any> {
    this.connected.add(storeId);
    return { status: 'connected' };
  }

  async disconnectStore(storeId: string): Promise<void> {
    this.connected.delete(storeId);
  }

  getQR(): string | null {
    return null;
  }

  isConnected(storeId: string): boolean {
    return this.connected.has(storeId);
  }

  reset(): void {
    this.sent.length = 0;
    this.connected.clear();
    this.offline.clear();
    this.failures = [];
    this.seq = 0;
  }
}
