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

WSL se apaga sin sesión abierta y se lleva Postgres: para tandas largas, `wsl -u root -- sleep 3600` en segundo plano.
