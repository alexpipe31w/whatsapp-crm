# Rediseño de Analytics — Insights profundos con gráficos reales

**Fecha:** 2026-06-07
**Proyecto:** Stockup Messages
**Estado:** Aprobado

---

## Problema

El Analytics actual (`Analytics.tsx`, renovado 2026-06-05) es funcional pero
se siente genérico — KPIs en cards iguales + "mini-barras" hechas con `<div>`
y CSS puro (no son gráficos reales, pese a que `recharts` está instalado en
el stack y sin usar). Además solo muestra totales del período actual: no hay
tendencias en el tiempo, comparación contra el período anterior, patrones de
actividad por hora/día, ni visibilidad de qué tan bien convierte la IA
conversaciones en citas/ventas.

El Dashboard (`Dashboard.tsx`) comparte el mismo lenguaje visual de cards —
si solo se rediseña Analytics, quedaría luciendo desactualizado por contraste.

---

## Diseño general

**Reparto de roles** (para no duplicar contenido entre páginas):

- **Dashboard** = vistazo operativo del día — "¿qué necesita mi atención
  ahora?" (chats esperando, citas de hoy, estado WhatsApp). Recibe el
  refresco visual (jerarquía, animaciones más suaves) pero **sin** gráficos
  de tendencia — esos quedan exclusivos de Analytics.
- **Analytics** = análisis profundo. Mantiene el grid de cards (consistente
  con el resto de la app) pero cada card se vuelve un mini-widget enfocado
  con gráfico real de `recharts` + period-over-period + patrones + embudo.

---

## 1. Backend — nuevo endpoint `/analytics/insights`

### `GET /analytics/insights?period=today|week|month|last_month`

Endpoint **nuevo**, separado de `/analytics/summary` (commit `9a82472`/
spec `2026-06-05-analytics-overhaul-design.md`):

- No toca el endpoint existente que ya funciona en producción → cero riesgo
  de regresión en las cards de KPIs/tops/métodos de pago que ya están bien.
- El frontend pide ambos en paralelo (`Promise.all`) — las cards "rápidas"
  (KPIs de `/summary`) no esperan a las de gráficos (`/insights`), y
  viceversa: cada grupo tiene su propio loading/skeleton.

```json
{
  "period": "month",
  "from": "2026-06-01",
  "to":   "2026-06-30",

  "series": [
    { "date": "2026-06-01", "revenue": 120000, "appointments": 3, "conversations": 8 },
    { "date": "2026-06-02", "revenue": 80000,  "appointments": 1, "conversations": 5 }
  ],

  "comparison": {
    "revenue":      { "current": 4200000, "previous": 3750000, "pctChange": 12.0 },
    "appointments": { "current": 38,      "previous": 31,      "pctChange": 22.6 },
    "customers":    { "current": 12,      "previous": 9,       "pctChange": 33.3 }
  },

  "patterns": {
    "byHour":    [0,0,0,0,0,0,1,2,5,8,12,15,18,14,10,9,11,13,7,4,2,1,0,0],
    "byWeekday": [4,12,15,18,20,22,9]
  },

  "funnel": {
    "conversations":  120,
    "withAppointment": 45,
    "withPurchase":    38
  }
}
```

### Cálculo de cada bloque

- **`series`**: agrupa `Order` (revenue) + `Appointment` (citas creadas) +
  `Conversation` (conversaciones iniciadas) por día dentro de `[from, to]`,
  anclado a hora Colombia (mismo patrón `tzOffset=-5*60`/`colMidnight` que
  ya usa `getSummary`). Para períodos largos (`month`) se agrupa por día;
  no hace falta downsampling — máximo ~31 puntos.
- **`comparison`**: recalcula `from`/`to` del **período anterior equivalente**
  (mismo tamaño, justo antes) y compara `revenue.total`, `count` de citas
  confirmadas+completadas, y clientes nuevos. `pctChange = (current - previous)
  / previous * 100`; si `previous === 0` y `current > 0` → `pctChange: 100`,
  si ambos son `0` → `pctChange: 0` (evita `Infinity`/`NaN`).
- **`patterns`**: cuenta `Appointment.scheduledAt` + `Order.createdAt` dentro
  del período, agrupados por hora del día (0-23) y por día de la semana (0=Dom)
  — ambos en hora Colombia. Sirve para responder "¿cuáles son mis horas/días
  pico?".
- **`funnel`**: aproximación **por cliente** (el schema no liga `Order`/
  `Appointment` directo a `Conversation` — solo comparten `customerId`):
  de los clientes con al menos un mensaje entrante en el período
  (`conversations`), cuántos tienen al menos una `Appointment` creada en el
  mismo rango (`withAppointment`), y cuántos tienen al menos una `Order`
  pagada/entregada (`withPurchase`). No es un embudo exacto por conversación,
  pero responde la pregunta real: "de la gente que me escribió, ¿cuántos
  terminaron agendando/comprando?".

### Multi-tenant / estándares

- `storeId` siempre del JWT (`req.user.storeId`), nunca del query — mismo
  guard que `/analytics/summary`.
- Reutiliza el helper de zona horaria Colombia ya existente en
  `analytics.service.ts.getSummary` (extraerlo a función compartida si crece
  la duplicación).

---

## 2. Frontend — componentes nuevos con `recharts`

Reemplazan `MiniBar` (CSS puro) y la barra de distribución manual, manteniendo
la paleta dark del design system (`#D4FF00` lima como acento primario,
`#141419`/`#1C1C24` superficies, sin emojis en la UI — solo `lucide-react`).

| Card | Gráfico (`recharts`) | Qué muestra |
|---|---|---|
| **Tendencia** | `AreaChart` con `<Area>` (línea + relleno degradado lima→transparente) | Ingresos/citas/conversaciones día a día — toggle entre las 3 series |
| **Comparativa** | Stat grande + ícono `TrendingUp`/`TrendingDown` + color verde/rojo | "$4.2M ▲12% vs. mes anterior" — una por métrica clave |
| **Patrones de actividad** | `BarChart` horizontal compacto, intensidad por color (estilo heatmap) | Actividad por hora del día y por día de la semana — "tus horas pico" |
| **Embudo IA→venta** | Barras descendentes conectadas + badge de % de conversión | "120 chats → 45 citas (38%) → 38 ventas (84%)" |
| **Productos vs Servicios** | `PieChart` tipo dona | Reemplaza la barra de distribución actual |
| **Top productos/servicios/staff** | `BarChart` vertical compacto, barra con gradiente lima | Reemplaza `MiniBar` manteniendo el ranking top-5 |

### Animaciones (`framer-motion`, ya en el stack)

- Stagger de entrada de cards al cargar — mismo patrón
  `containerVariants`/`itemVariants` que ya usa `Dashboard.tsx`
- Conteo animado de los números KPI (de 0 al valor final, ~600ms ease-out)
- Transición suave al cambiar de período: fade + slide corto en vez de
  reemplazo brusco del contenido

### Loading / error — independiente por grupo de cards

- Skeleton shimmer por card (reutiliza la clase `skeleton-shimmer` que ya
  existe en `Dashboard.tsx`)
- Las cards de `/summary` (KPIs, tops, métodos de pago) y las de
  `/insights` (tendencia, comparativa, patrones, embudo) cargan y fallan
  **independientemente** — si `/insights` tarda o falla, las KPIs siguen
  mostrándose con datos frescos
- Estados "sin datos suficientes" por widget (ej. el embudo necesita
  `conversations > 0`; la tendencia necesita al menos 2 puntos en `series`)

---

## 3. Archivos afectados (estimado)

**Backend** (`whatsapp-crm`):
- `src/analytics/analytics.service.ts` — nuevo método `getInsights(storeId, period)`
- `src/analytics/analytics.controller.ts` — nueva ruta `GET /analytics/insights`

**Frontend** (`stockup-frontend`):
- `src/services/api.ts` — nuevo `getAnalyticsInsights(period)`
- `src/pages/Analytics.tsx` — integra los nuevos widgets en `DashboardTab`
- `src/pages/Dashboard.tsx` — solo ajustes de animación/jerarquía visual,
  sin cambios de datos/endpoints
- Componentes nuevos (ubicación a definir en el plan: inline en `Analytics.tsx`
  vs. `src/components/analytics/`): `TrendChart`, `ComparisonStat`,
  `ActivityPatterns`, `FunnelChart`, `DonutBreakdown`, `TopBarChart`

---

## Pruebas

- `npx tsc --noEmit` limpio en ambos repos
- Backend: probar `/analytics/insights` con los 4 períodos contra datos
  reales de una tienda con historial (verificar `pctChange` con `previous=0`)
- Frontend: levantar dev server, navegar a `/analytics`, verificar cada
  card con datos reales — incluyendo el estado "sin datos suficientes" en
  una tienda/período sin actividad
- Responsive: grid de cards en mobile (2 cols) vs desktop (3-4 cols), igual
  que el patrón actual
