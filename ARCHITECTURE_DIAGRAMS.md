# 🏗️ ARQUITECTURA & DIAGRAMAS - STOCKUP + WHATSAPP CRM

## System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           CLIENTE (Browser)                             │
│                     http://localhost:3000                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│   ┌──────────────────────────────────────────────────────────────┐      │
│   │              React 19 (Stockup Frontend)                     │      │
│   ├──────────────────────────────────────────────────────────────┤      │
│   │                                                                │      │
│   │   App.tsx (Router raíz)                                      │      │
│   │   ├── /login                    ← Público                    │      │
│   │   ├── private routes                                         │      │
│   │   │   ├── /dashboard            ← Todos                      │      │
│   │   │   ├── /customers            ← Agentes+                   │      │
│   │   │   ├── /conversations        ← Agentes+                   │      │
│   │   │   ├── /appointments         ← Agentes+                   │      │
│   │   │   ├── /orders               ← Agentes+                   │      │
│   │   │   └── admin routes          ← Admin solo                 │      │
│   │   │       ├── /products                                      │      │
│   │   │       ├── /services                                      │      │
│   │   │       ├── /campaigns                                     │      │
│   │   │       ├── /analytics                                     │      │
│   │   │       ├── /users                                         │      │
│   │   │       ├── /whatsapp                                      │      │
│   │   │       ├── /ai-config                                     │      │
│   │   │       └── /blocked                                       │      │
│   │                                                                │      │
│   │   Context: AuthProvider + useAuth hook                       │      │
│   │   ├── token (JWT en localStorage)                            │      │
│   │   ├── user { userId, email, role, storeId }                 │      │
│   │   └── logout() → 401 handler                                 │      │
│   │                                                                │      │
│   │   Data Fetching: React Query + Axios                         │      │
│   │   ├── useQuery() → GET requests                              │      │
│   │   ├── useMutation() → POST/PATCH/DELETE                      │      │
│   │   └── Interceptores: JWT + Error handling                    │      │
│   │                                                                │      │
│   └──────────────────────────────────────────────────────────────┘      │
│                            ↓ HTTP(S)                                   │
│                     Bearer Token (JWT)                                 │
│                            ↓                                            │
└─────────────────────────────────────────────────────────────────────────┘
                             ⬇️
┌─────────────────────────────────────────────────────────────────────────┐
│                   NestJS Server (Backend)                               │
│                 http://localhost:3000/api                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌─ main.ts ──────────────────────────────────────────────┐             │
│  │ • CORS: origen * (credentials: false)                 │             │
│  │ • Global ValidationPipe (DTO validation)              │             │
│  │ • JWT middleware (Passport)                           │             │
│  │ • Global prefix: /api                                 │             │
│  │ • Health endpoint: GET /health (sin /api)             │             │
│  └──────────────────────────────────────────────────────┘             │
│                                    ↓                                    │
│  ┌─ AppModule ────────────────────────────────────────────┐             │
│  │                                                         │             │
│  │  Módulos cargados (17 total):                         │             │
│  │  ├── PrismaModule                 ← DB access          │             │
│  │  ├── ConfigModule                 ← Env validation     │             │
│  │  ├── AuthModule                   ← JWT + Passport     │             │
│  │  ├── StoresModule                 ← Tiendas            │             │
│  │  ├── CustomersModule              ← Clientes           │             │
│  │  ├── ProductsModule               ← Productos          │             │
│  │  ├── ServicesModule               ← Servicios          │             │
│  │  ├── OrdersModule                 ← Órdenes/Pedidos    │             │
│  │  ├── ConversationsModule          ← Chats              │             │
│  │  ├── MessagesModule               ← Mensajes           │             │
│  │  ├── AppointmentsModule           ← Citas              │             │
│  │  ├── CampaignsModule              ← Campañas           │             │
│  │  ├── WhatsappModule               ← Bot WA             │             │
│  │  ├── AiModule                     ← Groq LLM           │             │
│  │  ├── AnalyticsModule              ← Reportes           │             │
│  │  ├── DashboardModule              ← Métricas           │             │
│  │  └── BlockedModule                ← Bloqueados         │             │
│  │                                                         │             │
│  └───────┬──────────────────────────────────────────────┘             │
│          │                                                              │
│    ┌─────┴────────────────────────────────────────────┐                │
│    │        MODULO ARQUITECTURA (Ejemplo)             │                │
│    │  ┌─────────────────────────────────────────┐    │                │
│    │  │ CustomersModule                         │    │                │
│    │  ├──────────────────────────────────────┤    │                │
│    │  │ CustomersController                    │    │                │
│    │  │ ├── @Get('/')       → findAll()       │    │                │
│    │  │ ├── @Get(':id')     → findOne()       │    │                │
│    │  │ ├── @Post('/')      → create()        │    │                │
│    │  │ └── @Patch(':id')   → update()        │    │                │
│    │  │                                         │    │                │
│    │  │ CustomersService                       │    │                │
│    │  │ ├── @Inject(PrismaService)            │    │                │
│    │  │ ├── findAll(storeId)                  │    │                │
│    │  │ ├── create(dto, storeId)              │    │                │
│    │  │ └── update(id, dto)                   │    │                │
│    │  │                                         │    │                │
│    │  │ CreateCustomerDto                     │    │                │
│    │  │ ├── @IsString() name                  │    │                │
│    │  │ ├── @IsPhoneNumber() phone            │    │                │
│    │  │ └── @IsOptional() cedula              │    │                │
│    │  └──────────────────────────────────────┘    │                │
│    └──────────────────────────────────────────────┘                │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
                             ⬇️
┌─────────────────────────────────────────────────────────────────────────┐
│                     Prisma ORM Layer                                    │
│            (src/prisma/prisma.service.ts)                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  PrismaService extends PrismaClient                                    │
│  ├── prisma.store.findMany()                                          │
│  ├── prisma.customer.create()                                         │
│  ├── prisma.order.update()                                            │
│  ├── prisma.appointment.delete()                                      │
│  └── Generated types (Prisma Type Safety)                             │
│                                                                           │
│  Schema: prisma/schema.prisma                                         │
│  ├── 14+ Models (Store, Customer, Order, etc)                        │
│  ├── Enums (AppointmentStatus, PriceType, etc)                       │
│  ├── Relations (1:N, N:N)                                             │
│  └── Indexes estratégicos                                             │
│                                                                           │
└─────────────────────────────────────────────────────────────────────────┘
                             ⬇️
┌─────────────────────────────────────────────────────────────────────────┐
│                          Base de Datos                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  PostgreSQL 16-alpine (docker-compose.yml)                             │
│  ├── Port: 5432                                                        │
│  ├── Database: whatsapp_crm                                            │
│  ├── User: postgres:dev_password                                       │
│  │                                                                       │
│  ├── Tables (14+):                                                     │
│  │  ├── stores → Root entity                                           │
│  │  ├── customers → FK(storeId)                                        │
│  │  ├── products → FK(storeId, categoryId)                             │
│  │  ├── orders → FK(storeId, customerId)                               │
│  │  ├── conversations → FK(storeId, customerId)                        │
│  │  ├── messages → FK(conversationId, storeId)                         │
│  │  ├── appointments → FK(storeId, serviceId)                          │
│  │  └── ... más tablas                                                 │
│  │                                                                       │
│  └── Migrations (20+ versiones):                                       │
│     ├── 20260307162154_init                                            │
│     ├── 20260307163248_add_users                                       │
│     ├── 20260307201441_add_sender_to_message                           │
│     └── ... más migraciones                                            │
│                                                                           │
│  ┌─ Índices Clave ─────────────────────────────┐                      │
│  │ customers: (storeId, phone) UNIQUE          │                      │
│  │ products: (storeId, sku) UNIQUE             │                      │
│  │ messages: (conversationId, createdAt)       │                      │
│  │ appointments: (storeId, scheduledAt)        │                      │
│  └─────────────────────────────────────────────┘                      │
│                                                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Authentication Flow

```
┌──────────────────────────────────┐
│    POST /api/auth/login          │
│  { email, password }             │
└────────────┬─────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────┐
│  AuthService.login()                            │
│  ├─ Prisma: find User by email                 │
│  ├─ Bcrypt: verify(password, hash)             │
│  └─ If valid:                                  │
│     ├─ Generate JWT payload:                   │
│     │  {                                        │
│     │    sub: userId,        (claim)           │
│     │    email: string,      (claim)           │
│     │    role: "admin|agent|superadmin",       │
│     │    storeId: string,    (multi-tenant)    │
│     │    iat: number,        (issued at)       │
│     │    exp: number         (expiration)      │
│     │  }                                        │
│     └─ Sign JWT with JWT_SECRET                │
└────────┬──────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│  Response {                      │
│    token: "eyJhbG...",          │
│    user: {                      │
│      userId: "uuid",            │
│      email: "user@...",         │
│      role: "admin",             │
│      storeId: "uuid"            │
│    }                            │
│  }                              │
└────────┬───────────────────────┘
         │
         ▼
┌──────────────────────────────────────────┐
│  Frontend: useAuth hook                 │
│  ├─ localStorage.setItem('token', jwt) │
│  ├─ localStorage.setItem('user', data) │
│  └─ Render UI según role               │
└────────┬────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│  Solicitudes Posteriores                        │
│  ├─ axios.interceptors.request.use()           │
│  │  └─ Attach: Authorization: Bearer JWT       │
│  │                                              │
│  ├─ axios.interceptors.response.use()          │
│  │  ├─ if status 401:                         │
│  │  │  ├─ localStorage.removeItem('token')    │
│  │  │  └─ window.location.href = '/login'    │
│  │  └─ else: return response                 │
│  │                                              │
│  └─ Backend @UseGuards(JwtAuthGuard)           │
│     ├─ Passport extracts JWT header           │
│     ├─ Verifica firma con JWT_SECRET          │
│     └─ Si válido: req.user = payload          │
└──────────────────────────────────────────────────┘
```

---

## WhatsApp Integration Flow

```
┌─────────────────────────────────────────────────────┐
│         Cliente envía msg en WhatsApp               │
│    "Quiero agendar para mañana a las 3pm"          │
└────────────────┬────────────────────────────────────┘
                 │
                 ▼
        ┌────────────────────┐
        │  Baileys Library   │
        │  (WhatsApp Web)    │
        └────────┬───────────┘
                 │ Socket.io connection
                 ▼
     ┌────────────────────────────────────┐
     │  whatsapp.service.ts               │
     │  Escucha: message event            │
     │  ├─ Parse mensaje                   │
     │  ├─ Extraer sender, content, etc   │
     │  └─ Lógica de negocio:             │
     │     ├─ ¿Contacto nuevo?            │
     │     ├─ ¿Es solicitud de cita?      │
     │     └─ ¿Necesita respuesta IA?     │
     └────────┬─────────────────────────┘
              │
              ▼
     ┌────────────────────────────────────┐
     │  Crear/Update en BD:               │
     │  1. find o create Customer         │
     │  2. find o create Conversation     │
     │  3. create Message (fromCustomer)  │
     │  4. if es cita:                    │
     │     → Obtener AIConfiguration      │
     │     → POST a Groq LLM              │
     │     → Generar appointment prediction│
     │     → Guardar Appointment record   │
     └────────┬─────────────────────────┘
              │
              ▼
     ┌────────────────────────────────────┐
     │  AI Processing (Groq SDK)          │
     │  ├─ System prompt               │
     │  ├─ Customer message (context)  │
     │  └─ Llamada a Groq API          │
     │     → Respuesta contextualizada    │
     └────────┬─────────────────────────┘
              │
              ▼
     ┌────────────────────────────────────┐
     │  Guardar respuesta en BD:          │
     │  create Message(                   │
     │    sender: 'ai',                   │
     │    isAiResponse: true,             │
     │    content: <AI text>              │
     │  )                                 │
     └────────┬─────────────────────────┘
              │
              ▼
     ┌────────────────────────────────────┐
     │  Enviar por Baileys:               │
     │  baileys.sendMessage(              │
     │    to: customerPhone,              │
     │    message: aiResponse             │
     │  )                                 │
     └────────┬─────────────────────────┘
              │
              ▼
     ┌────────────────────────────────────┐
     │  Real-time Notifications:          │
     │  socket.emit('conversation:new', { │
     │    conversationId,                 │
     │    lastMessage,                    │
     │    appointment (if created)        │
     │  })                                │
     └────────┬─────────────────────────┘
              │
              ▼
     ┌────────────────────────────────────┐
     │  Frontend (socket listener)        │
     │  → Actualiza Conversations page    │
     │  → Muestra cita en Appointments    │
     │  → Notificación/toast              │
     └────────────────────────────────────┘
```

---

## Data Model Relationship Diagram

```
                          ┌─────────────┐
                          │   STORE     │ (1 negocio)
                          │─────────────│
                          │ storeId(PK) │
                          │ name        │
                          │ phone       │
                          │ ownerName   │
                          │ waSessionId │
                          │ isActive    │
                          └────────┬────┘
                                   │
                                   │ (1:N)
                    ┌──────────────┼──────────────┐
                    │              │              │
                    ▼              ▼              ▼
            ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
            │  CUSTOMER    │ │  PRODUCT     │ │   SERVICE    │
            ├──────────────┤ ├──────────────┤ ├──────────────┤
            │customerId(PK)│ │productId(PK) │ │serviceId(PK) │
            │storeId(FK)   │ │storeId(FK)   │ │storeId(FK)   │
            │phone(unique) │ │categoryId(FK)│ │priceType     │
            │name          │ │sku           │ │basePrice     │
            │cedula        │ │salePrice     │ │estimatedMin  │
            └───────┬──────┘ │costPrice     │ └──────┬───────┘
                    │        │stock        │        │
                    │        │hasVariants   │        │
                    │        │imageUrl      │        │ (1:N)
                    │        │shipping      │        │
        (1:N)       │        └───────┬──────┘        │
        ┌───────────┼────────────────┼───────────────┤
        │           │                │               │
        ▼           ▼                ▼               ▼
   ┌──────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────────┐
   │CONVERSAT │ │ PRODUCT VAR  │ │ SERVICE VAR  │ │APPOINTMENT│
   ├──────────┤ ├──────────────┤ ├──────────────┤ ├────────────┤
   │convId(PK)│ │variantId(PK) │ │variantId(PK) │ │appId(PK)   │
   │customerId│ │productId(FK) │ │serviceId(FK) │ │customerId  │
   │status    │ │name          │ │name          │ │serviceId   │
   │lastMsgAt │ │sku           │ │description   │ │status      │
   └─────┬────┘ │salePrice     │ │priceOverride │ │scheduledAt │
         │      │stock         │ │isActive      │ │duration    │
         │      │imageUrl      │ └──────────────┘ │priority    │
         │(1:N) │sortOrder     │                  │source(AI)  │
         │      └──────────────┘                  └────────────┘
         │
         ▼
    ┌──────────────┐
    │   MESSAGE    │
    ├──────────────┤
    │messageId(PK) │
    │convId(FK)    │
    │content       │
    │sender        │ ← 'customer'|'ai'|'business'
    │isAiResponse  │
    │createdAt     │
    └──────────────┘
         
    
También relacionado:
┌──────────┐      ┌─────────────┐      ┌──────────┐
│  ORDER   │─────▶│ ORDER_ITEM  │◀─────│ PRODUCT  │
├──────────┤      ├─────────────┤      │ or       │
│orderId   │      │itemId       │      │ SERVICE  │
│customerId│      │orderId(FK)  │      └──────────┘
│type      │      │productId/   │
│total     │      │ serviceId   │
│status    │      │quantity     │
└──────────┘      │price        │
                  └─────────────┘


┌───────────┐
│ CAMPAIGN  │
├───────────┤
│campaignId │
│storeId(FK)│
│name       │
│type       │
│status     │
└───────────┘

┌──────────────────┐
│ AI_CONFIG        │
├──────────────────┤
│configId          │
│storeId(FK,uniq)  │
│systemPrompt      │
│model             │
│temperature       │
│maxTokens         │
│enabledFeatures   │
└──────────────────┘

┌───────────────────┐
│ BLOCKED_CONTACT   │
├───────────────────┤
│blockedId          │
│storeId(FK)        │
│customerId(FK)     │
│reason             │
│blockedAt          │
└───────────────────┘

┌──────────────────┐
│ WHATSAPP_SESSION │
├──────────────────┤
│sessionId         │
│storeId(FK,uniq)  │
│qrCode            │
│isConnected       │
└──────────────────┘

┌──────────────┐
│ USER         │
├──────────────┤
│userId        │
│storeId(FK)   │
│email         │ ← unique per store
│passwordHash  │
│name          │
│role          │ ← admin/agent/superadmin
└──────────────┘
```

---

## Request/Response Cycle

```
┌─────────────────────┐
│ Client (React 19)   │
│                     │
│ const { data } =    │
│  useQuery({         │
│   queryKey: ['c'],  │
│   queryFn: () =>    │
│    api.get('/c')    │
│  })                 │
└──────────┬──────────┘
           │
           │ HTTP GET /api/customers
           │ Header: Authorization: Bearer JWT
           ▼
┌──────────────────────────────────────────┐
│ NestJS Server (main.ts)                 │
│                                         │
│ 1. Request llega a Express              │
│ 2. CORS middleware ✓                    │
│ 3. Validation pipes ✓                   │
│ 4. JWT Guard middleware ✓               │
│    ├─ Extrae token de Authorization    │
│    ├─ Verifica con JWT_SECRET          │
│    └─ Si válido: req.user = payload    │
└────────┬─────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────┐
│ CustomersController                     │
│                                         │
│ @UseGuards(JwtAuthGuard)               │
│ @Get()                                 │
│ findAll(@Req() req) {                  │
│   storeId = req.user.storeId           │
│   return this.service.findAll(storeId) │
│ }                                       │
└────────┬─────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────┐
│ CustomersService                        │
│                                         │
│ findAll(storeId: string) {              │
│   return this.prisma.customer.findMany(│
│     { where: { storeId } }             │
│   );                                    │
│ }                                       │
└────────┬─────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────┐
│ Prisma ORM                              │
│                                         │
│ prisma.customer.findMany({             │
│   where: { storeId: "xyz" }            │
│ })                                      │
│                                         │
│ ↓ Genera SQL query                     │
└────────┬─────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────┐
│ PostgreSQL Database                    │
│                                         │
│ SELECT * FROM customers                │
│ WHERE store_id = 'xyz'                 │
└────────┬─────────────────────────────┘
         │
         ▼ Retorna filas
┌──────────────────────────────────────────┐
│ Prisma (transforma)                    │
│ → Prisma types                         │
│ → JSON serializable                    │
└────────┬─────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────┐
│ NestJS Response handler                 │
│                                         │
│ {                                       │
│   statusCode: 200,                      │
│   data: [                               │
│     { customerId, phone, name, ... },   │
│     { ... }                             │
│   ]                                     │
│ }                                       │
└────────┬─────────────────────────────┘
         │
         │ HTTP 200 OK
         │ Content-Type: application/json
         ▼
┌──────────────────────────────────────────┐
│ Frontend (React Query)                  │
│                                         │
│ 1. Recibe respuesta                    │
│ 2. Valida status                        │
│ 3. Parsea JSON                         │
│ 4. Actualiza cache                      │
│ 5. Triguer re-render                    │
│                                         │
│ const { data } = useQuery(...) ✓       │
│ data === [{ ... }, { ... }]            │
│                                         │
│ Component re-renderiza con datos       │
└──────────────────────────────────────────┘
```

---

## Module Dependency Injection

```
┌────────────────────────────────┐
│    AppModule (root)            │
├────────────────────────────────┤
│ imports: [                      │
│   ConfigModule (env vars)      │
│   PrismaModule (DB access)     │
│   AuthModule                   │
│   StoresModule                 │
│   CustomersModule              │
│   ProductsModule               │
│   ServicesModule               │
│   OrdersModule                 │
│   ConversationsModule          │
│   MessagesModule               │
│   AppointmentsModule           │
│   CampaignsModule              │
│   WhatsappModule               │
│   AiModule                     │
│   AnalyticsModule              │
│   DashboardModule              │
│   BlockedModule                │
│ ],                              │
│ controllers: [AppController]   │
│ providers: [AppService]        │
└────────────────────────────────┘
         │
    ┌────┴────────────────────────────────────┐
    │                                         │
    ▼                                         ▼
┌─────────────────────┐          ┌────────────────────────┐
│ CustomersModule     │          │ OrdersModule           │
├─────────────────────┤          ├────────────────────────┤
│ imports:            │          │ imports:               │
│  [PrismaModule]     │          │  [PrismaModule]        │
│                     │          │                        │
│ controllers:        │          │ controllers:           │
│  [CustomersC]       │          │  [OrdersC]             │
│                     │          │                        │
│ providers:          │          │ providers:             │
│  [CustomersS]       │          │  [OrdersS]             │
│                     │          │                        │
│ constructor(        │          │ constructor(           │
│  @Inject(Prisma)    │          │  @Inject(Prisma)       │
│  prisma: P.Service) │          │  prisma: P.Service,    │
│ {                   │          │  @Inject(Customers)    │
│   // inyección ✓    │          │  customers: C.Service) │
│ }                   │          │ {                      │
│                     │          │   // inyección ✓       │
└─────────────────────┘          │ }                      │
                                 └────────────────────────┘
```

---

## Deployment Architecture (Tentativa)

```
┌────────────────────────────────────────────────────────────┐
│                      PRODUCCIÓN                            │
├────────────────────────────────────────────────────────────┤
│                                                              │
│   ┌─────────────────────────────────────────────────┐      │
│   │  cdn.vercel.app (Stockup Frontend)             │      │
│   │  ├── Static HTML/CSS/JS (optimizado)           │      │
│   │  ├── Auto-deploy on git push                   │      │
│   │  └── Global CDN distribution                   │      │
│   └──────────────┬───────────────────────────────┘      │
│                  │                                        │
│                  │ HTTPS                                 │
│                  │ API calls                             │
│                  ▼                                        │
│   ┌─────────────────────────────────────────────────┐      │
│   │  Railway.app (NestJS Backend)                  │      │
│   │  ├── Docker container                          │      │
│   │  ├── Auto-deploy from git                      │      │
│   │  ├── Port: 3000 (internal)                     │      │
│   │  ├── Environment variables                     │      │
│   │  └── SSL termination                           │      │
│   └──────────┬───────────────────────────────────┘      │
│              │                                            │
│              │ Connection pool                           │
│              ▼                                            │
│   ┌─────────────────────────────────────────────────┐      │
│   │  PostgreSQL (Railway managed DB)               │      │
│   │  ├── Database replica para backup              │      │
│   │  ├── Automated backups (daily)                 │      │
│   │  ├── SSL connection required                   │      │
│   │  └── Monitoring & alerts                       │      │
│   └─────────────────────────────────────────────────┘      │
│                                                              │
│   ┌─────────────────────────────────────────────────┐      │
│   │  Redis (optional - session/cache layer)       │      │
│   │  ├── Rate limiting                             │      │
│   │  ├── Session store                             │      │
│   │  └── Message queue (future)                    │      │
│   └─────────────────────────────────────────────────┘      │
│                                                              │
│   ┌─────────────────────────────────────────────────┐      │
│   │  External Services                            │      │
│   │  ├── Groq API (AI/LLM)                        │      │
│   │  ├── WhatsApp (Baileys)                       │      │
│   │  ├── Email service (SendGrid)                 │      │
│   │  └── File storage (S3/Cloudinary)             │      │
│   └─────────────────────────────────────────────────┘      │
│                                                              │
└────────────────────────────────────────────────────────────┘
```

---

**Última actualización:** 8 de Abril, 2026  
**Para:** IAs, Developers, Architects
