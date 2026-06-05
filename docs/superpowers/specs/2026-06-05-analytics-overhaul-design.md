# Analytics Overhaul — Spec

**Fecha:** 2026-06-05
**Proyecto:** Stockup Messages
**Estado:** Aprobado

---

## Problema

La sección actual de analíticas mezcla productos y servicios en un solo número y no distingue por empleado. Necesitamos un dashboard ejecutivo + reportes contables separados.

---

## Diseño general

Dos pestañas en la página de Analíticas:

**1. Dashboard** — KPIs de un vistazo, período seleccionable
**2. Reportes** — tablas detalladas con totales, por tipo, por método de pago, por empleado

---

## 1. Backend — nuevo endpoint de resumen

### `GET /analytics/summary?period=today|week|month|last_month`

Devuelve todo lo necesario para ambas pestañas en una sola llamada:

```json
{
  "period": "month",
  "from": "2026-06-01",
  "to":   "2026-06-30",

  "revenue": {
    "total":    150000,
    "products": 90000,
    "services": 60000
  },

  "orders": {
    "total":    12,
    "products": 7,
    "services": 5
  },

  "customers": {
    "total":   45,
    "new":     8
  },

  "byPaymentMethod": [
    { "method": "CASH",     "label": "Efectivo",       "amount": 80000, "count": 6 },
    { "method": "TRANSFER", "label": "Transferencia",  "amount": 50000, "count": 4 },
    { "method": "CARD",     "label": "Tarjeta",        "amount": 20000, "count": 2 }
  ],

  "topProducts": [
    { "name": "Shampoo Pro", "quantity": 5, "revenue": 45000 }
  ],

  "topServices": [
    { "name": "Corte Básico", "quantity": 8, "revenue": 40000 }
  ],

  "byStaff": [
    { "staffId": "abc", "name": "Carlos", "appointments": 12, "revenue": 36000 },
    { "staffId": "def", "name": "Luis",   "appointments": 8,  "revenue": 24000 }
  ],

  "recentOrders": [
    {
      "orderId": "...",
      "createdAt": "2026-06-05T12:00:00Z",
      "type": "service",
      "customerName": "Jesus Montoya",
      "description": "Corte Básico",
      "amount": 30000,
      "paymentMethod": "CASH",
      "staffName": null
    }
  ]
}
```

### Períodos
| `period` | Rango |
|----------|-------|
| `today`      | 00:00 – 23:59 hoy |
| `week`       | lunes de esta semana – hoy |
| `month`      | 1ro del mes actual – hoy |
| `last_month` | 1ro – último día del mes anterior |

### Lógica

- `revenue.products`: suma de `order.total` donde `order.type != 'service'`
- `revenue.services`: suma de `order.total` donde `order.type = 'service'`
- `customers.new`: clientes cuyo `createdAt` cae dentro del período
- `byStaff.revenue`: suma de `order.total` de citas (`appointment`) con status `DELIVERED/COMPLETED` donde `staffId` está asignado — si no hay orders de servicio con staffId, usar appointments completadas con `agreedPrice`
- `recentOrders`: últimas 50 órdenes (producto + servicio) del período, con `staffName` si aplica
- `topProducts`: top 5 productos por cantidad vendida en el período
- `topServices`: top 5 servicios por cantidad en el período

### Auth
Endpoint protegido con `JwtAuthGuard`. `storeId` del JWT.

---

## 2. Frontend — Analytics.tsx completo

### 2.1 Estructura de tabs

```
[Dashboard]  [Reportes]
```

### 2.2 Tab Dashboard

**Selector de período:** pills horizontales — Hoy / Esta semana / Este mes / Mes anterior

**Fila 1 — KPIs principales (4 tarjetas):**
```
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Ingresos     │ │ Ventas       │ │ Clientes     │ │ Clientes     │
│ totales      │ │ totales      │ │ totales      │ │ nuevos       │
│ $150.000     │ │ 12           │ │ 45           │ │ 8            │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

**Fila 2 — Desglose Productos vs Servicios (2 tarjetas lado a lado):**
```
┌─────────────────────────┐  ┌─────────────────────────┐
│ 🛍 Ventas Productos      │  │ ✂ Ventas Servicios       │
│ $90.000 · 7 órdenes     │  │ $60.000 · 5 servicios    │
│ ▓▓▓▓▓▓▓░░░░░ 60%        │  │ ░░░░░░▓▓▓▓▓ 40%         │
└─────────────────────────┘  └─────────────────────────┘
```

**Fila 3 — Por empleado (si hay staff):**
Tabla con: Foto inicial | Nombre | Citas | Ingresos | Barra de progreso relativa al top

**Fila 4 — Métodos de pago:**
Pills con: Efectivo $80k · Transferencia $50k · Tarjeta $20k

**Fila 5 — Top productos + Top servicios (2 columnas):**
Listas top 5 con nombre, cantidad y monto.

### 2.3 Tab Reportes

**Filtros:**
- Período: Hoy / Esta semana / Este mes / Mes anterior
- Tipo: Todos / Solo productos / Solo servicios
- Búsqueda por cliente o descripción

**Tabla:**
```
Fecha | Cliente | Tipo | Descripción | Empleado | Método | Monto
```

- Tipo badge: verde = Servicio, azul = Producto
- Empleado: nombre si fue asignado, "—" si no
- Monto: formato COP

**Totales al pie:**
- Subtotal productos | Subtotal servicios | **Total general**
- Desglose por método de pago

**Botón Exportar Excel** — genera `.xlsx` con todas las filas del período seleccionado.

---

## 3. Retrocompatibilidad

- El endpoint `/analytics/summary` es nuevo — no modifica los existentes (`/analytics/trends`, etc.)
- `Analytics.tsx` se reescribe completamente — la página actual está incompleta de todas formas
- No hay cambios a BD ni a otros módulos

---

## 4. Orden de implementación

1. Backend `AnalyticsService.getSummary()` + endpoint
2. Frontend `Analytics.tsx` — tab Dashboard completo
3. Frontend `Analytics.tsx` — tab Reportes + export Excel
