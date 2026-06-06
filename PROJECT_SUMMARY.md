# STOCKUP MESSAGES — PROJECT SUMMARY

**Última actualización:** 2026-06-05  
**Estado:** Producción activa

---

## RESUMEN EJECUTIVO

CRM WhatsApp con IA para barberos, salones y tiendas pequeñas en Latinoamérica.  
SaaS multi-tenant: cada tienda tiene su propia sesión de WhatsApp, IA, catálogo, citas, staff y analíticas.

**Repos:**
- Backend: `https://github.com/alexpipe31w/whatsapp-crm`
- Frontend: `https://github.com/alexpipe31w/stockup-frontend`

**URLs producción:**
- Backend: `https://whatsapp-crm.ash-1.instapods.app` (InstaPods, Always On)
- Frontend: `https://stockup-frontend.vercel.app` (Vercel, auto-deploy)
- BD: Neon PostgreSQL (serverless)

---

## STACK TÉCNICO

### Frontend (`C:\Users\alexp\Desktop\proyectos\stockup-frontend`)
- React 19 + TypeScript (CRA / react-scripts 5)
- Tailwind CSS 3.4 — design system dark mode propio
- React Router DOM v7
- Axios + TanStack Query v5
- lucide-react (iconos), framer-motion (animaciones)
- socket.io-client, recharts, qrcode.react
- xlsx / SheetJS 0.18.5 (exportación Excel)
- Capacitor v8 (Android APK)

### Backend (`C:\Users\alexp\Desktop\proyectos\whatsapp-crm`)
- NestJS 11 + TypeScript
- Prisma 6 + PostgreSQL (Neon)
- Baileys v7 (WhatsApp Web API)
- IA multi-provider: Groq / OpenAI / Together / Mistral / Anthropic
- Groq Whisper (audio → texto)
- Brevo HTTP API (emails)
- MercadoPago (suscripciones producción)
- node-cron (recordatorios, reportes diarios, keepalive)

---

## SCHEMA PRISMA — MODELOS ACTUALES

```
Store
├── staffLabel String?        // "Barbero", "Estilista", etc.
├── slug       String? @unique // para calendario público /cal/:slug
├── businessHours Json?
├── adminPhone String?
│
├── Staff[]                   // equipo de trabajo por tienda
│   ├── staffId, name, isActive
│   └── schedule Json?        // null = hereda store.businessHours
│
├── Customer[]
│   ├── phone, name, cedula, city
│   ├── totalOrders, totalSpent
│   └── acceptsMarketing
│
├── Conversation[]
│   └── Message[]
│
├── Product[] → ProductVariant[]
├── Category[]
├── Service[] → ServiceVariant[]
│
├── Order[]
│   ├── type: 'product' | 'food' | 'service'
│   ├── status: pending|confirmed|packed|shipped|delivered|cancelled
│   ├── isManual, manualPaymentMethod
│   ├── appointmentId? @unique  // idempotencia service orders
│   └── OrderItem[]
│
├── Appointment[]
│   ├── status: PENDING|CONFIRMED|IN_PROGRESS|COMPLETED|CANCELLED|NO_SHOW|RESCHEDULED
│   ├── priority: LOW|NORMAL|HIGH|URGENT
│   ├── source: AI|MANUAL|WHATSAPP|API
│   ├── staffId?               // empleado asignado
│   ├── paymentStatus, paymentEvidence
│   └── @@index([storeId, staffId, scheduledAt])
│
├── Campaign[]
├── User[]                    // admins/agentes de la tienda
├── BlockedContact[]
├── WhatsappSession
├── AIConfiguration
│   └── aiProvider (Groq/OpenAI/Together/Mistral/Anthropic)
├── Subscription
├── DailyReport[]
└── SuperAdmin
```

**REGLA CRÍTICA:** `prisma db push --accept-data-loss` SIEMPRE. NUNCA `prisma migrate` ni `prisma migrate reset` — hay drift histórico en Neon.

---

## MÓDULOS BACKEND (`src/`)

```
src/
├── ai/                    IA: respuestas, extracción citas, staff catalog,
│                          disponibilidad real (extractQueryDate + computeSlotsForAI)
├── admin-assistant/       Asistente IA personal para el dueño vía WhatsApp
├── analytics/             KPIs, /analytics/summary (períodos), tendencias
├── appointments/          CRUD citas, conflictos por staff, timeline, stats
├── auth/                  JWT + Passport, login, me
├── blocked/               Contactos bloqueados
├── campaigns/             Mensajería masiva, programada
├── config/                Validación envs (Zod + passthrough)
├── conversations/         Conversaciones WhatsApp, takeover, estados
├── customers/             CRUD clientes, historial, métricas
├── dashboard/             KPIs dashboard principal
├── messages/              Mensajes por conversación
├── notifications/         WhatsApp + email (cita creada/confirmada/recordatorio)
├── orders/                CRUD órdenes, manual, /store/:id?type=service
├── prisma/                PrismaService + PrismaModule
├── products/              CRUD productos + variantes + stock
├── public/                Endpoints SIN auth para calendario público
│   ├── GET /public/:slug           info básica tienda
│   └── GET /public/:slug/availability?date=YYYY-MM-DD
├── reminders/             Cron 30min: recordatorios 8h/2h/1h antes de cita
├── reports/               Cron 9pm COL: DailyReport + historial en BD
├── services/              CRUD servicios + variantes + plantillas
├── staff/                 CRUD empleados por tienda
│   └── GET/POST/PATCH/DELETE /staff
├── stores/                Config tienda, businessHours, slug, staffLabel
├── subscriptions/         MercadoPago webhooks, estado suscripción
├── superadmin/            Panel admin global con 2FA email
└── whatsapp/              Baileys, QR, sesión, envío mensajes
```

---

## FEATURES COMPLETAS

### WhatsApp CRM
- Conexión por QR (Baileys v7) por tienda
- Conversaciones en tiempo real, estados: active/pending_human/human/closed
- Takeover manual / release / cierre
- IA responde automáticamente con prompt configurable
- Anti-bucle IA, debounce de mensajes
- Audio → texto (Groq Whisper)
- Catálogo de productos e IA sabe precios/stock

### Admin Personal Assistant
- Activado cuando `adminPhone` escribe al propio WhatsApp del negocio
- Contexto real: citas hoy, ventas, finanzas, catálogo, top clientes
- Acciones ejecutables desde WA: CREATE_ORDER, CREATE/CANCEL/CONFIRM/COMPLETE_APPOINTMENT, DAILY_REPORT
- Historial en memoria (2h TTL, 16 mensajes)

### Sistema de Staff / Equipo
- Múltiples empleados por tienda (barberos, estilistas, técnicos)
- `schedule null` = hereda `store.businessHours` automáticamente
- Conflictos independientes por empleado (Carlos lleno no bloquea a Luis)
- IA pregunta al cliente qué empleado quiere → extrae `staffId`
- Frontend: tab "Equipo" en Config, filtro en Appointments, columna en lista/calendario

### Citas (Appointments)
- CRUD completo + timeline de historial
- Flujo de pago: comprobante vía WA → aprobar/rechazar
- **Auto-orden de servicio**: al confirmar pago → crea Order(type='service') atómica + actualiza cliente. Idempotente por `appointmentId @unique`
- Pendientes: cliente solicita cancelar/reagendar → badge en frontend

### Ventas de Productos (`/orders`)
- Modal con selector de productos del catálogo (auto-rellena precio, descuenta stock)
- Toggle cliente **existente** / **nuevo** (crea cliente on the fly)
- Botón Exportar Excel en header
- Filtro: `type !== 'service'` — service orders no aparecen aquí

### Ventas de Servicios (`/service-orders`)
- Se generan automáticamente al confirmar pago de citas
- **Nueva venta manual**: modal con cliente existente/nuevo, descripción, precio, método
- KPIs: revenue total, hoy, cantidad, métodos de pago
- Exportar Excel

### Calendario Público (`/cal/:slug`)
- Sin auth — ruta pública fuera de PrivateRoute
- Vista de slots disponibles por empleado, navegación por días (hoy +30)
- Slots calculados en tiempo real: businessHours minus citas PENDING/CONFIRMED/IN_PROGRESS
- Config: campo slug + preview link + botón copiar

### IA — Disponibilidad en Tiempo Real
- Regex detecta consultas de disponibilidad en mensaje del cliente
- `extractQueryDate()`: parsea "hoy", "mañana", "el lunes", "el 10 de junio"
- `computeSlotsForAI()`: calcula slots reales por empleado y fecha
- Inyecta bloque de disponibilidad exacta en el system prompt
- Sin fecha → IA pregunta "¿Para qué día?"

### Analíticas (renovadas)
- **Tab Dashboard**: ingresos totales, productos vs servicios, distribución %, métodos de pago, top productos, top servicios, rendimiento por profesional
- **Tab Reportes**: tabla filtrable, totales al pie, export Excel
- **Períodos**: Hoy / Esta semana / Este mes / Mes anterior
- Endpoint: `GET /analytics/summary?period=today|week|month|last_month`

### Excel Export (`src/utils/exportExcel.ts`)
- Incluye TODAS las órdenes con `total > 0` (sin filtrar por status — fix del bug original)
- Hojas: Resumen, Ventas Productos, Ventas Servicios, Todas las ventas, Citas
- Columnas numéricas reales (no strings) → sumas automáticas en Excel
- Fila de totales al final de cada hoja

### Notificaciones Automáticas
- 6 tipos: citaCreada, citaConfirmada, recordatorio, pendingAction, resuelta, comprobante
- WhatsApp (Baileys) + email (Brevo) simultáneamente
- Recordatorios: cron 30min, ventanas 8h/2h/1h antes, dedup atómico
- DailyReport: cron 9pm Colombia, guardado en BD (upsert por storeId+date)

### Core SaaS
- Registro público + verificación email (Brevo) + pago MercadoPago
- JWT + rutas protegidas por suscripción activa
- Superadmin con 2FA email: `/superadmin/login` → `/superadmin`
- MercadoPago producción (`APP_USR-...`), webhook HMAC verificado, idempotente

---

## FRONTEND — RUTAS

| Ruta | Componente | Auth requerida |
|------|-----------|----------------|
| `/` | Dashboard | Sí |
| `/whatsapp` | WhatsApp QR | Sí |
| `/conversations` | Conversations | Sí |
| `/appointments` | Appointments | Sí |
| `/campaigns` | Campaigns | Sí |
| `/products` | Products | Sí |
| `/services` | Services | Sí |
| `/orders` | Orders (Ventas Productos) | Sí |
| `/service-orders` | ServiceOrders (Ventas Servicios) | Sí |
| `/customers` | Customers | Sí |
| `/analytics` | Analytics | Sí |
| `/config` | Config (Negocio/IA/Equipo) | Sí |
| `/cal/:slug` | PublicCalendar | **No — pública** |

---

## DEPLOY

### Backend (InstaPods — $7/mo, Always On, US-East)
```
Build:  npm install && npx prisma db push --accept-data-loss && npx prisma generate && npm run build
Start:  npm run start:prod
Envs:   /home/instapod/app/.env  (cargadas por ConfigModule/dotenv — NO son OS vars)
SSH:    dashboard → Terminal
```

### Frontend (Vercel — auto-deploy desde main)
```
CI=true → ESLint warnings = errores de build
NUNCA Set-Content/Out-File de PowerShell para .tsx/.ts (BOM → unicode-bom error)
```

### Variables de entorno backend
```
DATABASE_URL, GROQ_API_KEY, JWT_SECRET, NODE_ENV=production,
PORT, WA_SESSION_PATH, MP_ACCESS_TOKEN, MP_SANDBOX=false,
MP_WEBHOOK_SECRET, APP_URL, FRONTEND_URL, ALLOWED_ORIGINS,
CRON_SECRET, BREVO_API_KEY, BREVO_SENDER_EMAIL
```

---

## DESIGN SYSTEM (Dark Mode)

| Token | Valor |
|-------|-------|
| Canvas | `#0A0A0F` |
| Surface | `#141419` |
| Surface Elevated | `#1C1C24` |
| Surface Overlay | `#24242E` |
| Accent Lima | `#D4FF00` |
| Accent Dark | `#A3CC00` |
| Text Primary | `#F0F0F5` |
| Text Secondary | `#8A8A9A` |

- Botones primarios: `gradient-brand` (#D4FF00→#A3CC00) con `text-[#0A0A0F]`
- Iconos: `lucide-react` — sin emojis en la UI
- Inputs en modales DEBEN tener: `bg-surface-elevated text-txt-primary placeholder:text-txt-tertiary`

---

## ESTÁNDARES DE INGENIERÍA

- **Multi-tenant:** toda query filtra por `storeId` del JWT, nunca del body
- **Atomicidad:** operaciones multi-tabla → `prisma.$transaction`
- **Idempotencia:** webhooks verifican si ya se procesaron; service orders por `appointmentId @unique`
- **DTOs:** `ValidationPipe` global con `whitelist: true, forbidNonWhitelisted: true`. TODOS los campos del frontend deben estar en el DTO con decoradores
- **Prisma JSON null:** usar `Prisma.JsonNull` (no `null` plano) en campos `Json?`
- **PublicModule:** sin `JwtAuthGuard` — módulo separado para endpoints públicos
- **Staff schedule:** `null` = hereda `store.businessHours`. No asumir que tiene schedule propio.
- **`createManualOrder`:** acepta `type` ('product' | 'food' | 'service') — default 'product'

---

## BUGS CRÍTICOS RESUELTOS (histórico)

| Bug | Fix | Commit |
|-----|-----|--------|
| Service orders aparecían en Ventas Productos | `filter(o => o.type !== 'service')` | — |
| Excel vacío (filtro `status=delivered` excluía manual/service) | Incluir todos con `total > 0` | — |
| Órdenes IA nunca se generaban | Caso 1.5 faltante + caché con items | `ae1d7c7` |
| Fecha cita año 2028 (LLM alucinaba) | Validación hoy+2años | `ae1d7c7` |
| Reagendar crea cita duplicada | Buscar PENDING/CONFIRMED en 48h, actualizar | `8f21ece` |
| Segunda cita sobreescribía la primera | Reagendar solo si `conversationCreatedAppts` vacío | `a9a9fce` |
| CORS post-migración InstaPods | Zod `.passthrough()` en schema | `b4887ca` |
| Chat IA color ilegible (blanco sobre lima) | `text-[#0A0A0F]` en burbujas IA | `c584889` |

### Limitación conocida
- **3+ citas en un solo mensaje:** extractor retorna solo 1 JSON a la vez. Las demás se crean en mensajes sucesivos.
