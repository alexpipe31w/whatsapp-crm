# CRM impecable — diseño

Fecha: 2026-10-09. Aprobado por Alex por partes en la sesión de brainstorming.

## Contexto

- Backend NestJS + Prisma (`whatsapp-crm`, ~17.800 líneas propias, 12 suites de test), panel en `stockup-frontend` (React, Vercel). Producción en un pod InstaPods: 2 vCPU, 1,9 GB RAM, Postgres 16 local, sin Redis, un solo proceso `app.service`.
- Todas las sesiones de Baileys viven en memoria del proceso de la API. Cada deploy las corta y las reabre a la vez. El reinicio del 2026-10-08 dejó a las 3 tiendas conectadas pidiendo QR, y antes una empresa sufrió un bloqueo temporal por reconexiones repetidas durante cambios.
- Alex avisó a los clientes de que **no hay servicio hasta terminar este programa**. Se puede desplegar sin modo "solo registrar"; el riesgo se concentra en la vuelta al servicio.
- El pod crecerá (más CPU/RAM/disco) según el negocio: ningún límite va fijo en código.

## Objetivos

1. Llevar el CRM al estándar de StockUp: tests, aislamiento entre tiendas, idempotencia, concurrencia, resiliencia y observabilidad. **Sin rediseño visual** (salvo la pantalla de cocina del módulo de restaurante, que es nueva).
2. Que un deploy normal no toque los números de WhatsApp, y que Baileys no pueda entrar en bucles de reconexión ni enviar a ritmo de robot.
3. Proveedor híbrido por tienda: Baileys o WhatsApp Cloud API oficial.
4. Volumen objetivo: 20–100 tiendas. Con el pod actual el techo real es ~20–25 sesiones de Baileys (30–60 MB cada una); escalar = más RAM o un segundo gateway.

## Programa

| Fase | Contenido |
|---|---|
| 0. Red de seguridad | Jest + Postgres real de tests, candados anti-producción, red cortada, fábricas de dos tiendas, CI |
| 1. Pasarela WhatsApp + Baileys blindado | Proceso `wa-gateway`, interfaz de proveedor, colas en Postgres, arriendo de sesión, reconexión escalonada, frenos anti-bloqueo |
| R. Módulo de restaurante | Ciclo propio (brainstorming → spec → plan). Menú con modificadores que cambian el precio, configuración por plato, IA que entiende pedidos de comida, pantalla de cocina en vivo |
| 2. Sesión y aislamiento | JWT, roles, filtro por tienda en cada endpoint, super-admin, staff |
| 3. Pedidos, stock, citas, sync StockUp | Carreras, doble agendamiento, stock atómico, idempotencia, sync. Sobre el modelo de pedido ya extendido por R |
| 4. IA | Partir `ai.service.ts` en piezas testeables; timeouts, coste, pool de keys, la config de la tienda manda |
| 5. Tareas programadas | Recordatorios, autoconfirmación, campañas, limpieza, reportes: candado, idempotencia, nunca enviar dos veces |
| 6. Endurecimiento de API | Límites de ritmo, validación con DTO, cabeceras, CORS, subidas, secretos, logs con contexto |
| 7. Click-path del panel | Recorrer cada botón del CRM en `stockup-frontend`. Sin rediseño |
| 8. Cloud API | `CloudApiProvider`, webhook firmado, plantillas en el panel, hueco para Embedded Signup |
| Cierre | Reconexión controlada de números y E2E real por tienda |

Ciclo de cada bloque: auditar leyendo el código entero → tests que fallan → arreglo → revisión (`/code-review`, `estandares-produccion`) → deploy → verificación en el pod. Un plan por bloque (writing-plans), escrito justo antes de empezarlo.

## Fase 0 — red de seguridad

- Jest contra Postgres en WSL, puerto 5434, BD `crm_test`. Dos candados: la URL debe ser localhost y el nombre de la BD debe terminar en `_test` (el 5433 es el túnel a la BD de producción del CRM).
- Red cortada a nivel de socket en los tests: nada sale a Groq, Gemini, Meta, Cloudinary ni WhatsApp.
- Dobles: `FakeWhatsAppProvider` (registra los envíos), dobles de IA, correo y Cloudinary.
- Fábricas para crear dos tiendas con datos y probar que A nunca ve ni modifica lo de B.
- CI en GitHub Actions con servicio Postgres.
- `src/generated/prisma` sale del control de versiones (hoy obliga a `git stash` en cada pull y ya tumbó producción una vez).
- Las migraciones de arranque de `prisma.service.ts` (`ALTER TABLE ... IF NOT EXISTS`) pasan a migraciones versionadas.

## Bloque 1 — pasarela de WhatsApp

### Arquitectura

```
 Teléfono ──► wa-gateway ──► [wa_inbound] ──► API (worker) ──► IA / pedidos / citas
                 ▲                                   │
                 └────────── [wa_outbound] ◄─────────┘
                      (Postgres + LISTEN/NOTIFY)
```

- `wa-gateway`: segundo punto de entrada del mismo repo (servicio systemd `wa-gateway.service`). Mantiene las sesiones y no tiene lógica de negocio. Guarda lo entrante en `wa_inbound` y envía lo que hay en `wa_outbound`.
- API (`app.service`): un worker consume `wa_inbound` y ejecuta la lógica actual (IA, pedidos, citas). Respuestas, recordatorios y campañas se encolan en `wa_outbound`. Nunca abre un socket.
- Si la API está caída o reiniciando, lo entrante se acumula en `wa_inbound` y se procesa al volver.
- Latencia: `LISTEN/NOTIFY` despierta al otro lado; sondeo de respaldo cada pocos segundos.

### Tablas

- `wa_session_lease`: `store_id` (PK), `owner_id`, `lease_until`, `status` (`connecting` | `open` | `needs_qr` | `paused_risk` | `logged_out`), contadores de reconexión, `last_open_at`. Un gateway solo abre un número si tiene el arriendo vigente; lo renueva periódicamente. Dos procesos nunca abren el mismo número.
- `wa_outbound`: `id`, `store_id`, `to`, `payload` (texto, media o plantilla), `kind` (`reply` | `notification` | `reminder` | `campaign`), `priority`, `idempotency_key` UNIQUE, `not_before`, `status` (`pending` | `sending` | `sent` | `failed` | `skipped`), `attempts`, `provider_message_id`, `delivery_status`, `error`, timestamps. Reclamo con `FOR UPDATE SKIP LOCKED`.
- `wa_inbound`: `id`, `store_id`, `provider_message_id` UNIQUE por tienda (dedupe), `payload`, `status`, `attempts`, `error`, timestamps. Reclamo con `FOR UPDATE SKIP LOCKED`.
- `wa_commands`: conectar, desconectar o cerrar sesión pedidos desde el panel; el gateway los ejecuta. El QR lo escribe el gateway y el panel lo lee.
- `whatsapp_sessions` (credenciales de Baileys) se mantiene; la escritura pasa a ser atómica e inmediata en cada actualización de credenciales (hoy va con temporizador y se pierde si el proceso muere).
- Retención: `wa_inbound` y `wa_outbound` procesados se purgan por antigüedad (configurable).

### Interfaz de proveedor

```ts
interface WhatsAppProvider {
  connect(storeId: string): Promise<void>;
  disconnect(storeId: string, opts: { logout: boolean }): Promise<void>;
  send(storeId: string, msg: OutboundMessage): Promise<SendResult>;
  // eventos: inbound, status (entregado/leído/fallido), connection
}
```

Implementaciones: `BaileysProvider` (bloque 1) y `CloudApiProvider` (bloque 8). Cada tienda tiene `whatsappProvider: 'baileys' | 'cloud'`. Un número usa un solo proveedor a la vez; cambiarlo es una acción explícita con confirmación.

### Baileys blindado

- **Apagado limpio**: al recibir SIGTERM el gateway guarda credenciales y cierra cada socket sin logout, después suelta los arriendos. `TimeoutStopSec` de systemd suficiente para hacerlo.
- **Arranque escalonado**: los números se abren de uno en uno con 20–40 s al azar entre ellos.
- **Presupuesto de reconexiones** por número: máximo N por hora y M por 24 h (configurable). Superado → `paused_risk`, aviso al admin en el panel, sin más intentos automáticos.
- **Errores que paran en seco**: 401 definitivo, 403 y señales de bloqueo detienen los reintentos. Se conservan los manejos actuales de 401 transitorio (`MAX_LOGGED_OUT_RETRIES`) y QR agotado (`MAX_QR_ATTEMPTS`).
- **Ritmo de envío**: una cola por número, nunca dos envíos simultáneos desde el mismo teléfono; estado "escribiendo…" y pausa proporcional al largo antes de cada respuesta; prioridad respuestas > avisos/recordatorios > campañas.
- **Campañas por Baileys**: solo a clientes que ya escribieron a la tienda; un mensaje cada 8–20 s al azar; solo en horario permitido (Ley 2300); tope diario por número que crece con su antigüedad y su historial sin incidentes; pausa automática si suben errores o desconexiones. Todos los valores configurables.
- **Configuración por entorno**: tope de sesiones por gateway, concurrencia de workers, presupuestos de reconexión y ritmos son variables de entorno. Ampliar el pod = subir valores y reiniciar.
- **Salud visible** en el panel por número: estado, reconexiones 24 h, envíos del día frente a su tope; y RAM del gateway.

## Bloque 8 — Cloud API

- Credenciales por tienda cifradas en BD (mismo cifrado que las de StockUp): `phone_number_id`, `waba_id`, token de acceso, secreto de la app y token de verificación del webhook. Alta inicial: la tienda las pega en Configuración.
- Webhook de Meta: verificación del `hub.challenge` y firma `X-Hub-Signature-256` sobre el cuerpo crudo; eventos deduplicados por id; mensajes a `wa_inbound`, estados (enviado, entregado, leído, fallido) a la fila de `wa_outbound`.
- Ventana de 24 h: antes de enviar se comprueba el último mensaje del cliente. Dentro → texto libre. Fuera → la plantilla asignada a ese caso. Sin plantilla → `skipped` con motivo visible en el panel.
- Plantillas: el CRM lee las aprobadas de la cuenta de la tienda; en el panel se asigna una por caso (recordatorio, confirmación, campaña, pedido listo…) y se mapean sus variables.
- Llamadas a Meta con timeout, reintentos con espera exponencial y jitter solo en errores temporales, respeto del 429.
- Embedded Signup: el modelo de credenciales y el flujo de alta quedan preparados para que solo cambie cómo se obtienen las credenciales. Alex inicia en paralelo el trámite de Tech Provider con Meta.

## Módulo de restaurante (fase R)

Fuera de este documento: tendrá su propio brainstorming y spec. Requisitos ya conocidos: modificadores y adiciones que cambian el precio, configurables por tienda; tiempo de preparación, temperatura o término por plato; IA capaz de recoger pedidos con todas las condiciones del cliente; pantalla de cocina en vivo para cocineros y admin. Va antes del bloque 3 para que pedidos e IA se endurezcan sobre el modelo final.

## Despliegue

- Dos servicios systemd: `app.service` (API) y `wa-gateway.service`.
- Script de deploy que compila y reinicia solo lo que cambió; un deploy de la API no reinicia el gateway.
- Copia de seguridad de la BD antes de cada migración.

## Criterios de terminado

Por bloque: tests que fallaban y ahora pasan, suite completa + compilación + build + CI en verde, revisión, deploy y verificación en el pod.

Del programa, antes de reabrir el servicio:
- Cada número reconectado uno a uno con el protocolo de números fríos (uso humano previo, sin pruebas masivas inmediatas).
- E2E real por tienda: conversación con la IA, un pedido o cita, un recordatorio y una cancelación.
- Un deploy de la API con los números conectados y **cero reconexiones** en los logs del gateway.

## Fuera de alcance

- Rediseño visual del panel existente.
- Redis u otra infraestructura nueva: las colas van sobre Postgres.
- Embedded Signup operativo (solo queda preparado).
