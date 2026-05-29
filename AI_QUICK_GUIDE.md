# 🤖 GUÍA RÁPIDA PARA IAs - STOCKUP + WHATSAPP CRM

## 📌 QUICK START (30 segundos)

**Proyecto:** Full-stack CRM con integración WhatsApp  
**Frontend:** React 19 + TypeScript  
**Backend:** NestJS + Prisma + PostgreSQL  
**Real-time:** Socket.io (opcional)  
**AI:** Groq SDK para respuestas automáticas

---

## 🗂️ ESTRUCTURA DE CARPETAS (Mapa Mental)

```
proyectos/
├── stockup-frontend/           ← React UI
│   ├── src/
│   │   ├── App.tsx            (Router principal)
│   │   ├── pages/             (12 páginas)
│   │   ├── hooks/             (useAuth)
│   │   ├── services/          (api.ts)
│   │   └── index.tsx          (Entry)
│   ├── public/
│   ├── build/                 (Producción)
│   ├── package.json           (React 19.2.4)
│   ├── tsconfig.json
│   └── tailwind.config.js
│
├── whatsapp-crm/              ← NestJS Backend
│   ├── src/
│   │   ├── main.ts            (Bootstrap)
│   │   ├── app.module.ts      (17 módulos)
│   │   ├── modules/
│   │   │   ├── auth/          (JWT)
│   │   │   ├── customers/
│   │   │   ├── products/
│   │   │   ├── orders/
│   │   │   ├── conversations/
│   │   │   ├── messages/
│   │   │   ├── appointments/
│   │   │   ├── whatsapp/      (Baileys)
│   │   │   ├── ai/            (Groq)
│   │   │   ├── analytics/
│   │   │   └── ...
│   │   ├── prisma/            (ORM)
│   │   └── config/
│   ├── prisma/
│   │   ├── schema.prisma      (14+ modelos)
│   │   └── migrations/        (20+ versions)
│   ├── docker-compose.yml     (PG + Redis)
│   ├── package.json           (NestJS 11)
│   ├── tsconfig.json
│   └── test/
│
└── PROJECT_SUMMARY.md         ← ¡Estás aquí!
```

---

## 🔴 CONTEXTO CRÍTICO (Lee esto primero)

### 1. **Modelos de Datos Centrales**

```
Store (1 negocio = 1 Store)
  ↓
├── Customers (clientes de esa tienda)
├── Products + ProductVariants (catálogo)
├── Services + ServiceVariants (servicios)
├── Orders + OrderItems (pedidos)
├── Conversations + Messages (chats WhatsApp)
├── Appointments (citas agendadas)
├── Campaigns (campañas marketing)
└── Users (agentes/empleados)
```

**Importante:** Casi TODO tiene `storeId` FK. Es multi-tenant entre tiendas.

### 2. **Flujo Autenticación**

```
Frontend                          Backend
  ↓                                ↓
Login (email/pass) ────────→ POST /auth/login
                             ├─ Prisma: find User
                             ├─ bcrypt: verify password
                             └─ Generate JWT
                                  ↓
Usuario recibe: token + user data
  ↓
Guard JWT protege rutas
  ↓
localStorage.token + Axios interceptor
  → Env: localStorage.removeItem on 401
```

### 3. **Flujo WhatsApp → Cita**

```
Cliente envía WhatsApp
   ↓ (Baileys captura)
whatsapp.service analiza
   ╔══════════════════════════════╗
   ║ ¿Es nueva cita?              ║
   ║ - Parse fecha, servicio, etc ║
   ║ - Validar disponibilidad     ║
   ║ - AI: generar respuesta      ║
   ╚══════════════════════════════╝
   ↓
Guardar: Appointment + Message
   ↓
Notificar business + cliente
   ↓
Dashboard se actualiza (socket.io)
```

### 4. **Modelos Principales (Prisma)**

```typescript
// Define TODO en prisma/schema.prisma
// Algunos tipos importantes:

enum AppointmentStatus {
  PENDING, CONFIRMED, IN_PROGRESS, COMPLETED, CANCELLED, NO_SHOW, RESCHEDULED
}

enum PriceType {
  FIXED, PER_HOUR, PER_DAY, PER_UNIT, VARIABLE
}

// +14 modelos más...
```

---

## 🎯 RUTAS FRONTEND (SPA)

```
/login                    ← Público
/dashboard               ← Todos autenticados
/customers               ← Agentes+
/conversations           ← Agentes+
/appointments            ← Agentes+
/orders                  ← Agentes+
/products                ← Admin solo
/services                ← Admin solo
/campaigns               ← Admin solo
/analytics               ← Admin solo
/users                   ← Admin solo
/whatsapp                ← Admin solo
/ai-config               ← Admin solo
/blocked                 ← Admin solo
```

---

## 🔌 ENDPOINTS BACKEND (Convención)

```
Patrón: GET|POST|PATCH /api/{resource}[/{id}][/{action}]

GET    /api/customers                 # Listar
POST   /api/customers                 # Crear
GET    /api/customers/:id             # Obtener
PATCH  /api/customers/:id             # Actualizar
DELETE /api/customers/:id             # Borrar

GET    /api/customers/:id/orders      # Sub-recurso
POST   /api/appointments              # Crear cita
PATCH  /api/appointments/:id          # Cambiar status
POST   /api/ai/chat                   # Enviar a LLM Groq
```

**Global:**
- GET /health (sin /api prefix)
- Base: http://localhost:3000/api
- CORS: Abierto (*)

---

## 💾 BASE DE DATOS (Schemas Rápido)

### Tablas Principales

| Tabla | Propósito | FK Principal |
|-------|----------|-------------|
| `stores` | Negocios | - |
| `customers` | Clientes | storeId |
| `products` | Productos | storeId |
| `product_variants` | Variantes | productId |
| `services` | Servicios | storeId |
| `service_variants` | Variantes | serviceId |
| `orders` | Pedidos | storeId, customerId |
| `order_items` | Líneas de orden | orderId |
| `conversations` | Chats | storeId, customerId |
| `messages` | Mensajes | conversationId |
| `appointments` | Citas | storeId, customerId, serviceId |
| `campaigns` | Campañas | storeId |
| `users` | Empleados | storeId |
| `blocked_contacts` | Bloqueados | storeId, customerId |
| `whatsapp_sessions` | Sesiones WA | storeId |
| `ai_configurations` | Config IA | storeId |

---

## 🛠️ STACK TECNOLÓGICO RESUMIDO

| Layer | Tecnología | Versión | Rol |
|-------|-----------|---------|-----|
| Frontend | React + TypeScript | 19 / 4.9 | UI |
| State | React Query | 5.90 | Fetching + caching |
| Router | React Router | 7.13 | SPA routing |
| HTTP | Axios | 1.13 | Client |
| WS | Socket.io | 4.8 | Real-time opcional |
| Backend | NestJS | 11.0 | Framework |
| ORM | Prisma | 6.19 | Database layer |
| Database | PostgreSQL | 16-alpine | SQL |
| Cache | Redis | 7-alpine | Sessions/cache |
| Auth | Passport + JWT | 0.7 | Security |
| WhatsApp | Baileys | 7.0-rc9 | Bot |
| AI | Groq SDK | 0.37 | LLM |
| Validation | Zod + Class-val | Latest | DTO validation |
| Logging | Pino | 10.3 | Structured logs |

---

## 📜 COMANDOS ESENCIALES

### Desarrollo Rápido

```bash
# Terminal 1: Backend
cd whatsapp-crm
npm run start:dev
# → http://localhost:3000/api

# Terminal 2: Frontend
cd stockup-frontend
npm start
# → http://localhost:3000

# Terminal 3: Database
cd whatsapp-crm
docker-compose up -d
# → PostgreSQL 5432, Redis 6379
```

### Prisma (Base de datos)

```bash
# Ver estado
npx prisma migrate status

# Crear migración
npx prisma migrate dev --name add_something

# Push cambios
npx prisma migrate deploy

# Generar cliente
npx prisma generate

# Studio GUI
npx prisma studio
```

---

## 🔐 AUTENTICACIÓN RÁPIDA

### Login
```typescript
// Frontend: useAuth hook
const { loginFn } = useAuth();
await loginFn('admin@example.com', 'password123');
// → Guarda token en localStorage
```

### Token
```typescript
// JWT payload típico
{
  sub: "user-uuid",           // userId
  email: "admin@example.com",
  role: "admin",              // admin | superadmin | agent
  storeId: "store-uuid",
  iat: 1712592000,
  exp: 1712678400
}
```

### Protección
```typescript
// Backend: Guards
@UseGuards(JwtAuthGuard)
@Post('secret')
protectedRoute() { }

// Frontend: Rutas
<PrivateRoute>     {/* token requerido */}
<AdminRoute>       {/* admin+ */}
<AgentRoute>       {/* agent+ */}
```

---

## 🚨 ERRORES COMUNES & SOLUCIONES

| Error | Causa | Fix |
|-------|-------|-----|
| `401 Unauthorized` | Token expirado | Login de nuevo |
| `CORS error` | Frontend != localhost:3000 | Actualizar .env |
| `Database connection` | PG no corre | `docker-compose up -d` |
| `Module not found` | Falta `npm install` | Ejecutar install |
| `Cannot POST /api/xxx` | Falta route en módulo | Revisar controller |
| `Validation error` | DTO incorrecto | Check @Is* decorators |

---

## 🎨 ESTRUCTURA DE COMPONENTES (Frontend)

```
App.tsx (Router raíz)
├── Layout
│   ├── Navbar (con logout)
│   ├── Sidebar (menú navegación)
│   └── Pages (outlet)
├── Login (public)
├── Dashboard
├── Customers
├── Conversations
├── Appointments
├── Orders
├── Products
├── Services
├── Campaigns
├── Analytics
├── Users
├── WhatsAppPage
├── AiConfig
└── Blocked
```

---

## 📊 PATRONES DE CODIFICACIÓN

### Backend (NestJS)

```typescript
// 1. Service (lógica)
@Injectable()
export class CustomersService {
  constructor(private prisma: PrismaService) {}
  
  findAll(storeId: string) {
    return this.prisma.customer.findMany({ where: { storeId } });
  }
}

// 2. Controller (ruta)
@Controller('customers')
export class CustomersController {
  constructor(private service: CustomersService) {}
  
  @Get()
  findAll(@Query('storeId') storeId: string) {
    return this.service.findAll(storeId);
  }
}

// 3. Module (inyección)
@Module({
  imports: [PrismaModule],
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
```

### Frontend (React)

```typescript
// 1. Hook (data fetching)
const { data: customers } = useQuery({
  queryKey: ['customers', storeId],
  queryFn: () => api.get(`/customers?storeId=${storeId}`)
});

// 2. Componente (render)
function Customers() {
  const { data } = useQuery(...);
  return <div>{data?.map(c => ...)}</div>;
}

// 3. Auth guard (protección)
function PrivateRoute({ children }) {
  const { token } = useAuth();
  return token ? children : <Navigate to="/login" />;
}
```

---

## 🔄 CICLO DE DESARROLLO

### Agregar Nueva Feature

1. **Database** → Prisma schema `+ migration`
   ```bash
   npx prisma migrate dev --name add_feature
   ```

2. **Backend** → NestJS module + service + controller
   ```typescript
   @Module({...})
   export class FeatureModule {}
   ```

3. **API Testing** → Postman / curl
   ```bash
   curl -H "Authorization: Bearer TOKEN" http://localhost:3000/api/feature
   ```

4. **Frontend** → React component + hook
   ```typescript
   const { data } = useQuery({...})
   ```

5. **Routing** → Add page en App.tsx
   ```typescript
   <Route path="/feature" element={<Feature />} />
   ```

---

## 🎯 USO PARA IAs

### Si eres IA debuggeando código:

1. **Busca `storeId`** → Es la "tienda" actual, vital para aislamiento
2. **Entiende DTOs** → `Create*Dto`, `Update*Dto` definen validación
3. **Revisa Guards** → `@UseGuards(JwtAuthGuard)` = protegido
4. **Usa Prisma docs** → ORM: `.findUnique()`, `.create()`, `.update()`
5. **Checa errores** → Mira `src/*.service.ts` por lógica de negocio
6. **Real-time** → Socket.io si ves `socket.emit()`

### Si eres IA generando código:

1. **Tema**: Sigue patrón Service + Controller + Module
2. **Validación**: DTOs con `@Is*` decorators
3. **DB**: Siempre incluye `storeId` en queries
4. **Auth**: Protege con `@UseGuards(JwtAuthGuard)` si necesita
5. **Error handling**: Try-catch + CustomException
6. **Frontend**: Use React Query para fetching
7. **Estilos**: Tailwind CSS utility classes

---

## 📚 REFERENCIAS RÁPIDAS

### Prisma
```typescript
// Queries comunes
await prisma.customer.findMany({ where: { storeId } });
await prisma.order.create({ data: {...} });
await prisma.appointment.update({ where: {id}, data: {...} });

// Relaciones
await prisma.customer.findUnique({
  where: { customerId: id },
  include: { orders: true, appointments: true }
});
```

### NestJS
```typescript
// Decorators comunes
@Get('/:id')                  // Ruta
@Body()                       // Payload
@Param('id')                  // URL param
@Query()                      // Query string
@UseGuards(JwtAuthGuard)      // Protege ruta
@Inject(ServiceName)          // Inyecta dependencia
```

### React Query
```typescript
// Hook comun
const { data, isLoading, error } = useQuery({
  queryKey: ['resource', params],
  queryFn: () => api.get('/endpoint')
});

// Mutation
const mutation = useMutation((data) => api.post('/endpoint', data), {
  onSuccess: () => queryClient.invalidateQueries(['resource'])
});
```

---

## ⚡ WORKFLOW TÍPICO

```
1. Usuario abre /appointments en browser
   ↓
2. Frontend: useQuery fetches GET /api/appointments?storeId=X
   ↓
3. Backend: AppointmentsController recibe request
   ↓
4. Service: Query Prisma por storeId + filtros
   ↓
5. Database: PostgreSQL retorna filas
   ↓
6. Backend: Response { data: [...] }
   ↓
7. Frontend: Renderiza con React, crea con mutación
   ↓
8. Usuario: "Crear cita" → POST /api/appointments
   ↓
9. Backend: Valida DTO, crea registro, retorna id
   ↓
10. Frontend: Invalida query, re-fetch automático
    ↓
11. Real-time: Socket.io notifica otros usuarios?
    ↓
12. Dashboard: Live update (si socket activo)
```

---

**¡Listo para ayudarte!** Si necesitas info de algo específico, pide el archivo completo: `PROJECT_SUMMARY.md`

---

📅 Actualizado: 8 de Abril, 2026  
👤 Rol: Developer | AI Assistant  
✅ Status: Listo para producción  
