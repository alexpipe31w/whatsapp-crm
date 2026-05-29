# 📚 DOCUMENTACIÓN COMPLETA - ÍNDICE MAESTRO

## 🎯 ¿Por dónde empiezo?

Depende tu rol:

| Rol | Empieza por | Luego lee |
|-----|----------|---------|
| **Developer (frontend)** | GETTING_STARTED.md | AI_QUICK_GUIDE.md → PROJECT_SUMMARY.md |
| **Developer (backend)** | GETTING_STARTED.md | PROJECT_SUMMARY.md (Modelos & Modules) |
| **DevOps/Arch** | ARCHITECTURE_DIAGRAMS.md | PROJECT_SUMMARY.md (Tech Stack) |
| **IA/Asistente Código** | AI_QUICK_GUIDE.md | PROJECT_SUMMARY.md (Patterns) |
| **Product Manager** | PROJECT_SUMMARY.md (Resumen Ejecutivo + Flujos) | - |
| **QA/Tester** | PROJECT_SUMMARY.md (Endpoints) | GETTING_STARTED.md (Testing) |

---

## 📖 DOCUMENTOS DISPONIBLES

### 1. **📋 PROJECT_SUMMARY.md** (Este es el MÁS COMPLETO)
**Para:** Entendimiento holístico del proyecto

✅ Incluye:
- Resumen ejecutivo de 2 líneas
- Tech stack completo (versiones exactas)
- Estructura de carpetas explicada
- **Modelos de datos (14+) con detalles completos**
- Enums y tipos de datos
- Pages del frontend (12 páginas)
- **Módulos del backend (17 módulos) con explicación**
- Flujos de negocio principales (3-5 flows)
- API endpoints (estimados)
- Variables de entorno
- Comandos principales
- Patrones clave de código
- Notas importantes (qué está bien, qué monitorear)

**Tamaño:** ~400 líneas, muy detallado

**Cuándo usar:** Como referencia para **entender TODO**, especialmente modelos de datos y estructura backend

---

### 2. **⚡ AI_QUICK_GUIDE.md** (Para IAs específicamente)
**Para:** IAs debuggeando, generando código, entendiendo workflow

✅ Incluye:
- Quick Start (30 segundos)
- Estructura de carpetas en mapa mental
- **Contexto crítico** (lee esto primero)
- Modelos centrales (storeId, multi-tenant)
- Flujo auth resumido
- Flujo WhatsApp → Cita
- Rutas frontend (todas listadas)
- Endpoints backend (patrón estándar)
- BD schemas rápido (tabla x tabla)
- Stack tech resumido (tabla bonita)
- Comandos esenciales (3-4 lines cada uno)
- Auth rápida (no es seguridad)
- Patrones: Backend (NestJS), Frontend (React)
- Ciclo de desarrollo (add feature paso a paso)
- **USO PARA IAs** (instrucciones específicas)
- Referencias rápidas (Prisma, NestJS, React Query)
- Workflow típico (request → response)
- Errores comunes & soluciones

**Tamaño:** ~300 líneas, denso pero legible por IAs

**Cuándo usar:** **Inicial** si eres IA, para contexto rápido

---

### 3. **🏗️ ARCHITECTURE_DIAGRAMS.md** (Visual de sistemas)
**Para:** Entender cómo todo se conecta

✅ Incluye:
- **System Architecture Diagram** (ASCII gigante)
  - Cliente → Frontend → Backend → BD
  - Todos los módulos en árbol visual
  - Prisma layer visible
  - PostgreSQL final
- **Authentication Flow Diagram**
  - Login step-by-step
  - JWT decode
  - Interceptores
  - Guards
- **WhatsApp Integration Flow Diagram**
  - Message llega → Baileys
  - Service processing
  - AI + Groq
  - Respuesta → Real-time
- **Data Model Relationship Diagram**
  - Todas 14+ tablas conectadas visualmente
  - Fks mostradas
  - Relaciones (1:N, N:N)
- **Request/Response Cycle**
  - Desde Client hasta DB
  - Cada middleware explicado
  - Response back al cliente
- **Module Dependency Injection**
  - AppModule raíz
  - Cómo se inyectan servicios
- **Deployment Architecture (Tentativa)**
  - Frontend: Vercel
  - Backend: Railway
  - External services

**Tamaño:** ~500 líneas de diagramas ASCII

**Cuándo usar:** Cuando necesitas **visualizar** cómo funciona todo junto

---

### 4. **🚀 GETTING_STARTED.md** (Setup paso a paso)
**Para:** Tu primera vez ejecutando el proyecto

✅ Incluye:
- Setup inicial (primera vez, 4 pasos)
- Archivo .env completito (comentado)
- Desarrollo diario (morning routine)
- Login inicial (qué credenciales)
- Hacer cambios (backend, frontend, BD)
- Testing (frontend, backend)
- Troubleshooting (10+ errores comunes + soluciones)
- **Prisma Studio GUI** (visual DB)
- Crear usuario inicial (seed script)
- **API Testing** (curl, Postman, VSCode extension)
- Build & Deployment (Vercel, Railway)
- Debugging (breakpoints, DevTools)
- Performance monitoring
- Limpieza & Reset
- **MEGA CHEAT SHEET** (todos los comandos)
- Checklist de setup exitoso

**Tamaño:** ~400 líneas, muy práctico

**Cuándo usar:** **Primera vez** que ejecutas el proyecto, o cuando necesitas un comando rápido

---

## 🗂️ ESTRUCTURA DE CARPETAS (Resumida)

```
c:\Users\alexp\Desktop\proyectos\
│
├── 📖 PROJECT_SUMMARY.md              ← REFERENCIA COMPLETA
├── 📋 AI_QUICK_GUIDE.md               ← PARA IAs
├── 🏗️ ARCHITECTURE_DIAGRAMS.md        ← DIAGRAMAS VISUALES
├── 🚀 GETTING_STARTED.md              ← SETUP & COMANDOS
├── 📚 README.md                       ← ESTE ARCHIVO
│
├── stockup-frontend/                  ← React 19 + TypeScript
│   ├── src/
│   │   ├── App.tsx                 (Router)
│   │   ├── pages/ (12 componentes)
│   │   ├── hooks/useAuth.tsx       (Auth context)
│   │   ├── services/api.ts         (Axios client)
│   │   └── index.tsx
│   ├── public/
│   ├── build/                      (Prod build)
│   ├── package.json                (React 19.2.4)
│   └── tailwind.config.js
│
└── whatsapp-crm/                      ← NestJS + PostgreSQL
    ├── src/
    │   ├── main.ts                 (Bootstrap)
    │   ├── app.module.ts           (17 módulos)
    │   ├── modules/
    │   │   ├── auth/
    │   │   ├── customers/
    │   │   ├── products/
    │   │   ├── orders/
    │   │   ├── conversations/
    │   │   ├── messages/
    │   │   ├── appointments/
    │   │   ├── campaigns/
    │   │   ├── whatsapp/           (Baileys)
    │   │   ├── ai/                 (Groq)
    │   │   └── ... más módulos
    │   ├── prisma/
    │   └── config/
    ├── prisma/
    │   ├── schema.prisma           (14+ modelos)
    │   └── migrations/             (20+ versiones)
    ├── docker-compose.yml          (PostgreSQL + Redis)
    ├── package.json                (NestJS 11)
    └── test/
```

---

## 🎯 MAPEO DE PREGUNTAS → DOCUMENTOS

### Contesto: "¿Cómo está estructurado el proyecto?"
→ **PROJECT_SUMMARY.md**: Secciones "ESTRUCTURA DEL PROYECTO" + "MODELOS DE DATOS"

### Pregunta: "¿Cómo ejecuto esto por primera vez?"
→ **GETTING_STARTED.md**: Sección "SETUP INICIAL" (Primera vez)

### Pregunta: "¿Cuál es la arquitectura de alto nivel?"
→ **ARCHITECTURE_DIAGRAMS.md**: "System Architecture Diagram"

### Pregunta: "¿Qué modelos de datos existen?"
→ **PROJECT_SUMMARY.md**: "MODELOS DE DATOS (Prisma Schema)" – _muy detallado_

### Pregunta: "¿Cómo funciona la autenticación?"
→ **ARCHITECTURE_DIAGRAMS.md**: "Authentication Flow Diagram"  
→ **AI_QUICK_GUIDE.md**: "🔐 Autenticación rápida"

### Pregunta: "¿Cómo entra un cliente y se agenda una cita?"
→ **AI_QUICK_GUIDE.md**: "Si eres IA debuggeando código" (paso 1: busca storeId)  
→ **ARCHITECTURE_DIAGRAMS.md**: "WhatsApp Integration Flow"

### Pregunta: "¿Qué endpoints existen?"
→ **PROJECT_SUMMARY.md**: Sección "API ENDPOINTS (Tentativa)"

### Pregunta: "¿Qué módulos NestJS hay?"
→ **PROJECT_SUMMARY.md**: Sección "MÓDULOS BACKEND (src/)"

### Pregunta: "¿Cuáles son los comandos para desarrollo?"
→ **GETTING_STARTED.md**: "COMANDOS ESENCIALES" + "MEGA CHEAT SHEET"

### Pregunta: "¿Qué tecnologías usa?"
→ **PROJECT_SUMMARY.md**: Sección "TECNOLOGÍAS PRINCIPALES"  
→ **AI_QUICK_GUIDE.md**: Tabla "Stack tecnológico resumido"

### Pregunta: "Me falta algo, ¿qué hago?"
→ **GETTING_STARTED.md**: Sección "TROUBLESHOOTING"

### Pregunta: "¿Cómo agrego nuevo campo en BD?"
→ **GETTING_STARTED.md**: "Hacer cambios → Database"

### Pregunta: "Necesito debuggear un módulo específico"
→ **PROJECT_SUMMARY.md**: Busca nombre del módulo en "MÓDULOS BACKEND"

---

## 🚀 QUICK REFERENCE (Copiar y pegar)

### Backend estar corriendo
```bash
cd whatsapp-crm
npm run start:dev
# Port: http://localhost:3000/api
```

### Frontend estar corriendo
```bash
cd stockup-frontend
npm start
# Port: http://localhost:3000
```

### BD estar corriendo
```bash
cd whatsapp-crm
docker-compose up -d
# PostgreSQL: localhost:5432
# Redis: localhost:6379
```

### Crear migración
```bash
npx prisma migrate dev --name your_migration_name
```

### Ver GUI BD
```bash
npx prisma studio
# Abre: http://localhost:5555
```

### Correr tests backend
```bash
npm run test
```

### Build producción frontend
```bash
npm run build
# → /build folder
```

---

## 💡 CONCEPTOS CLAVE (EN ORDEN)

1. **Store** = El negocio/tienda, todo relacionado a ella
2. **Multi-tenant** = Cada Store es aislada (filtrar por storeId siempre)
3. **JWT** = Token que lleva userId, role, storeId
4. **Prisma** = ORM que convierte schema.prisma → BD + tipos TypeScript
5. **NestJS Modules** = Organización de código (controller + service + dto)
6. **Baileys** = Librería para WhatsApp Web API (sin SMS API real)
7. **Groq** = LLM (IA) para generar respuestas automáticas
8. **Real-time** = Socket.io para notificaciones live (conversaciones, citas)
9. **React Query** = Manejo de estado de servidor (fetching, caching, mutations)
10. **DTO** = Data Transfer Object (validación de entrada)

---

## 🆘 SI ALGO ESTÁ ROTO

**Paso 1:** ¿Cuál es el error exacto?

**Paso 2:** Busca el error en **GETTING_STARTED.md** sección "TROUBLESHOOTING"

**Paso 3:** Si no está:
- Mira logs: `npm run start:dev | grep -i error`
- Mira BD: `npx prisma studio`
- Mira request: DevTools → Network tab (frontend) o Postman (backend)

**Paso 4:** Si sigue roto:
- Reset completo: `docker-compose down -v && docker-compose up -d`
- Limpia cache: `rm -rf node_modules && npm install`
- Regenera Prisma: `npx prisma generate`

---

## 📊 ESTADÍSTICAS DEL PROYECTO

| Métrica | Valor |
|---------|-------|
| **Proyectos** | 2 (frontend + backend) |
| **Lenguaje** | TypeScript (ambos) |
| **Modelos BD** | 14+ (Prisma) |
| **Migraciones BD** | 20+ |
| **Módulos Backend** | 17 (NestJS) |
| **Páginas Frontend** | 12 (React) |
| **Dependencias** | 100+ (total) |
| **Testing** | Jest (ambos) |
| **Deployment** | Vercel (FE) + Railway (BE) |
| **DB** | PostgreSQL 16 |
| **Cache** | Redis 7 (opcional) |

---

## ✅ CHECKLIST: ANTES DE EMPEZAR

Asegúrate de tener:

- [ ] Node.js 18+ instalado (`node -v`)
- [ ] npm o yarn (`npm -v`)
- [ ] Docker instalado (`docker -v`)
- [ ] Git (para clonar repoLos: `git -v`)
- [ ] Editor: VSCode + extensiones:
  - [ ] Prisma
  - [ ] ESLint
  - [ ] Prettier
  - [ ] Thunder Client o REST Client (para testing API)
- [ ] Mínimo 2-3 GB RAM disponibles
- [ ] Internet (para npm packages + Groq API)

---

## 🎓 LEARNING PATH (Recomendado)

### Semana 1: Entender la arquitectura
1. Lee: **AI_QUICK_GUIDE.md** (30 min)
2. Lee: **ARCHITECTURE_DIAGRAMS.md** (45 min)
3. Lee: **PROJECT_SUMMARY.md** (Complete) (2 horas)

### Semana 2: Ejecutar y explorar
1. Sigue: **GETTING_STARTED.md** (1 hora)
2. Login, explora UI, haz un pedido
3. Mira BD con **Prisma Studio** (30 min)
4. Prueba algunos endpoints con **Postman**

### Semana 3: Modificar código
1. Haz cambios pequeños en frontend (Customers page)
2. Haz cambios pequeños en backend (Service método)
3. Crea una migración Prisma (nuevo campo)
4. Todos cambios deben compilar sin errores

### Semana 4: Deep Dive
1. Lee código real (ej: `CustomersModule`)
2. Entiende DTO validation
3. Explora Prisma relations
4. Entiende JWT flow completo

---

## 📞 RECURSOS EXTERNOS

- **React Docs:** https://react.dev
- **NestJS Docs:** https://docs.nestjs.com
- **Prisma Docs:** https://www.prisma.io/docs
- **TypeScript Docs:** https://www.typescriptlang.org/docs
- **PostgreSQL Docs:** https://www.postgresql.org/docs
- **Baileys GitHub:** https://github.com/WhiskeySockets/Baileys
- **Groq API Docs:** https://console.groq.com/docs

---

## 🎉 ¡LISTO PARA EMPEZAR!

### Sigue esto en orden:

1. **Ahorita:** Lee este archivo (README.md) → 10 min ✓
2. **Ahora:** Lee AI_QUICK_GUIDE.md → 20 min
3. **Pronto:** Sigue GETTING_STARTED.md → 1-2 horas
4. **Luego:** Explora PROJECT_SUMMARY.md → Referencia continua
5. **Siempre:** Mira ARCHITECTURE_DIAGRAMS.md cuando necesites visualizar

---

## 📝 CHANGELOG

**Versión 1.0** — 8 de Abril, 2026
- Documentación completa inicial
- 4 documentos principales
- Todos los modelos documentados
- Stack tech final

---

**Preguntas frecuentes contestadas por:**

| Documento | Para |
|-----------|------|
| PROJECT_SUMMARY.md | "Explicame todo" |
| AI_QUICK_GUIDE.md | "Soy una IA" |
| ARCHITECTURE_DIAGRAMS.md | "Dibujame cómo funciona" |
| GETTING_STARTED.md | "Cómo ejecuto esto?" |

---

**¡Éxito en tu desarrollo! 🚀**

*Última actualización: 8 de Abril, 2026  
Mantenido por: Development Team  
Status: Production Ready*
