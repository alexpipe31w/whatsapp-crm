# Fase 0 — Red de seguridad del CRM · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que cualquier cambio de los bloques siguientes se pueda probar contra un Postgres real de tests, sin poder tocar producción ni salir a internet, con CI en GitHub y migraciones versionadas.

**Architecture:** Jest con dos proyectos: `unit` (los `*.spec.ts` de `src/`, rápidos, sin BD) e `int` (`test/**/*.int-spec.ts`, Postgres real en WSL, `--runInBand`). Un `setup-env` fija el entorno y corta la red antes de importar nada de `src/`. Una app Nest de pruebas reutiliza la misma configuración que `main.ts` y sustituye WhatsApp por un doble. Las migraciones de arranque de `prisma.service.ts` pasan a una migración versionada que en producción se marca como aplicada.

**Tech Stack:** NestJS 11, Prisma 6.19 (generador `prisma-client` + `@prisma/adapter-pg`), Jest 30 + ts-jest, supertest, Postgres 16 (WSL, puerto 5434), GitHub Actions, Node 20 (la versión del pod).

**Spec:** `docs/superpowers/specs/2026-10-09-crm-impecable-design.md` (sección "Fase 0").

---

## Datos que hay que saber antes de empezar

- Repo: `C:\Users\alexp\Desktop\proyectos\whatsapp-crm`, rama de trabajo `fase-0-red-de-seguridad` desde `main`.
- **Producción**: pod `ssh -o BatchMode=yes -p 2229 instapod@167.114.209.204`, app en `~/app`, BD local `instapod` (Postgres 16), servicio `app.service`. El puerto **5433** de esta máquina suele ser un túnel SSH a esa BD: **nunca** usarlo en tests.
- **Postgres de tests**: WSL, puerto **5434** (ya existe por StockUp, BD `stockup_test`). El 5432 es un Postgres 18 nativo de Windows: no usarlo. Si WSL está apagado: `wsl -u root -- service postgresql start`. WSL se apaga sin sesión abierta; para tandas largas mantener `wsl -u root -- sleep 3600` en segundo plano.
- Producción tiene 16 migraciones aplicadas en `_prisma_migrations` (la última `20260510031919_fase1_theme_colors_archived_messages_indices`). Todo lo posterior se aplicó con `STARTUP_MIGRATIONS` en `src/prisma/prisma.service.ts` (`ALTER TABLE ... IF NOT EXISTS` al arrancar).
- `src/generated/prisma` está commiteado y se regenera en cada `npm run build` (`prisma generate && nest build`). En el pod hay que hacer `git stash push -- src/generated` antes de cada `git pull`. Esta fase lo saca de git.
- Hay dos `setInterval` que dejarían a Jest colgado: `src/auth/registration.store.ts:23` (a nivel de módulo) y `src/admin-assistant/admin-assistant.service.ts:64`.
- `WhatsappService.onModuleInit` reconecta sesiones de Baileys: en tests **siempre** se sustituye por el doble.
- Nunca usar `Set-Content` de PowerShell para `.ts` (mete BOM). Usar Write/Edit.

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `test/support/env.ts` | URL por defecto de la BD de tests |
| `test/support/guard.ts` | Candados: URL local sin `?host=`, y nombre de BD `*_test` |
| `test/support/network.ts` | Corta todo socket que no vaya a localhost |
| `test/support/setup-unit.ts` | setupFile del proyecto `unit`: solo red cortada |
| `test/support/setup-env.ts` | setupFile del proyecto `int`: entorno de tests + red cortada |
| `test/support/db.ts` | `testPrisma()` y `resetDb()` con los dos candados |
| `test/support/fake-whatsapp.ts` | Doble de `WhatsappService` que registra los envíos |
| `test/support/app.ts` | `createTestApp()`: AppModule + `configureApp` + doble de WhatsApp |
| `test/support/auth.ts` | `tokenFor(user)`: JWT firmado como lo hace `AuthService` |
| `test/support/factories.ts` | `createStoreWithAdmin`, `createCustomer`, `createProduct`, `createProductWithVariants` |
| `test/support/guard.spec.ts`, `test/support/network.spec.ts` | Tests de los candados (proyecto `unit`) |
| `test/integration/orders.int-spec.ts` | Prueba de humo: aislamiento entre tiendas y cancelación con BD real |
| `src/app.setup.ts` | `configureApp(app)`: helmet, compresión, CORS, ValidationPipe, prefijo `api` (compartido por `main.ts` y los tests) |
| `scripts/test-db.ts` | Aplica las migraciones a la BD de tests con los candados |
| `scripts/deploy-pod.sh` | Deploy en el pod: pull, `npm ci` si cambió el lock, copia de BD y `migrate deploy` si hay migraciones nuevas, build, restart |
| `prisma/migrations/20261010000000_consolidar_migraciones_de_arranque/migration.sql` | Lo que antes hacían las `STARTUP_MIGRATIONS` |
| `.github/workflows/test.yml` | CI con servicio Postgres |
| `test/README.md` | Cómo preparar y correr los tests |

---

### Task 1: Rama y BD de tests en WSL

**Files:**
- Create: `test/support/env.ts`
- Create: `test/README.md`

- [ ] **Step 1: Crear la rama**

```bash
cd /c/Users/alexp/Desktop/proyectos/whatsapp-crm
git checkout main && git pull --ff-only
git checkout -b fase-0-red-de-seguridad
```

- [ ] **Step 2: Crear rol y BDs de tests en el Postgres de WSL (puerto 5434)**

```bash
wsl -u root -- service postgresql start
wsl -u root -- bash -c "sudo -u postgres psql -p 5434 -v ON_ERROR_STOP=1 -c \"CREATE ROLE crm_test LOGIN PASSWORD 'crm_test' CREATEDB\""
wsl -u root -- bash -c "sudo -u postgres psql -p 5434 -v ON_ERROR_STOP=1 -c \"CREATE DATABASE crm_test OWNER crm_test\""
wsl -u root -- bash -c "sudo -u postgres psql -p 5434 -v ON_ERROR_STOP=1 -c \"CREATE DATABASE crm_shadow_test OWNER crm_test\""
```

Expected: `CREATE ROLE`, `CREATE DATABASE`, `CREATE DATABASE`. `crm_shadow_test` es la BD sombra que Prisma usa para calcular diferencias (Task 6).

- [ ] **Step 3: Comprobar que se conecta desde Windows**

```bash
node -e "const {Client}=require('pg');const c=new Client('postgresql://crm_test:crm_test@localhost:5434/crm_test');c.connect().then(()=>c.query('select current_database() db')).then(r=>{console.log(r.rows[0]);return c.end()})"
```

Expected: `{ db: 'crm_test' }`

- [ ] **Step 4: Crear `test/support/env.ts`**

```ts
// URL de la BD de tests. Puerto 5434 = Postgres de WSL. NUNCA 5433 (túnel a producción).
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://crm_test:crm_test@localhost:5434/crm_test';

export const TEST_SHADOW_DATABASE_URL =
  process.env.TEST_SHADOW_DATABASE_URL ??
  'postgresql://crm_test:crm_test@localhost:5434/crm_shadow_test';
```

- [ ] **Step 5: Crear `test/README.md`**

````markdown
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
````

- [ ] **Step 6: Commit**

```bash
git add test/support/env.ts test/README.md
git commit -m "test: BD de tests del CRM en WSL (5434) y README"
```

---

### Task 2: Candados contra producción

**Files:**
- Create: `test/support/guard.ts`
- Test: `test/support/guard.spec.ts`

- [ ] **Step 1: Escribir el test que falla**

`test/support/guard.spec.ts`:

```ts
import { assertLocalDatabase, assertTestDatabaseName } from './guard';

describe('assertLocalDatabase', () => {
  it('acepta localhost', () => {
    const url = 'postgresql://u:p@localhost:5434/crm_test';
    expect(assertLocalDatabase('X', url)).toBe(url);
  });

  it('acepta 127.0.0.1', () => {
    expect(() => assertLocalDatabase('X', 'postgresql://u:p@127.0.0.1:5434/crm_test')).not.toThrow();
  });

  it('rechaza un host remoto', () => {
    expect(() => assertLocalDatabase('X', 'postgresql://u:p@167.114.209.204:5432/instapod')).toThrow(/no a localhost/);
  });

  it('rechaza ?host= que sobrescribe el host real', () => {
    expect(() => assertLocalDatabase('X', 'postgresql://u:p@localhost:5434/crm_test?host=10.0.0.1')).toThrow(/host=/);
  });

  it('rechaza ?hostaddr=', () => {
    expect(() => assertLocalDatabase('X', 'postgresql://u:p@localhost:5434/crm_test?hostaddr=10.0.0.1')).toThrow(/hostaddr=/);
  });

  it('rechaza una URL vacía', () => {
    expect(() => assertLocalDatabase('X', undefined)).toThrow(/no está definida/);
  });

  it('rechaza algo que no es postgres', () => {
    expect(() => assertLocalDatabase('X', 'mysql://u:p@localhost/crm_test')).toThrow(/postgres/);
  });
});

describe('assertTestDatabaseName', () => {
  it('acepta *_test', () => {
    expect(assertTestDatabaseName('crm_test')).toBe('crm_test');
  });

  it('rechaza la BD de producción aunque llegue por un túnel local', () => {
    expect(() => assertTestDatabaseName('instapod')).toThrow(/_test/);
  });
});
```

- [ ] **Step 2: Comprobar que falla**

Run: `npx jest test/support/guard.spec.ts --rootDir .`
Expected: FAIL, `Cannot find module './guard'`.

- [ ] **Step 3: Implementar `test/support/guard.ts`**

```ts
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const POSTGRES_PROTOCOLS = new Set(['postgresql:', 'postgres:']);
const HOST_OVERRIDE_PARAM = /^host(addr)?$/i;

/**
 * Primera llave: la BD tiene que estar en esta máquina. Rechaza también
 * `?host=`/`?hostaddr=`, porque pg les da prioridad sobre el host de la URL.
 */
export function assertLocalDatabase(name: string, url: string | undefined): string {
  if (!url) throw new Error(`[test-guard] ${name} no está definida`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`[test-guard] ${name} no es una URL válida`);
  }
  if (!POSTGRES_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`[test-guard] ${name} no es una URL de postgres`);
  }
  for (const key of parsed.searchParams.keys()) {
    if (HOST_OVERRIDE_PARAM.test(key)) {
      throw new Error(`[test-guard] ${name} trae "${key}=" en la query, que sobrescribe el host. Prohibido en tests.`);
    }
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`[test-guard] ${name} apunta a "${parsed.hostname}", no a localhost. Abortando para no tocar producción.`);
  }
  return url;
}

/**
 * Segunda llave, sobre la conexión real: un túnel SSH en un puerto local pasa la
 * primera. Las BDs de tests se llaman *_test.
 */
export function assertTestDatabaseName(name: string): string {
  if (!/_test$/.test(name)) {
    throw new Error(`[test-guard] conectado a la BD "${name}", que no termina en _test. Abortando para no tocar producción.`);
  }
  return name;
}
```

- [ ] **Step 4: Comprobar que pasa**

Run: `npx jest test/support/guard.spec.ts --rootDir .`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add test/support/guard.ts test/support/guard.spec.ts
git commit -m "test: candados contra producción (host local y BD *_test)"
```

---

### Task 3: Red cortada en los tests

**Files:**
- Create: `test/support/network.ts`
- Test: `test/support/network.spec.ts`

- [ ] **Step 1: Escribir el test que falla**

`test/support/network.spec.ts`:

```ts
import net from 'node:net';
import { installNetworkGuard } from './network';

function tryConnect(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.once('connect', () => { s.destroy(); resolve('connected'); });
    s.once('error', (e) => resolve(e.message));
  });
}

describe('installNetworkGuard', () => {
  beforeAll(() => installNetworkGuard());

  it('bloquea un host externo', async () => {
    await expect(tryConnect('api.groq.com', 443)).resolves.toMatch(/net-guard/);
  });

  it('bloquea una IP externa', async () => {
    await expect(tryConnect('167.114.209.204', 2229)).resolves.toMatch(/net-guard/);
  });

  it('deja pasar localhost (puede no haber nadie escuchando, pero no es el candado)', async () => {
    const msg = await tryConnect('127.0.0.1', 1);
    expect(msg).not.toMatch(/net-guard/);
  });

  it('instalarlo dos veces no lo duplica', async () => {
    installNetworkGuard();
    await expect(tryConnect('graph.facebook.com', 443)).resolves.toMatch(/net-guard/);
  });
});
```

- [ ] **Step 2: Comprobar que falla**

Run: `npx jest test/support/network.spec.ts --rootDir .`
Expected: FAIL, `Cannot find module './network'`.

- [ ] **Step 3: Implementar `test/support/network.ts`**

```ts
import net from 'node:net';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const INSTALLED = Symbol.for('crm.netGuardInstalled');

/**
 * Corta a nivel de socket toda conexión que no sea a localhost. Cubre fetch, axios,
 * los SDK de Groq/Gemini/Cloudinary, Baileys y cualquier https directo.
 * Postgres en localhost y los sockets unix siguen funcionando.
 */
export function installNetworkGuard(): void {
  const proto = net.Socket.prototype as net.Socket & { [INSTALLED]?: boolean };
  if (proto[INSTALLED]) return;
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const [first, second] = args;
    const opts = (typeof first === 'object' && first !== null ? first : {}) as { host?: string; path?: string };
    const isUnixSocket = typeof opts.path === 'string';
    const host =
      typeof first === 'number' || typeof first === 'string'
        ? typeof second === 'string' ? second : 'localhost'
        : (opts.host ?? 'localhost');
    if (!isUnixSocket && !LOCAL_HOSTS.has(host)) {
      process.nextTick(() => this.destroy(new Error(`[net-guard] conexión de red no permitida en tests: ${host}`)));
      return this;
    }
    return (original as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  proto[INSTALLED] = true;
}
```

- [ ] **Step 4: Comprobar que pasa**

Run: `npx jest test/support/network.spec.ts --rootDir .`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add test/support/network.ts test/support/network.spec.ts
git commit -m "test: red cortada en los tests (solo localhost)"
```

---

### Task 4: Jest con proyectos `unit` e `int`

**Files:**
- Create: `test/support/setup-unit.ts`
- Create: `test/support/setup-env.ts`
- Modify: `package.json` (bloques `scripts` y `jest`)
- Delete: `test/app.e2e-spec.ts`, `test/jest-e2e.json` (es el "Hello World" de la plantilla de Nest; no prueba nada del CRM)

- [ ] **Step 1: Crear `test/support/setup-unit.ts`**

```ts
import { installNetworkGuard } from './network';

installNetworkGuard();
```

- [ ] **Step 2: Crear `test/support/setup-env.ts`**

```ts
import { assertLocalDatabase } from './guard';
import { TEST_DATABASE_URL } from './env';
import { installNetworkGuard } from './network';

// Primer setupFile del proyecto int y sin imports de src/: PrismaService y
// ConfigModule leen el entorno al instanciarse, así que va fijado antes.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = assertLocalDatabase('TEST_DATABASE_URL', TEST_DATABASE_URL);
process.env.JWT_SECRET = 'test-jwt-secret-con-mas-de-32-caracteres-xx';
process.env.JWT_EXPIRES_IN = '1h';
process.env.GROQ_API_KEY = 'test-groq-key';
process.env.CRON_SECRET = 'test-cron-secret';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
process.env.BREVO_API_KEY = '';
process.env.CLOUDINARY_CLOUD_NAME = 'test';
process.env.CLOUDINARY_API_KEY = 'test';
process.env.CLOUDINARY_API_SECRET = 'test';

installNetworkGuard();
```

- [ ] **Step 3: Reemplazar el bloque `jest` y los scripts de test en `package.json`**

Scripts (sustituir `test`, `test:watch`, `test:cov`, `test:e2e`; dejar `test:debug`):

```json
    "test": "jest --selectProjects unit",
    "test:watch": "jest --selectProjects unit --watch",
    "test:cov": "jest --selectProjects unit --coverage",
    "test:int": "jest --selectProjects int --runInBand",
    "test:all": "npm test && npm run test:int",
    "test:db": "ts-node --transpile-only scripts/test-db.ts",
```

Bloque `jest` completo:

```json
  "jest": {
    "projects": [
      {
        "displayName": "unit",
        "rootDir": ".",
        "moduleFileExtensions": ["js", "json", "ts"],
        "testMatch": ["<rootDir>/src/**/*.spec.ts", "<rootDir>/test/support/**/*.spec.ts"],
        "transform": { "^.+\\.(t|j)s$": "ts-jest" },
        "setupFiles": ["<rootDir>/test/support/setup-unit.ts"],
        "testEnvironment": "node"
      },
      {
        "displayName": "int",
        "rootDir": ".",
        "moduleFileExtensions": ["js", "json", "ts"],
        "testMatch": ["<rootDir>/test/**/*.int-spec.ts"],
        "transform": { "^.+\\.(t|j)s$": "ts-jest" },
        "setupFiles": ["<rootDir>/test/support/setup-env.ts"],
        "testEnvironment": "node",
        "testTimeout": 30000
      }
    ]
  }
```

- [ ] **Step 4: Borrar la plantilla e2e**

```bash
git rm test/app.e2e-spec.ts test/jest-e2e.json
```

- [ ] **Step 5: Correr la suite unitaria**

Run: `npm test`
Expected: PASS. Las 12 suites que ya había en `src/` + `guard.spec.ts` + `network.spec.ts`. Si algún test existente intentaba salir a red, ahora falla con `[net-guard]`: anotarlo en el plan (sección "Hallazgos") y arreglar el test para que use un doble, no quitar el candado.

- [ ] **Step 6: Commit**

```bash
git add package.json test/support/setup-unit.ts test/support/setup-env.ts
git commit -m "test: jest con proyectos unit e int, red cortada en ambos"
```

---

### Task 5: Quitar los temporizadores que cuelgan a Jest

**Files:**
- Modify: `src/auth/registration.store.ts:23`
- Modify: `src/admin-assistant/admin-assistant.service.ts:64`

- [ ] **Step 1: Leer los dos sitios**

Run: `sed -n 15,35p src/auth/registration.store.ts; sed -n 55,70p src/admin-assistant/admin-assistant.service.ts`

- [ ] **Step 2: Añadir `.unref()` a los dos `setInterval`**

En `src/auth/registration.store.ts`, el `setInterval(() => { ... }, N);` de nivel de módulo pasa a:

```ts
setInterval(() => {
  // (cuerpo sin cambios)
}, N).unref(); // no mantiene vivo el proceso: limpieza de fondo, no trabajo pendiente
```

En `src/admin-assistant/admin-assistant.service.ts:64`:

```ts
    this.cleanupTimer = setInterval(() => this.cleanSessions(), 30 * 60 * 1000);
    this.cleanupTimer.unref(); // no mantiene vivo el proceso (tests, apagado)
```

(Conservar el valor `N` y el cuerpo exactos que hay hoy.)

- [ ] **Step 3: Compilar**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sin errores.

- [ ] **Step 4: Commit**

```bash
git add src/auth/registration.store.ts src/admin-assistant/admin-assistant.service.ts
git commit -m "fix: temporizadores de limpieza con unref (no cuelgan tests ni el apagado)"
```

---

### Task 6: Migraciones versionadas en vez de migraciones de arranque

**Files:**
- Create: `prisma/migrations/20261010000000_consolidar_migraciones_de_arranque/migration.sql`
- Create: `scripts/test-db.ts`
- Modify: `src/prisma/prisma.service.ts` (borrar `STARTUP_MIGRATIONS` y `runStartupMigrations`)

- [ ] **Step 1: Crear `scripts/test-db.ts`**

```ts
/**
 * Aplica las migraciones a la BD de tests. Fija DATABASE_URL ANTES de lanzar
 * Prisma para que nunca use la del .env (producción o túnel).
 */
import { spawnSync } from 'node:child_process';
import { assertLocalDatabase, assertTestDatabaseName } from '../test/support/guard';
import { TEST_DATABASE_URL } from '../test/support/env';

const url = assertLocalDatabase('TEST_DATABASE_URL', TEST_DATABASE_URL);
assertTestDatabaseName(new URL(url).pathname.slice(1));

const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url },
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
```

- [ ] **Step 2: Calcular qué falta entre las 16 migraciones y `schema.prisma`**

```bash
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url postgresql://crm_test:crm_test@localhost:5434/crm_shadow_test \
  --script > /tmp/consolidar.sql
cat /tmp/consolidar.sql
```

Expected: un script con las columnas y tablas que hoy crean las `STARTUP_MIGRATIONS` (`commission_percentage`, `suspended_from/until`, `default_service_id`, `auto_confirm_appointments`, `stockup_*`, `wa_lid`, `stockup_connections`, `sync_outbox`, `sync_inbox`, `order_*` de `stores`, etc.), y quizá otras diferencias acumuladas por `prisma db push` antiguos. **Si aparece algún `DROP`, parar y anotarlo en "Hallazgos"**: significa que el esquema y la historia discrepan y hay que decidir con Alex antes de seguir.

- [ ] **Step 3: Guardar el resultado como migración**

```bash
mkdir -p prisma/migrations/20261010000000_consolidar_migraciones_de_arranque
cp /tmp/consolidar.sql prisma/migrations/20261010000000_consolidar_migraciones_de_arranque/migration.sql
```

Añadir al principio del archivo:

```sql
-- Consolida lo que hasta 2026-10-10 aplicaban las STARTUP_MIGRATIONS de
-- src/prisma/prisma.service.ts. En producción estas columnas/tablas YA existen:
-- allí esta migración se marca como aplicada con `prisma migrate resolve --applied`
-- (ver scripts/deploy-pod.sh), nunca se ejecuta.
```

Y añadir al final del archivo lo que Prisma no puede expresar en `schema.prisma` (por eso `migrate diff` no lo genera):

```sql
-- Índice único PARCIAL: Prisma no declara índices con WHERE. Un LID por tienda,
-- solo cuando se conoce (identidad híbrida teléfono/LID de WhatsApp).
CREATE UNIQUE INDEX IF NOT EXISTS customers_store_wa_lid_key
  ON customers (store_id, wa_lid) WHERE wa_lid IS NOT NULL;
```

Los `UPDATE` de saneamiento de `STARTUP_MIGRATIONS` (modelos de IA retirados, `max_tokens`, copia de `has_delivery`/`requires_deposit`/`requires_customer_cedula` a `order_*`) **no** se copian: ya se aplicaron en producción y una BD nueva no tiene filas que sanear.

**Nombres de índices:** en producción el índice de `sync_outbox` se llama `sync_outbox_status_retry`, pero `schema.prisma` declara `@@index([status, nextRetryAt])` sin nombre (Prisma lo llamaría `sync_outbox_status_next_retry_at_idx`). Para que esquema y producción coincidan, en `prisma/schema.prisma` → `model SyncOutbox` cambiar a:

```prisma
  @@index([status, nextRetryAt], map: "sync_outbox_status_retry")
```

y repetir el Step 2 para regenerar el script con el nombre bueno. Hacer lo mismo con cualquier otro índice o restricción que el Step 6 muestre solo como renombrado.

- [ ] **Step 4: Aplicar las 17 migraciones a la BD de tests**

Run: `npm run test:db`
Expected: `All migrations have been successfully applied.` (17).

- [ ] **Step 5: Comprobar que la BD de tests coincide con el esquema**

```bash
npx prisma migrate diff \
  --from-url postgresql://crm_test:crm_test@localhost:5434/crm_test \
  --to-schema-datamodel prisma/schema.prisma --exit-code
```

Expected: una sola diferencia, `DROP INDEX "customers_store_wa_lid_key"`: es el índice parcial que Prisma no conoce. Es esperado. Cualquier otra diferencia = la migración consolidada no está completa; corregirla y volver al Step 4 (borrar y recrear `crm_test` antes: `wsl -u root -- bash -c "sudo -u postgres psql -p 5434 -c 'DROP DATABASE crm_test' -c 'CREATE DATABASE crm_test OWNER crm_test'"`).

**Footgun permanente:** por ese índice, en este repo **nunca** se usa `prisma db push` ni `prisma migrate dev` contra una BD con datos: lo borrarían. Las migraciones nuevas se generan con `prisma migrate diff ... --script` y se revisan a mano. Añadir esta advertencia como comentario encima de `waLid` en `schema.prisma`.

- [ ] **Step 6: Comprobar, SOLO LECTURA, que producción también coincide con el esquema**

Abrir el túnel en otra terminal (`ssh -N -L 5433:localhost:5432 -p 2229 instapod@167.114.209.204`) y con la URL de producción del `.env` del pod (no copiarla a ningún archivo):

```bash
npx prisma migrate diff --from-url "<URL de producción por el túnel 5433>" \
  --to-schema-datamodel prisma/schema.prisma --script
```

Expected: solo `DROP INDEX "customers_store_wa_lid_key"` (el índice parcial, esperado). Un renombrado de índice → ajustar `map:` en el esquema como en el Step 3. Cualquier otro `ALTER`/`CREATE`/`DROP` = producción no coincide con el esquema → anotarlo en "Hallazgos" y decidir con Alex antes del deploy. `migrate diff` no escribe en la BD.

- [ ] **Step 7: Borrar las migraciones de arranque de `src/prisma/prisma.service.ts`**

Eliminar la constante `STARTUP_MIGRATIONS`, el método `runStartupMigrations` y su llamada. `onModuleInit` queda:

```ts
  async onModuleInit() {
    await this.$connect();
    this.logger.log('Conectado a la base de datos');
  }
```

- [ ] **Step 8: Compilar y correr los unitarios**

Run: `npx tsc --noEmit -p tsconfig.json && npm test`
Expected: sin errores, todo en verde.

- [ ] **Step 9: Commit**

```bash
git add scripts/test-db.ts prisma/migrations/20261010000000_consolidar_migraciones_de_arranque src/prisma/prisma.service.ts prisma/schema.prisma
git commit -m "feat(db): migraciones versionadas; fuera las migraciones de arranque"
```

---

### Task 7: Sacar el cliente de Prisma generado de git

**Files:**
- Modify: `.gitignore`
- Modify: `package.json` (`postinstall`)

- [ ] **Step 1: Ignorar la carpeta generada**

En `.gitignore`, sustituir el bloque `# Prisma engine binaries ...` (3 líneas `src/generated/prisma/...`) por:

```gitignore
# Cliente Prisma: se genera en `npm install` (postinstall) y en `npm run build`.
# Commitearlo generado en Windows tumbó producción (2026-06) y obligaba a stash en cada pull.
src/generated/
```

- [ ] **Step 2: Generar el cliente al instalar**

En `package.json` → `scripts`, añadir:

```json
    "postinstall": "prisma generate",
```

- [ ] **Step 3: Dejar de seguir los archivos (sin borrarlos del disco)**

```bash
git rm -r --cached src/generated
git status --short | head
```

Expected: muchas líneas `D  src/generated/prisma/...` y ningún otro cambio.

- [ ] **Step 4: Comprobar que todo se regenera desde cero**

```bash
rm -rf src/generated
npm run build
ls src/generated/prisma/client.ts
npm test
```

Expected: el build genera el cliente, `client.ts` existe, los unitarios pasan.

- [ ] **Step 5: Commit**

```bash
git add .gitignore package.json
git commit -m "chore: el cliente Prisma generado sale de git (postinstall + build lo regeneran)"
```

---

### Task 8: Configuración de la app compartida entre `main.ts` y los tests

**Files:**
- Create: `src/app.setup.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Crear `src/app.setup.ts` con lo que hoy hace `main.ts` antes de `listen`**

```ts
import { INestApplication, ValidationPipe } from '@nestjs/common';
import compression from 'compression';
import helmet from 'helmet';

/**
 * Configuración HTTP común a producción y tests: si los tests no pasaran por
 * aquí, probarían una app con otro CORS, otra validación y sin el prefijo /api.
 */
export function configureApp(app: INestApplication): void {
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
  }));

  app.use(compression());

  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['http://localhost:3000', 'http://localhost:3001'];

  // Capacitor: Android usa https://localhost, iOS capacitor://localhost
  const capacitorOrigins = ['https://localhost', 'capacitor://localhost', 'ionic://localhost'];

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (capacitorOrigins.includes(origin)) return callback(null, true);
      if (allowedOrigins.some(o => o === '*' || origin === o)) return callback(null, true);
      callback(new Error(`CORS: origen no permitido: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id'],
  });

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));

  app.setGlobalPrefix('api');
}
```

- [ ] **Step 2: `src/main.ts` usa `configureApp`**

```ts
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { PrismaService } from './prisma/prisma.service';

async function bootstrap() {
  // rawBody: necesario para verificar firmas HMAC del sync StockUp (integrations)
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app);

  // Health check fuera del prefijo /api — para uptime checks
  const httpAdapter = app.getHttpAdapter();
  const prisma = app.get(PrismaService);

  httpAdapter.get('/health', async (_req: any, res: any) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.status(200).json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'error', db: 'disconnected', ts: new Date().toISOString() });
    }
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  Logger.log(`🚀 Server running on port ${port}`);
}
bootstrap();
```

- [ ] **Step 3: Compilar**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sin errores.

- [ ] **Step 4: Commit**

```bash
git add src/app.setup.ts src/main.ts
git commit -m "refactor: configureApp compartido por main.ts y los tests"
```

---

### Task 9: Utilidades de tests de integración

**Files:**
- Create: `test/support/db.ts`
- Create: `test/support/fake-whatsapp.ts`
- Create: `test/support/app.ts`
- Create: `test/support/auth.ts`
- Create: `test/support/factories.ts`

- [ ] **Step 1: `test/support/db.ts`**

```ts
import { PrismaService } from '../../src/prisma/prisma.service';
import { assertLocalDatabase, assertTestDatabaseName } from './guard';

let client: PrismaService | null = null;

/** Cliente Prisma de los tests (mismo PrismaService que usa la app). */
export function testPrisma(): PrismaService {
  if (!client) {
    assertLocalDatabase('DATABASE_URL', process.env.DATABASE_URL);
    client = new PrismaService();
  }
  return client;
}

/** Vacía todas las tablas. Se niega a correr fuera de localhost o de una BD *_test. */
export async function resetDb(): Promise<void> {
  const prisma = testPrisma();
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
  assertTestDatabaseName(db);

  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

export async function closeTestPrisma(): Promise<void> {
  if (client) await client.$disconnect();
  client = null;
}
```

- [ ] **Step 2: `test/support/fake-whatsapp.ts`**

Implementa los métodos de `WhatsappService` que usa el resto de la app (`sendMessage`, `connectStore`, `disconnectStore`, `getQR`, `isConnected`) y nada más. Si un test futuro necesita otro, se añade aquí.

```ts
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
```

Antes de dar por cerrado este paso, comprobar las firmas reales: `grep -n "async sendMessage\|async connectStore\|async disconnectStore\|getQR(\|isConnected(" src/whatsapp/whatsapp.service.ts`. Si alguna es síncrona/asíncrona distinta o devuelve otra forma, igualar el doble a la real.

- [ ] **Step 3: `test/support/app.ts`**

```ts
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
```

- [ ] **Step 4: `test/support/auth.ts`**

Mismo payload que `AuthService` (`src/auth/auth.service.ts:149`): `{ sub, email, role, storeId }`.

```ts
import { JwtService } from '@nestjs/jwt';

export interface TokenUser {
  userId: string;
  email: string;
  role: string;
  storeId: string | null;
}

export function tokenFor(user: TokenUser): string {
  const jwt = new JwtService({ secret: process.env.JWT_SECRET });
  return jwt.sign({ sub: user.userId, email: user.email, role: user.role, storeId: user.storeId }, { expiresIn: '1h' });
}

export function bearer(user: TokenUser): { Authorization: string } {
  return { Authorization: `Bearer ${tokenFor(user)}` };
}
```

- [ ] **Step 5: `test/support/factories.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { testPrisma } from './db';
import { TokenUser } from './auth';

let seq = 0;
const next = () => ++seq;

export interface StoreWithAdmin {
  storeId: string;
  admin: TokenUser;
}

/** Tienda + usuario admin de esa tienda. `label` solo sirve para leer los fallos. */
export async function createStoreWithAdmin(label = 'tienda'): Promise<StoreWithAdmin> {
  const prisma = testPrisma();
  const n = next();
  const store = await prisma.store.create({
    data: { name: `${label} ${n}`, phone: `57300000${String(n).padStart(4, '0')}` },
  });
  const user = await prisma.user.create({
    data: {
      name: `Admin ${label} ${n}`,
      email: `admin-${n}-${randomUUID().slice(0, 6)}@test.local`,
      password: 'no-se-usa-en-tests',
      role: 'admin',
      storeId: store.storeId,
    },
  });
  return {
    storeId: store.storeId,
    admin: { userId: user.userId, email: user.email, role: user.role, storeId: store.storeId },
  };
}

export async function createCustomer(storeId: string, name = 'Cliente') {
  const n = next();
  return testPrisma().customer.create({
    data: { storeId, phone: `57310000${String(n).padStart(4, '0')}`, name },
  });
}

export async function createProduct(storeId: string, opts: { name?: string; price?: number; stock?: number } = {}) {
  return testPrisma().product.create({
    data: {
      storeId,
      name: opts.name ?? `Producto ${next()}`,
      salePrice: opts.price ?? 10000,
      stock: opts.stock ?? 10,
    },
  });
}

export async function createProductWithVariants(
  storeId: string,
  variants: { name: string; stock: number; price?: number }[],
) {
  const prisma = testPrisma();
  const product = await prisma.product.create({
    data: { storeId, name: `Producto con variantes ${next()}`, salePrice: 10000, stock: 0, hasVariants: true },
  });
  const created = [];
  for (const [i, v] of variants.entries()) {
    created.push(await prisma.productVariant.create({
      data: { productId: product.productId, name: v.name, stock: v.stock, salePrice: v.price ?? 10000, sortOrder: i },
    }));
  }
  return { product, variants: created };
}
```

Si `prisma.customer.create` exige más campos obligatorios de los que muestra el esquema (por ejemplo `name`), añadirlos aquí; no tocar el esquema.

- [ ] **Step 6: Compilar**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sin errores. (`tsconfig.json` no tiene `include`, así que compila también `test/`; `tsconfig.build.json` excluye `test` del build.)

- [ ] **Step 7: Commit**

```bash
git add test/support/db.ts test/support/fake-whatsapp.ts test/support/app.ts test/support/auth.ts test/support/factories.ts
git commit -m "test: app de pruebas, doble de WhatsApp, JWT y fábricas de dos tiendas"
```

---

### Task 10: Prueba de humo con BD real (aislamiento y cancelación)

**Files:**
- Test: `test/integration/orders.int-spec.ts`

Esta prueba no busca bugs nuevos: demuestra que la red de seguridad funciona de punta a punta (HTTP → guard JWT → servicio → Postgres) y fija el arreglo del 2026-10-09 (cancelar devuelve stock) contra la BD real.

- [ ] **Step 1: Escribir los tests**

```ts
import request from 'supertest';
import { createTestApp, TestApp } from '../support/app';
import { bearer } from '../support/auth';
import { closeTestPrisma, resetDb, testPrisma } from '../support/db';
import { createCustomer, createProduct, createProductWithVariants, createStoreWithAdmin } from '../support/factories';

describe('pedidos (BD real)', () => {
  let t: TestApp;

  beforeAll(async () => { t = await createTestApp(); });
  afterAll(async () => { await t.close(); await closeTestPrisma(); });
  beforeEach(async () => { await resetDb(); t.wa.reset(); });

  it('la tienda B no puede leer un pedido de la tienda A', async () => {
    const a = await createStoreWithAdmin('A');
    const b = await createStoreWithAdmin('B');
    const customer = await createCustomer(a.storeId);
    const product = await createProduct(a.storeId, { stock: 5 });

    const created = await request(t.app.getHttpServer())
      .post('/api/orders/manual')
      .set(bearer(a.admin))
      .send({ customerId: customer.customerId, items: [{ productId: product.productId, quantity: 1, unitPrice: 10000 }] })
      .expect(201);

    await request(t.app.getHttpServer())
      .get(`/api/orders/${created.body.orderId}`)
      .set(bearer(b.admin))
      .expect(403);
  });

  it('la tienda B no puede cancelar un pedido de la tienda A', async () => {
    const a = await createStoreWithAdmin('A');
    const b = await createStoreWithAdmin('B');
    const customer = await createCustomer(a.storeId);
    const product = await createProduct(a.storeId, { stock: 5 });

    const created = await request(t.app.getHttpServer())
      .post('/api/orders/manual')
      .set(bearer(a.admin))
      .send({ customerId: customer.customerId, items: [{ productId: product.productId, quantity: 2, unitPrice: 10000 }] })
      .expect(201);

    await request(t.app.getHttpServer())
      .patch(`/api/orders/${created.body.orderId}/status`)
      .set(bearer(b.admin))
      .send({ status: 'cancelled' })
      .expect(403);

    const after = await testPrisma().product.findUniqueOrThrow({ where: { productId: product.productId } });
    expect(after.stock).toBe(3);
  });

  it('cancelar devuelve el stock de la variante en la BD', async () => {
    const a = await createStoreWithAdmin('A');
    const customer = await createCustomer(a.storeId);
    const { product, variants } = await createProductWithVariants(a.storeId, [{ name: 'Arazá', stock: 50 }]);

    const created = await request(t.app.getHttpServer())
      .post('/api/orders/manual')
      .set(bearer(a.admin))
      .send({
        customerId: customer.customerId,
        items: [{ productId: product.productId, variantId: variants[0].variantId, quantity: 2, unitPrice: 3500 }],
      })
      .expect(201);

    let v = await testPrisma().productVariant.findUniqueOrThrow({ where: { variantId: variants[0].variantId } });
    expect(v.stock).toBe(48);

    await request(t.app.getHttpServer())
      .patch(`/api/orders/${created.body.orderId}/status`)
      .set(bearer(a.admin))
      .send({ status: 'cancelled' })
      .expect(200);

    v = await testPrisma().productVariant.findUniqueOrThrow({ where: { variantId: variants[0].variantId } });
    expect(v.stock).toBe(50);
  });

  it('dos cancelaciones simultáneas devuelven el stock una sola vez', async () => {
    const a = await createStoreWithAdmin('A');
    const customer = await createCustomer(a.storeId);
    const product = await createProduct(a.storeId, { stock: 10 });

    const created = await request(t.app.getHttpServer())
      .post('/api/orders/manual')
      .set(bearer(a.admin))
      .send({ customerId: customer.customerId, items: [{ productId: product.productId, quantity: 3, unitPrice: 10000 }] })
      .expect(201);

    const cancel = () => request(t.app.getHttpServer())
      .patch(`/api/orders/${created.body.orderId}/status`)
      .set(bearer(a.admin))
      .send({ status: 'cancelled' });

    const [r1, r2] = await Promise.all([cancel(), cancel()]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);

    const after = await testPrisma().product.findUniqueOrThrow({ where: { productId: product.productId } });
    expect(after.stock).toBe(10);
  });

  it('ningún test sale por WhatsApp de verdad', () => {
    expect(t.wa.sent).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr**

Run: `npm run test:db && npm run test:int`
Expected: PASS, 5 tests. Posibles fallos y qué significan:
- `403` esperado pero llega otro código en los dos primeros → **bug de aislamiento real**: no arreglarlo aquí; cambiar ese `it` a `it.failing` con un comentario `// Bloque 2: <descripción>` y anotarlo en "Hallazgos".
- La simultánea devuelve `[200, 200]` → la transacción no serializa en Postgres real: anotarlo en "Hallazgos" (va al bloque 3) y marcar `it.failing`.
- Jest no termina ("open handles") → buscar otro temporizador o socket sin cerrar con `npm run test:int -- --detectOpenHandles` y arreglarlo como en la Task 5.

- [ ] **Step 3: Comprobar que el candado de BD funciona de verdad**

Run: `TEST_DATABASE_URL=postgresql://crm_test:crm_test@localhost:5434/postgres npm run test:int`
Expected: FAIL con `[test-guard] conectado a la BD "postgres", que no termina en _test`. (Postgres crea la BD `postgres` por defecto; no hace falta tener nada en ella.)

- [ ] **Step 4: Commit**

```bash
git add test/integration/orders.int-spec.ts
git commit -m "test: prueba de humo con BD real (aislamiento y cancelación de pedidos)"
```

---

### Task 11: CI en GitHub Actions

**Files:**
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Crear el workflow**

```yaml
name: tests

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: crm_test
          POSTGRES_PASSWORD: crm_test
          POSTGRES_DB: crm_test
        ports:
          - 5434:5432
        options: >-
          --health-cmd "pg_isready -U crm_test"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      TEST_DATABASE_URL: postgresql://crm_test:crm_test@localhost:5434/crm_test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx tsc --noEmit -p tsconfig.json
      - run: npm test
      - run: npm run test:db
      - run: npm run test:int
      - run: npm run build
```

(`npm ci` lanza `postinstall` → `prisma generate`. Push solo en `main` para no correr dos veces en los PR.)

- [ ] **Step 2: Commit y subir la rama**

```bash
git add .github/workflows/test.yml
git commit -m "ci: tests unitarios, de integración y build en GitHub Actions"
git push -u origin fase-0-red-de-seguridad
```

- [ ] **Step 3: Comprobar el run**

Run: `gh run list -R alexpipe31w/whatsapp-crm -L 1` y luego `gh run watch <id> --exit-status`.
Expected: `success`. Si no hay run (el workflow solo corre en `main` y PR), abrir un PR borrador: `gh pr create --draft --title "Fase 0: red de seguridad" --body "Plan: docs/superpowers/plans/2026-10-10-fase-0-red-de-seguridad.md"`.

---

### Task 12: Script de deploy en el pod y marca de la migración consolidada

**Files:**
- Create: `scripts/deploy-pod.sh`

- [ ] **Step 1: Crear `scripts/deploy-pod.sh`**

```bash
#!/usr/bin/env bash
# Deploy del CRM en el pod. Uso (en el pod): bash ~/app/scripts/deploy-pod.sh
# - npm ci solo si cambió package-lock.json
# - copia de la BD y `prisma migrate deploy` solo si hay migraciones nuevas
# - build y reinicio de app.service
set -euo pipefail
cd ~/app

before=$(git rev-parse HEAD)
git pull --ff-only
after=$(git rev-parse HEAD)

if [ "$before" = "$after" ]; then
  echo "[deploy] sin cambios ($after)"
else
  echo "[deploy] $before -> $after"
fi

changed=$(git diff --name-only "$before" "$after" || true)

if echo "$changed" | grep -q '^package-lock.json$'; then
  echo "[deploy] package-lock cambió: npm ci"
  npm ci
fi

if echo "$changed" | grep -q '^prisma/migrations/'; then
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  mkdir -p ~/backups
  echo "[deploy] migraciones nuevas: copia de seguridad en ~/backups/instapod-$ts.dump"
  pg_dump -d instapod -Fc -f ~/backups/instapod-"$ts".dump
  npx prisma migrate deploy
fi

npm run build
sudo systemctl reset-failed app.service || true
sudo systemctl restart app.service
sleep 15
curl -fsS localhost:3000/health && echo
echo "[deploy] OK $after"
```

- [ ] **Step 2: Commit**

```bash
chmod +x scripts/deploy-pod.sh
git add scripts/deploy-pod.sh
git commit -m "chore: script de deploy del pod con copia de BD antes de migrar"
```

- [ ] **Step 3: Procedimiento de la primera vez (lo ejecuta quien despliegue la Fase 0, con OK de Alex)**

Producción ya tiene todo lo que crea la migración consolidada (lo verificó la Task 6, Step 6). Por eso, **antes** del primer `deploy-pod.sh`, en el pod:

```bash
cd ~/app
git stash push -- src/generated        # última vez: después ya no está en git
git pull --ff-only
pg_dump -d instapod -Fc -f ~/backups/instapod-antes-fase0.dump
npx prisma migrate resolve --applied 20261010000000_consolidar_migraciones_de_arranque
npx prisma migrate status              # Expected: "Database schema is up to date!"
npm ci
npm run build
sudo systemctl restart app.service
sleep 15 && curl -fsS localhost:3000/health
git stash drop                          # el stash del cliente generado ya no sirve
```

Expected: `migrate status` al día y `/health` → `{"status":"ok","db":"connected",...}`. A partir de aquí, todos los deploys con `bash ~/app/scripts/deploy-pod.sh`.

---

### Task 13: Verificación final

- [ ] **Step 1: Todo desde cero**

```bash
rm -rf src/generated dist
npm ci
npx tsc --noEmit -p tsconfig.json
npm test
npm run test:db
npm run test:int
npm run build
```

Expected: todo en verde.

- [ ] **Step 2: Criterio de salida**

- Los candados fallan cuando deben (Task 2 tests + Task 10 Step 3).
- Ningún test abre sockets fuera de localhost (Task 3 tests).
- La prueba de humo de integración pasa contra Postgres real (o los fallos reales están marcados `it.failing` y anotados en "Hallazgos").
- CI en verde.
- `src/generated` fuera de git, `STARTUP_MIGRATIONS` eliminadas, migración consolidada aplicada en tests y verificada contra producción.

- [ ] **Step 3: Revisión**

Correr `/code-review high` sobre la rama y aplicar lo que salga. Después, con OK de Alex: merge a `main` y el procedimiento de la Task 12, Step 3 en el pod.

---

## Fuera de esta fase (a propósito)

- Dobles de IA (Groq/Gemini), correo y Cloudinary: la red cortada ya impide que un test los llame de verdad. Cada bloque crea el doble que necesite cuando escriba el primer test que lo use (el bloque 4 el de IA, el 5 el de correo), en `test/support/`.
- Segundo servicio systemd (`wa-gateway.service`) y el deploy que reinicia solo lo que cambió: llegan con el bloque 1.

## Hallazgos

(Se rellena durante la ejecución: tests existentes que salían a red, diferencias entre esquema y producción, bugs reales encontrados por la prueba de humo.)
