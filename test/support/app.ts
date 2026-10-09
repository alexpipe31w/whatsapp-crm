// Baileys es ESM puro y Jest (CommonJS) no lo carga; WhatsappService va sustituido por el doble,
// así que basta con un módulo vacío para que el import de whatsapp.service.ts no falle.
jest.mock('@whiskeysockets/baileys', () => ({}));

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { WhatsappService } from '../../src/whatsapp/whatsapp.service';
import { FakeWhatsapp } from './fake-whatsapp';

export interface TestApp {
  app: INestApplication;
  wa: FakeWhatsapp;
  close: () => Promise<void>;
}

/** La app real (AppModule + configureApp) con WhatsApp sustituido por el doble. */
export async function createTestApp(): Promise<TestApp> {
  const wa = new FakeWhatsapp();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(WhatsappService)
    .useValue(wa)
    .compile();

  const app = moduleRef.createNestApplication({ rawBody: true, logger: ['error'] });
  configureApp(app);
  await app.init();
  return { app, wa, close: () => app.close() };
}
