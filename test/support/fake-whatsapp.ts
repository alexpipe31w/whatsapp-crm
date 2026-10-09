export interface SentMessage {
  storeId: string;
  phone: string;
  message: string;
}

/** Doble de WhatsappService: nunca abre sockets, registra lo que se habría enviado. */
export class FakeWhatsapp {
  readonly sent: SentMessage[] = [];
  private readonly connected = new Set<string>();

  async onModuleInit(): Promise<void> {}

  async sendMessage(storeId: string, phone: string, message: string): Promise<void> {
    this.sent.push({ storeId, phone, message });
  }

  async connectStore(storeId: string): Promise<any> {
    this.connected.add(storeId);
    return { status: 'connected' };
  }

  async disconnectStore(storeId: string): Promise<void> {
    this.connected.delete(storeId);
  }

  getQR(_storeId: string): string | null {
    return null;
  }

  isConnected(storeId: string): boolean {
    return this.connected.has(storeId);
  }

  reset(): void {
    this.sent.length = 0;
    this.connected.clear();
  }
}
