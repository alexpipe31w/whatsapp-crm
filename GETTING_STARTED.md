# ⚡ GETTING STARTED - COMANDO A COMANDO

## 🚀 SETUP INICIAL (Primera vez)

### 1. Clone/Prep Workspace

```bash
# La estructura ya está en:
# c:\Users\alexp\Desktop\proyectos\
#   ├── stockup-frontend/
#   └── whatsapp-crm/

# Verifica que exista
cd c:\Users\alexp\Desktop\proyectos
dir
```

### 2. Setup Backend (Terminal 1)

```bash
cd whatsapp-crm

# 2a. Instalar dependencias
npm install
# Tarda ~3-5 min (node_modules 800+MB)

# 2b. Levantar BD (PostgreSQL + Redis)
docker-compose up -d
# Verifica:
docker ps
# Debes ver: postgres:16-alpine ✓ y redis:7-alpine ✓

# 2c. Configurar BD (Prisma)
npx prisma migrate deploy
# Carga migraciones en la BD

# 2d. Generar Prisma client
npx prisma generate
# Crea tipos TypeScript + cliente SQL

# 2e. Crear archivo .env
cp .env.example .env  # o creal manual con valores abajo

# 2f. Iniciar en modo desarrollo
npm run start:dev
# Verás: [0] [waiting for signal...]
# Si todo bien: [3] [Nest application successfully started] ✓
# Puerto: http://localhost:3000/api
```

### 3. Setup Frontend (Terminal 2)

```bash
cd stockup-frontend

# 3a. Instalar dependencias
npm install
# Tarda ~2-3 min (node_modules 500+MB)

# 3b. Crear .env.local
cat > .env.local << EOF
REACT_APP_API_URL=http://localhost:3000/api
REACT_APP_SOCKET_URL=http://localhost:3000
EOF

# 3c. Iniciar en modo desarrollo
npm start
# Se abre http://localhost:3000 automáticamente
# Browser: React dev server en modo watch
# Si ves página de login: ¡todo OK! ✓
```

### 4. Verificar Setup Completo

```bash
# Terminal 3: Verificar todo
curl http://localhost:3000/health
# Response: {"status":"ok"} ✓

curl http://localhost:3000/api/stores
# Response: error 401 (Unauthorized) ✓
# (es esperado sin JWT)

# Backend logs?
npm run start:dev --prefix whatsapp-crm | grep "Nest application"

# Base de datos OK?
docker exec whatsapp-crm-postgres-1 psql -U postgres -d whatsapp_crm -c "SELECT COUNT(*) FROM stores;"
```

---

## 📝 ARCHIVO .env DEL BACKEND

Crea en `whatsapp-crm/.env`:

```bash
# ──────────────────────────────────
# CONFIGURACIÓN DEL SERVIDOR
# ──────────────────────────────────
PORT=3000
NODE_ENV=development

# ──────────────────────────────────
# BASE DE DATOS
# ──────────────────────────────────
# Docker local:
DATABASE_URL=postgresql://postgres:dev_password@localhost:5432/whatsapp_crm

# Alternativa production (Railway):
# DATABASE_URL=postgresql://user:pwd@prod-db.railway.app:5432/whatsapp_crm

# ──────────────────────────────────
# JWT & SEGURIDAD
# ──────────────────────────────────
JWT_SECRET=tu-secret-key-super-largo-min-32-chars-12345678
JWT_EXPIRATION=24h  # Duración del token

# ──────────────────────────────────
# WHATSAPP (Baileys)
# ──────────────────────────────────
WHATSAPP_SESSIONS_PATH=./sessions

# ──────────────────────────────────
# AI (Groq LLM)
# ──────────────────────────────────
GROQ_API_KEY=gsk_your_api_key_here
GROQ_MODEL=mixtral-8x7b-32768
# O: groq-mixtral-8x7b, llama-3.1-405b, etc.

# ──────────────────────────────────
# REDIS (Opcional, para caché)
# ──────────────────────────────────
REDIS_URL=redis://localhost:6379

# ──────────────────────────────────
# CORS (Desarrollo)
# ──────────────────────────────────
CORS_ORIGIN=*  # O: http://localhost:3000

# ──────────────────────────────────
# LOGGING
# ──────────────────────────────────
LOG_LEVEL=debug  # debug | info | warn | error
```

---

## 🔄 DESARROLLO DIARIO

### Iniciar Servicios (Morning Routine)

```bash
# Terminal 1: Docker (BD + Cache)
cd whatsapp-crm
docker-compose up -d

# Terminal 2: Backend (NestJS)
npm run start:dev
# Watch mode: reinicia en cada cambio de archivo

# Terminal 3: Frontend (React)
cd ../stockup-frontend
npm start
# Auto-reload en http://localhost:3000
```

### Login Inicial

```
URL: http://localhost:3000/login

Email: admin@example.com (o usar seeder)
Password: password123 (según tu seed script)

Si falla:
  → Backend running? (Terminal 2: npm run start:dev)
  → BD running? (Terminal 1: docker-compose up)
  → Check .env DATABASE_URL
  → Check Prisma migrations: npx prisma migrate status
```

### Hacer Cambios

#### Backend: Editar Service

```typescript
// whatsapp-crm/src/customers/customers.service.ts
findAll(storeId: string) {
  // Cambio aquí
  return this.prisma.customer.findMany({
    where: { storeId },
    orderBy: { createdAt: 'desc' }  // ← Nuevo
  });
}
```

```bash
# Automático: npm run start:dev detecta cambio → reinicia server
# Verás en terminal: [HMR] Files changed
```

#### Frontend: Editar Componente

```typescript
// stockup-frontend/src/pages/Customers.tsx
function Customers() {
  const { data: customers } = useQuery({...});
  return (
    <div>
      <h1>Clientes {customers?.length || 0}</h1>  {/* ← Cambio */}
      {/* resto */}
    </div>
  );
}
```

```bash
# Automático: npm start detecta cambio → hot reload en browser
# No necesitas refresh manual ✓
```

#### Database: Agregar Campo

```prisma
// whatsapp-crm/prisma/schema.prisma
model Customer {
  customerId String @id @default(uuid())
  // ... campos existentes ...
  customField String?  @map("custom_field")  // ← Nuevo campo
}
```

```bash
# Crear migración
npx prisma migrate dev --name add_custom_field

# Prompt:
# Enter migration name: add_custom_field ✓
# → Genera: whatsapp-crm/prisma/migrations/20260408012345_add_custom_field/
# → Auto-aplica cambios a BD
```

---

## 🧪 TESTING

### Frontend Tests

```bash
cd stockup-frontend

# Correr tests
npm test
# Modo watch: escucha cambios

# Coverage completo
npm test -- --coverage

# Test específico
npm test -- Customers
```

### Backend Tests

```bash
cd whatsapp-crm

# Unit tests
npm run test
# Jest watch mode

# E2E tests
npm run test:e2e
# Ejecuta tests/app.e2e-spec.ts

# Coverage
npm run test:cov
```

---

## 🛠️ TROUBLESHOOTING

### Error: "connect ECONNREFUSED 127.0.0.1:5432"

```bash
# BD no está corriendo
docker-compose up -d

# Verifica:
docker ps | grep postgres
```

### Error: "Cannot find module 'prisma'"

```bash
cd whatsapp-crm
npm install
npx prisma generate
```

### Error: "Unexpected token" (Frontend)

```bash
# Clear cache React
rm -rf stockup-frontend/.cache
npm start
```

### Error: 401 Unauthorized (Todos los endpoints)

```bash
# JWT expirado o inválido
# → Delete localStorage.token
# → Login de nuevo
# O ver .env JWT_SECRET
```

### Port 3000 ya en uso

```bash
# Windows: Find what's using port 3000
netstat -ano | findstr :3000

# Kill el proceso
taskkill /PID <PID> /F

# O usa otro puerto:
PORT=3001 npm run start:dev
```

### Docker issues

```bash
# Bajar todo
docker-compose down

# Con volumen limpio (PELIGRO: pierde datos)
docker-compose down -v

# Rebuild
docker-compose up -d --build
```

---

## 📊 PRISMA STUDIO (GUI Base de Datos)

```bash
cd whatsapp-crm

# Abre interfaz visual
npx prisma studio
# Browser: http://localhost:5555

# Ventajas:
# - Ver tablas sin SQL
# - Crear/editar registros
# - Relaciones visibles
# - Search y filtros
```

---

## 🔐 CREAR USUARIO INICIAL

```typescript
// whatsapp-crm/prisma/seed.ts (crear si no existe)
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  // Crear Store
  const store = await prisma.store.create({
    data: {
      name: 'Test Store',
      phone: '+1234567890',
      ownerName: 'Owner Name',
      isActive: true,
    },
  });

  // Crear Admin User
  const user = await prisma.user.create({
    data: {
      storeId: store.storeId,
      email: 'admin@example.com',
      passwordHash: await bcrypt.hash('password123', 10),
      name: 'Admin User',
      role: 'admin',
    },
  });

  console.log({ store, user });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

```bash
# En package.json scripts:
"prisma": {
  "seed": "ts-node prisma/seed.ts"
}

# Ejecutar seed:
npx prisma db seed

# Verifica en Prisma Studio:
npx prisma studio
```

---

## 📱 API TESTING RÁPIDO

### Con Postman o curl

```bash
# 1. Login y obtener token
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"password123"}'

# Response:
# {
#   "token": "eyJhbGc...",
#   "user": {"userId":"...", "email":"...", "role":"admin", "storeId":"..."}
# }

# Guardar token:
TOKEN="eyJhbGc..."

# 2. Usar token en peticiones
curl -X GET http://localhost:3000/api/customers \
  -H "Authorization: Bearer $TOKEN"

# 3. POST (crear)
curl -X POST http://localhost:3000/api/customers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"John",
    "phone":"+1234567890",
    "storeId":"<store-uuid>"
  }'
```

### Con VSCode REST Client Extension

```
### whatsapp-crm/test.http

@token = <paste-your-jwt-here>
@baseUrl = http://localhost:3000/api

### Get all customers
GET {{baseUrl}}/customers
Authorization: Bearer {{token}}

### Create customer
POST {{baseUrl}}/customers
Authorization: Bearer {{token}}
Content-Type: application/json

{
  "name": "John Doe",
  "phone": "+1234567890",
  "storeId": "store-uuid-here"
}

### Get single customer
GET {{baseUrl}}/customers/customer-id-here
Authorization: Bearer {{token}}
```

---

## 📦 BUILD & DEPLOYMENT

### Frontend (Vercel)

```bash
cd stockup-frontend

# Build local
npm run build
# → Genera /build (optimizado)

# Conectar Vercel
npm install -g vercel
vercel login
vercel
# Sigue prompts de deploy
```

### Backend (Railway)

```bash
cd whatsapp-crm

# Build local
npm run build
# → Genera /dist

# Deploy a Railway (si está conectado)
railway deploy
# O desde Railway dashboard: import git repo

# Producción docker
docker build -t whatsapp-crm:latest .
docker run -p 3000:3000 whatsapp-crm:latest
```

---

## 🔍 DEBUGGING

### Backend Breakpoints

```bash
cd whatsapp-crm

# Debug mode with breakpoints
npm run start:debug
# En VSCode: Run → Start Debugging (debe tener launch.json)

# O directamente:
node --inspect-brk -r tsconfig-paths/register -r ts-node/register node_modules/.bin/nest start
```

### Frontend React DevTools

```
1. Instala extensión: React Developer Tools (Chrome/Firefox)
2. Abre browser devtools (F12)
3. Pestaña "Components" para inspeccionar React tree
4. Pestaña "Profiler" para performance

Debugging específico:
debugger;  // Pausa ejecución en inspect

console.log(variables);  // Logs ✓
```

---

## 📈 PERFORMANCE MONITORING

### Backend

```bash
# Ver tiempos de respuesta
npm run start:dev | grep "response"

# Alterar LOG_LEVEL para debug
LOG_LEVEL=debug npm run start:dev
```

### Frontend

```bash
# Coverage de componentes
npm test -- --coverage
# Verás qué está bien testado

# Performance
npm run build -- --analyze
# Analiza bundle size
```

---

## 🧹 LIMPIEZA & RESET

```bash
# Borrar BD completamente (caution!)
docker-compose down -v
docker-compose up -d

# Re-seed
npm run prisma:seed

# Limpiar node_modules (si problemas)
rm -rf node_modules
npm install

# Hard reset de todo
docker-compose down -v
rm -rf node_modules dist .next build
docker-compose up -d
npm install
npm run start:dev  # Backend
```

---

## 📚 COMANDOS MEGA CHEAT SHEET

```bash
# ─── BACKEND ─────────────────────
npm run start              # Producción
npm run start:dev          # Desarrollo (watch)
npm run start:debug        # Debug mode
npm run build              # Compilar
npm run lint               # ESLint
npm run format             # Prettier
npm run test               # Jest
npm run test:watch         # Jest watch
npm run test:cov           # Coverage
npm run test:e2e           # E2E tests

# ─── PRISMA ──────────────────────
npx prisma migrate dev     # Create migration
npx prisma migrate deploy  # Apply migrations
npx prisma generate        # Regenerate client
npx prisma db seed         # Run seed script
npx prisma studio          # GUI (localhost:5555)
npx prisma validate        # Validate schema

# ─── FRONTEND ────────────────────
npm start                  # Dev (localhost:3000)
npm run build              # Production build
npm test                   # Jest
npm run eject              # Eject CRA (one-way!)

# ─── DOCKER ──────────────────────
docker-compose up -d       # Start services
docker-compose down        # Stop services
docker-compose logs        # See logs
docker ps                  # List running
docker exec <id> /bin/sh   # Shell into container
docker-compose restart     # Restart

# ─── DATABASE ────────────────────
docker exec whatsapp-crm-postgres-1 \\
  psql -U postgres -d whatsapp_crm \\
  -c "SELECT * FROM stores LIMIT 5;"
```

---

## ✅ Checklist de Setup Exitoso

- [ ] Frontend: npm install OK
- [ ] Backend: npm install OK
- [ ] Docker: postgres ✓ redis ✓
- [ ] Prisma: migrations applied ✓
- [ ] Backend: npm run start:dev OK (sí está en watch mode)
- [ ] Frontend: npm start OK (mostró http://localhost:3000)
- [ ] Login: admin@example.com / password123 funciona
- [ ] API: GET /api/customers retorna datos (puede ser vacío)
- [ ] localStorage: Contiene token y user data
- [ ] BD:  `npx prisma studio` muestra datos

---

**¡Feliz desarrollando! 🚀**

Si algo falla, mira PROJECT_SUMMARY.md o AI_QUICK_GUIDE.md

Última actualización: 8 de Abril, 2026
