// Baileys es ESM puro y Jest (CommonJS) no lo carga. Con WhatsappService sustituido, o real
// pero sin filas en whatsapp_sessions (no abre sockets), basta con un módulo vacío.
jest.mock('@whiskeysockets/baileys', () => ({}));

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { WhatsappService } from '../../src/whatsapp/whatsapp.service';
import { WA_TRANSPORT } from '../../src/whatsapp/wa-transport';
import { FakeWhatsapp } from './fake-whatsapp';

export interface TestApp {
  app: INestApplication;
  wa: FakeWhatsapp;
  close: () => Promise<void>;
}

export interface TestAppOptions {
  /**
   * true: WhatsappService real (para probar el flujo de entrada) y solo el transporte
   * sustituido por el doble. Por defecto se sustituye todo WhatsappService.
   */
  realWhatsappService?: boolean;
  /** Sustituciones extra: [token, valor]. */
  overrides?: Array<[unknown, unknown]>;
}

/** La app real (AppModule + configureApp) con WhatsApp sustituido por el doble. */
export async function createTestApp(
  opts: TestAppOptions = {},
): Promise<TestApp> {
  const wa = new FakeWhatsapp();
  let builder = Test.createTestingModule({ imports: [AppModule] });
  builder = opts.realWhatsappService
    ? builder.overrideProvider(WA_TRANSPORT).useValue(wa)
    : builder.overrideProvider(WhatsappService).useValue(wa);
  for (const [token, value] of opts.overrides ?? []) {
    builder = builder.overrideProvider(token as any).useValue(value);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication({
    rawBody: true,
    logger: ['error'],
  });
  configureApp(app);
  await app.init();
  return { app, wa, close: () => app.close() };
}
