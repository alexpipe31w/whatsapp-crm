# Bloque 1 — auditoría del estado actual de WhatsApp

Fecha: 2026-10-09 (para el plan del 2026-10-10). Rama `main` en `fa0627b`. Solo lectura: no se tocó `src/`.
Spec de referencia: `docs/superpowers/specs/2026-10-09-crm-impecable-design.md`, sección "Bloque 1".

Fuentes: lectura completa de `src/whatsapp/*`, de los consumidores (`ai`, `messages`, `notifications`, `reminders`, `auto-confirm`, `campaigns`, `reports`, `admin-assistant`, `appointments`, `customers`, `conversations`, `blocked`), de `prisma/schema.prisma`, de `stockup-frontend/src/pages/WhatsApp.tsx` y `Dashboard.tsx`, de Baileys `7.0.0-rc.9` en `node_modules`, y **lectura de los logs de producción** (`journalctl -u app.service` en el pod, solo lectura) y de la unidad systemd.

---

## 0. Resumen ejecutivo

1. **El reinicio del 08-10 no fue lo que dejó las tiendas pidiendo QR: los logs muestran que ya estaban sin registrar antes.** Al arrancar a las 13:53:02, las tres sacaron QR en el mismo segundo. Eso solo ocurre si los creds guardados no tienen `me`. Dos tiendas (`4793e786…`, `7e2611c1…`) llevan pidiendo QR en cada arranque desde, como mínimo, el 2026-10-04. La tercera (`05a0e848…`) quedó así el 2026-10-07 a las 22:03:24, con un `401 — Intentional Logout`. Ese texto solo lo genera `sock.logout()`, y en el código solo lo llama `disconnectStore` (`whatsapp.service.ts:1439`), es decir, alguien pulsó Desconectar, Reconectar o Cancelar en el panel. El propio manejador de 401 lo tomó por transitorio y reconectó 5 s después con la BD ya vacía. Así creó una sesión **nueva sin registrar** y la guardó. Detalle en §5.4.
2. **Hay tres caminos en el código que pueden destruir una sesión buena** en un reinicio o reconexión: `loadFromDB` se traga cualquier error y devuelve `{}` → `initAuthCreds()` → sobrescribe la fila buena en 300 ms (`:126-135`, `:156-159`). El guardado va con un temporizador de 300 ms sin vaciado al apagar (`:140-154`), y no hay `enableShutdownHooks` (`main.ts`). Por último, `disconnectStore` + el reintento de 401 regeneran creds vacíos (`:553-563` + `:1429-1447`).
3. **Envíos duplicados ya hoy, sin migración de por medio.** El aviso "te conecto con un asesor" se manda **dos veces** (`whatsapp.service.ts:1306` y otra vez vía `messages.service.ts:58`, porque se guarda con `sender:'store', isAiResponse:false`). "Tu cita está confirmada" puede salir dos veces por tres caminos: panel, autoconfirmación y asistente del dueño. Las campañas se envían dentro de la petición HTTP sin reclamo, así que un doble clic o un reinicio a mitad las reenvía enteras. Ningún envío tiene clave de idempotencia y `Message` no guarda el id de WhatsApp.
4. **Se pierde trabajo en vuelo en cada deploy**: lo que esté en el buffer de 3 s, en la cola por cliente o esperando a la IA muere con el proceso. El mensaje del cliente ni siquiera llegó a guardarse, porque se guarda después del debounce (`:1260`). El recordatorio de confirmar la cita (5 min, `ai.service.ts:756-777`) también es un `setTimeout` en memoria.
5. **Un `/connect` manual sobre un socket vivo provoca un bucle de reconexión** cada 3–8 s. `connectStore` llama a `existing.end(undefined)` (`:410`), Baileys emite `close` sin código, `handleDisconnect` programa otra reconexión, esa cierra el socket nuevo, y así sigue. Encaja con el antecedente de "bloqueo por reconexiones repetidas durante cambios".
6. Propuesta de corte: **1a** salida por cola `wa_outbound` + idempotencia, todavía con el proceso único. **1b** creds atómicos, apagado limpio, arranque escalonado, presupuesto de reconexiones y arreglo de `disconnect`/`connect`. **1c** proceso `wa-gateway` + `wa_inbound` + arriendo + `wa_commands`. **1d** ritmo humano, prioridades, frenos de campaña y salud en el panel (§8).

---

## 1. Mapa de responsabilidades de `src/whatsapp/whatsapp.service.ts` (1456 líneas)

Leyenda: **T** = transporte puro, va al gateway. **N** = negocio, se queda en la API (worker de `wa_inbound`). **M** = mixta, hay que partirla.

### 1.1 Constantes y funciones de módulo

| Líneas | Pieza | Qué hace | Clase |
|---|---|---|---|
| 19-24 | `WHISPER_*`, `AUDIO_*` | Límites de audio: 180 s, 10 MB y 5 audios/min por número. | N (los límites de duración y bytes se validan con metadatos, así que también puede aplicarlos el gateway antes de descargar) |
| 28-34 | `MSG_DEBOUNCE_MS=3000`, `MSG_DEDUP_TTL_MS=10min`, `HISTORY_SYNC_WINDOW_MS=24h`, `MAX_CONTENT_LENGTH=4000`, `SEND_RETRY_*` | Debounce, dedupe, ventana de `append`, recorte para la IA y reintentos de envío. | Debounce/recorte: N. Ventana `append` y reintentos de envío: T |
| 37-48 | `MAX_QR_ATTEMPTS=3`, `MAX_LOGGED_OUT_RETRIES=2`, `LOGGED_OUT_RETRY_DELAY_MS=5000`, `LID_PRELOAD_*` | Política de conexión y precarga LID. | T |
| 51-76 | `IGNORED_TYPES`, `MEDIA_TYPES` | Clasificación de tipos de mensaje. | T (el filtrado es de protocolo) |
| 80-107 | `HUMAN_KEYWORDS` | Frases que piden un asesor. | N |
| 110-196 | `useDBAuthState(prisma, storeId)` | Estado de auth de Baileys guardado en **una sola fila JSON** (`whatsapp_sessions.data`) con creds y **todas** las claves. Caché en memoria + guardado con temporizador de 300 ms. | T (ver §5.3: hay que rehacerlo) |
| 205-286 | `extractTextContent(message)` | Saca el texto de todos los tipos de mensaje. | T. Lo ideal es que el gateway normalice y entregue `{type, text}` en el payload, y que el proto crudo vaya también para depurar |
| 294-300 | `sanitizeContent` | Quita caracteres de control y URLs largas, y recorta a 4000. | N (preparación para la IA) |
| 305-325 | `withRetry` | **Código muerto**: no se usa en ningún sitio (grep). | — se borra |

### 1.2 Clase `WhatsappService`

| Líneas | Método | Qué hace / de qué depende | Estado en memoria que toca | Clase |
|---|---|---|---|---|
| 333-354 | Campos | `sockets`, `qrCodes`, `reconnecting`, `qrAttempts`, `loggedOutAttempts`, `reconnectFailures`, `processedMsgIds`, `reconciledLids`, `messageQueues`, `audioRateLimiter`, `messageBuffers`, y además `whisperPromptCache` (1068) | — | ver §2 |
| 356-365 | constructor | Inyecta Prisma, `AiService`, `ConversationsService`, `MessagesService` (forwardRef), `CustomersService`, `BlockedService` y `AdminAssistantService`. | — | M: el gateway solo necesita Prisma |
| 369-396 | `onModuleInit` | (a) Registra `aiService.setSendFn` y `adminAssistant.setNotifyFn` → `sendMessage` (372-376). (b) Lee **todas** las `whatsappSession` de tiendas activas y llama a `connectStore` **en paralelo** con `Promise.allSettled` (379-392). No filtra por `subscriptionStatus`. | `sockets` (vía connectStore) | M: (a) pasa a ser "encolar en `wa_outbound`" en la API. (b) es el arranque del gateway y debe ser **escalonado** y con arriendo |
| 400-475 | `connectStore(storeId)` | Si `reconnecting` lo tiene, sale (401-404). Cierra el socket previo con `end(undefined)` (407-411). **`fetchLatestBaileysVersion()` en cada conexión**: es un `fetch` a GitHub `master` sin timeout (421, `generics.js:176`). Carga auth (422), crea el socket (424-436) con `getMessage` que devuelve `''` (435). Engancha `creds.update`, `connection.update`, `contacts.upsert/update` y `messages.upsert` (440-472). En `messages.upsert` solo procesa `notify` y `append` (`append` solo si tiene menos de 24 h) y llama a `processMessage` **en serie y con await** (463-471). | `sockets`, `reconnecting` (lectura) | T |
| 479-513 | `handleConnectionUpdate` | Guarda el QR en `qrCodes` (486-489). Con `open`: limpia contadores, escribe `stores.wa_session_id` (sin uso en ningún otro sitio) y lanza `preloadLidMappings` en segundo plano (491-508). Con `close` → `handleDisconnect`. | `qrCodes`, `reconnecting`, `qrAttempts`, `loggedOutAttempts`, `reconnectFailures` | T |
| 515-610 | `handleDisconnect` | Registra el motivo (520-533). 403 → para y conserva creds (537-546). 401 → hasta 2 reintentos con los mismos creds a los 5 s; después borra la sesión de la BD (548-579). 408 o `undefined` → cuenta como intento de QR y para al 3.º, **borrando el socket del mapa** (586-596). Resto → backoff con `computeReconnectDelay` (598-609). | todos los contadores, `sockets`, `qrCodes` | T |
| 626-661 | `resolveSenderIdentity(msg, sock)` | Saca la identidad del remitente: teléfono por `remoteJidAlt`, por `sock.signalRepository.lidMapping.getPNForLID` (caché local de la sesión, 643), o `lid:<user>`. | — | **T, necesita el `sock`**. El gateway resuelve y escribe en `wa_inbound` `{identity, waLid}` |
| 667-682 | `learnLidMappings` | Guarda en el store de Baileys los pares LID↔PN que llegan en eventos de contactos. | (store de Baileys, en las claves `lid-mapping` de la fila de sesión) | T |
| 692-737 | `preloadLidMappings` | Al abrir: lee hasta 500 clientes de la tienda (`customer.findMany`, 699-704) y consulta USYNC por lotes de 50 con un timeout de 20 s. | — | T (necesita el `sock`). Lee `customers`, pero es solo lectura y está acotada: aceptable en el gateway |
| 739-855 | `processMessage` | Sin `message` → aviso (740-744). `fromMe` → `handleOwnerStopCommand` (750-753). Dedupe en memoria (756-764). Descarta grupos y difusiones (773). Identidad (775-794). Si hay LID + teléfono → `customersService.linkLidIdentity` una vez por ejecución (797-810). Tipos ignorados (817-820). **Bloqueados** con `blockedService.isBlocked` (823-827). Audio → `handleAudioMessage` (830-833). Media → `handleMediaMessage` (836-839). Texto → extracción, saneado y filtro de "1 carácter sin letras" (842-850) → `bufferAndProcess`. | `processedMsgIds`, `reconciledLids` | **M**. Gateway: `fromMe`/tipo/grupo/identidad, guardar en `wa_inbound` con dedupe por UNIQUE y descargar el audio. API: bloqueados, fusión LID, audio→Whisper, media, texto y buffer |
| 859-887 | `handleOwnerStopCommand` | Si el dueño escribe `!stop` desde el teléfono dentro del chat de un cliente → `conversation.status='human'`. | — | M: el gateway reenvía los `fromMe` de texto `!stop` como inbound `kind=owner_command`; la API cambia el estado |
| 891-926 | `bufferAndProcess` | Debounce de 3 s por `storeId:phone`: acumula textos y luego `enqueueMessage(handleIncomingMessage)`. **Captura el `sock`** en el cierre. | `messageBuffers` | N (worker), sin `sock` |
| 928-938 | `enqueueMessage` | Cola en serie por clave (cadena de promesas). | `messageQueues` | N (worker). En multi-proceso se sustituye por un reclamo por clave (§7) |
| 942-952 | `checkAudioRateLimit(phone)` | 5 por minuto **por teléfono, sin `storeId`** (fuga entre tiendas, menor). | `audioRateLimiter` | N |
| 954-1065 | `handleAudioMessage` | Límite de ritmo → busca keys de Whisper en `aIConfiguration` (974-992) → valida duración y bytes con metadatos (999-1014). Si dura más de 3 min, **envía directamente** sin guardar el mensaje y sin mirar si la conversación está en `human` (1000-1009). Después **`downloadMediaMessage(..., { reuploadRequest: sock.updateMediaMessage })`** (1022-1025) → Whisper → `bufferAndProcess`. | `audioRateLimiter`, `whisperPromptCache` | **M**: la descarga necesita el `sock`, así que va al gateway. Whisper va en la API, con las keys de negocio |
| 1074-1100 | `buildWhisperPrompt` | Vocabulario: nombre de la tienda y 30 productos y servicios. Caché de 10 min. | `whisperPromptCache` | N |
| 1102-1160 | `transcribeAudio` | `fetch` a Groq/OpenAI con un timeout de 25 s hecho con `Promise.race`. La petición no se aborta. | — | N |
| 1164-1211 | `handleMediaMessage` | Crea cliente y conversación. Si no está en `human`/`closed`, pasa a **`pending_human`**, guarda `[image]` y responde con un acuse fijo. **Stickers**: `getMediaReply` devuelve `null` (1227). Aun así la conversación pasa a `pending_human` y después `messagesService.create(content:null)` lanza "vacío" (`messages.service.ts:33-35`), que se registra como error. | — | N (el envío se encola) |
| 1213-1230 | `getMediaReply` | Textos fijos. | — | N |
| 1234-1355 | `handleIncomingMessage` | **Asistente del dueño** si `isAdminPhone` (1245-1251): responde y sale, **sin guardar nada en `messages`**. Cliente: `findOrCreate` cliente y conversación (1254-1257). Guarda el mensaje del cliente (1260-1267). `human`/`closed` → silencio (1270-1275). `!stop` del cliente (1278-1285). Palabras de asesor → `human` + aviso (1290-1321, **doble envío**, ver §4). IA → `generateReply` (1326). Si es `null` (incluye `[IGNORAR]`) → silencio (1335). Guarda la respuesta **antes** de enviar (1338-1345) y la envía (1348). | — | N (pasa entero al worker; los `safeSend` se sustituyen por encolar) |
| 1359-1417 | `safeSend(sock, jid, text, …)` | Trocea a 4096 cortando por un salto de línea si está por encima del 70 % (1368-1384). 4 intentos por trozo, con 1,5 s o 6 s si es `not-acceptable`. Desde el 2.º intento usa el socket "fresco" del mapa (1391). Si un trozo falla, **los anteriores ya se enviaron** y no queda constancia. | `sockets` (lectura) | T |
| 1421-1423 | `getQR` | Lee `qrCodes`. | `qrCodes` | T → en el diseño nuevo se lee de la BD (`wa_session_lease`/`wa_commands`) |
| 1425-1427 | `isConnected` | `sockets.get(id)?.user != null`. **`user` es `authState.creds.me`** (`socket.js:848-850`): devuelve `true` si hay creds registrados aunque el socket esté caído o reconectando. | `sockets` | T → en el diseño nuevo, `status='open'` en el arriendo |
| 1429-1448 | `disconnectStore` | Limpia los mapas, hace **`sock.logout()`** (desvincula el dispositivo en WhatsApp, `socket.js:561-584`) y borra la fila de sesión y `waSessionId`. | todos | T (vía `wa_commands`) |
| 1450-1456 | `sendMessage(storeId, phone, content)` | Socket del mapa → `jidFromPhone` → `safeSend`. Si no hay socket, lanza una excepción. | `sockets` | T → en la API pasa a ser `outbound.enqueue(...)` |

`src/whatsapp/reconnect-delay.ts:17-29`: `computeReconnectDelay(status, failures, random)`. Base 5 s (408), 8 s (440) o 3 s (resto), exponencial ×2 desde el 2.º cierre, techo de 5 min y jitter de ±20 %. Es pura, tiene test (`reconnect-delay.spec.ts`, 4 casos) y va al gateway tal cual. `FORBIDDEN_STATUS = 403`.

`src/whatsapp/whatsapp.module.ts`: importa `AiModule`, `ConversationsModule`, `MessagesModule` (forwardRef, circular), `CustomersModule`, `BlockedModule` y `AdminAssistantModule`. El módulo del gateway no debe importar ninguno de ellos (§7.10).

`src/utils/wa-identity.util.ts` (`resolveJid`, `phoneFromJid`, `lidUserFromJid`, `jidFromPhone`, `lidIdentity`, `isLidIdentity`, `lidFromIdentity`): son puras y las comparten gateway y API.

---

## 2. Estado en memoria

| Estructura (línea) | Para qué | Qué pasa hoy al reiniciar | Dónde debe vivir |
|---|---|---|---|
| `sockets` (333) | Socket por tienda | Se pierde, los sockets no se cierran (no hay hook de apagado) y se recrean todos a la vez | Memoria del **gateway**. La propiedad del número la decide `wa_session_lease` |
| `qrCodes` (334) | QR vigente | Se pierde (sin importancia) | Postgres (`wa_session_lease.qr` o tabla aparte), escrito por el gateway y leído por la API para `GET /qr` |
| `reconnecting` (335) | Evita reconexiones paralelas | Se pierde | Memoria del gateway. Con un arriendo por tienda, el candado real es el arriendo |
| `qrAttempts` (336) | Para tras 3 QR caducados | Se pierde, así que **cada reinicio regala otros 3 ciclos de QR** (~8 min por tienda, se ve en los logs del 06, 07, 08 y 09-10) | Postgres (contadores en `wa_session_lease`) |
| `loggedOutAttempts` (341) | Tolerancia a 401 | Se pierde | Postgres |
| `reconnectFailures` (343) | Backoff | Se pierde: el backoff vuelve a 3 s | Postgres + **presupuesto por hora y por 24 h** (spec) |
| `processedMsgIds` (344) | Dedupe de entrantes, TTL de 10 min | **Se pierde**: lo que WhatsApp reentregue tras el reinicio (o un `append` de menos de 24 h) se procesa otra vez y la IA responde de nuevo. `Message` no tiene id de WhatsApp (`schema.prisma:220-236`) | Postgres: `wa_inbound` con UNIQUE `(store_id, provider_message_id)` + `ON CONFLICT DO NOTHING` |
| `reconciledLids` (347) | Fusiona LID↔teléfono una vez por ejecución | Se pierde (solo cuesta repetir la transacción idempotente) | Memoria del worker (caché). La fusión ya es idempotente en BD |
| `messageQueues` (348) | Orden en serie por cliente | **Se pierde con trabajo dentro**: mensajes sin responder | Postgres: filas `wa_inbound` pendientes + reclamo por clave (`store_id`, `identity`) |
| `audioRateLimiter` (349) | 5 audios/min | Se pierde (aceptable) | Memoria del worker (o se cuenta en `wa_inbound` con una consulta) |
| `messageBuffers` (350-354) | Debounce de 3 s | **Se pierde con mensajes que aún no están en la BD** | Postgres: el debounce se implementa al reclamar ("la fila más nueva de la clave tiene más de 3 s"), ver §3.3 |
| `whisperPromptCache` (1068) | Caché de 10 min | Se pierde (aceptable) | Memoria del worker |
| `useDBAuthState.cache` + `saveTimer` (137-154) | Auth de Baileys | **El temporizador pendiente se pierde con un SIGTERM**: las últimas claves o creds no llegan a la BD | Gateway: escritura inmediata y atómica (spec) + vaciado en el apagado |
| `makeCacheableSignalKeyStore` (428) | Caché de claves de Baileys | Se pierde. Antes provocó el incidente del `tctoken` (comentario 116-121) | Memoria del gateway |
| Fuera del módulo: `AiService.pendingConfirmTimers` (`ai.service.ts:741`, `setTimeout` de 5 min en 756-777) | Recordatorio "¿Confirmamos tu cita?" | **Se pierde**: el cliente nunca recibe el recordatorio | `wa_outbound` con `not_before = now()+5min` y clave por conversación. Se cancela marcándolo `skipped` (`cancelConfirmReminder`, 780-786) |
| Fuera: `AiService.pendingAppointments`, `pendingExtractions`, `pendingReschedules`, `conversationCreatedAppts`, `orderInProgress`, `appointmentInProgress` (729-741) | Estado de la conversación de la IA | Se pierden. **Exigen que una conversación la procese siempre el mismo proceso y en serie** | Siguen en memoria del worker de la API (bloque 4 para moverlas). Consecuencia: **un solo worker de `wa_inbound`**, o reparto por clave |
| Fuera: `AdminAssistantService.sessions` (`admin-assistant.service.ts:51`) | Historial del chat del dueño | Se pierde | Igual que ahora (worker). Fuera de alcance |

---

## 3. Flujo completo de un mensaje entrante

### 3.1 Recorrido hoy (proceso único)

1. **Baileys** `messages.upsert` (`:456`). Solo `notify` y `append` (`:460`). `append` se descarta si tiene más de 24 h (`:461-466`). Los mensajes se procesan en serie con `await` (`:463-471`), así que un `processMessage` lento (Whisper, 25 s) **frena todo lo que entra a esa tienda**.
2. `processMessage` (`:739`):
   - Sin `message` → aviso de "¿fallo de descifrado?" (`:740-744`).
   - `fromMe` → solo se mira `!stop` (`:750-753`, `:859-887`). **Los mensajes que el dueño escribe a mano desde el teléfono no se guardan en el CRM.**
   - Dedupe con `processedMsgIds` (`:756-764`), solo en memoria.
   - `resolveJid` → descarta `@g.us`/`@broadcast` (`:766-773`).
   - Identidad (**necesita el `sock`**: `getPNForLID`, `:643`). Sin identidad → volcado al log (`:776-794`).
   - LID: con `lid:<user>` se registra y se atiende. Con teléfono + LID se llama a `linkLidIdentity` en una transacción (`customers.service.ts:63+`).
   - `IGNORED_TYPES` (`:817-820`).
   - **Bloqueados**: `blockedService.isBlocked` compara los últimos 10 dígitos (`blocked.service.ts:56-70`). Con identidades `lid:` compara dígitos del LID: no casa con un bloqueado por teléfono.
   - **Audio** → `handleAudioMessage` (`:954`): límite de ritmo → keys de Whisper → límites → **descarga con el `sock`** (`:1022`) → Whisper (`:1102`) → el texto entra en `bufferAndProcess`. Si falla → `handleMediaMessage` como respaldo.
   - **Media** → `handleMediaMessage` (`:1164`): `pending_human` + guarda `[image]` + acuse + guarda el acuse (`isAiResponse:true`).
   - **Texto** → `extractTextContent` → `sanitizeContent` (4000) → filtro de 1 carácter → log `📩` con 100 caracteres del contenido (`:852`, PII en el log) → `bufferAndProcess`.
3. `bufferAndProcess` (`:891`): espera 3 s desde el último mensaje de esa clave, une con `\n` y llama a `enqueueMessage` → cola en serie por `storeId:phone`.
4. `handleIncomingMessage` (`:1234`):
   - **Dueño**: `isAdminPhone` compara los últimos 9 dígitos de `stores.admin_phone` (`admin-assistant.service.ts:878-886`). Si el dueño llega como `lid:` **no se le reconoce** y le contesta la IA de clientes. `adminAssistant.handle` (LLM + acciones) → `safeSend`. No se guarda en `messages`.
   - `customers.findOrCreate` (upsert por `storeId_phone`) y `conversations.findOrCreate` (busca activa, crea y recupera si hay P2002).
   - **Guarda el mensaje del cliente** (`messages.create`, `sender:'customer'`) y actualiza `lastMessageAt`.
   - `human`/`closed` → silencio. `!stop` → `human`.
   - Palabras de asesor → `human` + aviso (**doble envío**, §4).
   - `aiService.generateReply(storeId, content, conversationId)` (`ai.service.ts:1347`): lee la configuración, el catálogo, la conversación, los pedidos, las citas, el historial (`MAX_HISTORY_MESSAGES`), la tienda y el personal. Devuelve `null` con `[IGNORAR]` (`:1920-1940`) o "eso no es lo mío" (`:1947-1950`), y el mensaje de respaldo si se agotan los cartuchos (con dedupe por historial, `:1885-1910`). Por dentro puede crear pedidos y citas y llamar a `notifications.*` (admin) sin esperar (`:903`, `:1022`, `:1060`, `:1146`, `:3089`, `:3305`), y programar el recordatorio de 5 min (`:2813`).
   - Guarda la respuesta de la IA (`isAiResponse:true`) **antes** de enviarla (`:1338-1345`) → `safeSend` (`:1348`).
5. `safeSend` (`:1359`): trocea a 4096 → `sock.sendMessage(jid, {text})` con reintentos. `jid` = `jidFromPhone(phone)`: con `lid:<user>` envía a `<user>@lid`, si no a `<digits>@s.whatsapp.net`.

### 3.2 Dónde se guarda cada cosa

| Dato | Tabla | Cuándo |
|---|---|---|
| Cliente | `customers` (`phone` = teléfono o `lid:<user>`, `wa_lid`) | `findOrCreate` tras el debounce. Fusión LID antes del debounce |
| Conversación | `conversations` (`status`: `active`/`pending_human`/`human`/`closed`/`archived`) | Tras el debounce |
| Mensaje del cliente | `messages` (`sender:'customer'`), **sin id de WhatsApp** | Tras el debounce (se pierde si el proceso muere antes) |
| Respuesta | `messages` (`sender:'store'`, `isAiResponse:true`) | Antes del envío. Si el envío falla, en la BD consta como enviada |
| Mensajes del dueño (asistente) | ninguna | — |
| Audio | no se persiste (búfer en memoria) | — |
| Credenciales | `whatsapp_sessions.data` (JSON único) | Temporizador de 300 ms |

### 3.3 Qué necesita el `sock` y por tanto no puede pasar tal cual a la API

- `downloadMediaMessage` con `reuploadRequest: sock.updateMediaMessage` (`:1022-1025`). → El **gateway descarga** el audio (solo `audioMessage` con ≤180 s y ≤10 MB según metadatos) y lo deja en `wa_inbound` (columna `bytea` o fichero temporal) con purga corta. La API transcribe.
- `signalRepository.lidMapping.getPNForLID` (`:643`), `storeLIDPNMappings` (`:677`) y `getLIDsForPNs` (`:719`). → El **gateway resuelve la identidad** y escribe en `wa_inbound` `identity` + `wa_lid`.
- `sock.sendMessage` (`:1392`). → Gateway, desde `wa_outbound`.
- Hoy no existe presencia "escribiendo" ni marcar como leído (grep sin resultados en `sendPresenceUpdate`/`readMessages`). La spec los pide: irán en el gateway, a la hora de enviar (1d).

### 3.4 Cómo queda el debounce sin memoria

El gateway inserta cada mensaje en `wa_inbound(store_id, provider_message_id UNIQUE, identity, kind, text, push_name, received_at, status='pending')`. El worker reclama **por clave** `(store_id, identity)` solo cuando `max(received_at) < now() - 3 s` y no hay otra fila de la clave en `processing`. Toma todas las pendientes de la clave en orden, las une y lo hace en una transacción corta con `FOR UPDATE SKIP LOCKED`. Así se conservan el debounce, el orden y la serie por cliente, y nada se pierde con un reinicio.

---

## 4. Todos los envíos salientes

Todo pasa por `WhatsappService.sendMessage` (`:1450`) o directamente por `safeSend`. Ninguno tiene clave de idempotencia. Los reintentos de `safeSend` (4 por trozo) pueden duplicar un trozo si WhatsApp lo aceptó y la confirmación se perdió (Baileys no lo deduplica).

| # | Origen (archivo:línea) | Destino | Disparador y frecuencia | Idempotente hoy | Riesgo de duplicado | `kind` | Clave natural propuesta |
|---|---|---|---|---|---|---|---|
| 1 | Respuesta IA `whatsapp.service.ts:1348` | cliente | Cada turno, tras el debounce | No | Si se reprocesa el entrante (reentrega tras reinicio, `append`) la IA responde otra vez | `reply` | `ai:{inbound_batch_id}` (id del lote reclamado) |
| 2 | Aviso de asesor `:1306` **+** `messages.service.ts:58-64` | cliente | Palabra de asesor | **Ya duplica**: `safeSend` y luego `messagesService.create({sender:'store', isAiResponse:false})` lo vuelve a enviar (`messages.service.ts:58`) | **Seguro, 2 envíos** (código; no aparece en los logs desde 08-01 porque no se ha dado el caso) | `reply` | `handoff:{inbound_batch_id}` + arreglar `isAiResponse:true` o una bandera "no enviar" |
| 3 | Acuse de media `:1196` | cliente | Cada imagen, vídeo o documento | No | Igual que el 1 | `reply` | `media-ack:{inbound_id}` |
| 4 | Audio largo `:1003` | cliente | Audio de más de 180 s | No. Ignora `human` y no se guarda | Igual que el 1 | `reply` | `audio-long:{inbound_id}` |
| 5 | Asistente del dueño `:1249` | dueño | Cada mensaje del dueño | No | Igual que el 1, y el LLM vuelve a ejecutar **acciones** (crear o cancelar citas) | `reply` | `admin-reply:{inbound_batch_id}`. **Las acciones también deben ser idempotentes** (bloque 3) |
| 6 | Asistente → cliente `admin-assistant.service.ts:698` (cancelar), `:718` (confirmar), `:785` (`SEND_CUSTOMER_MESSAGE`) | cliente | Acción del dueño | No. Los dos primeros sin `await` y con `.catch(()=>{})` | Al reprocesar se repiten. El de confirmar choca con el 8 y el 9 | `notification` (698, 718) / `reply` (785) | `appt:{id}:cancelled`, `appt:{id}:confirmed`, `admin-msg:{inbound_batch_id}:{n}` |
| 7 | Mensaje del asesor desde el panel `messages.service.ts:60` (`POST /messages`) | cliente | Clic del asesor | No. Si el envío falla, solo avisa en el log, devuelve 200 y el mensaje consta como enviado | Doble clic o reintento HTTP | `reply` | `msg:{messageId}` (la fila de `messages` creada en la misma transacción) |
| 8 | `notifyAppointmentConfirmed` `notifications.service.ts:165`, llamado desde `appointments.controller.ts:76` (PATCH) y `auto-confirm.service.ts:53` | cliente | PATCH con `status=CONFIRMED`; cron cada 5 min | **No**: `appointments.service.ts:368-370` dispara `'confirmed'` **siempre que el DTO traiga CONFIRMED**, aunque ya lo estuviera. La autoconfirmación no exige `PENDING` en el `update` | Guardar dos veces en el panel → 2 mensajes. Panel + cron + asistente del dueño a la vez → hasta 3. `withRetry` (`notifications.service.ts:100-108`) no reintenta de verdad porque `sendWA` se traga el error | `notification` | `appt:{id}:confirmed:{scheduledAt}` (para que una cita reprogramada sí vuelva a avisar) |
| 9 | `notifyActionResolved` `notifications.service.ts:228` ← `appointments.controller.ts:84,89` | cliente | Aprobar o rechazar cancelación o reprogramación | No | Doble PATCH | `notification` | `appt:{id}:resolved:{action}:{approved}` |
| 10 | `notifyReminder` `notifications.service.ts:182` ← `reminders.service.ts:85` | cliente | Cron `0,30 * * * *`, ventanas de 8 h, 2 h y 1 h | **Sí, en el reclamo**: `updateMany ... where reminderXSentAt null` (`reminders.service.ts:78-83`). Pero si el envío falla, **la marca ya está puesta y no se reintenta** | No duplica, pero **pierde** envíos | `reminder` | `appt:{id}:reminder:{8h|2h|1h}`. El reclamo y el `INSERT wa_outbound` van en **la misma transacción** |
| 11 | `notifyAppointmentCreated` `notifications.service.ts:147` ← `ai.service.ts:3089,3305`, `public.service.ts:256` | dueño | Cita creada | No | Si se reprocesa el turno de la IA y vuelve a crear la cita | `notification` | `appt:{id}:created:admin` |
| 12 | `notifyPendingAction` `:211` ← `ai.service.ts:1022,1060,1146` | dueño | El cliente pide cancelar o reprogramar | No | Reprocesado | `notification` | `appt:{id}:pending:{action}:{inbound_batch_id}` |
| 13 | `notifyPaymentProofDetected` `:250` ← `ai.service.ts:903` | dueño | Comprobante detectado | No | Reprocesado | `notification` | `appt:{id}:payment-proof:{inbound_batch_id}` |
| 14 | Recordatorio "¿Confirmamos tu cita?" `ai.service.ts:766-769` (`sendFn`) | cliente | `setTimeout` de 5 min | No. Guarda en `messages` y luego envía | No duplica, pero **se pierde al reiniciar** | `reply` | `confirm-nudge:{conversationId}:{n}` con `not_before` |
| 15 | Reporte diario `reports.service.ts:176` (cron `0 2 * * *`) y `POST /reports/generate` (`reports.controller.ts:14-19`) | dueño | Diario + manual | No | Llamadas manuales repetidas | `notification` | `report:{storeId}:{yyyy-mm-dd}` (cron) / `report:{storeId}:manual:{uuid}` |
| 16 | Resumen matutino `reports.service.ts:263` (cron `30 11 * * *`) | dueño | Diario, solo si hay citas | No | Si el cron corre dos veces (dos procesos) | `notification` | `briefing:{storeId}:{yyyy-mm-dd}` |
| 17 | Campañas `campaigns.service.ts:80` (`POST /campaigns/:id/send`) | todos los clientes no bloqueados | Manual | **No**: el bucle va **dentro de la petición HTTP**, sin estado `sending`. `status='sent'` solo al final (`:97-100`) | **Doble clic → dos bucles completos.** Un reinicio a mitad deja `draft` y el siguiente envío repite a todos. Destino: **todos** los clientes, también los que nunca escribieron (va contra la spec). `scheduledAt` se guarda pero **ningún cron lo usa** | `campaign` | `campaign:{campaignId}:{customerId}` |

Notas:
- `isConnected` (§1.2) da `true` con creds registrados aunque el socket esté caído, así que `campaigns.service.ts:54` deja pasar campañas con WhatsApp desconectado.
- Todos los avisos al dueño van **desde el propio número de la tienda a `stores.admin_phone`**. Si ese número es el mismo que el vinculado, se envía a sí mismo. Hay que comprobarlo al migrar.

---

## 5. Ciclo de vida de la conexión

### 5.1 Conectar

- Arranque: `onModuleInit` → todas las tiendas `isActive` con fila en `whatsapp_sessions`, **en paralelo** (`:386`). No mira `subscriptionStatus`. Desactivar una tienda (`stores.service.ts:96`) no cierra su socket.
- Panel: `POST /whatsapp/connect/:storeId` → `connectStore`. Si `reconnecting` lo tiene, la petición se ignora en silencio (`:401-404`) y el panel no se entera.
- `connectStore` sobre un socket vivo: `existing.end(undefined)` (`:410`). En Baileys, `end()` emite `connection.update {connection:'close', lastDisconnect:{error: undefined}}` (`socket.js:471-497`). `handleDisconnect` recibe `statusCode === undefined`, lo cuenta como intento de QR y **programa otra reconexión en ~3 s** (`:586-609`). Esa reconexión cierra el socket recién creado, que vuelve a emitir `close undefined`, y así sucesivamente. Si el socket nuevo llega a `open` antes, el `open` resetea los contadores (`:494-497`) y **el bucle no termina nunca**. Solo se corta si fallan 3 seguidos sin abrir. **Cada vuelta es un inicio de sesión nuevo contra WhatsApp.** El panel provoca exactamente esto con "Reconectar" (`WhatsApp.tsx:84-96`: `disconnect` → espera 1,5 s → `connect`), y con cualquier `connect` sobre un número conectado.

### 5.2 Códigos de cierre

| Código | Rama | Efecto |
|---|---|---|
| 403 | `:537-546` | Para en seco y conserva creds (desde `cbe1a17`, 10-08). Antes del 10-08: reintentos cada 3 s (logs del 10-07 22:01-22:03, decenas de 403 con `location` cambiante: `frc`, `lla`, `vll`, `cln`, `odn`, `cco`, `atn`) |
| 401 `loggedOut` | `:548-580` | Reintento 1/2 a los 5 s con creds que **se vuelven a leer de la BD**, 2/2 igual. Al 3.º, `deleteMany` de la sesión + `waSessionId=null`. **No distingue un 401 provocado por nosotros (`logout()`) de uno del servidor** (§5.4) |
| 408 / `undefined` | `:586-596` | `qrAttempts++`. Al 3.º: para, **borra el socket del mapa** (un socket vivo queda huérfano si el `undefined` venía de un `end()`) y borra el QR |
| 440 (`connectionReplaced`), 428, 515, 500… | `:598-609` | Backoff `computeReconnectDelay`: base 3 s (8 s el 440), ×2, techo de 5 min y ±20 %. **Sin límite total**: un número que cae y abre en bucle (abre → cae → abre) resetea `reconnectFailures` en cada `open` y nunca llega al techo |
| `MAX_QR_ATTEMPTS = 3`, `MAX_LOGGED_OUT_RETRIES = 2` | `:37`, `:41` | Contadores en memoria: se reinician con cada proceso |

### 5.3 Credenciales (`useDBAuthState`, `:110-196`)

- **Una sola fila JSON** con `creds` y **todas** las claves Signal (`pre-key`, `session`, `sender-key`, `app-state-sync-key`, `lid-mapping`, `tctoken`…). Cada cambio reescribe el blob entero (`:144-150`): la escritura crece con la sesión y la última escritura gana.
- **Temporizador de 300 ms** (`:140-154`): las escrituras se agrupan. Si el proceso muere dentro de esa ventana, **los cambios se pierden**. El `catch` vacío (`:151`) se traga los errores de escritura sin dejar log ("se reintentará en el próximo cambio", que puede no llegar nunca).
- **`loadFromDB` devuelve `{}` ante cualquier error** (`:132-134`, `catch {}` sin log). Después `if (!cache['creds']) { cache['creds'] = initAuthCreds(); scheduleSave(); }` (`:156-159`). Una lectura fallida (BD aún no lista, pool agotado con `connectionTimeoutMillis: 10_000` y `max: 10` en `prisma.service.ts:13-18`, JSON corrupto) **sustituye en 300 ms una sesión registrada por creds nuevos sin registrar**: el QR queda garantizado y la sesión buena se pierde sin dejar rastro. Este es el agujero más grave del archivo.
- `saveCreds` (`:190-193`) solo vuelve a programar el temporizador.
- **SIGTERM hoy**: `main.ts` no llama a `app.enableShutdownHooks()` (lo confirma el comentario de `prisma.service.ts:31-33`). No hay manejador de señales en ningún sitio (grep). Node termina **al instante**: no se vacía el temporizador, no se cierran los sockets (WhatsApp ve una caída de TCP, no un cierre) y se pierde el trabajo en vuelo. systemd (`app.service`, unidad leída en el pod) usa `ExecStart=/bin/bash -c "... node dist/main.js"`, `Restart=on-failure` y `TimeoutStopSec` por defecto (90 s); la señal llega al cgroup entero.

### 5.4 Causa del QR del 2026-10-08 (con evidencia)

Logs del pod (`journalctl -u app.service`):

- **08-10 13:53:02**, PID 98337 nuevo: `Reconectando 3 store(s) con sesión guardada` y en el **mismo segundo** `QR generado` para `05a0e848`, `4793e786` y `7e2611c1`. Un QR instantáneo al arrancar significa que los creds cargados **no tenían `me`**: ya estaban sin registrar en la BD *antes* del reinicio. Después vienen 3 ciclos de QR de ~2:45 min cada uno (`408 QR refs attempts ended`) y a las 14:01:18 `deteniendo reconexión automática` para las tres.
- **`4793e786` y `7e2611c1`**: tienen el mismo patrón (QR en cada arranque, 3 ciclos y parada) el 10-04 02:27, el 10-06 18:38/18:47/18:57/19:18, el 10-07 14:21, el 10-08 13:53 y el 10-09 18:02. **No se conectaron en ningún momento de la ventana revisada.** El único 401 registrado es del 09-01 17:32 en `4793e786`: `401 — Intentional Logout` → `reintento 1/2 con los mismos creds`.
- **`05a0e848`**: el 10-06 sobrevivió **tres reinicios seguidos** (18:34, 18:36 y 18:38), reconectando en 1–2 s sin QR. Prueba de que un reinicio por sí solo no desvincula cuando los creds están bien guardados. El 10-07 entra en el bucle de 403 (cuenta en revisión). A las **22:03:24** aparece `código: 401 — motivo: Intentional Logout` → `reintento 1/2 con los mismos creds (sin borrar sesión)` → a las 22:06:09 `408 QR refs attempts ended`, es decir, la "reconexión con los mismos creds" mostró un QR. A las 22:11:40 para tras 3 ciclos.

Mecanismo, con el código:
1. `"Intentional Logout"` es el texto por defecto de `sock.logout()` en Baileys (`socket.js:583`). En `src/` solo lo llama `disconnectStore` (`whatsapp.service.ts:1439`), y a este solo llega `DELETE /whatsapp/disconnect/:storeId`, que el panel usa en Desconectar, **Cancelar** y **Reconectar** (`WhatsApp.tsx:59-96`). Alguien pulsó uno de esos botones. Lo más probable es que fuera durante el bucle de 403, para "arreglarlo".
2. `logout()` envía `remove-companion-device` (`socket.js:561-582`): **desvincula el dispositivo en WhatsApp**. Es definitivo.
3. `disconnectStore` borra el socket del mapa y los contadores, y después borra la fila de sesión (`:1444-1447`). Pero el `close` que emite `logout()` lo procesa `handleDisconnect` con `statusCode 401`. Como `loggedOutAttempts` se acaba de limpiar, lo toma por **401 transitorio** y programa `connectStore` a los 5 s (`:553-563`).
4. A los 5 s, `useDBAuthState` no encuentra fila → `initAuthCreds()` → `scheduleSave()` **vuelve a crear la fila** con creds sin registrar (`:156-159`). Desde ahí, la tienda cuenta como "con sesión guardada" en cada arranque y pide QR siempre.

Conclusión: **el reinicio del 08-10 no desvinculó nada; dejó a la vista que las tres sesiones ya estaban muertas.** Una cayó el 10-07 por un `disconnect` desde el panel combinado con el falso 401 transitorio. En las otras dos, el último evento registrado es un `Intentional Logout` del 09-01 (solo para `4793e786`; para `7e2611c1` no hay rastro de la causa en el journal disponible). En el panel no podían figurar como conectadas, porque `isConnected` exige `creds.me`. Si alguien las vio "conectadas" antes del 08-10, fue antes del 10-04 (dato no verificable con estos logs).

Riesgos **latentes** que sí pueden desvincular o corromper en un reinicio futuro, aunque esta vez no fueron la causa: `loadFromDB` → `{}` → sobrescritura (§5.3), el temporizador de 300 ms perdido con SIGTERM, el arranque de N sockets a la vez y el bucle de `connect` sobre un socket vivo (§5.1).

Comprobación pendiente (no hecha, por ser prod): `SELECT store_id, data->'creds'->'me' IS NOT NULL AS registrado, updated_at FROM whatsapp_sessions;` por el túnel, para confirmar que las tres filas tienen `me` nulo.

---

## 6. Superficie HTTP y lo que espera el panel

`src/whatsapp/whatsapp.controller.ts` (`JwtAuthGuard`, y en todos `req.user.storeId === :storeId`, si no 403):

| Ruta | Respuesta hoy | Uso en `stockup-frontend` |
|---|---|---|
| `POST /whatsapp/connect/:storeId` (`:11-17`) | `await connectStore` → `{message}` (espera la importación de Baileys, la versión de GitHub y la carga de auth) | `connectWhatsApp` (`src/services/api.ts:390-391`) ← `WhatsApp.tsx:52` (Conectar), `:91` (Reconectar) |
| `GET /whatsapp/qr/:storeId` (`:19-28`) | `{qr}` o `{message}` (200 en los dos casos) | `getWhatsAppQR` ← `WhatsApp.tsx:24`, **sondeo cada 3 s** mientras `!connected` (`:38-47`) |
| `GET /whatsapp/status/:storeId` (`:30-36`) | `{storeId, connected}` (`connected` = `creds.me != null`) | `getWhatsAppStatus` ← `WhatsApp.tsx:16` (al cargar + sondeo de 3 s) y `Dashboard.tsx:66` (una vez) |
| `DELETE /whatsapp/disconnect/:storeId` (`:38-44`) | `logout` + borrar la sesión → `{message}` | `disconnectWhatsApp` ← `WhatsApp.tsx:62` (Desconectar), **`:77` (Cancelar el QR)** y **`:87` (Reconectar)** |

Contrato que hay que respetar para no romper el panel sin tocarlo: mismas rutas, `{qr}` cuando hay QR y `{connected: boolean}`. Con el gateway:
- `connect` → insertar `wa_commands(connect)` y responder enseguida. El QR aparece en BD unos segundos después y el sondeo de 3 s ya lo recoge.
- `status.connected` → `wa_session_lease.status = 'open'` (más preciso que hoy). Se pueden **añadir** campos (`status`, `reconnects24h`, `sentToday`, `dailyCap`, `pausedRisk`) sin romper nada; el panel los ignora hasta la parte de salud (1d).
- **Cambio de semántica obligatorio**: "Cancelar" y "Reconectar" no pueden seguir haciendo `logout` (desvincula el teléfono). Opciones: `DELETE /disconnect` acepta `?logout=false` (cerrar sin desvincular) y el panel envía `logout=true` solo en "Desconectar". O el backend deja de desvincular cuando el número no está registrado. Hace falta un cambio mínimo en el panel (`WhatsApp.tsx:74-96`) o una decisión de Alex. **Pregunta abierta.**
- El panel no muestra errores (`catch {}` en todas las llamadas): un `connect` ignorado por `reconnecting` pasa desapercibido.

---

## 7. Riesgos y trampas de la migración

1. **Orden de los mensajes**: hoy está garantizado por la cola en serie por `storeId:phone`. Con varios workers hace falta reclamar por clave (`identity`) y no por fila. Salida: una sola cola por número (spec), y los trozos de 4096 de un mismo mensaje lógico van en **una** fila de `wa_outbound` con el payload troceado, nunca en filas sueltas que puedan intercalarse.
2. **Latencia de la IA**: hoy son 3 s de debounce + IA. Se añade gateway → INSERT → NOTIFY → worker → INSERT → NOTIFY → gateway (decenas de ms si NOTIFY funciona). El sondeo de respaldo debe ser de pocos segundos, no de 30. El ritmo humano de 1d (escribiendo + pausa proporcional) añade más a propósito: hay que fijar el tope para que una respuesta larga no tarde 30 s.
3. **`@lid` frente a teléfono**: la dirección de envío sale de `jidFromPhone(identity)`. Si `linkLidIdentity` fusiona la ficha entre el encolado y el envío, la fila de `wa_outbound` lleva la identidad vieja (`lid:`). Hay que guardar en `wa_outbound.to` el **jid ya resuelto** al encolar y aceptar que un `@lid` siga siendo válido. El incidente del `tctoken` (comentario `:116-121`) dice que el envío a `@lid` depende de que las claves se deserialicen bien: la reescritura de `useDBAuthState` debe mantener `BufferJSON.replacer`/`reviver` exactamente igual.
4. **`fromMe`**: hoy los ecos de lo que envía el bot llegan por `messages.upsert` y se descartan por `fromMe`, salvo `!stop`. En el gateway: el `!stop` del dueño se reenvía como comando y lo demás se descarta. **No** hay que meter los ecos en `wa_inbound` (provocarían respuestas de la IA a sí misma). Usar `provider_message_id` de `wa_outbound` para reconocer los propios.
5. **Dedupe entre procesos**: UNIQUE `(store_id, provider_message_id)` en `wa_inbound` + `ON CONFLICT DO NOTHING`. Ojo, los mensajes **sin id** (`msg.key.id` vacío, `:757`) no se pueden deduplicar: hace falta una clave sintética o rechazarlos con log.
6. **Transacciones largas**: la IA tarda segundos (timeouts `AI_TIMEOUT_MAIN_MS`, Whisper 25 s). El reclamo de `wa_inbound` no puede tener abierta una transacción con `FOR UPDATE` durante la IA. Patrón: reclamar (`status='processing'`, `claimed_by`, `claimed_until`) en una transacción corta, procesar fuera y cerrar en otra corta. Recuperar los reclamos vencidos.
7. **Pool de Postgres**: `max: 10` (`prisma.service.ts:15`) por proceso. `LISTEN` necesita una conexión `pg.Client` **dedicada** fuera del pool de Prisma (Prisma no soporta LISTEN; `pg` ya es dependencia directa en `package.json`). El gateway, con N sesiones escribiendo claves, más los workers y la API, comparten el `max_connections` del Postgres del pod.
8. **Escritura de creds**: pasar a "inmediata y atómica" con el blob único actual multiplica las escrituras de un JSON que crece. Recomendación: **una fila por clave** (`whatsapp_session_keys(store_id, type, id, value)`) + `creds` en su propia fila, con upsert en lote por evento. La migración de datos de la fila JSON actual se hace al arrancar el gateway, de forma idempotente.
9. **Memoria por sesión**: no se pudo medir con sesiones registradas (hoy las 3 están sin registrar: `node dist/main.js` ocupa 159 MB de RSS con la API y los 3 sockets en QR). La cifra de 30–60 MB por sesión de la spec **no está verificada aquí**. Medirla en 1c con un número real antes de fijar el tope de sesiones por gateway.
10. **Acoplamiento de módulos**: `WhatsappModule` importa IA, conversaciones, mensajes (circular con `forwardRef`), clientes, bloqueados y asistente. El gateway debe arrancar con un módulo propio (`GatewayModule`: Prisma + Baileys) para no cargar la IA ni los crons. **`ScheduleModule.forRoot()` está en `AppModule`**: si el gateway reutiliza `AppModule`, los crons (recordatorios, reportes, autoconfirmación, `@Interval(30_000)` de sync) **correrían dos veces**.
11. **Tests**: `test/support/fake-whatsapp.ts` sustituye **todo** `WhatsappService` (y su `onModuleInit` no hace nada), así que el flujo de entrada (debounce, `!stop`, asesor, `[IGNORAR]`, LID) **no tiene ningún test**. Sacarlo a un `InboundProcessor` puro antes de mover nada permite fijar su comportamiento con tests que fallen primero.
12. **Logs**: hoy se registra el contenido (`:852` 100 caracteres, `:1055` transcripción) y los teléfonos. El gateway no debe registrar contenido. Cada línea del gateway debe llevar `storeId`, `waMessageId` y `outboundId`. Baileys va con `level:'silent'` (`:420`): al depurar un cierre no hay nada de Baileys en el log; conviene `warn` en el gateway.
13. **`fetchLatestBaileysVersion()`** en cada conexión (`:421`): un `fetch` sin timeout a la rama `master` de GitHub. Con arranque escalonado hay que cachear la versión por proceso o fijarla, para que un cambio upstream no altere el protocolo sin deploy.
14. **Mensajes en vuelo al cortar la API**: con `wa_inbound` dejan de perderse. Al cortar el **gateway**, Baileys ya ha confirmado a WhatsApp lo recibido; si no se insertó en `wa_inbound` antes de morir, se pierde. Hay que insertar antes de cualquier otra cosa y vaciar en el apagado.
15. **El asistente del dueño ejecuta acciones con efectos** (crear o cancelar citas, enviar a clientes). Con reintentos de `wa_inbound` (fallo después de ejecutar y antes de marcar `done`), las acciones se repetirían. Hay que marcar el inbound como procesado en la misma transacción que la última escritura, o hacer idempotentes las acciones (bloque 3).
16. **Dos procesos con el mismo número** = `440 connectionReplaced` en bucle y claves pisándose. El arriendo es la defensa. Hasta 1c no existe: durante 1a y 1b sigue habiendo un único proceso y la regla es "nunca dos `node dist/main.js`".

---

## 8. Propuesta de sub-bloques desplegables

Principio: primero lo que **para la pérdida y los duplicados con el proceso actual**, después lo que **protege los números**, y por último la **separación de procesos**. Cada sub-bloque deja el sistema funcionando y es reversible.

### 1a — Salida por cola `wa_outbound` + idempotencia (proceso único)

- Migración `wa_outbound` (columnas de la spec + `to_jid` resuelto, payload troceado a 4096, `idempotency_key UNIQUE`, `not_before`, `priority`, `kind`) e índices `(status, not_before, priority)` y `(store_id, status)`.
- `OutboundService.enqueue({storeId, to, text, kind, key, notBefore?})` con `INSERT … ON CONFLICT (idempotency_key) DO NOTHING`. **Todos** los sitios de §4 pasan a encolar con su clave. Donde ya hay una escritura de negocio (mensaje del asesor, reclamo del recordatorio, guardar la respuesta de la IA), el encolado va **en la misma transacción**.
- Un despachador **dentro del mismo proceso** reclama con `FOR UPDATE SKIP LOCKED`, uno por tienda a la vez, y llama a `safeSend`, registrando `provider_message_id`, `attempts` y `error`. Reintenta con backoff y un tope, solo en errores temporales.
- Arreglos incluidos porque los toca el mismo cambio: el doble envío del aviso de asesor (`:1306` + `messages.service.ts:58`); `'confirmed'` solo en la transición `PENDING→CONFIRMED` (`appointments.service.ts:368`) y autoconfirmación con `where status=PENDING`; campañas fuera de la petición HTTP (`sending` → encolar uno por cliente → `sent`), solo a clientes con mensajes entrantes (spec); el recordatorio de 5 min de la IA como `not_before` (sobrevive a reinicios).
- `wa_inbound` **todavía no**, pero sí la UNIQUE de dedupe: **tabla `wa_inbound` mínima usada solo como registro de ids vistos** (inserción `ON CONFLICT` en `processMessage`), para que deje de haber respuestas duplicadas tras un reinicio.
- Por qué primero: elimina los duplicados y las pérdidas de salida **sin tocar los sockets**. Es la base que necesitan 1c (el gateway leerá esta misma tabla) y 1d (ritmo y prioridades actúan sobre ella).

### 1b — Credenciales seguras, apagado limpio, arranque escalonado y presupuesto de reconexiones (proceso único)

- `useDBAuthState` nuevo: `loadFromDB` **falla con error** si la BD falla (nunca `{}` → `initAuthCreds` sobre una fila existente; solo se crean creds nuevos si la fila **no existe**). Escritura inmediata y atómica por evento (tabla de claves por fila, §7.8). Errores de escritura registrados en el log.
- `enableShutdownHooks()` + `beforeApplicationShutdown`: dejar de reclamar outbound, esperar a los envíos en curso, vaciar las escrituras de claves y hacer `sock.end(undefined)` **sin logout** marcando "cierre propio" para que `handleDisconnect` no reconecte. `TimeoutStopSec` en el drop-in de systemd.
- Arranque escalonado (uno cada 20–40 s al azar), y solo tiendas con creds **registrados** (`creds.me`). Las que no lo están quedan en `needs_qr` sin abrir socket: se acaban los 3 ciclos de QR en cada arranque.
- `connectStore` idempotente: si hay un socket `open` o `connecting`, no hace nada; los `close` de sockets que ya no son el actual se ignoran (comparar `sock` con `this.sockets.get(storeId)`). Así se rompe el bucle de §5.1.
- `disconnectStore`: marcar el cierre como intencional para que el 401 propio no dispare el reintento (§5.4). Separar `close` (sin logout) de `logout`. Decisión del panel en §6.
- Presupuesto de reconexiones (N por hora y M por 24 h, por entorno) persistido en una tabla de estado por tienda (la futura `wa_session_lease`, creada ya aquí con `status` y contadores, todavía sin `owner_id`/`lease_until` en uso) → `paused_risk`.
- `status` expone `status` además de `connected`. `connected` pasa a significar "socket `open`".
- Por qué antes del gateway: estos cambios son los que **protegen los números**, y se pueden probar con el proceso actual. Cuando llegue 1c, el código de conexión que se mueve ya está blindado.

### 1c — Proceso `wa-gateway` + `wa_inbound` + arriendo + `wa_commands`

- Segundo entrypoint `src/gateway.main.ts` con `GatewayModule` propio (sin `ScheduleModule`, IA ni módulos de negocio) y `wa-gateway.service` en systemd. El script de deploy reinicia solo lo que cambió.
- `BaileysProvider` detrás de `WhatsAppProvider`: conexión, identidad (LID), descarga de audio, envío desde `wa_outbound` (el despachador de 1a se muda aquí) y precarga LID.
- `wa_inbound` completo (identidad resuelta, tipo, texto normalizado, audio en bytes con purga, `!stop` del dueño). En la API, `InboundWorker`: reclamo por clave con debounce de 3 s (§3.4), y el código actual de `processMessage` (parte N) + `handleIncomingMessage` sacado a un `InboundProcessor` con tests.
- `wa_session_lease` con `owner_id`, `lease_until` y renovación. `wa_commands` (connect, disconnect, logout) desde el controlador, y QR y estado leídos de la BD.
- LISTEN/NOTIFY en los dos sentidos + sondeo de respaldo cada 2–5 s.
- Retención: purga de `wa_inbound` y `wa_outbound` procesados por antigüedad (cron en la API, con candado).
- Por qué en tercer lugar: es el cambio grande y el más arriesgado. Llega con la salida ya en cola (1a) y la conexión ya blindada (1b), así que la migración es mover código probado y no reescribirlo. Criterio de terminado de la spec: un deploy de la API con números conectados y **cero reconexiones** en el gateway.

### 1d — Ritmo humano, prioridades, frenos de campaña y salud en el panel

- Una cola por número en el gateway, con prioridad `reply` > `notification`/`reminder` > `campaign`. "Escribiendo…" + pausa proporcional al largo con tope.
- Campañas: 8–20 s al azar, horario permitido (Ley 2300), tope diario por número según antigüedad e incidentes, y pausa automática si suben errores o desconexiones.
- Salud: endpoint de estado ampliado + bloque en el panel (estado, reconexiones 24 h, envíos del día frente al tope, RAM del gateway). Es lo único que toca la UI y es aditivo.
- Por qué al final: necesita la cola (1a) y el gateway (1c), y es lo único que cambia el comportamiento visible para el cliente final (respuestas algo más lentas a propósito).

### Orden de despliegue y estado tras cada uno

| Tras | Sigue funcionando | Gana |
|---|---|---|
| 1a | Todo igual, mismo proceso | Sin duplicados, envíos trazables y reintentables, campañas seguras |
| 1b | Todo igual, mismo proceso | Un reinicio no desvincula ni hace bucles, apagado limpio, `status` fiable |
| 1c | API y gateway separados | Un deploy de la API no toca los números, y lo entrante no se pierde |
| 1d | Igual + salud visible | Ritmo humano y frenos anti-bloqueo |

---

## 9. Pendientes y decisiones abiertas

- **Panel**: ¿"Cancelar" y "Reconectar" deben desvincular el teléfono? (§6). Recomendación: no. Solo "Desconectar" hace `logout`, y requiere un cambio mínimo en `WhatsApp.tsx`.
- Confirmar en BD (túnel) que las 3 filas de `whatsapp_sessions` no tienen `creds.me` (§5.4). Se pueden borrar sin riesgo antes de la reconexión controlada del cierre del programa.
- Medir la RAM de una sesión registrada real (§7.9).
- `stores.wa_session_id` no se lee en ningún sitio (solo se escribe en `:500`, `:576` y `:1446`): sustituirlo por `wa_session_lease` o eliminarlo.
- Fuera del bloque 1 pero detectado aquí: los mensajes que el dueño escribe a mano desde el teléfono no entran al historial; `isBlocked` no funciona con identidades `lid:`; el dueño no se reconoce si escribe como `lid:`; con un sticker la conversación pasa a `pending_human` y se registra un error; `campaign.scheduledAt` no lo usa nadie.
