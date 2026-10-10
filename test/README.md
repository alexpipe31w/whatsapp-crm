# Tests del CRM

## Una sola vez
Postgres de WSL en el puerto 5434 (el 5433 es el túnel a producción: nunca en tests):

```bash
wsl -u root -- service postgresql start
wsl -u root -- bash -c "sudo -u postgres psql -p 5434 -c \"CREATE ROLE crm_test LOGIN PASSWORD 'crm_test' CREATEDB\""
wsl -u root -- bash -c "sudo -u postgres psql -p 5434 -c \"CREATE DATABASE crm_test OWNER crm_test\""
wsl -u root -- bash -c "sudo -u postgres psql -p 5434 -c \"CREATE DATABASE crm_shadow_test OWNER crm_test\""
```

## Cada vez
- `npm run test:db` — aplica las migraciones a `crm_test`.
- `npm test` — tests unitarios (`src/**/*.spec.ts` y `test/support/*.spec.ts`), sin BD.
- `npm run test:int` — tests de integración (`test/**/*.int-spec.ts`) contra `crm_test`.
- `npm run test:all` — los dos.

## Candados
- La URL de la BD tiene que ser localhost y sin `?host=` / `?hostaddr=`.
- La BD conectada tiene que llamarse `*_test` (para cazar un túnel SSH en un puerto local).
- Ningún test puede abrir sockets fuera de localhost (Groq, Gemini, Meta, Cloudinary, WhatsApp…).
- WhatsApp se sustituye siempre por `FakeWhatsapp` (`test/support/fake-whatsapp.ts`).

## Cola de WhatsApp (`wa_outbound`)
- El despachador está apagado en tests (`WA_OUTBOUND_DISPATCHER=off`, en `setup-env.ts`): se mueve a mano con `t.app.get(OutboundDispatcher).tick()`.
- `t.wa.failNext(err1, err2…)` programa fallos de envío en orden (`null` = ese envío pasa); `t.wa.disconnect(storeId)` / `reconnect(storeId)` simulan el socket caído.
- `createTestApp({ realWhatsappService: true })` usa el `WhatsappService` real (flujo de entrada) y solo sustituye el transporte (`WA_TRANSPORT`).
- `createTestApp({ overrides: [[OUTBOUND_CONFIG, cfg]] })` cambia ritmos y reintentos (`loadOutboundConfig()` + lo que haga falta).
- Los métodos privados se prueban con una vista tipada (`wa as unknown as { processMessage: … }`), no con `as any`.

WSL se apaga sin sesión abierta y se lleva Postgres: para tandas largas, `wsl -u root -- sleep 3600` en segundo plano.
