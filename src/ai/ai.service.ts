import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { createCompletion, PROVIDER_CONFIG, AIProvider } from './providers';
import {
  buildCartridgeList, ensurePool, getNextCartridge,
  markExhausted, isRateLimitError, getPoolStatus, Cartridge,
} from './key-pool';
import { PrismaService } from '../prisma/prisma.service';
import { SyncService } from '../integrations/sync.service';
import { NotificationsService } from '../notifications/notifications.service';
import { formatBusinessHoursForAI } from '../utils/business-hours.util';

// ─── Constantes ───────────────────────────────────────────────────────────────

const CONFIG_CACHE_TTL_MS  = 60_000;
const CATALOG_CACHE_TTL_MS = 120_000;
const AI_TIMEOUT_MAIN_MS = 30_000;
const AI_TIMEOUT_EXT_MS  = 20_000;
const ORDER_GUARD_TTL_MS   = 10 * 60 * 1000;
const CONFIRM_REMINDER_MS  =  5 * 60 * 1000; // recordatorio si el cliente no confirma en 5 min
const MAX_HISTORY_MESSAGES = 14;

// JS \b NO trata tildes/eñes como caracteres de palabra: "sí" pierde el límite de cierre
// (falso negativo — el cliente confirma y el sistema no lo detecta) y "cl"/"av" hacen
// match dentro de "clásico"/"avísame" (falso positivo — se guarda basura como dirección).
// Estos límites Unicode-aware (\p{L}\p{N}_) resuelven ambos problemas en español.
const ES_WORD_CHARS = '\\p{L}\\p{N}_';
function esWord(alternativas: string): string {
  return `(?<![${ES_WORD_CHARS}])(?:${alternativas})(?![${ES_WORD_CHARS}])`;
}

const PURCHASE_INTENT_RE = new RegExp(
  `${esWord('quiero|deseo|pedir|pido|ordenar|comprar|llevar|encargar|confirm|dale|listo|acepto|perfecto|procede|adelante|claro|exacto|sip|yep|yes|s[ií]|ok|pedido|orden|dirección|entrega|envío|cantidad|unidades?')}|\\[Pedido del catálogo:`,
  'iu',
);
const APPOINTMENT_INTENT_RE = /\b(agendar|agenda|cita|visita|visita técnica|técnico|técnica|programar|reservar|reserva|turno|appointment|quiero una cita|necesito una visita|instalar|instalación|mantenimiento|corte|sesión)\b/i;

// Confirmaciones — el mensaje debe SER una confirmación, no solo CONTENER una.
// Antes el regex usaba esWord() para buscar la palabra en cualquier parte de la
// frase, lo que producía falsos positivos graves: "sí o sí" (énfasis, no es un
// "sí" de respuesta) o "ah listo, déjamela con Carlos" (sigue con otra idea —
// "listo" es muletilla, no confirmación) se detectaban como confirmación y
// disparaban un agendado/pedido prematuro o una falsa "complete=true".
// Ahora exigimos que la frase de confirmación domine el mensaje completo,
// permitiendo solo adornos triviales alrededor (puntuación, emojis, "gracias"...).
const CONFIRMATION_WORDS   = 's[ií]|ok|okay|dale|listo|acepto|perfecto|procede|adelante|claro|exacto|sip|yep|yes|confirm|correcto|de acuerdo|está bien|estoy de acuerdo|va|hagale|hádale|marchando|hecho|venga|eso|eso mismo|así es|claro que sí|por supuesto|obvio|chévere|bacano|sale|de una|okey|sisas';
const CONFIRMATION_FILLERS = 'gracias|porfa|por favor|vale|ya';
const CONFIRMATION_DECOR   = '[\\s,.!?¡¿…\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\uFE0F]';
// "pues sí", "bueno sí", etc. — prefijo opcional de 1-2 palabras antes de la confirmación
const CONFIRMATION_PREFIX  = '(?:(?:pues|bueno|o sea|claro que|la verdad)\\s+)?';
const CONFIRMATION_RE = new RegExp(
  `^${CONFIRMATION_DECOR}*${CONFIRMATION_PREFIX}${esWord(CONFIRMATION_WORDS)}` +
  `(?:${CONFIRMATION_DECOR}+${esWord(`${CONFIRMATION_WORDS}|${CONFIRMATION_FILLERS}`)})?` +
  `${CONFIRMATION_DECOR}*$` +
  `|^(?:👍|✅|✓)$`,
  'iu',
);

// Mensajes donde el cliente coordina/avisa sobre una cita YA existente
// ("ya voy", "llegando", "ya le llego", "confírmamela", "voy en camino").
const ARRIVAL_COORD_RE = new RegExp(
  '\\b(' +
  'ya\\s+(voy|vamos|le\\s+lleg|llegu|estamos|casi)|' +
  'voy\\s+(en\\s+camino|saliendo|para\\s+all|llegando)|' +
  'en\\s+camino|llegando|ya\\s+casi|estoy\\s+llegando|' +
  'conf[ií]rma(mela|r)?|confirmad[ao]|sigue\\s+en\\s+pie' +
  ')\\b',
  'i',
);

const ADDRESS_RE = new RegExp(
  `${esWord('calle|carrera|cra|cl|av|avenida|barrio|diagonal|transversal|manzana|casa|apto|apartamento')}|#\\d|\\d{2,}[-–]\\d+`,
  'iu',
);

const PAYMENT_PROOF_RE = new RegExp(
  esWord('pagu[eé]|transfer[ií]|te mand[eé]|comprobante|transacci[oó]n|consign[eé]|listo el pago|ya pagu[eé]|hice el pago'),
  'iu',
);
const CANCEL_RESCHEDULE_RE = /\b(cancelar|no puedo ir|no puedo asistir|cambiar la cita|reprogramar|mover la cita|otro d[ií]a|otra hora|posponer|aplazar)\b/i;
const MIN_ADVANCE_RE       = /m[ií]nimo\s+(\d+)\s*(hora|horas|h\b)/i;

// ─── Respaldo determinístico cuando el LLM está caído ─────────────────────────
// Detecta intención por palabras clave (no usa LLM porque el LLM es justo lo que
// falló) y arma UN mensaje con los links públicos. Un marcador invisible permite
// detectar en el historial que ya se envió, para no repetirlo en cada mensaje
// (el spam del incidente del 2026-06-18).
const FALLBACK_MARKER = 'no está disponible en este momento';
// Ventana del dedup del respaldo. Antes se buscaba el marcador en TODO el historial
// sin límite de tiempo → una conversación que recibió el respaldo durante un bajón de
// rate-limit quedaba MUDA para siempre, aunque el pool se recuperara segundos después.
// Ahora solo se silencia si el respaldo se mandó hace menos de esto; pasado el lapso la
// IA reintenta (responde si el pool ya revivió, o re-manda el respaldo a lo sumo 1 vez
// cada FALLBACK_DEDUP_MS).
const FALLBACK_DEDUP_MS = 10 * 60 * 1000;
const PRODUCT_INTENT_RE = /\b(producto|productos|comprar|compra|vende[ns]?|precio de|cu[aá]nto vale|domicilio|env[ií]o|gel|cera|shampoo|pomada|cuesta)\b/i;
const APPT_INTENT_RE    = /\b(cita|agendar|agenda|turno|corte|barba|cejas?|hora|disponib|reservar|peluqu)\b/i;

function buildFallbackMessage(opts: { hasSlug: boolean; frontendUrl: string; slug?: string; lastUserText: string }): string | null {
  if (!opts.hasSlug || !opts.frontendUrl || !opts.slug) return null;
  const cal    = `${opts.frontendUrl}/cal/${opts.slug}`;
  const tienda = `${opts.frontendUrl}/tienda/${opts.slug}`;
  const t = opts.lastUserText;
  const wantsProduct = PRODUCT_INTENT_RE.test(t);
  const wantsAppt    = APPT_INTENT_RE.test(t);

  let cuerpo: string;
  if (wantsProduct && !wantsAppt) {
    cuerpo = `Para tu compra, puedes ver los productos y dejar tu pedido aquí:\n🛍️ ${tienda}`;
  } else if (wantsAppt && !wantsProduct) {
    cuerpo = `Para agendar tu cita, entra aquí y elige horario:\n📅 ${cal}`;
  } else {
    cuerpo = `Si quieres agendar una cita: 📅 ${cal}\nSi buscas un producto: 🛍️ ${tienda}`;
  }
  return `¡Hola! 👋 Nuestro asistente ${FALLBACK_MARKER}, pero vuelve muy pronto. ${cuerpo}`;
}

// ─── Meses en español ─────────────────────────────────────────────────────────
const MESES: Record<string, number> = {
  enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6,
  julio:7, agosto:8, septiembre:9, octubre:10, noviembre:11, diciembre:12,
  ene:1, feb:2, mar:3, abr:4, jun:6, jul:7, ago:8, sep:9, oct:10, nov:11, dic:12,
};

// ─── Días de semana ────────────────────────────────────────────────────────────
const DIAS_SEMANA: Record<string, number> = {
  domingo:0, lunes:1, martes:2, miércoles:3, miercoles:3,
  jueves:4, viernes:5, sábado:6, sabado:6,
};

// ─── Fecha en zona horaria Colombia (YYYY-MM-DD) ─────────────────────────────
const TZ_CO = 'America/Bogota';

function coDateStr(d: Date = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: TZ_CO }); // YYYY-MM-DD
}

// Devuelve un Date representando mediodia Colombia para la fecha dada (evita DST)
function coNoon(dateStr: string): Date {
  return new Date(`${dateStr}T12:00:00-05:00`);
}

// Devuelve la clave de día ('sun'|'mon'|...'sat') en timezone Colombia.
// SEGURO: usa en-CA (YYYY-MM-DD) + new Date(y,m,d) que nunca devuelve NaN.
function coDayKey(d: Date): string {
  const [y, m, dy] = d.toLocaleDateString('en-CA', { timeZone: TZ_CO }).split('-').map(Number);
  return ['sun','mon','tue','wed','thu','fri','sat'][new Date(y, m - 1, dy).getDay()];
}

// ─── Calendario de referencia para el extractor (evita alucinaciones de fechas) ──
function buildCalendarioRef(): string {
  const DIAS = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const todayStr = coDateStr();
  const today = coNoon(todayStr);
  const todayName = DIAS[today.getUTCDay()];
  const lines = [`HOY: ${todayName}, ${todayStr} (Colombia — America/Bogota)`];
  lines.push('PRÓXIMAS FECHAS (usa exactamente estos valores YYYY-MM-DD):');
  for (let i = 1; i <= 30; i++) {
    const d = new Date(today.getTime() + i * 86_400_000);
    const ymd = coDateStr(d);
    const nombre = DIAS[d.getUTCDay()];
    const label = i === 1 ? ' ← mañana' : '';
    lines.push(`  ${nombre}: ${ymd}${label}`);
  }
  lines.push('REGLA: "el lunes" = el lunes más cercano en el futuro. "la otra semana"/"la próxima semana" = la semana que EMPIEZA el PRÓXIMO LUNES; si HOY es sáb 6-jun, esa semana empieza el lun 8-jun → "el lunes de la otra semana" = 8-jun, "el viernes de la otra semana" = 12-jun. "dentro de dos semanas" = el día MÁS CERCANO al punto HOY+14; si HOY es sáb 6-jun, "viernes dentro de dos semanas" → punto=sáb 20-jun → viernes más cercano = 19-jun (1 día antes), NO 26-jun. Siempre elige el día más cercano al punto HOY+N*7, puede ser antes o después.');
  return lines.join('\n');
}

// ─── Parser de fecha en español ───────────────────────────────────────────────
const SEMANAS_TEXTO: Record<string, number> = { una:1, dos:2, tres:3, cuatro:4, cinco:5, seis:6, siete:7, ocho:8 };

function parseSemanaOffset(t: string): number {
  // "dentro de dos semanas" | "en tres semanas"
  const m = t.match(/\b(?:dentro\s+de|en)\s+(una|dos|tres|cuatro|cinco|seis|siete|ocho|\d+)\s+semanas?\b/);
  if (!m) return 0;
  return (SEMANAS_TEXTO[m[1]] ?? parseInt(m[1], 10) ?? 0) * 7;
}

function parseFechaEspanol(text: string): string | null {
  const t      = text.toLowerCase().trim();
  const hoyStr = coDateStr();            // "2026-06-05" en hora Colombia
  const hoy    = coNoon(hoyStr);         // mediodia Colombia hoy

  // pasado mañana (antes de mañana para evitar falso match)
  if (/\bpasado\s+ma[ñn]ana\b/.test(t)) {
    const d = new Date(hoy); d.setDate(d.getDate() + 2);
    return coDateStr(d);
  }
  // mañana — EXCLUIR "de la mañana" / "por la mañana" (AM, no tomorrow)
  if (/\bma[ñn]ana\b/.test(t) && !/(?:de|por)\s+la\s+ma[ñn]ana/.test(t)) {
    const d = new Date(hoy); d.setDate(d.getDate() + 1);
    return coDateStr(d);
  }
  // hoy
  if (/\bhoy\b/.test(t)) {
    return hoyStr;
  }

  // "dentro de N días" | "en N días"
  const NUM_DIAS_ES: Record<string, number> = {
    'un': 1, 'uno': 1, 'una': 1, 'dos': 2, 'tres': 3, 'cuatro': 4, 'cinco': 5,
    'seis': 6, 'siete': 7, 'ocho': 8, 'nueve': 9, 'diez': 10,
    'quince': 15, 'veinte': 20, 'veintiuno': 21, 'veintidos': 22, 'treinta': 30,
  };
  const diasM = t.match(/\b(?:dentro\s+de|en)\s+(\d+|un[ao]?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|veinte|treinta)\s+días?\b/);
  if (diasM) {
    const n = parseInt(diasM[1]) || NUM_DIAS_ES[diasM[1]] || 0;
    if (n > 0) { const d = new Date(hoy); d.setDate(d.getDate() + n); return coDateStr(d); }
  }

  // Formatos numéricos: 24/03/2026 | 24-03-2026 | 24/03 | 24-03
  const numFmt = t.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (numFmt) {
    let day   = parseInt(numFmt[1]);
    let month = parseInt(numFmt[2]);
    let year  = numFmt[3] ? parseInt(numFmt[3]) : hoy.getFullYear();
    if (year < 100) year += 2000;
    const fecha = coNoon(`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`);
    if (fecha < hoy) fecha.setFullYear(fecha.getFullYear() + 1);
    return coDateStr(fecha);
  }

  // "el 24 de marzo" | "24 de marzo" | "el 24 de marzo de 2026"
  const textFmt = t.match(/\b(\d{1,2})\s+de\s+([a-záéíóúñ]+)(?:\s+(?:de\s+)?(\d{4}))?\b/);
  if (textFmt) {
    const day    = parseInt(textFmt[1]);
    const mesNom = textFmt[2].toLowerCase();
    const month  = MESES[mesNom];
    if (month) {
      const year  = textFmt[3] ? parseInt(textFmt[3]) : hoy.getFullYear();
      const fecha = coNoon(`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`);
      if (fecha < hoy) fecha.setFullYear(fecha.getFullYear() + 1);
      return coDateStr(fecha);
    }
  }

  // "el lunes" | "el próximo martes" | "este viernes" | "el lunes dentro de tres semanas"
  const weekDaysOffset = parseSemanaOffset(t); // 0 si no menciona semanas
  const otroSemana = /otra\s+semana|pr[oó]xima\s+semana|siguiente\s+semana/.test(t);
  const refPoint = new Date(hoy);
  if (weekDaysOffset > 0) {
    refPoint.setDate(refPoint.getDate() + weekDaysOffset);
  } else if (otroSemana) {
    // "La otra semana" = la semana que empieza el próximo lunes
    const daysToMon = (1 - hoy.getDay() + 7) % 7 || 7;
    refPoint.setDate(refPoint.getDate() + daysToMon);
  }
  const refDia = refPoint.getDay();

  for (const [nombre, diaSemana] of Object.entries(DIAS_SEMANA)) {
    const re = new RegExp(`\\b(?:el\\s+)?(?:pr[oó]ximo\\s+|este\\s+|esta\\s+)?${nombre}\\b`);
    if (re.test(t)) {
      const d = new Date(refPoint);
      let diff = diaSemana - refDia;
      if (weekDaysOffset > 0) {
        // Nearest neighbor: encontrar el día más cercano al refPoint (puede ser antes o después)
        if (diff > 3)  diff -= 7;
        if (diff < -3) diff += 7;
      } else if (otroSemana) {
        // El día cae dentro de la semana anclada al lunes; diff=0 es válido (el lunes mismo)
        if (diff < 0) diff += 7;
      } else {
        if (diff <= 0) diff += 7;
      }
      d.setDate(d.getDate() + diff);
      return coDateStr(d);
    }
  }

  return null;
}

// ─── Query date extractor for AI availability detection ───────────────────────
function extractQueryDate(message: string, _today: Date, tz = TZ_CO): Date | null {
  const lower  = message.toLowerCase();
  const hoyStr = coDateStr();        // fecha actual en Colombia
  const hoy    = coNoon(hoyStr);     // mediodia Colombia hoy
  const dayOfWeek = hoy.getDay();    // día de semana correcto en Colombia

  if (/\bhoy\b/.test(lower)) return hoy;

  // pasado mañana (antes de "mañana" para evitar el falso match / off-by-one)
  if (/\bpasado\s+ma[ñn]ana\b/.test(lower)) {
    const d = new Date(hoy); d.setDate(d.getDate() + 2); return d;
  }

  // mañana — EXCLUIR "de la mañana" / "por la mañana" (AM, no tomorrow)
  if (/\bma[ñn]ana\b/.test(lower) && !/(?:de|por)\s+la\s+ma[ñn]ana/.test(lower)) {
    const d = new Date(hoy); d.setDate(d.getDate() + 1); return d;
  }

  // "dentro de N días" — antes del loop de días para que tome prioridad
  const NUM_DIAS_EQ: Record<string, number> = {
    'un': 1, 'uno': 1, 'una': 1, 'dos': 2, 'tres': 3, 'cuatro': 4, 'cinco': 5,
    'seis': 6, 'siete': 7, 'ocho': 8, 'nueve': 9, 'diez': 10,
    'quince': 15, 'veinte': 20, 'treinta': 30,
  };
  const diasMEQ = lower.match(/\b(?:dentro\s+de|en)\s+(\d+|un[ao]?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|veinte|treinta)\s+días?\b/);
  if (diasMEQ) {
    const n = parseInt(diasMEQ[1]) || NUM_DIAS_EQ[diasMEQ[1]] || 0;
    if (n > 0) { const d = new Date(hoy); d.setDate(d.getDate() + n); return d; }
  }

  // Jerga colombiana: "el finde" / "este finde" / "fin de semana" → el próximo sábado
  if (/\b(el|este)\s+finde\b|\bfin\s+de\s+semana\b/.test(lower)) {
    const diff = (6 - dayOfWeek + 7) % 7 || 7;
    const d = new Date(hoy); d.setDate(d.getDate() + diff); return d;
  }

  const DAYS: Record<string, number> = {
    domingo:0, lunes:1, martes:2, miércoles:3, miercoles:3,
    jueves:4, viernes:5, sábado:6, sabado:6,
  };

  // Soporte "dentro de N días / semanas" para avanzar el punto de referencia del día de semana
  // Ej: "dentro de 8 días el miércoles" | "dentro de una semana el lunes"
  const weeksOff = parseSemanaOffset(lower);
  const refDateEQ = new Date(hoy);
  if (weeksOff > 0) {
    refDateEQ.setDate(refDateEQ.getDate() + weeksOff);
  } else if (/otra\s+semana|pr[oó]xima\s+semana|siguiente\s+semana/.test(lower)) {
    refDateEQ.setDate(refDateEQ.getDate() + 7);
  }
  const refDayEQ = refDateEQ.getDay();

  for (const [word, target] of Object.entries(DAYS)) {
    if (lower.includes(word)) {
      if (weeksOff > 0) {
        // Nearest neighbor: día más cercano al refDateEQ (puede ser antes o después)
        let diff = target - refDayEQ;
        if (diff > 3)  diff -= 7;
        if (diff < -3) diff += 7;
        const d = new Date(refDateEQ); d.setDate(d.getDate() + diff); return d;
      }
      const diff = (target - dayOfWeek + 7) % 7 || 7;
      const d = new Date(hoy); d.setDate(d.getDate() + diff); return d;
    }
  }

  // "el 10" or "el 10 de junio"
  const MONTHS_NUM: Record<string, number> = {
    enero:0, febrero:1, marzo:2, abril:3, mayo:4, junio:5,
    julio:6, agosto:7, septiembre:8, octubre:9, noviembre:10, diciembre:11,
  };
  const dateMatch = lower.match(/\bel\s+(\d{1,2})(?:\s+de\s+(\w+))?/);
  if (dateMatch) {
    const day  = parseInt(dateMatch[1], 10);
    const monthWord = dateMatch[2];
    const month = monthWord ? (MONTHS_NUM[monthWord] ?? hoy.getMonth()) : hoy.getMonth();
    const year  = hoy.getFullYear();
    const mm    = String(month + 1).padStart(2, '0');
    const dd    = String(day).padStart(2, '0');
    let d = coNoon(`${year}-${mm}-${dd}`);
    if (!isNaN(d.getTime())) {
      // Roll-over al año siguiente si la fecha calculada ya pasó (igual que parseFechaEspanol)
      if (d < hoy) d = coNoon(`${year + 1}-${mm}-${dd}`);
      return d;
    }
  }

  return null;
}

// ─── Parser de hora en español ────────────────────────────────────────────────
function parseHoraEspanol(text: string): string | null {
  const t = text.toLowerCase().trim();

  // HH:MM formato 24h o 12h. Acepta ":", ".", "," o "h" como separador de minutos
  // ("3:30", "3.30", "3,30", "3h30") — un cliente escribió "3.30" y el parser solo
  // leía el "3" → agendaba 3:00 en vez de 3:30.
  const colonFmt = t.match(/\b(\d{1,2})[:.,h](\d{2})\s*(am|pm|a\.m\.|p\.m\.)?\b/);
  if (colonFmt) {
    let h = parseInt(colonFmt[1]);
    const m = colonFmt[2];
    const period = colonFmt[3];
    if (period && /pm|p\.m\./.test(period) && h < 12) h += 12;
    if (period && /am|a\.m\./.test(period) && h === 12) h = 0;
    // Sin indicador: horas < 7 asumimos PM (nadie agenda a las 4:30am en una
    // barbería). Misma heurística que la rama de número desnudo más abajo —
    // sin esto "4:30" quedaba 04:30 AM y la cita se rechazaba por "fuera del horario".
    if (!period && h > 0 && h < 7) h += 12;
    return `${String(h).padStart(2,'0')}:${m}`;
  }

  // Tiempo relativo: "en media hora", "dentro de una hora", "en dos horas y media"
  // Solo con prefijo explícito (evita confundir "las 16 horas" con relativo)
  const NUM_ES: Record<string, number> = {
    'un': 1, 'una': 1, 'dos': 2, 'tres': 3, 'cuatro': 4,
    'cinco': 5, 'seis': 6, 'siete': 7, 'ocho': 8, 'nueve': 9, 'diez': 10,
  };
  const relRe = /(?:dentro\s+de|en)\s+(media\s+hora|hora(?:\s+y\s+(?:media|cuarto))?|(?:un[a]?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\d+)\s+hora(?:s)?(?:\s+y\s+(?:media|cuarto))?)/;
  const relM = t.match(relRe);
  if (relM) {
    const phrase = relM[1].trim();
    let offsetMin = 0;
    if (/^media\s+hora/.test(phrase)) {
      offsetMin = 30;
    } else if (/^hora\s+y\s+media/.test(phrase)) {
      offsetMin = 90;
    } else if (/^hora\s+y\s+cuarto/.test(phrase)) {
      offsetMin = 75;
    } else if (/^hora$/.test(phrase)) {
      offsetMin = 60;
    } else {
      const numM = phrase.match(/^(un[a]?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\d+)/);
      const numStr = numM?.[1] ?? '1';
      const n = parseInt(numStr) || NUM_ES[numStr] || 1;
      offsetMin = n * 60;
      if (/y\s+media/.test(phrase)) offsetMin += 30;
      if (/y\s+cuarto/.test(phrase)) offsetMin += 15;
    }
    // Colombia es UTC-5 (sin horario de verano)
    const coDate = new Date(Date.now() - 5 * 60 * 60 * 1000 + offsetMin * 60_000);
    return `${String(coDate.getUTCHours()).padStart(2,'0')}:${String(coDate.getUTCMinutes()).padStart(2,'0')}`;
  }

  // Primero intenta con prefijo explícito ("a las"/"las") — permite omitir am/pm
  // Luego intenta con marcador de periodo explícito (am/pm/mañana/tarde) — permite omitir prefijo
  // Nunca captura un número desnudo sin contexto: evita confundir "11" de "jueves 11 a las 8 am"
  // La frase de minutos también acepta números deletreados ("y 22", "y 50") — antes solo
  // reconocía "y media/cuarto/tres cuartos" y descartaba cualquier otro número en silencio,
  // agendando a la hora en punto (ej: "a las 3 y 50" terminaba agendado a las 3:00pm).
  const MINUTOS_FRASE = 'y\\s+(?:media|cuarto|tres\\s+cuartos?|\\d{1,2})';
  // Jerga colombiana para introducir una hora aproximada: "a eso de las 3", "como a las 3",
  // "por ahí a las 3", "más o menos a las 3" — todas equivalen a "a las 3". Todas exigen
  // la palabra "las" explícita para no confundir con otros usos de "como"/"tipo"/"por ahí".
  const PREFIJO_HORA = 'a\\s+eso\\s+de\\s+las?\\s+|como\\s+a\\s+las?\\s+|por\\s+ah[ií]\\s+a\\s+las?\\s+|m[aá]s\\s+o\\s+menos\\s+a\\s+las?\\s+|a\\s+las?\\s+|las?\\s+';
  const prefixFmt = t.match(new RegExp(`\\b(?:${PREFIJO_HORA})(\\d{1,2})(?!\\s*(?:días?|semanas?|meses?|años?))\\s*(?:${MINUTOS_FRASE})?\\s*(am|pm|a\\.m\\.|p\\.m\\.|(?:de|en|por)\\s+la\\s+(?:ma[ñn]ana|tarde|noche))?\\b`));
  const periodFmt = t.match(new RegExp(`\\b(\\d{1,2})(?!\\s*(?:días?|semanas?|meses?|años?))\\s*(?:${MINUTOS_FRASE})?\\s*(am|pm|a\\.m\\.|p\\.m\\.|(?:de|en|por)\\s+la\\s+(?:ma[ñn]ana|tarde|noche))\\b`));
  const simpleFmt = prefixFmt ?? periodFmt;
  if (simpleFmt) {
    let h = parseInt(simpleFmt[1]);
    if (h > 23) return null; // no es una hora
    const minutosTxt = simpleFmt[0].toLowerCase();
    let m = 0;
    if (/y\s+media/.test(minutosTxt)) m = 30;
    else if (/y\s+cuarto/.test(minutosTxt)) m = 15;
    else if (/tres\s+cuartos?/.test(minutosTxt)) m = 45;
    else {
      const minNum = minutosTxt.match(/y\s+(\d{1,2})\b/);
      if (minNum) m = Math.min(parseInt(minNum[1], 10), 59);
    }
    const period = simpleFmt[2] ?? '';
    // Inferir AM/PM
    if (/pm|p\.m\.|tarde|noche/.test(period) && h < 12) h += 12;
    if (/am|a\.m\.|ma[ñn]ana/.test(period) && h === 12) h = 0;
    // Sin indicador: horas < 7 asumimos PM (nadie agenda a las 3am)
    if (!period && h > 0 && h < 7) h += 12;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }

  return null;
}

// ─── Parser de cantidad de personas (acompañantes) ───────────────────────────
// Heurística de respaldo: el LLM es la fuente primaria de partySize; esto cubre
// los casos en que devuelve null. Devuelve null si no detecta un grupo.
export function parsePartySize(text: string): number | null {
  const t = (text || '').toLowerCase();
  const WORD: Record<string, number> = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 };

  // "somos 3", "venimos 2", "vamos 4", "para 3"
  const digitVerb = t.match(/\b(?:somos|venimos|ser[ií]amos|vamos|llevamos|para)\s+(\d{1,2})\b/);
  if (digitVerb) { const n = parseInt(digitVerb[1], 10); if (n >= 1 && n <= 20) return n; }

  // "3 personas", "2 cupos", "4 turnos"
  const digitNoun = t.match(/\b(\d{1,2})\s+(?:personas?|cupos?|turnos?|citas?)\b/);
  if (digitNoun) { const n = parseInt(digitNoun[1], 10); if (n >= 1 && n <= 20) return n; }

  // en palabras: "somos tres", "venimos dos", "tres personas"
  const wordVerb = t.match(/\b(?:somos|venimos|ser[ií]amos|vamos)\s+(un|una|uno|dos|tres|cuatro|cinco|seis)\b/);
  if (wordVerb) return WORD[wordVerb[1]];
  const wordNoun = t.match(/\b(dos|tres|cuatro|cinco|seis)\s+(?:personas?|cupos?|turnos?|citas?)\b/);
  if (wordNoun) return WORD[wordNoun[1]];

  // acompañante implícito: "yo y mi hijo", "con mi esposa", "y mi novia" → 2
  if (/\b(?:yo\s+y\s+mi|con\s+mi|y\s+mi)\s+(hij[oa]|espos[oa]|novi[oa]|amig[oa]|herman[oa]|pap[aá]|mam[aá]|pareja|cu[ñn]ad[oa]|primo|prima)\b/.test(t)) {
    return 2;
  }
  return null;
}

// ─── Parser de nombre robusto ─────────────────────────────────────────────────
function parseNombreCliente(text: string, conversationLines: string[] = []): string | null {
  const allText = [text, ...conversationLines].join('\n');
  const lines = allText.split(/\n/).map(l => l.trim()).filter(Boolean);

  // Palabras comunes del español que NUNCA forman parte de un nombre propio.
  // Si cualquier palabra del mensaje está en este set, el mensaje no es un nombre.
  const NON_NAME_WORDS = new Set([
    // Saludos
    'hola','hey','ei','ey','buen','buenas','buenos','saludos','bueno',
    // Despedidas / cortesía
    'gracias','favor','disculpa','disculpe','perdón','permiso','adiós','hasta',
    // Tiempo
    'mañana','hoy','tarde','noche','madrugada','ahora','ahorita','después','antes',
    'temprano','pronto','ya','rato','momento','día','dias','semana','semanas','mes','año',
    'lunes','martes','miercoles','miércoles','jueves','viernes','sabado','sábado','domingo',
    'enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre',
    'octubre','noviembre','diciembre',
    // Verbos de intención / acción frecuentes
    'quiero','deseo','necesito','quisiera','puedo','tengo','tienen','tiene',
    'hay','están','quisieras','saber','conocer','preguntar','agendar','agenda',
    'agéndame','agendame','reserva','reservar','programar','consultar','ayudar',
    'dime','dame','muestrame','muéstrame','explica','explícame','informar',
    // Partículas / conectores frecuentes al inicio de mensajes
    'para','por','con','sin','una','unos','unas','los','las','del','sobre',
    'entre','desde','hasta','durante','también','tampoco','solo','sólo',
    'en','la','el','lo','un','uno','y','o','de','al','se','te','le','su',
    'me','mi','mis','sus','tu','tus','nos','les',
    'que','qué','como','cómo','cuando','cuándo','donde','dónde',
    'cuanto','cuánto','cuantos','cuántos','cual','cuál','cuales','cuáles',
    // Adjetivos / pronombres frecuentes que NO son nombres
    'nuevo','nueva','nuevos','nuevas','soy','eres','es','era','estoy','estas',
    'esta','estás','están','somos','viejo','vieja','joven','pequeño','grande',
    // Respuestas / confirmaciones
    'si','sí','no','ok','okey','bien','claro','perfecto','listo','dale','va',
    'entendido','exacto','correcto','genial','super','súper',
    // Servicios y términos del negocio
    'cita','citas','corte','barba','manicure','pedicure','servicio','servicios',
    'precio','precios','costo','costos','disponible','disponibilidad','disponibles',
    'info','información','informacion','ayuda','atención','atencion','contacto',
    'quisiera','trabajo','trabajar','pago','pagar','cobrar','cobro',
    // Palabras de consulta
    'tienen','ofrecen','hacen','atienden','abren','cierran','trabajan',
    'oye','oiga','mira','mire','ve','vea',
  ]);

  const isNotName = (line: string): boolean => {
    // Es dirección
    if (ADDRESS_RE.test(line)) return true;
    // Es teléfono (7+ dígitos)
    if (/^[\d\s+\-()\/.]{7,}$/.test(line)) return true;
    // Es hora
    if (/\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)\b/i.test(line)) return true;
    // Es confirmación
    if (CONFIRMATION_RE.test(line)) return true;
    // Es solo números y símbolos
    if (/^[\d\W]+$/.test(line)) return true;
    // Alguna palabra de la línea está en el set de palabras no-nombre
    const words = line.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/);
    if (words.some(w => NON_NAME_WORDS.has(w.replace(/[^a-z]/g, '')))) return true;
    // Más de 5 palabras → probablemente una frase, no un nombre
    if (line.trim().split(/\s+/).length > 5) return true;
    return false;
  };

  // Nombre de una sola palabra capitalizada (ej: "Nicolas", "Carmen") — aceptar si el
  // mensaje actual es SOLO esa palabra (el cliente respondió únicamente su nombre)
  const singleWordMsg = text.trim();
  const singleWordMatch = singleWordMsg.match(/^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{1,})\s*$/);
  if (singleWordMatch && !isNotName(singleWordMsg)) {
    return singleWordMatch[1].charAt(0).toUpperCase() + singleWordMatch[1].slice(1).toLowerCase();
  }

  // Patrones explícitos primero: "me llamo X", "soy X", "mi nombre es X"
  // IMPORTANTE: usar [ \t]+ (no \s+) para no cruzar saltos de línea entre mensajes distintos
  const explicitPatterns = [
    /(?:me\s+llamo|mi\s+nombre\s+es|nombre[:\s]+|llámame|llamamé)[ \t]+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:[ \t]+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i,
    /(?:me\s+llamo|mi\s+nombre\s+es|nombre[:\s]+)[ \t]+([a-záéíóúñ]+(?:[ \t]+[a-záéíóúñ]+)*)/i,
    /\bsoy[ \t]+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+[ \t]+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:[ \t]+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i,
    /\bsoy[ \t]+([a-záéíóúñ]{3,}[ \t]+[a-záéíóúñ]{3,}(?:[ \t]+[a-záéíóúñ]{3,})*)/i,
  ];

  for (const pattern of explicitPatterns) {
    const match = allText.match(pattern);
    if (match) {
      const nombre = match[1].trim();
      const words = nombre.split(/[ \t]+/);
      if (words.length >= 2 && words.length <= 6) {
        const cleanWords = words.map(w => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, ''));
        // Rechazar si alguna palabra capturada está en el set de no-nombres
        if (cleanWords.some(w => NON_NAME_WORDS.has(w))) continue;
        return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      }
    }
  }

  // Buscar dos palabras capitalizadas (proper case)
  for (const line of lines) {
    if (isNotName(line)) continue;
    const match = line.match(/^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{1,}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{1,}){1,5})\s*$/);
    if (match) return match[1].trim();
  }

  // Buscar en minúsculas: "paula culma"
  for (const line of lines) {
    if (isNotName(line)) continue;
    const match = line.match(/^([a-záéíóúñ]{2,}(?:\s+[a-záéíóúñ]{2,}){1,5})\s*$/i);
    if (match && match[1].split(' ').length >= 2) {
      return match[1].trim().split(' ')
        .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
    }
  }

  // Buscar en mayúsculas: "PAULA CULMA"
  for (const line of lines) {
    if (isNotName(line)) continue;
    const match = line.match(/^([A-ZÁÉÍÓÚÑ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ]{2,}){1,5})\s*$/);
    if (match) {
      return match[1].split(' ')
        .map((w: string) => w.charAt(0) + w.slice(1).toLowerCase())
        .join(' ');
    }
  }

  return null;
}

// Detecta cuando el extractor LLM devolvió una frase-placeholder en vez de un
// nombre real (ej: "Cliente no registrado", "el cliente no mencionó su nombre").
// Estas frases pasan los regex de "dos palabras capitalizadas" y terminan
// guardándose como si fueran el nombre del cliente.
const PLACEHOLDER_NAME_RE = /no\s+(registrad|proporcion|mencion|dij|especific|indic|dio|tiene)|sin\s+nombre|nombre\s+(desconocido|no\s)|cliente\s+(an[oó]nimo|desconocido)|desconocid/i;

function isPlaceholderName(name: string | null | undefined): boolean {
  if (!name) return true;
  return PLACEHOLDER_NAME_RE.test(name);
}

// ─── Merge robusto de datos de cita ──────────────────────────────────────────
function mergeAppt(
  base: AppointmentExtractionResult,
  update: AppointmentExtractionResult,
): AppointmentExtractionResult {
  return {
    ...base,
    ...update,
    // Preservar valores no-null del base si el update devolvió null
    serviceId:        update.serviceId        ?? base.serviceId,
    serviceVariantId: update.serviceVariantId ?? base.serviceVariantId,
    type:             update.type             || base.type,
    scheduledDate:    update.scheduledDate    ?? base.scheduledDate,
    scheduledTime:    update.scheduledTime    ?? base.scheduledTime,
    durationMinutes:  update.durationMinutes  ?? base.durationMinutes,
    agreedPrice:      update.agreedPrice      ?? base.agreedPrice,
    description:      update.description      ?? base.description,
    address:          update.address          ?? base.address,
    notes:            update.notes            ?? base.notes,
    customerName:     update.customerName     ?? base.customerName,
    customerCedula:   update.customerCedula   ?? base.customerCedula,
    staffId:          update.staffId          ?? base.staffId,
    staffName:        update.staffName        ?? base.staffName,
    complete:         update.complete,
    reason:           update.reason,
  };
}

const PRICE_TYPE_LABELS: Record<string, string> = {
  FIXED:    'Precio fijo',
  PER_HOUR: 'por hora',
  PER_DAY:  'por día',
  PER_UNIT: 'por unidad',
  VARIABLE: 'Precio variable — cotización',
};

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface ExtractedItem {
  itemType: 'producto' | 'servicio';
  productId: string | null;
  serviceId: string | null;
  variantId: string | null;
  serviceVariantId: string | null;
  quantity: number;
  description?: string | null;
}

interface ExtractionResult {
  complete: boolean;
  items: ExtractedItem[];
  deliveryAddress: string | null;
  notes: string | null;
  reason: string;
  customerName: string | null;
  customerCedula: string | null;
}

interface AppointmentExtractionResult {
  complete: boolean;
  serviceId: string | null;
  serviceVariantId: string | null;
  type: string;
  scheduledDate: string | null;
  scheduledTime: string | null;
  durationMinutes: number | null;
  agreedPrice: number | null;
  description: string | null;
  address: string | null;
  notes: string | null;
  reason: string;
  customerName: string | null;
  customerCedula: string | null;
  staffId: string | null;
  staffName: string | null;
  partySize?: number;
}

interface StoreSettings {
  paymentMethods?: Array<{ label: string; value: string }>;
  paymentNote?: string;
  orderClosingMessage?: string;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  private readonly configCache           = new Map<string, CacheEntry<any>>();
  private readonly catalogCache          = new Map<string, CacheEntry<{ products: any[]; services: any[] }>>();
  private readonly staffCache = new Map<string, { data: { staffId: string; name: string; schedule: any }[]; setAt: number }>();
  private readonly orderInProgress        = new Set<string>();
  private readonly pendingExtractions     = new Map<string, ExtractionResult>();
  private readonly appointmentInProgress  = new Set<string>();
  private readonly pendingAppointments    = new Map<string, AppointmentExtractionResult>();
  // conversationId → appointmentId: client said "quiero reprogramar" but didn't give new date/time yet
  private readonly pendingReschedules     = new Map<string, string>();
  // Citas ya creadas en esta conversación — se inyectan en el prompt del extractor
  // para que el LLM no las vuelva a extraer cuando el cliente pide una segunda cita.
  private readonly conversationCreatedAppts = new Map<string, Array<{scheduledDate: string; scheduledTime: string; type: string}>>();
  private readonly pendingConfirmTimers = new Map<string, NodeJS.Timeout>();
  private sendFn: ((storeId: string, phone: string, message: string) => Promise<void>) | null = null;

  constructor(
    private readonly prisma:        PrismaService,
    private readonly notifications: NotificationsService,
    private readonly sync:          SyncService,
  ) {}

  // ─── Recordatorio de confirmación de cita ────────────────────────────────────

  setSendFn(fn: (storeId: string, phone: string, message: string) => Promise<void>): void {
    this.sendFn = fn;
  }

  private scheduleConfirmReminder(conversationId: string, storeId: string, phone: string): void {
    const existing = this.pendingConfirmTimers.get(conversationId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this.pendingConfirmTimers.delete(conversationId);
      if (!this.pendingAppointments.has(conversationId) || !this.sendFn) return;

      const reminder = '¿Confirmamos tu cita? Responde *Sí* para agendarla o *No* si prefieres otro horario. 😊';
      try {
        await this.prisma.message.create({
          data: { conversationId, storeId, content: reminder, type: 'text', sender: 'store', isAiResponse: true },
        });
        await this.sendFn(storeId, phone, reminder);
        this.logger.log(`[Cita] 🔔 Recordatorio enviado a ${phone} (conv ${conversationId.slice(-8)})`);
      } catch (err: any) {
        this.logger.warn(`[Cita] No se pudo enviar recordatorio: ${err.message}`);
      }
    }, CONFIRM_REMINDER_MS);

    this.pendingConfirmTimers.set(conversationId, timer);
  }

  private cancelConfirmReminder(conversationId: string): void {
    const t = this.pendingConfirmTimers.get(conversationId);
    if (t) {
      clearTimeout(t);
      this.pendingConfirmTimers.delete(conversationId);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────

  private getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
    return entry.value;
  }

  private setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  invalidateCatalogCache(storeId: string): void {
    this.catalogCache.delete(storeId);
  }

  private parseSettings(raw: any): StoreSettings {
    if (!raw) return {};
    try {
      if (typeof raw === 'string') return JSON.parse(raw);
      if (typeof raw === 'object') return raw as StoreSettings;
    } catch {
      this.logger.warn('No se pudo parsear AIConfiguration.settings');
    }
    return {};
  }

  private buildPaymentBlock(settings: StoreSettings): string | null {
    const methods = settings.paymentMethods;
    if (!methods?.length) return null;
    const lines = methods.map(m => `• ${m.label}: ${m.value}`).join('\n');
    const note   = settings.paymentNote
      ? `\n\n${settings.paymentNote}`
      : '\n\nCuando realices el pago, compártenos el comprobante por aquí.';
    return `💳 Información de pago:\n${lines}${note}`;
  }

  private resolveServicePrice(service: any, variant?: any): number {
    if (variant?.priceOverride != null) return Number(variant.priceOverride);
    const base = service.basePrice ? Number(service.basePrice) : 0;
    if (variant?.priceModifier != null) {
      return Number((base * (1 + Number(variant.priceModifier) / 100)).toFixed(2));
    }
    return base;
  }

  private buildServicePriceLabel(service: any): string {
    if (service.priceType === 'VARIABLE') {
      const rango = service.minPrice && service.maxPrice
        ? ` (rango: $${Number(service.minPrice).toLocaleString('es-CO')} – $${Number(service.maxPrice).toLocaleString('es-CO')})`
        : '';
      return `Cotización${rango}`;
    }
    if (!service.basePrice) return 'Precio a confirmar';
    const unidad = service.unitLabel ? `/${service.unitLabel}` : '';
    const label  = PRICE_TYPE_LABELS[service.priceType] ?? '';
    return `$${Number(service.basePrice).toLocaleString('es-CO')}${unidad}${label !== 'Precio fijo' ? ` (${label})` : ''}`;
  }

  private extractMinAdvanceHours(systemPrompt: string): number {
    const match = MIN_ADVANCE_RE.exec(systemPrompt);
    if (match) return parseInt(match[1]);
    return 2;
  }

  private async tryDetectPaymentProof(
    storeId: string,
    customerId: string,
    userMessage: string,
  ): Promise<string | null> {
    if (!PAYMENT_PROOF_RE.test(userMessage)) return null;

    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const appt = await this.prisma.appointment.findFirst({
      where: {
        storeId,
        customerId,
        status:    { in: ['CONFIRMED', 'PENDING'] },
        createdAt: { gte: cutoff },
      },
      orderBy: { scheduledAt: 'asc' },
      include: {
        customer:       { select: { name: true, phone: true } },
        service:        { select: { name: true } },
        serviceVariant: { select: { name: true } },
      },
    });
    if (!appt) return null;

    const excerpt = userMessage.slice(0, 200);
    await this.prisma.appointment.update({
      where: { appointmentId: appt.appointmentId },
      data:  { paymentProofUrl: excerpt },
    });

    this.notifications.notifyPaymentProofDetected(appt as any, excerpt).catch(() => {});
    return 'Recibido ✅ Tu comprobante fue enviado al admin para verificación. Te confirmaremos en breve.';
  }

  private async tryHandleCancelOrReschedule(
    storeId: string,
    customerId: string,
    conversationId: string,
    userMessage: string,
    systemPrompt: string,
    activeStaff: Array<{ staffId: string; name: string; schedule?: any }> = [],
  ): Promise<string | null> {
    if (!CANCEL_RESCHEDULE_RE.test(userMessage)) return null;

    // ── Prevenir bucle: si ya hay una acción pendiente registrada, informar y no repetir ──
    const alreadyPending = await this.prisma.appointment.findFirst({
      where: {
        storeId,
        customerId,
        status:        { in: ['PENDING', 'CONFIRMED'] },
        pendingAction: { in: ['CANCEL_REQUESTED', 'RESCHEDULE_REQUESTED'] },
      },
    });
    if (alreadyPending) {
      const tipo = alreadyPending.pendingAction === 'CANCEL_REQUESTED' ? 'cancelación' : 'reprogramación';
      return `Tu solicitud de ${tipo} ya fue registrada y está siendo procesada por el equipo ✅ Te avisaremos en cuanto tengamos respuesta.`;
    }

    const appt = await this.prisma.appointment.findFirst({
      where: {
        storeId,
        customerId,
        status:        { in: ['PENDING', 'CONFIRMED'] },
        pendingAction: null,
      },
      orderBy: { scheduledAt: 'asc' },
      include: {
        customer:       { select: { name: true, phone: true } },
        service:        { select: { name: true } },
        serviceVariant: { select: { name: true } },
      },
    });
    if (!appt) return null;

    const minHours   = this.extractMinAdvanceHours(systemPrompt);
    const hoursUntil = (appt.scheduledAt.getTime() - Date.now()) / (1000 * 60 * 60);
    if (hoursUntil < minHours) {
      return `Lo sentimos, solo podemos procesar cambios con al menos ${minHours} horas de anticipación. Contacta directamente a la barbería.`;
    }

    const isReschedule = /reprogramar|cambiar la cita|mover|otro d[ií]a|otra hora|posponer|aplazar/i.test(userMessage);

    // ── Reprogramación directa si el cliente ya dio la nueva fecha y hora ──────
    if (isReschedule) {
      const newDate = parseFechaEspanol(userMessage);
      const newTime = parseHoraEspanol(userMessage);

      if (newDate && newTime) {
        const newScheduledAt = new Date(`${newDate}T${newTime}:00-05:00`);

        // Validar que el nuevo horario esté dentro del turno del barbero asignado
        if (appt.staffId) {
          const staffMember = activeStaff.find(s => s.staffId === appt.staffId);
          if (staffMember?.schedule) {
            const dayKey = coDayKey(newScheduledAt);
            const daySched = (staffMember.schedule as any)[dayKey];
            if (!daySched?.isOpen) {
              return `Lo siento, ${staffMember.name} no trabaja ese día. ¿Te funciona otro día de la semana?`;
            }
          }
          // Verificar conflicto con otras citas del barbero
          const slotEnd = new Date(newScheduledAt.getTime() + 30 * 60_000);
          const conflict = await this.prisma.appointment.findFirst({
            where: {
              appointmentId: { not: appt.appointmentId },
              staffId:       appt.staffId,
              status:        { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
              AND: [
                { scheduledAt: { lt: slotEnd } },
                { OR: [
                  { endsAt: { gt: newScheduledAt } },
                  { endsAt: null, scheduledAt: { gt: new Date(newScheduledAt.getTime() - 30 * 60_000) } },
                ]},
              ],
            },
          });
          if (conflict) {
            const staffInfo = activeStaff.find(s => s.staffId === appt.staffId);
            return `Ese horario ya está ocupado para ${staffInfo?.name ?? 'el profesional'}. ¿Te funciona otra hora o fecha?`;
          }
        }

        // Reagendar directamente
        await this.prisma.$transaction(async (tx) => {
          await tx.appointment.update({
            where: { appointmentId: appt.appointmentId },
            data: {
              scheduledAt:       newScheduledAt,
              status:            'PENDING',
              pendingAction:     null,
              pendingActionAt:   null,
              pendingActionData: Prisma.JsonNull,
            },
          });
          await tx.appointmentTimeline.create({
            data: {
              appointmentId: appt.appointmentId,
              action:        'RESCHEDULED',
              newStatus:     'PENDING',
              note:          `Reprogramado por el cliente vía WhatsApp → ${newDate} ${newTime}`,
              isPublic:      true,
              performedById: null,
            },
          });
        });
        this.pendingReschedules.delete(conversationId);

        // Notificar al admin del cambio
        this.notifications.notifyPendingAction(
          { ...appt, pendingAction: 'RESCHEDULE_REQUESTED', pendingActionData: { newDate, newTime } } as any,
          'reschedule',
        ).catch(() => {});

        const fechaFormateada = newScheduledAt.toLocaleDateString('es-CO', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Bogota',
        });
        const horaFormateada = newScheduledAt.toLocaleTimeString('es-CO', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
        });

        return `✅ ¡Tu cita fue reprogramada!\n\n📆 *Nueva fecha:* ${fechaFormateada}\n🕐 *Nueva hora:* ${horaFormateada}\n\nUn asesor confirmará el cambio desde el panel. ¡Gracias! 😊`;
      }

      // Sin fecha/hora aún — guardar estado y preguntar al cliente
      this.pendingReschedules.set(conversationId, appt.appointmentId);
      setTimeout(() => this.pendingReschedules.delete(conversationId), 10 * 60_000);

      const fechaActual = appt.scheduledAt.toLocaleDateString('es-CO', {
        weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Bogota',
      });
      const horaActual = appt.scheduledAt.toLocaleTimeString('es-CO', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
      });
      return `Claro, puedo reprogramar tu cita del ${fechaActual} a las ${horaActual}. ¿Para qué fecha y hora te gustaría cambiarla?`;
    }

    // ── Cancelación — requiere aprobación del admin ───────────────────────────
    await this.prisma.appointment.update({
      where: { appointmentId: appt.appointmentId },
      data: {
        pendingAction:       'CANCEL_REQUESTED',
        pendingActionAt:     new Date(),
        pendingActionData:   Prisma.JsonNull,
        pendingActionReason: userMessage.slice(0, 500),
      },
    });
    this.notifications.notifyPendingAction(appt as any, 'cancel').catch(() => {});

    return '🗑 Tu solicitud de *cancelación* fue enviada al equipo. Un asesor la procesará y te confirmará en breve ✅';
  }

  // ── Segundo paso de reprogramación: cliente ya dio la nueva fecha/hora ──────
  private async tryCompleteReschedule(
    appointmentId: string,
    conversationId: string,
    userMessage: string,
    activeStaff: Array<{ staffId: string; name: string; schedule?: any }>,
  ): Promise<string | null> {
    const newDate = parseFechaEspanol(userMessage);
    const newTime = parseHoraEspanol(userMessage);
    if (!newDate || !newTime) return null;

    const appt = await this.prisma.appointment.findFirst({
      where: { appointmentId, status: { in: ['PENDING', 'CONFIRMED'] } },
      include: { customer: { select: { name: true, phone: true } }, service: { select: { name: true } } },
    });
    if (!appt) {
      // La cita ya no existe (fue cancelada/procesada mientras esperábamos la nueva
      // fecha) — el cliente SÍ dio una fecha+hora nuevas (pasó el check de arriba),
      // así que es una señal de "confirmación" real. Devolver un mensaje honesto en
      // vez de null evita que el AI libre asuma "listo, quedó reprogramada" sobre
      // una cita que ya no está activa.
      this.pendingReschedules.delete(conversationId);
      return 'Esa cita ya no está activa (fue cancelada o ya se procesó). Si quieres agendar una nueva, cuéntame qué servicio, día y hora te gustaría y con gusto te ayudo. 🙏';
    }

    const newScheduledAt = new Date(`${newDate}T${newTime}:00-05:00`);

    if (appt.staffId) {
      const staffMember = activeStaff.find(s => s.staffId === appt.staffId);
      if (staffMember?.schedule) {
        const dayKey = coDayKey(newScheduledAt);
        if (!(staffMember.schedule as any)[dayKey]?.isOpen) {
          return `Lo siento, ${staffMember.name} no trabaja ese día. ¿Te funciona otro día?`;
        }
      }
      const slotEnd = new Date(newScheduledAt.getTime() + 30 * 60_000);
      const conflict = await this.prisma.appointment.findFirst({
        where: {
          appointmentId: { not: appt.appointmentId },
          staffId:       appt.staffId,
          status:        { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
          AND: [
            { scheduledAt: { lt: slotEnd } },
            { OR: [
              { endsAt: { gt: newScheduledAt } },
              { endsAt: null, scheduledAt: { gt: new Date(newScheduledAt.getTime() - 30 * 60_000) } },
            ]},
          ],
        },
      });
      if (conflict) {
        const staffInfo = activeStaff.find(s => s.staffId === appt.staffId);
        return `Ese horario ya está ocupado para ${staffInfo?.name ?? 'el profesional'}. ¿Te funciona otra hora?`;
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.appointment.update({
        where: { appointmentId },
        data: {
          scheduledAt:       newScheduledAt,
          status:            'PENDING',
          pendingAction:     null,
          pendingActionAt:   null,
          pendingActionData: Prisma.JsonNull,
        },
      });
      await tx.appointmentTimeline.create({
        data: {
          appointmentId,
          action:        'RESCHEDULED',
          newStatus:     'PENDING',
          note:          `Reprogramado por el cliente vía WhatsApp → ${newDate} ${newTime}`,
          isPublic:      true,
          performedById: null,
        },
      });
    });

    this.pendingReschedules.delete(conversationId);
    this.notifications.notifyPendingAction(
      { ...appt, pendingAction: 'RESCHEDULE_REQUESTED', pendingActionData: { newDate, newTime } } as any,
      'reschedule',
    ).catch(() => {});

    const fechaFormateada = newScheduledAt.toLocaleDateString('es-CO', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Bogota',
    });
    const horaFormateada = newScheduledAt.toLocaleTimeString('es-CO', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
    });

    return `✅ ¡Tu cita fue reprogramada!\n\n📆 *Nueva fecha:* ${fechaFormateada}\n🕐 *Nueva hora:* ${horaFormateada}\n\nUn asesor confirmará el cambio. ¡Gracias! 😊`;
  }

  // Inserta UNA cita de la IA: guard final de conflicto dentro de la transacción
  // (anti-doble-booking) + creación + timeline. Reutilizado por el path single y el
  // de grupo (acompañantes). `descriptionOverride` permite marcar "Persona k de N".
  private async insertAiAppointment(
    storeId: string,
    customerId: string,
    resolvedStaffId: string | null,
    scheduledAt: Date,
    endsAt: Date | null,
    durationMinutes: number | null,
    extracted: any,
    descriptionOverride?: string | null,
  ): Promise<any> {
    return this.prisma.$transaction(async (tx) => {
      // Guard final dentro de la transacción para evitar doble-booking concurrente
      if (resolvedStaffId) {
        const slotEnd = endsAt ?? new Date(scheduledAt.getTime() + 30 * 60_000);
        const conflict = await tx.appointment.findFirst({
          where: {
            staffId: resolvedStaffId,
            status: { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
            AND: [
              { scheduledAt: { lt: slotEnd } },
              {
                OR: [
                  { endsAt: { gt: scheduledAt } },
                  { endsAt: null, scheduledAt: { gt: new Date(scheduledAt.getTime() - 30 * 60_000) } },
                ],
              },
            ],
          },
        });
        if (conflict) throw new Error('Conflicto de horario detectado');
      }

      const appt = await tx.appointment.create({
        data: {
          storeId,
          customerId,
          serviceId:        extracted.serviceId        ?? null,
          serviceVariantId: extracted.serviceVariantId ?? null,
          type:             extracted.type             ?? 'cita',
          status:           'PENDING',
          priority:         'NORMAL',
          source:           'AI',
          scheduledAt,
          endsAt,
          durationMinutes,
          description:  descriptionOverride !== undefined ? descriptionOverride : (extracted.description ?? null),
          address:      extracted.address     ?? null,
          notes:        extracted.notes       ?? null,
          agreedPrice:  extracted.agreedPrice ?? null,
          staffId:      resolvedStaffId,
        },
      });
      await tx.appointmentTimeline.create({
        data: {
          appointmentId: appt.appointmentId,
          action:        'CREATED',
          newStatus:     'PENDING',
          note:          'Cita creada automáticamente por el asistente de WhatsApp',
          isPublic:      true,
          performedById: null,
        },
      });
      return appt;
    });
  }

  // Dada la lista de slots libres de 30 min ("HH:MM") de un profesional ese día,
  // devuelve la hora "HH:MM" del primer bloque donde caben `n` citas de `durationMin`
  // consecutivas, buscando primero desde `fromMin` y, si no hay, en todo el día.
  // Devuelve null si no existe ningún bloque consecutivo de ese tamaño.
  private findConsecutiveBlock(
    freeSlots: string[],
    fromMin: number,
    n: number,
    durationMin: number,
  ): string | null {
    const SLOT = 30;
    const slotsPerPerson = Math.max(1, Math.ceil(durationMin / SLOT));
    const need = slotsPerPerson * n; // # de slots de 30 min requeridos en total
    const freeSet = new Set(
      freeSlots.map(t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; }),
    );
    const fits = (start: number): boolean => {
      for (let i = 0; i < need; i++) {
        if (!freeSet.has(start + i * SLOT)) return false;
      }
      return true;
    };
    const toLabel = (min: number) =>
      `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

    // 1) primero desde la hora pedida en adelante
    const fromHere = [...freeSet].filter(min => min >= fromMin).sort((a, b) => a - b);
    for (const start of fromHere) if (fits(start)) return toLabel(start);

    // 2) si no hay, la ventana consecutiva más cercana del día (cualquier hora)
    const all = [...freeSet].sort((a, b) => a - b);
    for (const start of all) if (fits(start)) return toLabel(start);

    return null;
  }

  private async computeSlotsForAI(
    storeId: string,
    date: Date,
    activeStaff: { staffId: string; name: string; schedule: any }[],
    store: { businessHours: any },
  ): Promise<{ name: string; slots: string[]; occupied: string[] }[]> {
    const tz = 'America/Bogota';
    const dateStr = date.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
    // -05:00 explícito (igual que coNoon/computeSlots de public.service.ts): "T00:00:00"
    // sin offset se interpreta en la zona horaria DEL PROCESO, no en Colombia. En
    // producción el server corre en UTC (sin TZ configurado en render/railway/nixpacks),
    // así que sin el offset este rango — y cada slot calculado más abajo — quedaba
    // corrido 5 horas: la "disponibilidad real" que se le inyecta a la IA marcaba como
    // libres horarios que ya estaban ocupados (y viceversa).
    const startOfDay = new Date(`${dateStr}T00:00:00-05:00`);
    const endOfDay   = new Date(`${dateStr}T23:59:59-05:00`);

    const dayKey = coDayKey(date);

    const results: { name: string; slots: string[]; occupied: string[] }[] = [];

    const members = activeStaff.length > 0
      ? activeStaff
      : [{ staffId: null as any, name: (store as any).name ?? 'Negocio', schedule: null }];

    for (const member of members) {
      const effectiveHours = member.schedule ?? store.businessHours;
      if (!effectiveHours) { results.push({ name: member.name, slots: [], occupied: [] }); continue; }

      const daySchedule = (effectiveHours as any)[dayKey];
      if (!daySchedule?.isOpen) { results.push({ name: member.name, slots: [], occupied: [] }); continue; }

      const whereClause: any = {
        storeId,
        scheduledAt: { gte: startOfDay, lte: endOfDay },
        status: { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
      };
      if (member.staffId) whereClause.staffId = member.staffId;

      const appts = await this.prisma.appointment.findMany({
        where: whereClause,
        select: { scheduledAt: true, endsAt: true },
      });

      const slots: string[] = [];
      const occupiedSlots: string[] = [];
      const SLOT = 30;

      for (const shift of ['shift1', 'shift2'] as const) {
        const s = daySchedule[shift];
        if (!s?.open || !s?.close) continue;
        const [sh, sm] = s.open.split(':').map(Number);
        const [eh, em] = s.close.split(':').map(Number);
        let cur = sh * 60 + sm;
        const end = eh * 60 + em;

        while (cur + SLOT <= end) {
          const slotStart = new Date(`${dateStr}T${String(Math.floor(cur/60)).padStart(2,'0')}:${String(cur%60).padStart(2,'0')}:00-05:00`);
          const slotEnd   = new Date(slotStart.getTime() + SLOT * 60000);

          const occupied = appts.some(a => {
            const aEnd = a.endsAt ?? new Date(a.scheduledAt.getTime() + SLOT * 60000);
            return a.scheduledAt < slotEnd && aEnd > slotStart;
          });

          const label = `${String(Math.floor(cur/60)).padStart(2,'0')}:${String(cur%60).padStart(2,'0')}`;
          if (occupied) {
            occupiedSlots.push(label);
          } else {
            slots.push(label);
          }
          cur += SLOT;
        }
      }

      results.push({ name: member.name, slots, occupied: occupiedSlots });
    }

    return results;
  }

  async generateReply(
    storeId: string,
    userMessage: string,
    conversationId: string,
  ): Promise<string | null> {
    try {
      let config = this.getCached(this.configCache, storeId);
      if (!config) {
        config = await this.prisma.aIConfiguration.findUnique({ where: { storeId } });
        if (!config) {
          this.logger.warn(`No hay AIConfiguration para store: ${storeId}`);
          return null;
        }
        this.setCached(this.configCache, storeId, config, CONFIG_CACHE_TTL_MS);
      }

      let catalog = this.getCached(this.catalogCache, storeId);
      if (!catalog) {
        const [products, services] = await Promise.all([
          this.prisma.product.findMany({
            where:   { storeId, isActive: true },
            include: { variants: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } },
            orderBy: { name: 'asc' },
          }),
          this.prisma.service.findMany({
            where:   { storeId, isActive: true },
            include: { variants: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } },
            orderBy: { name: 'asc' },
          }),
        ]);
        catalog = { products, services };
        this.setCached(this.catalogCache, storeId, catalog, CATALOG_CACHE_TTL_MS);
      }
      const { products, services } = catalog;

      const [conversationRow, orders, appointments, history, store, activeStaff, activeAppt] = await Promise.all([
        this.prisma.conversation.findFirst({
          where:   { conversationId, storeId },
          include: {
            customer: {
              select: {
                customerId: true, name: true, cedula: true, city: true, phone: true,
                lastConversationSummary: true,
              },
            },
          },
        }),
        this.prisma.order.findMany({
          where: { storeId, customer: { conversations: { some: { conversationId } } } },
          include: { orderItems: { include: { product: { select: { name: true, salePrice: true } } } } },
          orderBy: { createdAt: 'desc' },
          take: 5,
        }),
        this.prisma.appointment.findMany({
          where: { storeId, customer: { conversations: { some: { conversationId } } } },
          include: {
            service:        { select: { name: true } },
            serviceVariant: { select: { name: true } },
          },
          orderBy: { scheduledAt: 'asc' },
          take: 5,
        }),
        this.prisma.message.findMany({
          where:   { conversationId },
          orderBy: { createdAt: 'asc' },
          take:    MAX_HISTORY_MESSAGES,
        }),
        this.prisma.store.findUnique({ where: { storeId } }),
        (() => {
          const now = Date.now();
          const cached = this.staffCache.get(storeId);
          if (cached && (now - cached.setAt) < 5 * 60_000) return Promise.resolve(cached.data);
          return this.prisma.staff
            .findMany({
              where:   { storeId, isActive: true },
              orderBy: { createdAt: 'asc' },
              select:  { staffId: true, name: true, schedule: true },
            })
            .then(list => {
              this.staffCache.set(storeId, { data: list, setAt: now });
              return list;
            });
        })(),
        this.prisma.appointment.findFirst({
          where: {
            storeId,
            customer: { conversations: { some: { conversationId } } },
            status:   { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
            // Inicio del día en hora Colombia (no usar setHours local: en prod el
            // proceso corre en UTC y daría medianoche UTC, corrida 5h). Colombia
            // no tiene DST → offset fijo -05:00, consistente con coNoon().
            scheduledAt: { gte: new Date(`${coDateStr()}T00:00:00-05:00`) },
          },
          orderBy: { scheduledAt: 'asc' },
          include: {
            service:        { select: { name: true } },
            serviceVariant: { select: { name: true } },
            staff:          { select: { name: true } },
          },
        }),
      ]);

      if (!conversationRow) {
        this.logger.warn(`Conversación ${conversationId} no pertenece a store ${storeId}`);
        return null;
      }

      const customer   = conversationRow.customer;
      const settings   = this.parseSettings(config.settings);

      // ── Cartridge pool — key rotation cross-provider ────────────────────────
      const allCartridges = buildCartridgeList(config);
      ensurePool(storeId, allCartridges);
      const cartridge  = getNextCartridge(storeId) ?? allCartridges[0];
      const provider   = cartridge.provider;
      const apiKey     = cartridge.apiKey;
      const model      = cartridge.model;
      this.logger.debug(`[Pool] ${storeId} → ${provider}/${model} | ${getPoolStatus(storeId)}`);

      // ── Pago detectado ──────────────────────────────────────────────────────
      const paymentReply = await this.tryDetectPaymentProof(storeId, customer.customerId, userMessage);
      if (paymentReply) return paymentReply;

      // ── Paso 2 de reprogramación: cliente ya dio la nueva fecha/hora ──────────
      const pendingRescheduleApptId = this.pendingReschedules.get(conversationId);
      if (pendingRescheduleApptId) {
        const rescheduleResult = await this.tryCompleteReschedule(
          pendingRescheduleApptId, conversationId, userMessage, activeStaff,
        );
        if (rescheduleResult) return rescheduleResult;

        // Guard anti-alucinación: estamos esperando que el cliente diga la nueva
        // fecha/hora para reprogramar, y su mensaje fue una confirmación ("sí",
        // "dale", "esa está bien"...) SIN una fecha+hora nuevas y claras (si las
        // hubiera traído, tryCompleteReschedule ya habría respondido arriba). El AI
        // libre, viendo en el historial que se ofreció reprogramar, podría inventar
        // "¡listo, quedó reprogramada!" sin que el sistema haya movido nada — mismo
        // patrón de alucinación que con citas y pedidos. Pedimos la fecha y hora
        // exactas en vez de arriesgarnos.
        if (CONFIRMATION_RE.test(userMessage.trim())) {
          this.logger.warn(`[Reprogramación] Confirmación sin fecha/hora clara — pidiendo datos exactos (convId=${conversationId.slice(-8)})`);
          return `Para reprogramar tu cita necesito que me digas el día y la hora exactos a los que la quieres mover (por ejemplo: "el viernes a las 3pm"). ¿Cuál te queda mejor? 🙏`;
        }
      }

      // ── Cancelar / Reprogramar ──────────────────────────────────────────────
      const cancelRescheduleReply = await this.tryHandleCancelOrReschedule(
        storeId, customer.customerId, conversationId, userMessage, config.systemPrompt, activeStaff,
      );
      if (cancelRescheduleReply) return cancelRescheduleReply;

      // ── Guard: el cliente coordina/avisa sobre una cita YA existente ───────────
      // Si tiene una cita activa en BD y su mensaje es de llegada/coordinación
      // (o un "sí" suelto) SIN una nueva fecha/hora concreta, NUNCA dejamos que el
      // extractor/AI libre diga "no tienes cita" o intente re-agendar. Respondemos
      // con la cita real. Fuente de verdad = BD. (Bug real Next Level, 2026-06-17.)
      if (
        activeAppt &&
        !this.appointmentInProgress.has(conversationId) &&
        (ARRIVAL_COORD_RE.test(userMessage) || CONFIRMATION_RE.test(userMessage.trim())) &&
        parseFechaEspanol(userMessage) === null &&
        parseHoraEspanol(userMessage) === null
      ) {
        const f = new Date(activeAppt.scheduledAt).toLocaleDateString('es-CO', {
          weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Bogota',
        });
        const h = new Date(activeAppt.scheduledAt).toLocaleTimeString('es-CO', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
        });
        const svc   = (activeAppt as any).service?.name ? ` de ${(activeAppt as any).service.name}` : '';
        const prof  = (activeAppt as any).staff?.name ? ` con ${(activeAppt as any).staff.name}` : '';
        this.logger.log(`[Cita] Coordinación sobre cita activa (convId=${conversationId.slice(-8)}) → respuesta segura desde BD`);
        return `¡Tranquilo! Tu cita${svc}${prof} sigue en pie para el ${f} a las ${h}. Aquí te esperamos. 😊`;
      }

      const hasCatalog           = products.length > 0 || services.length > 0;
      const hasPurchaseIntent    = PURCHASE_INTENT_RE.test(userMessage);
      const hasAppointmentIntent = APPOINTMENT_INTENT_RE.test(userMessage);
      const hasPendingOrder      = this.pendingExtractions.has(conversationId);
      const hasPendingAppt       = this.pendingAppointments.has(conversationId);

      // Detectar día de semana o confirmación dentro del contexto de agendamiento previo
      const APPT_CONTEXT_RE = /\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|ma[ñn]ana|hoy|las?\s+\d{1,2}(\s*(am|pm))?|\d{1,2}:\d{2}|agend[aeo]|con\s+(luis|carlos))\b/i;
      const recentHistory   = history.slice(-6);
      const prevHadApptCtx  = recentHistory.some(
        (m: any) => m.isAiResponse && /cita|agend|barbero|profesional|confirma|horario/i.test(m.content),
      );
      // Un "sí"/"dale" suelto no matchea APPT_CONTEXT_RE (no menciona día/hora/agend-)
      // ni APPOINTMENT_INTENT_RE — sin esto, la única puerta de entrada al flujo de
      // citas era hasPendingAppt. Si el caché no tenía la conversación (TTL, fallo
      // previo del extractor, etc.), el bloque completo —incluido el guard anti-
      // alucinación de la línea ~1300— se saltaba entero y la IA principal quedaba
      // libre, repitiendo su propia "confirmación" inventada en bucle (incidente
      // real con Duan, 2026-06-07 ~8:14pm: 6 "sí" seguidos sin crear la cita nunca).
      // Fix: si el ÚLTIMO mensaje de la IA pidió explícitamente confirmar una cita
      // y el cliente responde con una confirmación, eso también cuenta como hint —
      // deliberadamente más estrecho que "prevHadApptCtx" (que dispara con solo
      // mencionar "profesional"/"horario", palabras comunes en cualquier charla de
      // barbería) para no añadir llamadas de más al extractor ni falsos positivos.
      const lastAiMsg = [...recentHistory].reverse().find((m: any) => m.isAiResponse);
      const aiAskedApptConfirmation = !!lastAiMsg && /¿\s*(confirmas?|todo\s+(bien|correcto|ok)|es\s+correcto|procedo)\b|te\s+agendar[ée]|qued[oó]\s+(lista|registrada|agendada|confirmada)/i.test(lastAiMsg.content);
      const hasApptContextHint =
        (APPT_CONTEXT_RE.test(userMessage) && prevHadApptCtx) ||
        (CONFIRMATION_RE.test(userMessage.trim()) && aiAskedApptConfirmation);

      // ── Consulta pura de horario → link de reservas ─────────────────────────
      // Solo cuando el cliente pregunta por disponibilidad/horario sin intención
      // activa de agendar: se le manda el link público para que elija él mismo.
      const SCHEDULE_QUERY_RE = /\b(horario[s]?|disponible|disponibilidad|cu[aá]ndo\s+(pueden?|tienen?|atienden?)|qu[eé]\s+hora[s]?|hora[s]?\s+libre[s]?|cu[aá]ndo\s+tienen?|qu[eé]\s+d[ií]as?)\b/i;
      if (
        SCHEDULE_QUERY_RE.test(userMessage) &&
        !hasAppointmentIntent && !hasPendingAppt && !hasApptContextHint &&
        store?.slug
      ) {
        const frontendUrl = (process.env.FRONTEND_URL ?? '').replace(/\/$/, '');
        if (frontendUrl) {
          const publicLink = `${frontendUrl}/cal/${store.slug}`;
          const staffLabelPublic = ((store as any).staffLabel ?? 'profesional').toLowerCase();
          return `Para ver los horarios disponibles y agendar tu cita, entra a nuestro link 📅\n\n${publicLink}\n\nAllí puedes elegir el ${staffLabelPublic}, el servicio y el horario que más te quede. ¡Es muy fácil! 😊`;
        }
      }

      // ── Pre-check horario: día cerrado detectado en el mensaje actual ───────────
      // Si el cliente menciona una fecha y ese día está cerrado, avisar de inmediato
      // antes de llamar al extractor o al LLM principal (evita que el LLM pida
      // servicio/barbero para un día sin disponibilidad).
      if ((hasAppointmentIntent || hasPendingAppt) && store) {
        const earlyDate = extractQueryDate(userMessage, new Date());
        if (earlyDate) {
          const edKey = coDayKey(earlyDate);
          const DAY_NAMES_PRE: Record<string, string> = {
            sun: 'domingos', mon: 'lunes', tue: 'martes', wed: 'miércoles',
            thu: 'jueves', fri: 'viernes', sat: 'sábados',
          };
          let edClosed = false;
          if (activeStaff.length > 0) {
            edClosed = !activeStaff.some(s => (s.schedule as any)?.[edKey]?.isOpen === true);
          } else if (store.businessHours) {
            edClosed = (store.businessHours as any)[edKey]?.isOpen === false;
          }
          if (edClosed) {
            this.logger.warn(`[Pre-check] Día ${edKey} cerrado — bloqueando antes del extractor/LLM`);
            const cur = this.pendingAppointments.get(conversationId);
            if (cur) this.pendingAppointments.set(conversationId, { ...cur, scheduledDate: null, scheduledTime: null, complete: false });
            this.cancelConfirmReminder(conversationId);
            return `Lo siento, no tenemos disponibilidad los ${DAY_NAMES_PRE[edKey] ?? edKey}. ¿Te gustaría agendar para otro día? 😊`;
          }
        }
      }

      // ── Flujo de agendamiento ────────────────────────────────────────────────
      // Solo correr el extractor si hay datos concretos para extraer.
      // Si el mensaje es pura intención sin fecha/hora/confirmación y no hay caché → saltar y dejar que el AI principal pida los datos.
      const messageHasBookingData =
        parseFechaEspanol(userMessage) !== null ||
        parseHoraEspanol(userMessage) !== null ||
        CONFIRMATION_RE.test(userMessage.trim());

      if (
        (hasPendingAppt || hasApptContextHint || (hasAppointmentIntent && messageHasBookingData)) &&
        !this.appointmentInProgress.has(conversationId)
      ) {
        // Extractor usa su propio cartucho del pool (distinto al del main call) para no duplicar carga sobre la misma key
        const extractorC = getNextCartridge(storeId) ?? cartridge;
        const apptResult = await this.tryExtractAndCreateAppointment(
          extractorC.provider, extractorC.apiKey, extractorC.model, history, userMessage,
          customer, storeId, conversationId, services, activeStaff, store,
        );
        if (apptResult.created) {
          const firstMsg = apptResult.message!;
          // Si el mismo mensaje sugiere UNA SEGUNDA cita ("y también para mi hijo a las 12:30")
          // correr el extractor de nuevo — conversationCreatedAppts ya incluye la primera
          // así que el LLM no la re-extrae y busca el slot diferente en el mensaje.
          const MULTI_APPT_HINT_RE = /\b(?:también|otra|y\s+(?:una|otro|para|quiero|agend[ae])|además|aparte|y\s+también)\b/i;
          if (MULTI_APPT_HINT_RE.test(userMessage) && !this.appointmentInProgress.has(conversationId)) {
            const extractorC2 = getNextCartridge(storeId) ?? cartridge;
            const apptResult2 = await this.tryExtractAndCreateAppointment(
              extractorC2.provider, extractorC2.apiKey, extractorC2.model, history, userMessage,
              customer, storeId, conversationId, services, activeStaff, store,
            );
            if (apptResult2.created) return firstMsg + '\n\n' + apptResult2.message!;
            if (apptResult2.message) return firstMsg + '\n\n' + apptResult2.message;
          }
          return firstMsg;
        }
        // Si falló por horario/conflicto hay un mensaje específico — usarlo directamente
        // para evitar que el AI principal genere una confirmación falsa
        if (!apptResult.created && apptResult.message) return apptResult.message;

        // ── Guard anti-alucinación (incidente real en producción, 2026-06-07) ──
        // Un cliente confirmó su cita ("sí") y el AI principal respondió "¡tu cita
        // está lista!" cuando NUNCA se creó (el extractor falló en silencio: timeout,
        // JSON inválido, caché incompleto, rotación de cartuchos bajo carga, etc. —
        // cualquier camino interno que termine en { created:false } sin mensaje).
        // Ante esa combinación EXACTA — el cliente está confirmando una cita que ya
        // se venía conversando, y el sistema no devolvió ni éxito ni un rechazo claro
        // — JAMÁS dejamos que el AI de respuesta libre continúe: podría inventar un
        // "quedaste agendado" que no existe. Mejor pedir reconfirmación honesta.
        if ((hasPendingAppt || hasApptContextHint) && CONFIRMATION_RE.test(userMessage.trim())) {
          this.logger.warn(
            `[Cita] Confirmación sin resultado claro del extractor — devolviendo mensaje seguro anti-alucinación (convId=${conversationId.slice(-8)})`,
          );
          return `Para dejar tu cita bien registrada necesito reconfirmar los datos: ¿qué servicio, con qué profesional y para qué día y hora la quieres? Así no se nos pierde ningún detalle y queda agendada correctamente. 🙏`;
        }
      }

      // ── Flujo de orden ────────────────────────────────────────────────────────
      // El flujo de PEDIDOS (productos con entrega) NUNCA corre cuando la conversación
      // es de CITA — ni por intención de cita en el mensaje, ni por contexto de cita
      // previo, ni por cita en caché. Sin esto, un "Necesito una cita" (donde
      // "necesito" matchea intención de compra) o un "sí/Si Jorge" de confirmación
      // de cita disparaban el extractor de pedidos, que creaba una orden FANTASMA con
      // servicio y dirección INVENTADOS (copiados de los ejemplos de su propio prompt).
      // Incidente real Salón Glamour 2026-06-17.
      const inApptContext = hasAppointmentIntent || hasApptContextHint || hasPendingAppt;
      const shouldTryOrder =
        hasCatalog &&
        history.length >= 2 &&
        !inApptContext &&
        (hasPurchaseIntent || hasPendingOrder) &&
        !this.orderInProgress.has(conversationId);

      if (shouldTryOrder) {
        const orderResult = await this.tryExtractAndCreateOrder(
          provider, apiKey, model, history, userMessage,
          products, services, customer, storeId, conversationId, settings, store,
        );
        if (orderResult.created) return orderResult.message!;
        // Mismo principio que en citas: si hay un mensaje específico (ej. "ese
        // producto no tiene stock"), usarlo directo — nunca dejar que el AI
        // principal improvise sobre el resultado de una compra.
        if (orderResult.message) return orderResult.message;

        // ── Guard anti-alucinación para el flujo de venta de productos/servicios ──
        // Mismo patrón que el de citas (incidente real en producción, 2026-06-07):
        // si el cliente está confirmando un pedido que ya se venía armando y el
        // extractor no devolvió ni creación ni un mensaje claro de rechazo (timeout,
        // JSON inválido, dirección/nombre faltante detectado tarde, etc.), jamás
        // dejamos que el AI de respuesta libre continúe — podría inventar "¡tu
        // pedido quedó registrado!" sin que exista ninguna orden real.
        if (hasPendingOrder && CONFIRMATION_RE.test(userMessage.trim())) {
          this.logger.warn(
            `[Orden] Confirmación sin resultado claro del extractor — devolviendo mensaje seguro anti-alucinación (convId=${conversationId.slice(-8)})`,
          );
          return `Para dejar tu pedido bien registrado necesito reconfirmar: ¿qué productos o servicios quieres, en qué cantidad, y a qué dirección los enviamos? Así no se nos pierde ningún detalle y queda bien registrado. 🙏`;
        }
      }

      // ── Respuesta principal ───────────────────────────────────────────────────
      const now = new Date();
      const fechaActual = now.toLocaleDateString('es-CO', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        timeZone: 'America/Bogota',
      });
      const horaActual = now.toLocaleTimeString('es-CO', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
      });

      const allClientText = [
        ...history.filter((m: any) => !m.isAiResponse).map((m: any) => m.content),
        userMessage,
      ].join(' ');
      const addressAlreadyGiven = ADDRESS_RE.test(allClientText);

      const AVAIL_RE = /horario|disponible|disponibilidad|cuándo puedo|qué hora|hora libre|cuando tiene|qué días|que dias/i;
      let availabilityBlock = '';

      // Calcular disponibilidad tanto cuando preguntan como cuando agenden con fecha específica.
      // También cuando ya hay una cita en curso (hasPendingAppt/hasApptContextHint): un
      // mensaje de seguimiento como "¿el viernes a las 3 hay campo?" no contiene "horario"
      // ni "agendar" — sin esto, la IA respondería sin disponibilidad real inyectada,
      // confiando solo en el horario general del profesional (no en lo ya ocupado).
      if ((AVAIL_RE.test(userMessage) || hasAppointmentIntent || hasPendingAppt || hasApptContextHint) && store) {
        const queryDate = extractQueryDate(userMessage, new Date());
        if (queryDate) {
          const slotsData = await this.computeSlotsForAI(
            storeId,
            queryDate,
            activeStaff,
            store,
          );
          const dayName = queryDate.toLocaleDateString('es-CO', { weekday: 'long', timeZone: 'America/Bogota' });
          const dateLabel = queryDate.toLocaleDateString('es-CO', { day: 'numeric', month: 'long', timeZone: 'America/Bogota' });
          // Incluir AGENDA COMPLETA del día (libres Y ocupados, en orden cronológico) —
          // así la IA puede mostrarla proactivamente apenas el cliente menciona el día
          // ("3:00 libre, 3:30 libre, 4:00 ocupado...") en vez de proponer una hora a la
          // vez y descubrir recién al final que estaba ocupada (eso alargaba la conversación
          // y cansaba al cliente).
          // Formato 12h (am/pm) ya calculado para el cliente — la IA solo lo copia,
          // no convierte (las conversiones a mano la confundían). El 24h queda como ancla interna.
          const to12h = (hhmm: string): string => {
            const [h, m] = hhmm.split(':').map(Number);
            const period = h < 12 ? 'a. m.' : 'p. m.';
            const h12 = h % 12 === 0 ? 12 : h % 12;
            return `${h12}:${String(m).padStart(2, '0')} ${period}`;
          };
          const lines: string[] = [];
          for (const s of slotsData) {
            if (s.slots.length === 0 && s.occupied.length === 0) {
              lines.push(`- ${s.name}: NO DISPONIBLE ese día`);
              continue;
            }
            const merged = [
              ...s.slots.map(t => ({ t, label: 'libre' })),
              ...s.occupied.map(t => ({ t, label: 'ocupado' })),
            ].sort((a, b) => a.t.localeCompare(b.t));
            lines.push(`- ${s.name}: ${merged.map(m => `${m.t} (${to12h(m.t)}) ${m.label}`).join(', ')}`);
          }
          if (lines.some(l => !l.includes('NO DISPONIBLE'))) {
            availabilityBlock = `\nAGENDA REAL DEL ${dayName.toUpperCase()} ${dateLabel} (hora: estado — "libre" = disponible para agendar, "ocupado" = ya tiene cita):\n${lines.join('\n')}\n\nREGLA CRÍTICA — MUESTRA LA AGENDA PROACTIVAMENTE: en cuanto el cliente diga o confirme el día que quiere, muéstrale de una vez el listado completo de horarios de ese día (libres Y ocupados, ej: "3:00 libre, 3:30 libre, 4:00 ocupado, 4:30 libre...") para que elija directamente una hora libre — NO le propongas una hora a la vez ni esperes a que pida una hora ocupada para recién ahí decirle que no hay campo; eso alarga la conversación innecesariamente. Usa SOLO estos horarios para ese día — son los reales y verificados, no inventes ni calcules otros.\nREGLA — HORA QUE NO ENCAJA EN LA GRILLA: los horarios están en bloques de 30 minutos según la duración del servicio. Si el cliente pide una hora que NO aparece en la lista (ej. pide "3:40" y la lista solo tiene "3:30" y "4:00"), NO la agendes ni la trates como válida — explícale brevemente que el servicio dura bloques de 30 min y por eso no puedes agendar a esa hora exacta, y ofrécele de una vez el horario LIBRE más cercano de la lista (ej. "no te puedo agendar a las 3:40 porque el servicio dura 30 min, ¿te sirve a las 3:30?").\nREGLA — CUALQUIER PROFESIONAL: si el cliente dice "con cualquier barbero/profesional/el que esté disponible" y pide una hora específica, busca en la AGENDA REAL quién tiene ESA HORA como "libre" y responde con el nombre de ese profesional — NUNCA digas que alguien está disponible a una hora que NO aparece en su lista como "libre".\nREGLA — NO INVENTES RESTRICCIONES DE CIERRE: esta grilla YA tiene en cuenta el horario de cierre y la duración del servicio. Si una hora aparece como "libre", está disponible para agendar — agéndala sin dudar. NUNCA rechaces ni cuestiones una hora "libre" diciendo que "está muy cerca del cierre" o "el horario es hasta las X"; si apareciera "libre" es porque cabe. Y NUNCA ofrezcas una hora que NO esté en la lista (ej. si la lista termina en "18:30 libre", no ofrezcas "19:00").\nREGLA — MUESTRA LA HORA AL CLIENTE EN AM/PM: cada horario trae su versión 12h entre paréntesis (ej. "18:30 (6:30 p. m.)"). Cuando le muestres u ofrezcas horarios al cliente, escribe SIEMPRE la versión am/pm (ej. "6:30 p. m.", "9:00 a. m."), NUNCA la hora de 24h — al cliente le cuesta la hora militar. El número de 24h es SOLO tu referencia interna para no confundirte de hora; no lo conviertas tú a mano, copia el am/pm que ya viene calculado.`;
          } else {
            availabilityBlock = `\nDISPONIBILIDAD PARA EL ${dayName.toUpperCase()} ${dateLabel}: Ningún profesional disponible ese día.`;
          }
        }
      }

      // Incluir catálogo completo solo cuando hay intención real de compra/cita/consulta
      const CATALOG_QUERY_RE = /\b(servicio|servicios|producto|productos|cat[aá]logo|precio|precios|tienen|tienes|ofrecen|disponible|cu[aá]nto|descuento|paquete|qu[eé]\s+(hay|tienen|ofrecen|tienes))\b/i;
      const includeCatalog = hasPurchaseIntent || hasAppointmentIntent || hasPendingOrder || hasPendingAppt || CATALOG_QUERY_RE.test(userMessage);

      // Inyectar datos del caché de cita incompleta para que el LLM principal no recalcule fechas
      const cachedAppt = this.pendingAppointments.get(conversationId);
      let pendingApptBlock = '';
      if (cachedAppt && (cachedAppt.scheduledDate || cachedAppt.scheduledTime || cachedAppt.staffId)) {
        const DIAS_ES: Record<string,string> = { sun:'domingo', mon:'lunes', tue:'martes', wed:'miércoles', thu:'jueves', fri:'viernes', sat:'sábado' };
        const lines: string[] = ['CITA EN PROGRESO (datos ya recopilados — NO los recalcules, úsalos tal cual):'];
        if (cachedAppt.scheduledDate) {
          const dk = coDayKey(coNoon(cachedAppt.scheduledDate));
          lines.push(`  Fecha: ${cachedAppt.scheduledDate} (${DIAS_ES[dk] ?? dk})`);
        }
        if (cachedAppt.scheduledTime) lines.push(`  Hora: ${cachedAppt.scheduledTime}`);
        if (cachedAppt.staffName)     lines.push(`  Profesional: ${cachedAppt.staffName}`);
        else if (cachedAppt.staffId) {
          const sn = activeStaff.find(s => s.staffId === cachedAppt.staffId)?.name;
          if (sn) lines.push(`  Profesional: ${sn}`);
        }
        if (cachedAppt.serviceId) {
          const svcName = services.find((s: any) => s.serviceId === cachedAppt.serviceId)?.name;
          if (svcName) lines.push(`  Servicio: ${svcName}`);
        }
        lines.push('REGLA: Usa exactamente la fecha/hora/profesional de arriba — NO los recalcules ni "corrijas". Si ya están fecha + hora + servicio, NO pidas un "sí" aparte ni un paso extra de confirmación: el sistema agenda la cita directamente. Solo pregunta por lo que falte de la lista de arriba (ej. el servicio si no aparece).');
        pendingApptBlock = '\n' + lines.join('\n');
      }

      const enrichedSystemPrompt = this.buildSystemPrompt(
        config.systemPrompt, customer, orders, appointments,
        products, services, fechaActual, horaActual,
        history, userMessage, addressAlreadyGiven, settings,
        customer.lastConversationSummary ?? null,
        store,
        activeStaff,
        availabilityBlock,
        includeCatalog,
        activeAppt,
      );

      const messages: any[] = [
        { role: 'system', content: enrichedSystemPrompt + pendingApptBlock },
        ...history.map((m: any) => ({
          role:    m.isAiResponse ? 'assistant' : 'user',
          content: m.content.trim(),
        })),
        { role: 'user', content: userMessage },
      ];

      let reply: string | undefined;
      const doCompletion = (c: Cartridge) =>
        Promise.race([
          createCompletion(c.provider, c.apiKey, c.model, messages, Number(config.temperature), config.maxTokens),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('AI timeout')), AI_TIMEOUT_MAIN_MS)
          ),
        ]);

      // Retry loop — intenta TODOS los cartuchos activos antes de rendirse
      const triedKeys = new Set<string>();
      let cur: Cartridge | null = cartridge;

      while (cur !== null && reply === undefined) {
        const key = `${cur.provider}:${cur.apiKey}`;
        if (triedKeys.has(key)) break;
        triedKeys.add(key);
        const thisCur = cur;

        try {
          reply = await doCompletion(thisCur);
        } catch (err: any) {
          if (isRateLimitError(err)) {
            this.logger.warn(
              `[Pool] Límite de tasa ${thisCur.provider} ...${thisCur.apiKey.slice(-4)}, rotando ` +
              `(${triedKeys.size}/${allCartridges.length} cartuchos probados)`,
            );
            markExhausted(storeId, thisCur);
            const next = getNextCartridge(storeId);
            cur = (next && !triedKeys.has(`${next.provider}:${next.apiKey}`)) ? next : null;
          } else {
            // Error no-rate-limit → intenta modelo rápido del mismo cartucho
            this.logger.warn(`[Pool] Error en ${thisCur.provider}: ${err.message?.slice(0, 60)}, probando modelo rápido`);
            try {
              reply = await createCompletion(
                thisCur.provider, thisCur.apiKey,
                PROVIDER_CONFIG[thisCur.provider]?.defaultFastModel ?? thisCur.model,
                messages, Number(config.temperature), config.maxTokens,
              );
            } catch {
              // Modelo rápido también falló → marca agotado y rota
              markExhausted(storeId, thisCur);
              const next = getNextCartridge(storeId);
              cur = (next && !triedKeys.has(`${next.provider}:${next.apiKey}`)) ? next : null;
            }
          }
        }
      }

      if (reply === undefined) {
        // Todos los cartuchos agotados. En vez de silencio total (o del spam viejo),
        // mandamos UN mensaje útil con los links públicos — pero solo si no lo mandamos
        // ya en esta conversación (dedup por historial), para no repetirlo en cada turno.
        this.logger.error(`[Pool] Todos los cartuchos agotados para store ${storeId} — respaldo`);
        const dedupCutoff = Date.now() - FALLBACK_DEDUP_MS;
        const yaEnviado = (history ?? []).some(
          (m: any) =>
            m?.isAiResponse &&
            typeof m.content === 'string' &&
            m.content.includes(FALLBACK_MARKER) &&
            m.createdAt != null &&
            new Date(m.createdAt).getTime() >= dedupCutoff,
        );
        if (yaEnviado) {
          this.logger.log(`[Pool] Respaldo ya enviado hace <10min → silencio`);
          return null;
        }
        const frontendUrl = (process.env.FRONTEND_URL ?? '').replace(/\/$/, '');
        return buildFallbackMessage({
          hasSlug:      !!store?.slug,
          frontendUrl,
          slug:         store?.slug ?? undefined,
          lastUserText: userMessage ?? '',
        });
      }

      // ── Silencio en mensajes fuera de tema ──────────────────────────────────
      // Si el LLM determinó que el mensaje NO tiene nada que ver con el negocio
      // (spam, cobranza, número equivocado, cadenas, etc.), responde con el sentinel
      // [IGNORAR]; aquí lo convertimos en silencio total — devolver null hace que el
      // caller (whatsapp.service) omita el envío (no se manda ni se guarda nada).
      if (reply && /\[\s*IGNORAR\s*\]/i.test(reply)) {
        this.logger.log(`[IA] Mensaje fuera de tema → silencio (convId=${conversationId.slice(-8)})`);
        return null;
      }

      // Backstop determinístico: el modelo a veces ignora la prohibición y suelta
      // "(jaja) eso no es lo mío" como redirección a un mensaje claramente ajeno
      // (personal, spam, cobranzas). Esos casos van a SILENCIO total, igual que [IGNORAR].
      if (reply && /eso no es lo m[ií]o/i.test(reply)) {
        this.logger.log(`[IA] "eso no es lo mío" → silencio (convId=${conversationId.slice(-8)})`);
        return null;
      }

      return reply ?? null;

    } catch (err: any) {
      this.logger.error(`Error generando respuesta IA: ${err.message}`);
      return null;
    }
  }

  // ─── Extracción y creación de orden ──────────────────────────────────────────

  private async tryExtractAndCreateOrder(
    provider: AIProvider,
    apiKey: string,
    model: string,
    history: any[],
    latestMessage: string,
    products: any[],
    services: any[],
    customer: any,
    storeId: string,
    conversationId: string,
    settings: StoreSettings,
    store: any = null,
  ): Promise<{ created: boolean; message?: string }> {

    const cached            = this.pendingExtractions.get(conversationId);
    let extracted: ExtractionResult;
    // Cédula del cliente requerida para generar la guía de envío (toggle del negocio).
    const requiresCedula = !!store?.requiresCustomerCedula;
    const needsCedula    = requiresCedula && !customer.cedula;

    // Para órdenes el nombre del cliente es opcional — se usa "Cliente general" si no hay
    const needsName = !customer.name;
    const needsCustomerData = false;

    // ── Caso 1: extracción completa cacheada + cliente confirma ───────────────
    if (
      cached?.complete &&
      cached.deliveryAddress &&
      (!needsCustomerData || cached.customerName) &&
      CONFIRMATION_RE.test(latestMessage.trim())
    ) {
      this.logger.log(`[Orden] Usando caché completo para ${conversationId}`);
      extracted = cached;
      this.pendingExtractions.delete(conversationId);

    // ── Caso 1.5: caché tiene items + dirección + nombre (si aplica) + confirmación actual ──
    // El LLM extractor devuelve complete=false porque la confirmación llega en mensaje separado.
    // Este shortcut crea la orden directamente sin re-correr el extractor.
    } else if (
      cached?.items?.length &&
      cached.deliveryAddress &&
      (!needsCustomerData || cached.customerName) &&
      CONFIRMATION_RE.test(latestMessage.trim())
    ) {
      this.logger.log(`[Orden] Caso 1.5 — shortcut confirmación para ${conversationId}`);
      extracted = { ...cached, complete: true };
      this.pendingExtractions.delete(conversationId);

    // ── Caso 2: había items, faltaba dirección, llega dirección Y ya tenemos nombre ──
    } else if (
      cached?.items?.length &&
      !cached.deliveryAddress &&
      ADDRESS_RE.test(latestMessage) &&
      !needsCustomerData
    ) {
      this.logger.log(`[Orden] Completando con dirección para ${conversationId}`);
      extracted = { ...cached, deliveryAddress: latestMessage.trim(), complete: true };
      this.pendingExtractions.delete(conversationId);

    // ── Caso 3: correr el extractor ───────────────────────────────────────────
    } else {
      const productLines = products.flatMap((p: any) => {
        if (p.variants?.length > 0) {
          return p.variants.map((v: any) =>
            `- "${p.name} - ${v.name}" | tipo:producto | productId:${p.productId} | variantId:${v.variantId} | serviceVariantId:null | precio:${v.salePrice} | stock:${v.stock}`
          );
        }
        return [`- "${p.name}" | tipo:producto | productId:${p.productId} | variantId:null | serviceVariantId:null | precio:${p.salePrice} | stock:${p.stock}`];
      });

      const serviceLines = services.flatMap((s: any) => {
        const precioBase = this.buildServicePriceLabel(s);
        if (s.variants?.length > 0) {
          return s.variants.map((v: any) => {
            const precio = v.priceOverride ? `$${Number(v.priceOverride).toLocaleString('es-CO')}` : precioBase;
            return `- "${s.name} - ${v.name}" | tipo:servicio | serviceId:${s.serviceId} | variantId:null | serviceVariantId:${v.variantId} | precio:${precio}`;
          });
        }
        return [`- "${s.name}" | tipo:servicio | serviceId:${s.serviceId} | variantId:null | serviceVariantId:null | precio:${precioBase}`];
      });

      const catalogSummary   = [...productLines, ...serviceLines].join('\n');
      const conversationText = [
        ...history.map((m: any) => `${m.isAiResponse ? 'Asistente' : 'Cliente'}: ${m.content.trim()}`),
        `Cliente: ${latestMessage}`,
      ].join('\n');

      const cedulaInstruction = requiresCedula
        ? (customer.cedula
            ? `La cédula ya está registrada (${customer.cedula}).`
            : `La cédula del cliente es OBLIGATORIA para generar la guía de envío: extráela en "customerCedula". Sin cédula NO se puede completar el pedido.`)
        : `La cédula es opcional — extráela SOLO si el cliente la menciona explícitamente.`;

      const customerDataInstruction = needsName
        ? `DATOS DEL CLIENTE (OPCIONAL):
Si el cliente mencionó su nombre en la conversación, extráelo en "customerName". Si no lo mencionó, deja null.
El nombre NO es requisito para "complete":true — la orden se puede crear sin él.
${cedulaInstruction}`
        : `DATOS DEL CLIENTE: Nombre ya registrado (${customer.name}).
${cedulaInstruction}`;

      const extractorPrompt = `Eres un extractor de datos de órdenes de compra. Tu única tarea es leer la conversación y extraer los datos del pedido en JSON.

CATÁLOGO DISPONIBLE (usa EXACTAMENTE estos IDs):
${catalogSummary}

CONVERSACIÓN:
${conversationText}

${customerDataInstruction}

NOTA ESPECIAL — CATÁLOGO WA: Si ves un mensaje con formato [Pedido del catálogo: {nombre} | cantidad: {n} | precio: {p}], el cliente seleccionó ese producto directamente desde el catálogo de WhatsApp. Úsalo para identificar el item.

NOTA ESPECIAL — NOMBRE Y DIRECCIÓN EN MISMO MENSAJE: Si el cliente da su nombre y dirección en el mismo mensaje (ej: "Juan Pérez y carrera 45 #20-30, Bogotá" o "María López, Calle 10 #5-20 barrio Centro"), sepáralos correctamente:
- customerName → solo el nombre completo (ej: "Juan Pérez")
- deliveryAddress → solo la dirección (ej: "carrera 45 #20-30, Bogotá")
No incluyas el nombre en deliveryAddress ni la dirección en customerName.

REGLAS ESTRICTAS:
1. "complete":true SOLO si se cumplen TODAS las condiciones simultáneamente:
   a) Al menos un producto/servicio del catálogo con cantidad
   b) Dirección con calle, carrera, barrio o similar (solo ciudad NO es suficiente)
   c) Confirmación explícita del cliente (sí, confirmo, listo, dale, ok, etc.)
   d) Si se requieren datos del cliente: nombre presente${requiresCedula && !customer.cedula ? `
   e) Cédula del cliente presente (este negocio la exige para la guía de envío)` : ''}
2. Si falta CUALQUIER condición → "complete":false.
3. Para productos CON variantes: variantId es OBLIGATORIO, serviceVariantId debe ser null.
4. Para servicios CON variantes: serviceVariantId es OBLIGATORIO, variantId debe ser null.
5. Para productos/servicios SIN variantes: variantId y serviceVariantId deben ser null.
6. Si el stock de un item es 0, NO lo incluyas y explícalo en "reason".
7. "deliveryAddress": copia textualmente lo que dijo el cliente. Sin dirección válida → null.

Responde ÚNICAMENTE con este JSON (sin markdown, sin texto adicional):
{
  "complete": boolean,
  "items": [{"itemType":"producto"|"servicio","productId":"uuid o null","serviceId":"uuid o null","variantId":"uuid o null","serviceVariantId":"uuid o null","quantity":number,"description":"nombre legible"}],
  "deliveryAddress": "string o null",
  "notes": "string o null",
  "reason": "explicación breve",
  "customerName": "nombre completo del cliente o null",
  "customerCedula": "número de cédula o null"
}`;

      try {
        const raw = await Promise.race([
          createCompletion(provider, apiKey, PROVIDER_CONFIG[provider].defaultFastModel,
            [{ role: 'user', content: extractorPrompt }], 0, 900),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Extractor timeout')), AI_TIMEOUT_EXT_MS)
          ),
        ]);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { created: false };

        extracted = JSON.parse(jsonMatch[0]);

        // ── Fallback nombre para órdenes ──────────────────────────────────────
        if (needsCustomerData && !extracted.customerName) {
          const historyClientLines = history
            .filter((m: any) => !m.isAiResponse)
            .map((m: any) => m.content);
          const fallback = parseNombreCliente(latestMessage, historyClientLines);
          if (fallback) {
            this.logger.log(`[Orden] Fallback nombre TS: "${fallback}"`);
            extracted.customerName = fallback;
          }
        }

        this.logger.log(`[Orden] Extracción: complete=${extracted.complete} reason=${extracted.reason}`);

        // Guardar nombre del cliente proactivamente aunque la orden aún no esté completa
        if (needsName && extracted.customerName && !extracted.complete) {
          this.prisma.customer.update({
            where: { customerId: customer.customerId },
            data: {
              name: extracted.customerName.replace(/\b\w/g, l => l.toUpperCase()),
              ...(extracted.customerCedula && { cedula: extracted.customerCedula }),
            },
          }).then(() => {
            this.logger.log(`[Orden] Nombre guardado proactivamente: ${extracted.customerName}`);
            customer.name = extracted.customerName;
          }).catch(() => {});
        }

        if (extracted.items?.length > 0) {
          this.pendingExtractions.set(conversationId, extracted);
          setTimeout(() => this.pendingExtractions.delete(conversationId), ORDER_GUARD_TTL_MS);
        }

      } catch (err: any) {
        this.logger.error(`[Orden] Error extractor: ${err.message}`);
        return { created: false };
      }
    }

    if (!extracted?.complete)       return { created: false };
    if (!extracted.items?.length)   return { created: false };
    if (!extracted.deliveryAddress) return { created: false };
    if (needsCustomerData && !extracted.customerName) {
      return { created: false };
    }
    // Guard de cédula: si el negocio la exige para la guía de envío y no la tenemos
    // (ni registrada en el cliente ni extraída ahora), pídela en vez de crear la orden.
    // Cubre todos los caminos (caché y extractor fresco).
    if (needsCedula && !extracted.customerCedula && !customer.cedula) {
      this.logger.log(`[Orden] Falta cédula (requerida) para ${conversationId} — pidiéndola`);
      return {
        created: false,
        message: `Para generar tu guía de envío necesito tu número de cédula 🪪. ¿Me lo compartes, por favor?`,
      };
    }
    if (this.orderInProgress.has(conversationId)) {
      this.logger.warn(`[Orden] Ya en progreso para ${conversationId}`);
      return { created: false };
    }

    this.orderInProgress.add(conversationId);

    try {
      // Actualizar datos del cliente si se recopilaron ahora
      if (needsName && extracted.customerName) {
        await this.prisma.customer.update({
          where: { customerId: customer.customerId },
          data: {
            name:   extracted.customerName.replace(/\b\w/g, l => l.toUpperCase()),
            ...(extracted.customerCedula && { cedula: extracted.customerCedula }),
          },
        });
        this.logger.log(`✅ [Orden] Cliente actualizado: ${extracted.customerName}`);
      } else if (extracted.customerCedula && !customer.cedula) {
        // Cliente ya tenía nombre pero faltaba la cédula y la dio ahora.
        await this.prisma.customer.update({
          where: { customerId: customer.customerId },
          data:  { cedula: extracted.customerCedula },
        });
        this.logger.log(`✅ [Orden] Cédula registrada para ${customer.customerId}`);
      }

      const orderItemsData: any[]       = [];
      const orderItemsSummary: string[] = [];
      // Decrementos de stock a aplicar atómicamente junto con la creación de la orden.
      // Solo productos/variantes (los servicios no manejan stock).
      const stockOps: { productId?: string; variantId?: string; quantity: number }[] = [];
      let total = 0;

      for (const item of extracted.items) {
        if (item.itemType === 'servicio' && item.serviceId) {
          const catalogData = this.getCached(this.catalogCache, storeId);
          const service     = catalogData?.services?.find((s: any) => s.serviceId === item.serviceId);
          if (!service) { this.logger.warn(`[Orden] Servicio no encontrado: ${item.serviceId}`); continue; }
          const variant   = item.serviceVariantId ? service.variants?.find((v: any) => v.variantId === item.serviceVariantId) : null;
          const unitPrice = this.resolveServicePrice(service, variant);
          const subtotal  = unitPrice * item.quantity;
          total += subtotal;
          orderItemsData.push({
            service: { connect: { serviceId: item.serviceId } },
            ...(item.serviceVariantId && { serviceVariant: { connect: { variantId: item.serviceVariantId } } }),
            description: item.description ?? (variant ? `${service.name} - ${variant.name}` : service.name),
            quantity: item.quantity,
            unitPrice,
          });
          orderItemsSummary.push(
            `• ${item.description ?? service.name}${variant ? ` - ${variant.name}` : ''} x${item.quantity}` +
            (unitPrice > 0 ? ` — $${subtotal.toLocaleString('es-CO')}` : ' — Precio a confirmar'),
          );
        } else if (item.productId) {
          const catalogData = this.getCached(this.catalogCache, storeId);
          const product     = catalogData?.products?.find((p: any) => p.productId === item.productId);
          if (!product) { this.logger.warn(`[Orden] Producto no encontrado: ${item.productId}`); continue; }
          if (item.variantId) {
            const variant = product.variants?.find((v: any) => v.variantId === item.variantId);
            if (!variant) { this.logger.warn(`[Orden] Variante no encontrada: ${item.variantId}`); continue; }
            if (variant.stock < item.quantity) { this.logger.warn(`[Orden] Stock insuficiente variante ${variant.name}`); continue; }
            const unitPrice = Number(variant.salePrice);
            const subtotal  = unitPrice * item.quantity;
            total += subtotal;
            orderItemsData.push({
              product: { connect: { productId: item.productId } },
              variant: { connect: { variantId: item.variantId } },
              description: item.description ?? `${product.name} - ${variant.name}`,
              quantity: item.quantity, unitPrice,
            });
            stockOps.push({ variantId: item.variantId, quantity: item.quantity });
            orderItemsSummary.push(`• ${item.description ?? `${product.name} - ${variant.name}`} x${item.quantity} — $${subtotal.toLocaleString('es-CO')}`);
          } else {
            if (product.stock < item.quantity) { this.logger.warn(`[Orden] Stock insuficiente: ${product.name}`); continue; }
            const unitPrice = Number(product.salePrice);
            const subtotal  = unitPrice * item.quantity;
            total += subtotal;
            orderItemsData.push({
              product: { connect: { productId: item.productId } },
              description: item.description ?? product.name,
              quantity: item.quantity, unitPrice,
            });
            stockOps.push({ productId: item.productId, quantity: item.quantity });
            orderItemsSummary.push(`• ${item.description ?? product.name} x${item.quantity} — $${subtotal.toLocaleString('es-CO')}`);
          }
        }
      }

      if (orderItemsData.length === 0) {
        this.logger.warn(`[Orden] Sin items válidos`);
        // Mensaje explícito en vez de { created:false } a secas: el cliente confirmó
        // ("complete":true exige confirmación) pero ningún item pasó validación
        // (sin stock, no encontrado, etc.) — decirle la razón real evita que el AI
        // principal improvise un "tu pedido quedó registrado" que no existe.
        return {
          created: false,
          message: `No pude registrar tu pedido porque ${extracted.items.length === 1 ? 'el producto/servicio que mencionaste ya no está disponible o no tiene stock suficiente' : 'los productos/servicios que mencionaste ya no están disponibles o no tienen stock suficiente'}. ¿Quieres elegir otra opción del catálogo?`,
        };
      }

      // Transacción atómica: descontar stock (guardado con stock >= cantidad y
      // store-scoped, igual que orders.service) y crear la orden en una sola unidad.
      // Antes la orden se creaba sin tocar el stock → el inventario nunca bajaba con
      // las ventas por IA. El guard gte evita sobreventa si el cache quedó desfasado.
      let order: { orderId: string };
      try {
        order = await this.prisma.$transaction(async (tx) => {
          for (const op of stockOps) {
            if (op.variantId) {
              const r = await tx.productVariant.updateMany({
                where: { variantId: op.variantId, stock: { gte: op.quantity }, product: { storeId } },
                data:  { stock: { decrement: op.quantity } },
              });
              if (r.count === 0) throw new Error('STOCK_OUT');
              await this.sync.emitStockChanged(tx, storeId, { variantId: op.variantId });
            } else if (op.productId) {
              const r = await tx.product.updateMany({
                where: { productId: op.productId, stock: { gte: op.quantity }, storeId },
                data:  { stock: { decrement: op.quantity } },
              });
              if (r.count === 0) throw new Error('STOCK_OUT');
              await this.sync.emitStockChanged(tx, storeId, { productId: op.productId });
            }
          }
          return tx.order.create({
            data: {
              storeId,
              customerId:      customer.customerId,
              status:          'pending',
              total,
              deliveryAddress: extracted.deliveryAddress,
              notes: [extracted.notes ? `Notas: ${extracted.notes}` : null, 'Creado automáticamente por IA'].filter(Boolean).join(' | '),
              orderItems: { create: orderItemsData },
            },
          });
        });
      } catch (e: any) {
        if (e?.message === 'STOCK_OUT') {
          this.logger.warn(`[Orden] Stock agotado durante la confirmación — orden no creada`);
          return {
            created: false,
            message: `Lo siento, uno de los productos se agotó mientras confirmabas el pedido. ¿Quieres elegir otra opción del catálogo?`,
          };
        }
        throw e;
      }

      this.sync.kick();

      await this.prisma.conversation.update({ where: { conversationId }, data: { status: 'pending_human' } });
      this.pendingExtractions.delete(conversationId);
      this.logger.log(`✅ [Orden] ${order.orderId} — ${orderItemsData.length} items — Total: $${total}`);

      const nombreCliente  = extracted.customerName ? `, ${extracted.customerName.split(' ')[0]}` : customer.name ? `, ${customer.name}` : '';
      const paymentBlock   = this.buildPaymentBlock(settings);
      const paymentSection = paymentBlock ? `\n\n${paymentBlock}` : `\n\nUn asesor te contactará pronto para coordinar el pago y confirmar el envío.`;
      const closingMessage = settings.orderClosingMessage ?? '';

      return {
        created: true,
        message:
          `¡Pedido registrado${nombreCliente}! 🎉\n\n` +
          `📦 Resumen:\n${orderItemsSummary.join('\n')}` +
          `\n\n💰 Total: $${total.toLocaleString('es-CO')}\n` +
          `📍 Dirección de entrega: ${extracted.deliveryAddress}` +
          paymentSection +
          (closingMessage ? `\n\n${closingMessage}` : ''),
      };

    } finally {
      this.orderInProgress.delete(conversationId);
    }
  }

  // ─── Extracción y creación de cita ───────────────────────────────────────────

  private async tryExtractAndCreateAppointment(
    provider: AIProvider,
    apiKey: string,
    model: string,
    history: any[],
    latestMessage: string,
    customer: any,
    storeId: string,
    conversationId: string,
    services: any[],
    activeStaff: Array<{ staffId: string; name: string; schedule?: any }> = [],
    store: any = null,
  ): Promise<{ created: boolean; message?: string }> {

    const cached = this.pendingAppointments.get(conversationId);
    let extracted: AppointmentExtractionResult;

    // Para citas: solo se requiere nombre (la cédula es opcional — no siempre aplica)
    const needsName    = !customer.name;
    const needsCedula  = !customer.cedula;
    const needsCustomerData = false; // nombre no bloquea la creación de citas

    // ── FIX CASO 1: no esperamos complete=true del caché ─────────────────────
    // Si el caché tiene fecha, hora y nombre (si aplica) Y el cliente confirma
    // → creamos directamente sin re-correr el extractor
    const cacheHasAllData =
      cached &&
      cached.scheduledDate &&
      cached.scheduledTime &&
      (!needsCustomerData || cached.customerName);

    this.logger.log(
      `[Cita] ENTRY convId=${conversationId.slice(-8)} msg="${latestMessage.slice(0,30)}" ` +
      `cache={date:${cached?.scheduledDate},time:${cached?.scheduledTime},staff:${cached?.staffId?.slice(-8)}} ` +
      `cacheOK=${!!cacheHasAllData} confRE=${CONFIRMATION_RE.test(latestMessage.trim())} needName=${needsCustomerData}`,
    );

    if (cacheHasAllData && CONFIRMATION_RE.test(latestMessage.trim())) {
      // Guard: no re-crear si el mismo slot ya fue creado en esta conversación
      const caso1Already = this.conversationCreatedAppts.get(conversationId) ?? [];
      if (caso1Already.some(a => a.scheduledDate === cached!.scheduledDate && a.scheduledTime === cached!.scheduledTime)) {
        this.logger.warn(`[Cita] Caso 1 — slot ${cached!.scheduledDate} ${cached!.scheduledTime} ya fue creado — limpiando caché`);
        this.pendingAppointments.delete(conversationId);
        this.cancelConfirmReminder(conversationId);
        // Devolvemos un mensaje explícito (no { created:false } a secas): esta cita SÍ
        // existe de verdad — fue creada minutos atrás en esta misma conversación — así
        // que confirmar de nuevo aquí es seguro y correcto, no una alucinación.
        return {
          created: false,
          message: `¡Ya quedó registrada! Tu cita para el ${cached!.scheduledDate} a las ${cached!.scheduledTime}` +
            (cached!.staffName ? ` con ${cached!.staffName}` : '') +
            ` está confirmada — no necesitas confirmarla otra vez. ¡Te esperamos! 😊`,
        };
      }
      this.logger.log(`[Cita] Caso 1 — caché con datos suficientes + confirmación para ${conversationId}`);
      // Re-parsear hora y fecha del mensaje actual: el cliente puede confirmar Y dar
      // un horario diferente al del caché (ej: "ok, a las 3 pm"). Siempre el mensaje
      // actual tiene prioridad sobre el caché.
      const caso1Hora  = parseHoraEspanol(latestMessage);
      const caso1Fecha = parseFechaEspanol(latestMessage);
      extracted = {
        ...cached,
        complete: true,
        ...(caso1Hora  && caso1Hora  !== cached!.scheduledTime && { scheduledTime: caso1Hora }),
        ...(caso1Fecha && caso1Fecha !== cached!.scheduledDate && { scheduledDate: caso1Fecha }),
      };
      if (caso1Hora && caso1Hora !== cached!.scheduledTime) {
        this.logger.log(`[Cita] Caso 1 — hora actualizada del mensaje: ${cached!.scheduledTime} → ${caso1Hora}`);
      }
      // NO borramos el caché aquí — se borra al crear exitosamente (línea ~1966)
      // o al detectar conflicto/horario inválido. Así el cliente puede reintentar si falla.

    // ── Caso 2: correr el extractor ───────────────────────────────────────────
    } else {
      const conversationText = [
        ...history.map((m: any) => `${m.isAiResponse ? 'Asistente' : 'Cliente'}: ${m.content.trim()}`),
        `Cliente: ${latestMessage}`,
      ].join('\n');

      const customerDataInstruction = needsName
        ? `DATOS DEL CLIENTE (OPCIONAL):
Si el cliente mencionó su nombre en la conversación, extráelo en "customerName". El nombre NO es requisito para "complete":true.

IMPORTANTE — EXTRACCIÓN DE NOMBRE SIN ETIQUETAS:
Los clientes frecuentemente envían todos sus datos juntos en un mensaje sin etiquetas, por ejemplo:
"Paula Culma
3118265286
Cra45#20-48
Para el 24 de marzo a las 3 pm"

En ese caso:
- La primera línea con dos o más palabras capitalizadas = nombre del cliente → "Paula Culma"
- Una línea solo con dígitos (10 dígitos) = teléfono, NO es nombre
- Una línea con Cra/Calle/# = dirección, NO es nombre
- La frase con fecha/hora = scheduledDate y scheduledTime

La cédula es OPCIONAL — extráela SOLO si el cliente mencionó explícitamente un número de 6-10 dígitos como cédula. Un teléfono NO es cédula.`
        : `DATOS DEL CLIENTE: Nombre ya registrado (${customer.name}).`;

      const servicesCatalog = services.length > 0
        ? `CATÁLOGO DE SERVICIOS DISPONIBLES:
${services.flatMap((s: any) => {
  const precio = this.buildServicePriceLabel(s);
  const dur    = s.estimatedMinutes ? ` | duración: ${Math.floor(s.estimatedMinutes / 60)}h${s.estimatedMinutes % 60 > 0 ? ` ${s.estimatedMinutes % 60}min` : ''}` : '';
  if (s.variants?.length > 0) {
    return s.variants.map((v: any) => {
      const precioV = v.priceOverride ? `$${Number(v.priceOverride).toLocaleString('es-CO')}` : precio;
      const durV    = v.estimatedMinutes ? ` | duración: ${Math.floor(v.estimatedMinutes / 60)}h${v.estimatedMinutes % 60 > 0 ? ` ${v.estimatedMinutes % 60}min` : ''}` : dur;
      return `- "${s.name} - ${v.name}" | serviceId:${s.serviceId} | serviceVariantId:${v.variantId} | precio:${precioV}${durV}`;
    });
  }
  return [`- "${s.name}" | serviceId:${s.serviceId} | serviceVariantId:null | precio:${precio}${dur}`];
}).join('\n')}`
        : `CATÁLOGO DE SERVICIOS: No hay servicios registrados.`;

      const fechaHoy = coDateStr(); // YYYY-MM-DD en hora Colombia (no UTC)

      const staffCatalog = activeStaff.length > 0
        ? `\nEQUIPO DISPONIBLE:\n${activeStaff.map((s: { staffId: string; name: string }) => `- "${s.name}" → staffId: "${s.staffId}"`).join('\n')}\n`
        : '';

      // Citas ya creadas en esta sesión → inyectar para que el LLM no las re-extraiga
      const alreadyCreated = this.conversationCreatedAppts.get(conversationId) ?? [];
      const alreadyCreatedBlock = alreadyCreated.length > 0
        ? `\nCITAS YA REGISTRADAS EN ESTA CONVERSACIÓN (NO las vuelvas a extraer — ya están confirmadas en el sistema):\n${alreadyCreated.map(a => `- ${a.type || 'cita'} el ${a.scheduledDate} a las ${a.scheduledTime} → YA CREADA`).join('\n')}\nSi el cliente pide UNA NUEVA cita con fecha/hora DIFERENTE a las anteriores, extrae ESA nueva cita.\n`
        : '';

      const appointmentPrompt = `Eres un extractor de datos para agendamiento de citas. Lee la conversación y extrae los datos en JSON.

${buildCalendarioRef()}
${alreadyCreatedBlock}
${servicesCatalog}
${staffCatalog}

CONVERSACIÓN:
${conversationText}

${customerDataInstruction}

REGLAS ESTRICTAS:
1. "complete":true cuando el cliente, de forma AFIRMATIVA (no como pregunta), ya dio:
   a) Fecha específica (día y mes como mínimo)
   b) Hora específica
   c) Qué necesita el cliente (basta con lo ya hablado en la conversación)
   ${store?.requiresCustomerAddress ? 'd) Dirección física del cliente (este negocio la requiere)' : ''}
   Dar fecha y hora concretas ("el viernes 19 a las 6:30pm", "agéndame mañana a las 3", "sí, el sábado 3pm") YA ES pedir la cita: NO exijas un "sí" aparte ni un paso extra de confirmación — agéndala de una. Si además dio su nombre, mejor (no es requisito).
2. "complete":false SOLO si: falta la fecha o la hora, son ambiguas ("algún día", "en la tarde" sin hora exacta), o el cliente está PREGUNTANDO disponibilidad ("¿tienen el viernes?", "¿hay campo a las 3?") en lugar de pedir la cita.
3. "scheduledDate": formato "YYYY-MM-DD". Usa EXACTAMENTE las fechas del PRÓXIMAS FECHAS del calendario de arriba.
   NO calcules manualmente — copia el valor de la tabla. Si el cliente dice "el lunes", usa el valor "lunes: YYYY-MM-DD" de la tabla.
4. "scheduledTime": formato "HH:MM" en 24h. "2pm" → "14:00", "4pm" → "16:00"
5. ${store?.requiresCustomerAddress
      ? `"address": Este negocio SÍ requiere la dirección del cliente. Extrae SOLO si da una dirección física real (calle, carrera, barrio + número, ej: "Cra 45 #20-48"). Si aún no la ha dado → null (y "complete" debe ser false). NUNCA pongas el mensaje completo del cliente como dirección — solo el fragmento que sea una dirección real.`
      : `"address": Este negocio NO requiere dirección (el cliente asiste al local). SIEMPRE devuelve null — ignora cualquier texto que parezca dirección, nunca lo guardes ni lo trates como tal.`}
6. ${store?.requiresCustomerCedula
      ? `"customerCedula": Este negocio SÍ requiere cédula del cliente. Extrae el número de documento (6-10 dígitos) cuando el cliente lo mencione explícitamente como cédula/documento. Un número de teléfono NO es cédula.`
      : `"customerCedula": Este negocio NO requiere cédula. SIEMPRE devuelve null — no la pidas (si el cliente la da espontáneamente puedes capturarla, pero nunca la exijas ni la conviertas en requisito).`}
7. "type": texto libre describiendo la cita (ej: "visita_tecnica", "instalación solar", "corte de cabello").
8. "staffId": si el cliente eligió un profesional, usa su ID del EQUIPO DISPONIBLE. Si no hay equipo o no eligió → null.
9. "partySize": número de personas que serán atendidas en esta solicitud (el cliente + sus acompañantes). Detéctalo de frases como "venimos 3", "somos 2", "yo y mi hijo" (=2), "para mí y mi novia" (=2), "3 personas". Si el cliente NO menciona acompañantes, devuelve 1. Todas las personas del grupo van con el MISMO servicio y el MISMO profesional.

Responde ÚNICAMENTE con este JSON (sin markdown, sin texto adicional):
{
  "complete": boolean,
  "serviceId": "uuid o null",
  "serviceVariantId": "uuid o null",
  "type": "descripción del tipo de cita",
  "scheduledDate": "YYYY-MM-DD o null",
  "scheduledTime": "HH:MM o null",
  "durationMinutes": number | null,
  "agreedPrice": number | null,
  "description": "descripción de qué se va a hacer o null",
  "address": "dirección si aplica o null",
  "notes": "notas adicionales o null",
  "reason": "por qué complete es true o false",
  "customerName": "nombre completo o null",
  "customerCedula": "número de cédula o null (solo si fue mencionado)",
  "staffId": "uuid del profesional elegido o null",
  "staffName": "nombre del profesional elegido o null",
  "partySize": number (1 si no hay acompañantes)
}`;

      try {
        const raw = await Promise.race([
          createCompletion(provider, apiKey, PROVIDER_CONFIG[provider].defaultFastModel,
            [{ role: 'user', content: appointmentPrompt }], 0, 700),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Appointment extractor timeout')), AI_TIMEOUT_EXT_MS)
          ),
        ]);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { created: false };

        extracted = JSON.parse(jsonMatch[0]);

        // ── partySize: normalizar a entero ≥ 1; fallback TS si el LLM no lo dio ──
        let partySize = typeof extracted.partySize === 'number' && Number.isFinite(extracted.partySize) ? Math.trunc(extracted.partySize) : 1;
        if (partySize < 1) partySize = 1;
        if (partySize === 1) {
          const allClientText = [
            ...history.filter((m: any) => !m.isAiResponse).map((m: any) => m.content),
            latestMessage,
          ].join(' ');
          const tsParty = parsePartySize(allClientText);
          if (tsParty && tsParty > 1) {
            this.logger.log(`[Cita] partySize fallback TS: ${tsParty}`);
            partySize = tsParty;
          }
        }
        extracted.partySize = partySize;

        // ── Fallbacks TypeScript — aplican cuando el LLM devuelve null ──────────

        // Nombre — si el LLM devolvió una frase-placeholder ("Cliente no registrado",
        // "el cliente no mencionó su nombre"), tratarla como si no hubiera devuelto nada
        if (extracted.customerName && isPlaceholderName(extracted.customerName)) {
          this.logger.warn(`[Cita] Nombre placeholder descartado del LLM: "${extracted.customerName}"`);
          extracted.customerName = null;
        }
        if (!extracted.customerName && needsName) {
          const historyClientLines = history
            .filter((m: any) => !m.isAiResponse)
            .map((m: any) => m.content);
          const fallback = parseNombreCliente(latestMessage, historyClientLines);
          if (fallback) {
            this.logger.log(`[Cita] Fallback nombre TS: "${fallback}"`);
            extracted.customerName = fallback;
          }
        }

        // Fecha — validar rango razonable (hoy → +2 años). El LLM a veces alucina 2028+.
        if (extracted.scheduledDate) {
          const parsedDate = new Date(extracted.scheduledDate);
          const twoYearsFromNow = new Date(); twoYearsFromNow.setFullYear(twoYearsFromNow.getFullYear() + 2);
          if (isNaN(parsedDate.getTime()) || parsedDate > twoYearsFromNow || parsedDate < new Date(Date.now() - 86400_000)) {
            this.logger.warn(`[Cita] Fecha fuera de rango del LLM: ${extracted.scheduledDate} — usando fallback TS`);
            extracted.scheduledDate = null;
          }
        }

        // Cruce día-semana: si el cliente mencionó "lunes", "martes", etc.,
        // verificar que la fecha del LLM sea ese día. Si no coincide, usar fallback TS.
        if (extracted.scheduledDate) {
          const latestLower = latestMessage.toLowerCase();
          const DIAS_CHECK: [string, number][] = [
            ['lunes',1],['martes',2],['miércoles',3],['miercoles',3],
            ['jueves',4],['viernes',5],['sábado',6],['sabado',6],['domingo',0],
          ];
          for (const [nombre, numDia] of DIAS_CHECK) {
            if (latestLower.includes(nombre)) {
              const llmDay = new Date(extracted.scheduledDate + 'T12:00:00').getDay();
              if (llmDay !== numDia) {
                const fallback = parseFechaEspanol(latestMessage);
                if (fallback) {
                  this.logger.warn(`[Cita] LLM asignó ${extracted.scheduledDate} (día ${llmDay}) pero cliente dijo "${nombre}" (día ${numDia}) → override TS: ${fallback}`);
                  extracted.scheduledDate = fallback;
                }
              }
              break;
            }
          }
        }

        // Si el caché tiene fecha y el LLM la cambió sin que el mensaje actual mencione una
        // nueva fecha, restaurar la del caché (evita que Gemini/Groq sobreescriban con datos
        // mal reextraídos del historial).
        if (cached?.scheduledDate && extracted.scheduledDate !== cached.scheduledDate && !parseFechaEspanol(latestMessage)) {
          this.logger.log(`[Cita] LLM cambió fecha sin ref en msg actual (${extracted.scheduledDate}→${cached.scheduledDate}) — restaurando caché`);
          extracted.scheduledDate = cached.scheduledDate;
        }

        if (!extracted.scheduledDate) {
          const allText = [
            ...history.filter((m: any) => !m.isAiResponse).map((m: any) => m.content),
            latestMessage,
          ].join(' ');
          const fallback = parseFechaEspanol(allText);
          if (fallback) {
            this.logger.log(`[Cita] Fallback fecha TS: "${fallback}"`);
            extracted.scheduledDate = fallback;
          }
        }

        // Hora — si el LLM extrajo una hora, validar contra el mensaje actual.
        // Si el mensaje actual contiene una hora distinta, preferir el parser TS
        // (el LLM tiende a confundirse cuando hay múltiples horas en el historial).
        const tsHoraActual = parseHoraEspanol(latestMessage);
        if (tsHoraActual && extracted.scheduledTime && tsHoraActual !== extracted.scheduledTime) {
          this.logger.log(`[Cita] Hora LLM (${extracted.scheduledTime}) != TS del mensaje actual (${tsHoraActual}) → usando TS`);
          extracted.scheduledTime = tsHoraActual;
        }
        // Mismo para la hora: si el caché la tenía y el LLM la cambió sin ref en mensaje actual
        if (cached?.scheduledTime && extracted.scheduledTime !== cached.scheduledTime && !parseHoraEspanol(latestMessage)) {
          this.logger.log(`[Cita] LLM cambió hora sin ref en msg actual (${extracted.scheduledTime}→${cached.scheduledTime}) — restaurando caché`);
          extracted.scheduledTime = cached.scheduledTime;
        }

        if (!extracted.scheduledTime) {
          const allText = [
            ...history.filter((m: any) => !m.isAiResponse).map((m: any) => m.content),
            latestMessage,
          ].join(' ');
          const fallback = parseHoraEspanol(allText);
          if (fallback) {
            this.logger.log(`[Cita] Fallback hora TS: "${fallback}"`);
            extracted.scheduledTime = fallback;
          }
        }

        // Staff — el nombre mencionado en el último mensaje del cliente tiene prioridad
        // sobre el staffId del LLM. El modelo rápido se confunde cuando el historial
        // contiene muchas menciones de otro profesional.
        if (activeStaff.length > 0) {
          let bestStaff: { staffId: string; name: string } | null = null;
          let bestPos = -1;
          // Buscar en el mensaje actual Y en el historial reciente para capturar
          // menciones de staff de mensajes anteriores (ej: "con Andrés" en msg 1,
          // cliente da nombre propio en msg 2 sin repetir el barbero)
          const searchContext = [
            latestMessage,
            ...history.filter((m: any) => !m.isAiResponse).slice(-4).map((m: any) => m.content),
          ].join(' ');
          for (const s of activeStaff) {
            // Buscar todas las palabras del nombre (>2 chars) para manejar nombres
            // compuestos como "Asesor de imagen Andrés" donde split(' ')[0] = "Asesor"
            const nameWords = s.name.split(/\s+/).filter((w: string) => w.length > 2);
            for (const word of nameWords) {
              // esWord (no \b) — nombres con tilde ("José", "Andrés") no matchean con \b nativo de JS
              const re = new RegExp(esWord(word), 'giu');
              let m: RegExpExecArray | null;
              while ((m = re.exec(searchContext)) !== null) {
                if (m.index > bestPos) {
                  bestPos = m.index;
                  bestStaff = s;
                }
              }
            }
          }
          if (bestStaff && extracted.staffId !== bestStaff.staffId) {
            this.logger.log(`[Cita] Fallback staffId: LLM="${extracted.staffId?.slice(-8)}" → "${bestStaff.staffId.slice(-8)}" (${bestStaff.name})`);
            extracted.staffId = bestStaff.staffId;
            extracted.staffName = bestStaff.name;
          }
        }

        // Dirección (si es visita a domicilio y no vino del LLM) — solo si el negocio la requiere
        if (store?.requiresCustomerAddress && !extracted.address && ADDRESS_RE.test(latestMessage)) {
          const lines = latestMessage.split('\n').map(l => l.trim());
          const addrLine = lines.find(l => ADDRESS_RE.test(l));
          if (addrLine) {
            this.logger.log(`[Cita] Fallback dirección TS: "${addrLine}"`);
            extracted.address = addrLine;
          }
        }

        // Servicio — si el LLM no resolvió el serviceId pero sí dio un tipo de cita,
        // hacer fuzzy-match contra los servicios registrados por solapamiento de palabras.
        if (!extracted.serviceId && extracted.type && services.length > 0) {
          const norm = (s: string) =>
            s.toLowerCase()
              .normalize('NFD').replace(/[̀-ͯ]/g, '')
              .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
          const needleWords = norm(extracted.type).split(' ').filter(w => w.length > 2);
          let bestScore = 0;
          let bestSvc: any = null;
          for (const svc of services) {
            const hay = norm(svc.name);
            if (needleWords.length === 0) continue;
            const matches = needleWords.filter(w => hay.includes(w)).length;
            const score = matches / needleWords.length;
            if (score > bestScore) { bestScore = score; bestSvc = svc; }
          }
          if (bestSvc && bestScore >= 0.5) {
            this.logger.log(`[Cita] Fallback serviceId: "${extracted.type}" → "${bestSvc.name}" (score=${bestScore.toFixed(2)})`);
            extracted.serviceId = bestSvc.serviceId;
            if (!extracted.durationMinutes && bestSvc.estimatedMinutes) extracted.durationMinutes = bestSvc.estimatedMinutes;
            if (!extracted.agreedPrice    && bestSvc.price)             extracted.agreedPrice    = bestSvc.price;
          }
        }

        this.logger.log(`[Cita] Post-fallback: complete=${extracted.complete} date=${extracted.scheduledDate} time=${extracted.scheduledTime} staff=${extracted.staffId?.slice(-8)} name=${extracted.customerName} reason=${extracted.reason}`);

        // Guardar nombre proactivamente aunque la cita aún no esté completa
        if (needsName && extracted.customerName && !extracted.complete) {
          this.prisma.customer.update({
            where: { customerId: customer.customerId },
            data: {
              name: extracted.customerName.replace(/\b\w/g, l => l.toUpperCase()),
              ...(extracted.customerCedula && needsCedula && { cedula: extracted.customerCedula }),
            },
          }).then(() => {
            this.logger.log(`[Cita] Nombre guardado proactivamente: ${extracted.customerName}`);
            customer.name = extracted.customerName;
          }).catch(() => {});
        }

        // Guardar en caché incluso si no está completo — acumula datos entre mensajes
        if (extracted.scheduledDate || extracted.description || extracted.serviceId || extracted.customerName || extracted.staffId) {
          // Merge robusto con caché previo
          const merged: AppointmentExtractionResult = cached
            ? mergeAppt(cached, extracted)
            : extracted;

          this.pendingAppointments.set(conversationId, merged);
          setTimeout(() => {
            this.pendingAppointments.delete(conversationId);
            this.cancelConfirmReminder(conversationId);
          }, ORDER_GUARD_TTL_MS);

          // Si el merge ahora tiene todos los datos y hay confirmación → crear
          const mergeAlready = this.conversationCreatedAppts.get(conversationId) ?? [];
          const mergeDupe = mergeAlready.some(
            a => a.scheduledDate === merged.scheduledDate && a.scheduledTime === merged.scheduledTime,
          );
          if (
            !mergeDupe &&
            merged.scheduledDate &&
            merged.scheduledTime &&
            (!needsCustomerData || merged.customerName) &&
            CONFIRMATION_RE.test(latestMessage.trim())
          ) {
            this.logger.log(`[Cita] Merge completo + confirmación para ${conversationId}`);
            extracted = { ...merged, complete: true };
            this.pendingAppointments.delete(conversationId);
            this.cancelConfirmReminder(conversationId);
          } else if (mergeDupe) {
            this.logger.warn(`[Cita] Merge — slot ${merged.scheduledDate} ${merged.scheduledTime} ya fue creado — limpiando caché`);
            this.pendingAppointments.delete(conversationId);
            this.cancelConfirmReminder(conversationId);
            extracted = merged;
          } else {
            extracted = merged;
            // Si la caché tiene todos los datos pero el cliente aún no confirma,
            // la IA va a preguntar "¿Confirmamos?" → programar recordatorio automático
            if (merged.scheduledDate && merged.scheduledTime && (!needsCustomerData || merged.customerName)) {
              this.scheduleConfirmReminder(conversationId, storeId, customer.phone);
            }
          }
        }

      } catch (err: any) {
        this.logger.error(`[Cita] Error extractor: ${err.message}`);
        return { created: false };
      }
    }

    // Guard: el LLM puede devolver complete=true mirando el historial aunque el mensaje
    // actual no sea una confirmación. Solo se honra complete=true del LLM si el mensaje
    // actual es una confirmación explícita.
    if (extracted?.complete && !CONFIRMATION_RE.test(latestMessage.trim())) {
      this.logger.warn(`[Cita] LLM complete=true sin confirmación actual — forzando false`);
      extracted = { ...extracted, complete: false };
    }

    // Fallback de servicio: si el cliente no especificó y la tienda tiene un
    // servicio predeterminado configurado, usarlo (evita alargar la conversación).
    if (extracted && !extracted.serviceId && store?.defaultServiceId) {
      const def = services.find((s: any) => s.serviceId === store.defaultServiceId);
      if (def) {
        extracted.serviceId = def.serviceId;
        this.logger.log(`[Cita] Servicio predeterminado aplicado: ${def.name} (convId=${conversationId.slice(-8)})`);
      }
    }

    // ── Validación final ───────────────────────────────────────────────────────
    this.logger.log(`[Cita] PRE-VALID: complete=${extracted?.complete} date=${extracted?.scheduledDate} time=${extracted?.scheduledTime} staffId=${extracted?.staffId?.slice(-8)}`);
    if (!extracted?.complete)     return { created: false };
    if (!extracted.scheduledDate) return { created: false };
    if (!extracted.scheduledTime) return { created: false };
    // Solo bloquear si falta el NOMBRE (cédula es opcional para citas)
    if (needsCustomerData && !extracted.customerName) {
      this.logger.log(`[Cita] Falta nombre del cliente — no se crea`);
      return { created: false };
    }
    if (this.appointmentInProgress.has(conversationId)) {
      this.logger.warn(`[Cita] Ya en progreso para ${conversationId}`);
      return { created: false };
    }

    this.appointmentInProgress.add(conversationId);

    try {
      // FIX: actualizar cliente con lo que tengamos (nombre siempre, cédula si existe)
      if (needsName && extracted.customerName) {
        await this.prisma.customer.update({
          where: { customerId: customer.customerId },
          data: {
            name: extracted.customerName.replace(/\b\w/g, l => l.toUpperCase()),
            ...(extracted.customerCedula && needsCedula && { cedula: extracted.customerCedula }),
          },
        });
        this.logger.log(`✅ [Cita] Cliente actualizado: ${extracted.customerName}${extracted.customerCedula ? ` — CC ${extracted.customerCedula}` : ''}`);
      } else if (!needsName && needsCedula && extracted.customerCedula) {
        // Cliente ya tiene nombre pero no cédula — aprovechar si la dio
        await this.prisma.customer.update({
          where: { customerId: customer.customerId },
          data: { cedula: extracted.customerCedula },
        });
        this.logger.log(`✅ [Cita] Cédula actualizada: ${extracted.customerCedula}`);
      }

      const scheduledAt = new Date(`${extracted.scheduledDate}T${extracted.scheduledTime}:00-05:00`);
      if (isNaN(scheduledAt.getTime())) {
        this.logger.warn(`[Cita] Fecha inválida: ${extracted.scheduledDate}T${extracted.scheduledTime}`);
        return { created: false };
      }

      // Validar horario aunque no se haya seleccionado un profesional específico
      if (!extracted.staffId) {
        const dayKey = coDayKey(scheduledAt);
        const [hReq, mReq] = (extracted.scheduledTime ?? '00:00').split(':').map(Number);
        const minReq = hReq * 60 + mReq;
        const DAY_NAMES: Record<string, string> = { sun:'domingos', mon:'lunes', tue:'martes', wed:'miércoles', thu:'jueves', fri:'viernes', sat:'sábados' };
        const staffLabel = (store as any)?.staffLabel ?? 'profesional';

        if (activeStaff.length > 0) {
          // Buscar staff disponible exactamente a la hora pedida
          const availableAtTime = activeStaff.filter(s => {
            const daySched = (s.schedule as any)?.[dayKey];
            if (!daySched?.isOpen) return false;
            return ['shift1', 'shift2'].some(shift => {
              const sh = daySched[shift];
              if (!sh?.open || !sh?.close) return false;
              const [shH, shM] = sh.open.split(':').map(Number);
              const [ehH, ehM] = sh.close.split(':').map(Number);
              return minReq >= shH * 60 + shM && minReq < ehH * 60 + ehM;
            });
          });

          if (availableAtTime.length > 0) {
            // Auto-asignar el primer disponible a esa hora
            extracted.staffId = availableAtTime[0].staffId;
            this.logger.log(`[Cita] Auto-asignado ${availableAtTime[0].name} para las ${extracted.scheduledTime} (cualquier barbero)`);
          } else {
            const anyoneWorks = activeStaff.some(s => (s.schedule as any)?.[dayKey]?.isOpen === true);
            this.cancelConfirmReminder(conversationId);
            if (!anyoneWorks) {
              const workDays = Object.entries(DAY_NAMES)
                .filter(([k]) => activeStaff.some(s => (s.schedule as any)?.[k]?.isOpen === true))
                .map(([, v]) => v);
              const daySugg = workDays.length > 0 ? ` Atendemos los ${workDays.join(', ')}.` : '';
              return {
                created: false,
                message: `Lo siento, no tenemos disponibilidad los ${DAY_NAMES[dayKey] ?? dayKey}.${daySugg} ¿Quieres elegir otro día? 😊`,
              };
            }
            // Recopilar ventanas horarias de todos los staff que trabajan ese día
            const availWindows: string[] = [];
            for (const s of activeStaff) {
              const ds = (s.schedule as any)?.[dayKey];
              if (!ds?.isOpen) continue;
              for (const sh of ['shift1', 'shift2']) {
                const t = ds[sh];
                if (t?.open && t?.close) availWindows.push(`${t.open}–${t.close}`);
              }
            }
            const uniqueWindows = [...new Set(availWindows)];
            const hourSugg = uniqueWindows.length > 0 ? ` Atendemos de ${uniqueWindows.join(' y ')}.` : '';
            return {
              created: false,
              message: `Lo siento, ningún ${staffLabel} está disponible a las ${extracted.scheduledTime}.${hourSugg} ¿Quieres elegir otra hora? 😊`,
            };
          }
        }
        // Sin staff pero con businessHours: bloquear si la tienda está cerrada ese día
        else if (store?.businessHours) {
          const dayBH = (store.businessHours as any)[dayKey];
          if (dayBH?.isOpen === false) {
            this.cancelConfirmReminder(conversationId);
            return {
              created: false,
              message: `Lo siento, estamos cerrados los ${DAY_NAMES[dayKey] ?? dayKey}. ¿Quieres elegir otro día? 😊`,
            };
          }
        }
      }

      // Validar que el barbero/profesional trabaje ese día y en ese horario
      if (extracted.staffId) {
        const staffMember = activeStaff.find(s => s.staffId === extracted.staffId);
        if (staffMember?.schedule) {
          const dayKey = coDayKey(scheduledAt);
          const daySched = (staffMember.schedule as any)[dayKey];
          this.logger.log(`[Cita] SCHED-CHECK staff=${staffMember.name} dayKey=${dayKey} isOpen=${daySched?.isOpen} scheduledAt=${scheduledAt.toISOString()}`);

          if (!daySched?.isOpen) {
            this.logger.warn(`[Cita] ${staffMember.name} no trabaja el ${dayKey} — pidiendo otra fecha`);
            this.cancelConfirmReminder(conversationId);
            const DN: Record<string, string> = { sun:'domingos', mon:'lunes', tue:'martes', wed:'miércoles', thu:'jueves', fri:'viernes', sat:'sábados' };
            const workDays = Object.entries(DN)
              .filter(([k]) => (staffMember.schedule as any)?.[k]?.isOpen === true)
              .map(([, v]) => v);
            const daySugg = workDays.length > 0 ? ` ${staffMember.name} trabaja los ${workDays.join(', ')}.` : '';
            return {
              created: false,
              message: `Lo siento, ${staffMember.name} no trabaja ese día.${daySugg} ¿Quieres elegir otro día o con otro profesional?`,
            };
          }

          // Verificar que la hora caiga dentro de algún turno del día
          const [hReq, mReq] = extracted.scheduledTime!.split(':').map(Number);
          const minReq = hReq * 60 + mReq;
          const inShift = ['shift1', 'shift2'].some(shift => {
            const s = daySched[shift];
            if (!s?.open || !s?.close) return false;
            const [sh, sm] = s.open.split(':').map(Number);
            const [eh, em] = s.close.split(':').map(Number);
            return minReq >= sh * 60 + sm && minReq < eh * 60 + em;
          });
          if (!inShift) {
            this.logger.warn(`[Cita] ${extracted.scheduledTime} fuera del turno de ${staffMember.name} el ${dayKey} — pidiendo otra hora`);
            this.cancelConfirmReminder(conversationId);
            const shiftWindows: string[] = [];
            for (const sh of ['shift1', 'shift2']) {
              const t = daySched[sh];
              if (t?.open && t?.close) shiftWindows.push(`${t.open}–${t.close}`);
            }
            const hourSugg = shiftWindows.length > 0 ? ` Hoy atiende de ${shiftWindows.join(' y ')}.` : '';
            return {
              created: false,
              message: `Lo siento, las ${extracted.scheduledTime} está fuera del horario de ${staffMember.name}.${hourSugg} ¿Quieres elegir otra hora? 😊`,
            };
          }
        }
      }

      const durationMinutes = extracted.durationMinutes ?? null;
      const endsAt          = durationMinutes ? new Date(scheduledAt.getTime() + durationMinutes * 60_000) : null;

      // ─── Rama de GRUPO (acompañantes): N citas back-to-back, mismo barbero/servicio ───
      const partySize = Math.trunc(extracted.partySize ?? 1);
      if (partySize > 1) {
        const N = partySize;
        const GROUP_CAP = 4;
        const staffLabel = (store as any)?.staffLabel ?? 'profesional';

        // Cap: grupos grandes → no auto-agendar, derivar a asesor
        if (N > GROUP_CAP) {
          this.cancelConfirmReminder(conversationId);
          this.pendingAppointments.delete(conversationId);
          return {
            created: false,
            message: `Para grupos de más de ${GROUP_CAP} personas prefiero que un asesor te coordine directamente para no dejarte mal con los horarios. Te contacta en breve. 🙌`,
          };
        }

        // Requiere barbero elegido si hay equipo (las N van con el mismo)
        if (activeStaff.length > 0 && !extracted.staffId) {
          this.cancelConfirmReminder(conversationId);
          return {
            created: false,
            message: `Para agendar a las ${N} personas necesito que elijas con qué ${staffLabel} las atendemos (van todas con el mismo): ${activeStaff.map(s => s.name).join(', ')}.`,
          };
        }

        const groupStaffId = extracted.staffId ?? activeStaff[0]?.staffId ?? null;
        const staffInfoG   = activeStaff.find(s => s.staffId === groupStaffId);
        const svcG         = services.find((s: any) => s.serviceId === extracted.serviceId);
        const D            = durationMinutes ?? svcG?.estimatedMinutes ?? 30;

        const to12 = (min: number): string => {
          const h = Math.floor(min / 60), m = min % 60;
          const period = h < 12 ? 'a. m.' : 'p. m.';
          const h12 = h % 12 === 0 ? 12 : h % 12;
          return `${h12}:${String(m).padStart(2, '0')} ${period}`;
        };

        // Slots libres del barbero ese día (solo lectura)
        let libresG: string[] = [];
        try {
          const slotsData = await this.computeSlotsForAI(storeId, scheduledAt, activeStaff as any, store as any);
          libresG = slotsData.find(s => s.name === staffInfoG?.name)?.slots ?? [];
        } catch (e: any) {
          this.logger.warn(`[Cita][Grupo] No se pudo computar slots: ${e?.message}`);
        }

        const [bh, bm] = extracted.scheduledTime!.split(':').map(Number);
        const baseMin  = bh * 60 + bm;
        const blockStart = this.findConsecutiveBlock(libresG, baseMin, N, D);

        if (!blockStart) {
          this.cancelConfirmReminder(conversationId);
          this.pendingAppointments.delete(conversationId);
          return {
            created: false,
            message: `Uy, no tengo ${N} turnos seguidos con ${staffInfoG?.name ?? 'ese profesional'} ese día. ¿Quieres mirar otro día u otro ${staffLabel}?`,
          };
        }

        const blockMin = (() => { const [h, m] = blockStart.split(':').map(Number); return h * 60 + m; })();

        // Si el bloque libre no arranca en la hora pedida, ofrecerlo y esperar confirmación
        if (blockMin !== baseMin) {
          this.cancelConfirmReminder(conversationId);
          return {
            created: false,
            message: `A las ${to12(baseMin)} no me caben los ${N} seguidos con ${staffInfoG?.name}. ¿Te sirve arrancando ${to12(blockMin)}? Los dejo back-to-back. 💈`,
          };
        }

        // Crear N citas back-to-back desde la hora pedida
        const createdGroup: any[] = [];
        for (let k = 0; k < N; k++) {
          const at   = new Date(scheduledAt.getTime() + k * D * 60_000);
          const ends = new Date(at.getTime() + D * 60_000);
          try {
            const appt = await this.insertAiAppointment(
              storeId, customer.customerId, groupStaffId, at, ends, D, extracted, `Persona ${k + 1} de ${N}`,
            );
            createdGroup.push({ appt, at });
            this.notifications.notifyAppointmentCreated(appt as any).catch(() => {});
          } catch (e: any) {
            this.logger.warn(`[Cita][Grupo] Falló la cita ${k + 1}/${N}: ${e?.message}`);
            break; // no revertir las ya creadas (mismo criterio que citas múltiples actuales)
          }
        }

        this.cancelConfirmReminder(conversationId);
        this.pendingAppointments.delete(conversationId);

        if (createdGroup.length === 0) {
          return {
            created: false,
            message: `Uy, no pude dejar los turnos (alguien tomó ese horario). ¿Probamos otra hora?`,
          };
        }

        // Registrar para que el extractor no re-extraiga el grupo
        const reg = this.conversationCreatedAppts.get(conversationId) ?? [];
        for (const g of createdGroup) {
          reg.push({
            scheduledDate: extracted.scheduledDate!,
            scheduledTime: `${String(g.at.getHours()).padStart(2, '0')}:${String(g.at.getMinutes()).padStart(2, '0')}`,
            type: extracted.type ?? 'cita',
          });
        }
        this.conversationCreatedAppts.set(conversationId, reg);
        setTimeout(() => this.conversationCreatedAppts.delete(conversationId), ORDER_GUARD_TTL_MS);

        await this.prisma.conversation.update({ where: { conversationId }, data: { status: 'pending_human' } });

        const horas = createdGroup
          .map(g => g.at.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' }))
          .join(', ');
        const fechaG = scheduledAt.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Bogota' });
        const profLine = staffInfoG?.name ? ` con ${staffInfoG.name}` : '';
        const faltaron = createdGroup.length < N
          ? `\n\n(Solo pude dejar ${createdGroup.length} de ${N}; para el resto te contacta un asesor.)`
          : '';

        this.logger.log(`✅ [Cita][Grupo] ${createdGroup.length}/${N} citas — ${extracted.scheduledDate} desde ${extracted.scheduledTime}`);
        return {
          created: true,
          message: `¡Listo! ✅ Dejé ${createdGroup.length} turno${createdGroup.length > 1 ? 's' : ''}${profLine} el ${fechaG}: ${horas}.${faltaron}\n\nUn asesor confirma pronto. ¡Gracias! 😊`,
        };
      }

      // Reagendar solo si NO se ha creado ninguna cita en esta conversación aún.
      // Si ya hay citas creadas (múltiples citas en una misma conversación), siempre crear nueva.
      const alreadyCreatedInSession = (this.conversationCreatedAppts.get(conversationId) ?? []).length;
      const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const existingAppt = alreadyCreatedInSession === 0
        ? await this.prisma.appointment.findFirst({
            where: {
              storeId,
              customerId: customer.customerId,
              status:     { in: ['PENDING', 'CONFIRMED'] },
              source:     'AI',
              createdAt:  { gte: cutoff },
            },
            orderBy: { createdAt: 'desc' },
          })
        : null;

      let appointment: any;

      if (existingAppt && existingAppt.scheduledAt.getTime() === scheduledAt.getTime()) {
        // Mismo horario exacto → ya existe esta cita, evitar duplicado (idempotente)
        this.logger.log(`[Cita] Cita idéntica ya existe ${existingAppt.appointmentId} — sin duplicar`);
        appointment = existingAppt;
      } else if (existingAppt) {
        // Horario diferente → reagendar la cita existente al nuevo horario
        this.logger.log(`[Cita] Reagendando cita existente ${existingAppt.appointmentId} → ${extracted.scheduledDate} ${extracted.scheduledTime}`);
        appointment = await this.prisma.$transaction(async (tx) => {
          const appt = await tx.appointment.update({
            where: { appointmentId: existingAppt.appointmentId },
            data: {
              scheduledAt,
              endsAt,
              durationMinutes,
              ...(extracted.address     && { address:      extracted.address }),
              ...(extracted.description && { description:  extracted.description }),
              ...(extracted.agreedPrice && { agreedPrice:  extracted.agreedPrice }),
              status: 'PENDING',
              pendingAction:     null,
              pendingActionAt:   null,
              pendingActionData: Prisma.JsonNull,
            },
          });
          await tx.appointmentTimeline.create({
            data: {
              appointmentId: appt.appointmentId,
              action:        'RESCHEDULED',
              newStatus:     'PENDING',
              note:          `Cita reagendada automáticamente por el asistente de WhatsApp a ${extracted.scheduledDate} ${extracted.scheduledTime}`,
              isPublic:      true,
              performedById: null,
            },
          });
          return appt;
        });
      } else {
        // Auto-asignar primer staff disponible si el cliente no especificó uno
        let resolvedStaffId = extracted.staffId ?? null;
        if (!resolvedStaffId && activeStaff.length > 0) {
          const slotEnd = endsAt ?? new Date(scheduledAt.getTime() + 30 * 60_000);
          const dayKey = coDayKey(scheduledAt);
          const [hReq, mReq] = extracted.scheduledTime!.split(':').map(Number);
          const minReq = hReq * 60 + mReq;
          for (const s of activeStaff) {
            const sched = (s.schedule as any)?.[dayKey] ?? (store?.businessHours as any)?.[dayKey];
            if (sched?.isOpen === false) continue;
            if (sched) {
              const inShift = ['shift1', 'shift2'].some(sh => {
                const t = sched[sh];
                if (!t?.open || !t?.close) return false;
                const [shH, shM] = t.open.split(':').map(Number);
                const [ehH, ehM] = t.close.split(':').map(Number);
                return minReq >= shH * 60 + shM && minReq < ehH * 60 + ehM;
              });
              if (!inShift) continue;
            }
            const busy = await this.prisma.appointment.findFirst({
              where: {
                staffId: s.staffId,
                status: { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
                AND: [
                  { scheduledAt: { lt: slotEnd } },
                  { OR: [
                    { endsAt: { gt: scheduledAt } },
                    { endsAt: null, scheduledAt: { gt: new Date(scheduledAt.getTime() - 30 * 60_000) } },
                  ]},
                ],
              },
            });
            if (!busy) {
              resolvedStaffId = s.staffId;
              this.logger.log(`[Cita] Auto-asignando ${s.name} (primer disponible en el slot)`);
              break;
            }
          }
          if (!resolvedStaffId) {
            this.pendingAppointments.delete(conversationId);
            this.cancelConfirmReminder(conversationId);
            return {
              created: false,
              message: `Lo siento, no hay disponibilidad a las ${extracted.scheduledTime}. ¿Quieres elegir otra hora?`,
            };
          }
        }

        // Conflict check before transaction to return a proper message
        if (resolvedStaffId) {
          const slotEnd = endsAt ?? new Date(scheduledAt.getTime() + 30 * 60_000);
          const preConflict = await this.prisma.appointment.findFirst({
            where: {
              staffId: resolvedStaffId,
              status: { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
              AND: [
                { scheduledAt: { lt: slotEnd } },
                { OR: [
                  { endsAt: { gt: scheduledAt } },
                  { endsAt: null, scheduledAt: { gt: new Date(scheduledAt.getTime() - 30 * 60_000) } },
                ]},
              ],
            },
          });
          if (preConflict) {
            this.pendingAppointments.delete(conversationId);
            this.cancelConfirmReminder(conversationId);
            const staffInfo = activeStaff.find(s => s.staffId === resolvedStaffId);
            // En vez de un genérico "elige otra hora", ofrecer de una el slot LIBRE más
            // cercano de ESE profesional ese día (primero el siguiente a la hora pedida;
            // si no hay más tarde, el libre más cercano antes).
            let sugerencia = ' ¿Quieres elegir otra hora disponible?';
            try {
              const slotsData = await this.computeSlotsForAI(storeId, scheduledAt, activeStaff as any, store as any);
              const libres = slotsData.find(s => s.name === staffInfo?.name)?.slots ?? [];
              if (libres.length > 0) {
                const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
                const [rh, rm] = extracted.scheduledTime!.split(':').map(Number);
                const reqMin   = rh * 60 + rm;
                const after    = libres.filter(t => toMin(t) > reqMin).sort((a, b) => toMin(a) - toMin(b));
                const pick     = after[0] ?? [...libres].sort((a, b) => toMin(b) - toMin(a))[0];
                if (pick) {
                  const [h, m] = pick.split(':').map(Number);
                  const period = h < 12 ? 'a. m.' : 'p. m.';
                  const h12    = h % 12 === 0 ? 12 : h % 12;
                  sugerencia = ` ¿Te sirve a las ${h12}:${String(m).padStart(2, '0')} ${period}?`;
                }
              }
            } catch (e: any) {
              this.logger.warn(`[Cita] No se pudo computar slot sugerido tras conflicto: ${e?.message}`);
            }
            return {
              created: false,
              message: `Lo siento, ese horario ya está ocupado para ${staffInfo?.name ?? 'el profesional'}.${sugerencia}`,
            };
          }
        }

        appointment = await this.insertAiAppointment(
          storeId,
          customer.customerId,
          resolvedStaffId,
          scheduledAt,
          endsAt,
          durationMinutes,
          extracted,
        );
      }

      await this.prisma.conversation.update({ where: { conversationId }, data: { status: 'pending_human' } });
      this.pendingAppointments.delete(conversationId);
      this.cancelConfirmReminder(conversationId);
      this.logger.log(`✅ [Cita] ${appointment.appointmentId} — ${extracted.scheduledDate} ${extracted.scheduledTime}`);
      this.notifications.notifyAppointmentCreated(appointment as any).catch(() => {});

      // Registrar cita creada para que el extractor no la vuelva a extraer
      const created = this.conversationCreatedAppts.get(conversationId) ?? [];
      created.push({ scheduledDate: extracted.scheduledDate!, scheduledTime: extracted.scheduledTime!, type: extracted.type ?? 'cita' });
      this.conversationCreatedAppts.set(conversationId, created);
      setTimeout(() => this.conversationCreatedAppts.delete(conversationId), ORDER_GUARD_TTL_MS);

      const nombreMostrar   = extracted.customerName ? extracted.customerName.split(' ')[0] : customer.name ? customer.name.split(' ')[0] : null;
      const nombreCliente   = nombreMostrar ? `, ${nombreMostrar}` : '';
      const fechaFormateada = scheduledAt.toLocaleDateString('es-CO', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        timeZone: 'America/Bogota',
      });
      const horaFormateada = scheduledAt.toLocaleTimeString('es-CO', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
      });

      const staffName = extracted.staffName
        ?? (appointment.staffId ? activeStaff.find(s => s.staffId === appointment.staffId)?.name : undefined);
      const staffLine = staffName ? `\n👤 *Profesional:* ${staffName}` : '';

      return {
        created: true,
        message:
          `¡Cita agendada${nombreCliente}! ✅\n\n` +
          `📆 *Fecha:* ${fechaFormateada}\n` +
          `🕐 *Hora:* ${horaFormateada}` +
          staffLine +
          (durationMinutes ? `\n⏱ *Duración estimada:* ${Math.floor(durationMinutes / 60)}h${durationMinutes % 60 > 0 ? ` ${durationMinutes % 60}min` : ''}` : '') +
          (extracted.agreedPrice ? `\n💰 *Precio acordado:* $${Number(extracted.agreedPrice).toLocaleString('es-CO')}` : '') +
          (extracted.address ? `\n📍 *Dirección:* ${extracted.address}` : '') +
          (extracted.description ? `\n📝 *Descripción:* ${extracted.description}` : '') +
          `\n\nUn asesor confirmará tu cita pronto. ¡Gracias! 😊`,
      };

    } finally {
      this.appointmentInProgress.delete(conversationId);
    }
  }

  // ─── System prompt ────────────────────────────────────────────────────────────

  private buildSystemPrompt(
    basePrompt: string,
    customer: any,
    orders: any[],
    appointments: any[],
    products: any[],
    services: any[],
    fechaActual: string,
    horaActual: string,
    history: any[],
    latestMessage: string,
    addressAlreadyGiven: boolean,
    settings: StoreSettings,
    lastConversationSummary: string | null = null,
    store: any = null,
    activeStaff: Array<{ staffId: string; name: string; schedule?: any }> = [],
    availabilityBlock = '',
    includeCatalog = true,
    activeAppt: any = null,
  ): string {
    const sep           = '\n===================================================\n';
    const nombreCliente = customer.name ?? null;

    const clienteSection = `CLIENTE:
- Nombre: ${nombreCliente ?? 'No registrado aún'}
- Cédula: ${customer.cedula ?? 'No registrada aún'}
- Ciudad: ${customer.city ?? 'No registrada'}
- ${nombreCliente
    ? `Llámalo ${nombreCliente} de forma natural (no en cada mensaje).`
    : `No sabes el nombre. No lo inventes. Lo pedirás cuando generes una orden o cita.`}
- NUNCA menciones datos de otros clientes.`;

    const clientMessages  = [
      ...history.filter((m: any) => !m.isAiResponse).map((m: any) => m.content),
      latestMessage,
    ];
    const allClientText   = clientMessages.join(' ').toLowerCase();
    const datosMencionados: string[] = [];

    [...products, ...services].forEach((item: any) => {
      if (allClientText.includes(item.name.toLowerCase())) {
        datosMencionados.push(`✅ Item mencionado: "${item.name}"`);
      }
    });
    if (addressAlreadyGiven) {
      datosMencionados.push('✅ Dirección: YA FUE DADA — NO LA VUELVAS A PEDIR');
    }

    const datosSection = datosMencionados.length > 0
      ? `DATOS YA RECOPILADOS (NO LOS VUELVAS A PEDIR):\n${datosMencionados.join('\n')}`
      : `DATOS RECOPILADOS: Ninguno aún.`;

    const STATUS_LABELS: Record<string, string> = {
      pending: 'Pendiente', confirmed: 'Confirmado', preparing: 'En preparación',
      ready: 'Listo', delivered: 'Entregado', cancelled: 'Cancelado',
    };

    let ordenesSection: string;
    if (orders.length === 0) {
      ordenesSection = `PEDIDOS ANTERIORES: Ninguno.`;
    } else {
      const textoOrdenes = orders.map((o: any, i: number) => {
        const fecha = new Date(o.createdAt).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
        const items = o.orderItems.map((it: any) => `    · ${it.product?.name ?? 'Item'} x${it.quantity} — $${it.unitPrice}`).join('\n');
        return `  Pedido #${i + 1} (${fecha}) — ${STATUS_LABELS[o.status] ?? o.status} — $${o.total}\n${items}`;
      }).join('\n\n');
      ordenesSection = `PEDIDOS ANTERIORES:\n${textoOrdenes}\nREGLA: Solo muestra estos. Si pregunta por uno que no aparece, remite a asesor.`;
    }

    const APPT_STATUS_LABELS: Record<string, string> = {
      PENDING: 'Pendiente de confirmar', CONFIRMED: 'Confirmada', IN_PROGRESS: 'En curso',
      COMPLETED: 'Completada', CANCELLED: 'Cancelada', NO_SHOW: 'No se presentó', RESCHEDULED: 'Reagendada',
    };

    let citasSection: string;
    if (appointments.length === 0) {
      citasSection = `CITAS/AGENDAMIENTOS ANTERIORES: Ninguno.`;
    } else {
      const textoCitas = appointments.map((a: any, i: number) => {
        const fecha = new Date(a.scheduledAt).toLocaleDateString('es-CO', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Bogota',
        });
        const hora = new Date(a.scheduledAt).toLocaleTimeString('es-CO', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
        });
        const servicioNombre = a.service?.name
          ? ` — ${a.service.name}${a.serviceVariant ? ` (${a.serviceVariant.name})` : ''}`
          : '';
        return (
          `  Cita #${i + 1}${servicioNombre} — ${fecha} a las ${hora}\n` +
          `  Estado: ${APPT_STATUS_LABELS[a.status] ?? a.status}` +
          (a.description ? `\n  Descripción: ${a.description}` : '')
        );
      }).join('\n\n');
      citasSection = `CITAS/AGENDAMIENTOS:\n${textoCitas}`;
    }

    let citaActivaSection = '';
    if (activeAppt) {
      const f = new Date(activeAppt.scheduledAt).toLocaleDateString('es-CO', {
        weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Bogota',
      });
      const h = new Date(activeAppt.scheduledAt).toLocaleTimeString('es-CO', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
      });
      const svc  = activeAppt.service?.name
        ? `${activeAppt.service.name}${activeAppt.serviceVariant ? ` (${activeAppt.serviceVariant.name})` : ''}`
        : 'servicio';
      const prof = activeAppt.staff?.name ? ` con ${activeAppt.staff.name}` : '';
      citaActivaSection =
        `⚠️ CITA ACTIVA DE ESTE CLIENTE (fuente de verdad — NO la ignores):\n` +
        `- ${svc}${prof} — ${f} a las ${h} — Estado: ${APPT_STATUS_LABELS[activeAppt.status] ?? activeAppt.status}\n` +
        `REGLAS:\n` +
        `- Este cliente YA tiene una cita. NO agendes otra salvo que pida explícitamente una distinta.\n` +
        `- Si dice que va en camino / llega tarde / "ya le llego" / "confírmamela" → confírmale que su cita SIGUE EN PIE con esos datos. NUNCA digas que no tiene cita.`;
    }

    const hasItems = products.length > 0 || services.length > 0;
    let catalogoSection: string;

    if (!hasItems) {
      catalogoSection = `CATÁLOGO: Sin productos ni servicios registrados.`;
    } else if (!includeCatalog) {
      // Modo compacto: solo nombres para mensajes sin intención de compra/cita
      const prodNames = products.map((p: any) => p.name).join(', ');
      const svcNames  = services.map((s: any) => s.name).join(', ');
      catalogoSection = [
        prodNames ? `PRODUCTOS DISPONIBLES: ${prodNames}` : null,
        svcNames  ? `SERVICIOS DISPONIBLES: ${svcNames}` : null,
        `(El cliente puede pedir detalles, precios o agendar en cualquier momento.)`,
      ].filter(Boolean).join('\n');
    } else {
      const productosTxt = products.length > 0
        ? products.map((p: any) => {
            const lines = [`  · ${p.name}`];
            if (p.description) {
              const clean = p.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
              if (clean) lines.push(`    ${clean}`);
            }
            if (p.variants?.length > 0) {
              p.variants.forEach((v: any) => {
                lines.push(`    - ${v.name}: $${Number(v.salePrice).toLocaleString('es-CO')} | ${v.stock === 0 ? '⚠️ AGOTADO' : `${v.stock} disp.`}`);
              });
            } else {
              lines.push(`    Precio: $${Number(p.salePrice).toLocaleString('es-CO')} | ${p.stock === 0 ? '⚠️ AGOTADO' : `${p.stock} disp.`}`);
              if (p.hasShipping) lines.push(`    Incluye envío`);
            }
            return lines.join('\n');
          }).join('\n\n')
        : null;

      const serviciosTxt = services.length > 0
        ? services.map((s: any) => {
            const precioTxt = this.buildServicePriceLabel(s);
            const lines     = [`  · ${s.name} — ${precioTxt}`];
            if (s.description) {
              const clean = s.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
              if (clean) lines.push(`    ${clean}`);
            }
            if (s.estimatedMinutes) {
              const h = Math.floor(s.estimatedMinutes / 60);
              const m = s.estimatedMinutes % 60;
              lines.push(`    Duración: ${h > 0 ? `${h}h` : ''}${m > 0 ? ` ${m}min` : ''}`);
            }
            if (s.hasVariants && s.variants?.length > 0) {
              lines.push(`    Variantes:`);
              s.variants.forEach((v: any) => {
                const pv = v.priceOverride ? `$${Number(v.priceOverride).toLocaleString('es-CO')}` : v.priceModifier ? `${v.priceModifier > 0 ? '+' : ''}${v.priceModifier}% sobre base` : 'Precio base';
                lines.push(`      - ${v.name}: ${pv}`);
              });
            }
            return lines.join('\n');
          }).join('\n\n')
        : null;

      const partes = [
        productosTxt ? `PRODUCTOS:\n${productosTxt}` : null,
        serviciosTxt ? `SERVICIOS:\n${serviciosTxt}` : null,
      ].filter(Boolean).join('\n\n');

      catalogoSection = `CATÁLOGO:\n${partes}
REGLAS:
- Habla SOLO de estos items.
- No inventes precios ni características.
- Si el stock es AGOTADO, avísalo y ofrece alternativa si hay.
- Para servicios VARIABLE, explica que el precio se cotiza y un asesor confirmará.`;
    }

    const clienteDataPendiente = !customer.name;
    // Nombres de métodos: store.paymentMethods (lista simple del negocio) o, si no hay,
    // los labels de settings.paymentMethods (lista estructurada con datos de cuenta).
    const storePayNames        = ((store as any)?.paymentMethods as string[] | undefined)?.filter(Boolean) ?? [];
    const settingsPayNames     = (settings.paymentMethods ?? []).map(m => m.label).filter(Boolean);
    const paymentMethodNames   = (storePayNames.length > 0 ? storePayNames : settingsPayNames).join(', ');
    const hasPaymentMethods    = paymentMethodNames.length > 0;
    const paymentInstruction   = hasPaymentMethods
      ? `- Formas de pago aceptadas: ${paymentMethodNames}. Puedes informar al cliente CUÁLES son (los nombres) cuando pregunte o al tomar el pedido.\n- NO des los números de cuenta, Nequi ni datos para transferir antes de confirmar el pedido — esos se envían automáticamente al registrarlo.`
      : `- Si el cliente pregunta por métodos de pago: "Un asesor te contactará con esa información."`;

    const requiresCedula = !!(store as any)?.requiresCustomerCedula && !customer.cedula;
    const cedulaLine = requiresCedula ? `\n  e) Número de cédula del cliente (obligatorio para la guía de envío)` : '';
    const pedidoAsks = ['tu nombre completo', 'dirección de entrega', requiresCedula ? 'número de cédula' : null].filter(Boolean).join(', ');

    const flujoSection = `FLUJO DE TOMA DE ORDEN (PRODUCTOS Y SERVICIOS):

Para crear un pedido necesito:
  a) Productos o servicios con cantidad
  b) Dirección de entrega completa
  c) ${!customer.name ? 'Nombre completo del cliente' : '(nombre ya registrado)'}
  d) Confirmación explícita${cedulaLine}

${requiresCedula ? `CÉDULA OBLIGATORIA: este negocio necesita el número de cédula del cliente para generar la guía de envío. Pídela junto con la dirección (no por separado) y NO confirmes el pedido sin ella.\n` : ''}${!customer.name ? `IMPORTANTE: Cuando el cliente muestre intención de compra PIDE todo de una:\n"Para registrar tu pedido necesito ${pedidoAsks}."` : (requiresCedula ? `IMPORTANTE: cuando el cliente vaya a comprar, pídele dirección de entrega y número de cédula juntos.` : '')}

ANTI-LOOP:
- Si un dato ya está en DATOS YA RECOPILADOS, NO lo vuelvas a pedir.
- Si ya tienes todo, muestra el resumen y pide SOLO confirmación.

SOBRE ENVÍO Y PAGOS:
- NUNCA calcules ni menciones costos de envío.
${paymentInstruction}

PROHIBIDO:
- Pedir datos que ya tienes.
- Inventar precios o características.
- Mencionar items fuera del catálogo.`;

    const staffLabel = ((store as any)?.staffLabel ?? 'profesional').toLowerCase();
    const staffLabelCap = staffLabel.charAt(0).toUpperCase() + staffLabel.slice(1);

    const staffBlock = activeStaff.length > 0
      ? `\nEQUIPO DISPONIBLE (${staffLabelCap}s):\n${activeStaff.map((s: { staffId: string; name: string; schedule?: any }) => {
          const schedLine = s.schedule
            ? `\n    Horario: ${formatBusinessHoursForAI(s.schedule as any).split('\n').join(', ')}`
            : '';
          return `- ${s.name} (id: ${s.staffId})${schedLine}`;
        }).join('\n')}\n\nREGLA OBLIGATORIA DE AGENDAMIENTO CON EQUIPO:\n1. SIEMPRE pregunta una vez: "¿Con qué ${staffLabel} quieres tu cita? Disponibles: ${activeStaff.map((s: { staffId: string; name: string }) => s.name).join(', ')}". El cliente DEBE elegir antes de confirmar; ya elegido, no vuelvas a preguntar.\n2. ANTES de proponer, agendar o confirmar una fecha con un ${staffLabel}, verifica SIEMPRE su horario (arriba, "Horario: ...") para ese día. Si muestra "Cerrado" o no incluye ese día, NO trabaja: NO lo ofrezcas, NO digas que quedó agendado con él, y avisa de una proponiendo otro día u otro ${staffLabel}. Verifica ANTES de responder, nunca después de prometer. Si el elegido no está disponible a esa hora, avisa y sugiere otra hora/${staffLabel} — nunca confirmes primero y corrijas después.\n3. Si preguntan por el horario de un ${staffLabel}, usa el de arriba.\n4. NUNCA des por elegido/asignado a un ${staffLabel} si el cliente no lo eligió EXPLÍCITAMENTE ("con X", "quiero con X", "que me atienda X", "agéndame con X"). Si no eligió, pregúntale; jamás asumas o inventes. OJO: NO es elección, aunque suene a un nombre del equipo: (a) el nombre del propio cliente (su nombre de WhatsApp); (b) un saludo/bendición/palabra suelta al inicio ("Oward Dios te bendiga", "Hola Jhon"); (c) un nombre mal escrito o ambiguo. Ante la duda, pregunta.`
      : '';

    const defaultSvc = store?.defaultServiceId
      ? services.find((s: any) => s.serviceId === store.defaultServiceId)
      : null;
    const defaultSvcRule = defaultSvc
      ? `\nSERVICIO PREDETERMINADO: si el cliente pide un turno/cita y NO especifica el servicio, agéndalo con "${defaultSvc.name}" sin preguntar cuál — no alargues. Solo pregunta el servicio si el cliente claramente quiere algo distinto.`
      : '';
    const horaVagaRule =
      `\nHORA VAGA: si el cliente da una hora imprecisa ("desde las 8", "en la mañana", "lo más temprano", "por ahí a las 7"), NO preguntes una y otra vez: ofrece el horario libre real más cercano de la AGENDA REAL que te paso y pide UNA confirmación. Nunca inventes una hora que no esté libre.`;

    // Saludo personalizado: si ya conocemos el nombre (p. ej. por pushName de WhatsApp),
    // saluda por el primer nombre en el primer mensaje.
    const saludoNombre = customer.name ? ` ${customer.name.split(' ')[0]}` : '';
    // Datos a pedir en el primer mensaje. Si hay servicio predeterminado, NO se pide el servicio.
    const primerMsgAsks = [
      defaultSvc ? null : `   - ¿Qué servicio desea?`,
      activeStaff.length > 0 ? `   - ¿Con qué ${staffLabel} prefiere? (${activeStaff.map((s: { name: string }) => s.name).join(', ')})` : null,
      `   - ¿Qué día y hora prefiere?`,
      clienteDataPendiente ? `   - Su nombre completo.` : null,
    ].filter(Boolean).join('\n');
    const ejemploAsks = [
      defaultSvc ? null : `qué servicio deseas`,
      activeStaff.length > 0 ? `con quién prefieres (${activeStaff.map((s: { name: string }) => s.name).join(' o ')})` : null,
      `para qué día y hora`,
    ].filter(Boolean).join(', ');
    const defaultSvcNota = defaultSvc
      ? `\n   (NO preguntes el servicio: por defecto es "${defaultSvc.name}". Solo pregúntalo si el cliente claramente pide algo distinto.)`
      : '';

    const agendamientoSection = `FLUJO DE AGENDAMIENTO (CITAS Y SERVICIOS):

PRIMER MENSAJE — REGLA CRÍTICA: cuando el cliente muestre intención de agendar (o salude en un negocio de citas), en TU PRIMER MENSAJE: saludo breve y amable${saludoNombre ? `, llamándolo por su nombre (${saludoNombre.trim()})` : ''}, y pregunta TODO de una sin esperar respuesta intermedia:
${primerMsgAsks}${defaultSvcNota}
Ejemplo: "¡Hola${saludoNombre}! 👋 Para agendar tu cita necesito: ${ejemploAsks}?${clienteDataPendiente ? ' También tu nombre completo.' : ''}"
Aplica a CUALQUIER negocio de citas (barbería, salón, taller, consultorio, reparaciones...), con términos genéricos "${staffLabel}", "servicio", "cita". NO preguntes de a una; recoge todo en un intercambio.

Con todo listo, muestra resumen y pide confirmación: "¿Confirmamos tu cita de [servicio] con [profesional] para el [fecha] a las [hora]?"

ACOMPAÑANTES (GRUPO): si viene con acompañantes ("venimos 3", "yo y mi hijo", "somos 2"), son citas separadas consecutivas (back-to-back) con el MISMO profesional y servicio. Pide UNA sola confirmación listando horarios ("Para confirmar: 3 cortes con [profesional] desde las 3:00 p. m. (3:00, 3:30 y 4:00). ¿Todo bien?"). NO confirmes una por una; el sistema calcula horarios y crea las citas, tú confirmas una vez.

IMPORTANTE:
- Hora ambigua ("3") → pregunta "¿A las 3pm?".
- Servicios VARIABLE: el precio lo confirma un asesor en la visita.
- PRECIO Y DURACIÓN: menciónalos UNA vez por conversación (al presentar el servicio); no los repitas en confirmaciones, avisos de no disponibilidad ni mensajes posteriores.
${staffBlock}

DISPONIBILIDAD: si pregunta por horarios sin decir el día, pregunta "¿Para qué día quieres consultar la disponibilidad?"
${defaultSvcRule}${horaVagaRule}
`;

    // Contexto de conversaciones anteriores (generado por el cleanup nocturno)
    const contextoPrevio = lastConversationSummary
      ? `HISTORIAL DEL CLIENTE (conversación anterior archivada):\n${lastConversationSummary}\n\nUSA ESTE CONTEXTO para dar un servicio más personalizado. No repitas preguntas que ya se respondieron en conversaciones previas.`
      : `HISTORIAL DEL CLIENTE: Primera interacción o sin historial previo.`;

    const audioSection = `AUDIO: entiendes notas de voz (el sistema las transcribe y recibes el texto). Responde natural sin mencionar el audio salvo que el contexto lo pida; si preguntan si escuchas audios, di que sí.`;

    const antiBucleSection = `CONFIRMACIONES (REGLA ABSOLUTA — NUNCA VIOLAR — un cliente real recibió una confirmación falsa por esto):
- La confirmación REAL la genera el SISTEMA: "¡Cita agendada! ✅" (citas) o "¡Pedido registrado! 🎉" (pedidos). Si ese mensaje exacto NO aparece en el historial, la cita/pedido NO existe — sin importar cuántas veces el cliente diga "sí" o "confirmo".
- NUNCA afirmes ni insinúes que una cita/pedido quedó creado ("cita confirmada/registrada/agendada", "quedas agendado", "nos vemos el X", "hasta entonces", "ya quedó", "ya está", "pedido confirmado/registrado", "en camino", "procesando tu compra", etc.) si no ves ese mensaje del sistema. NUNCA inventes un éxito.
- Si el cliente dice "sí" y la cita/pedido aún NO fue creado: responde con el resumen pidiendo confirmación explícita ("Para confirmar: [servicio] con [profesional] el [fecha] a las [hora]. ¿Todo correcto?" / "Para confirmar tu pedido: [items], envío a [dirección]. ¿Todo bien?"). NUNCA "dame un momento" ni "estoy procesando" — el sistema no manda nada después y el cliente quedaría esperando.
- Si el sistema no pudo crearla, pide otro horario/producto o que reconfirme los datos.
- INVERSA — NO repreguntes algo ya confirmado: si en el historial ya está "¡Cita agendada! ✅" o "¡Pedido registrado! 🎉", eso YA quedó creado — no preguntes "¿confirmas?" ni repitas el resumen. Si el cliente dice "ok/listo/gracias" después, solo agradece o despídete breve ("¡De nada! Cualquier cosa me avisas 😊"); nunca reabras la confirmación.

ANTI-BUCLE (OBLIGATORIO):
- Si ya hiciste una pregunta y el cliente respondió algo (aunque no sea exacto), NO la repitas: avanza con lo que dijo.
- Si el cliente pregunta otra cosa en vez de responder la tuya, contéstale eso directamente. Nunca hagas la misma pregunta dos veces seguidas.
- Varios mensajes juntos (separados por salto de línea) = léelos como uno solo.
- SALUDO UNA SOLA VEZ: el saludo/presentación va SOLO en tu primer mensaje. Si ya saludaste en el historial, NO vuelvas a saludar: continúa respondiendo. Re-saludar en cada turno es un error.`;

    const brevedadRule =
      `\nBREVEDAD (OBLIGATORIO): respuestas cortas estilo WhatsApp (1-3 líneas). NO re-listes todos los profesionales en cada mensaje. NO vuelvas a pedir datos que el cliente ya dio o que el sistema ya tiene (nombre, etc.). Cuando tengas día + hora + servicio, propón UNA confirmación corta y agenda; no des pasos extra.`;

    // Ejemplo de formato de catálogo: solo cuando hay catálogo que mostrar.
    const formatoCatalogoEjemplo = (hasItems && includeCatalog)
      ? `\n- Para mostrar el catálogo usa este estilo limpio (saltos de línea, no guiones ni líneas decorativas):
    Tenemos disponible:

    [emoji] Nombre del producto
    Precio: $XX.000 | X unidades disponibles
- Emojis sugeridos: 📦 productos, 🔧 servicios, 🛍️ catálogo general.`
      : '';
    const formatoSection = `FORMATO DE MENSAJES (MUY IMPORTANTE):
- NUNCA uses asteriscos (*) para negritas ni nada.
- NUNCA uses guiones seguidos (---) como separadores ni viñetas con guion (- item); usa emojis o texto plano.
- El texto debe verse limpio en WhatsApp, sin ningún símbolo de formato visible.${formatoCatalogoEjemplo}${brevedadRule}`;

    // ── Información del negocio ───────────────────────────────────────────────
    const negocioLines: string[] = [];
    if (store) {
      if (store.description)        negocioLines.push(store.description);
      if (store.address)            negocioLines.push(`📍 Dirección: ${store.address}${store.neighborhood ? `, ${store.neighborhood}` : ''}`);
      if (store.directions)         negocioLines.push(`🗺️ Cómo llegar: ${store.directions}`);
      if (store.googleMapsUrl)      negocioLines.push(`🔗 Google Maps: ${store.googleMapsUrl}`);
      if (store.email)              negocioLines.push(`📧 Email: ${store.email}`);
      if (store.website)            negocioLines.push(`🌐 Web: ${store.website}`);
      if (store.instagram)          negocioLines.push(`📸 Instagram: @${store.instagram}`);
      if (store.facebook)           negocioLines.push(`📘 Facebook: ${store.facebook}`);
      if (store.tiktok)             negocioLines.push(`🎵 TikTok: @${store.tiktok}`);
      if ((store.paymentMethods as string[])?.length > 0)
        negocioLines.push(`💳 Formas de pago: ${(store.paymentMethods as string[]).join(', ')}`);
      if (store.paymentAccount)     negocioLines.push(`🏦 Nequi/Cuenta: ${store.paymentAccount}`);
      if (store.requiresDeposit)    negocioLines.push(`💰 Se requiere anticipo de ${store.depositAmount ?? 'un monto a convenir'} para confirmar la cita.`);
      if (store.cancellationPolicy) negocioLines.push(`❌ Cancelaciones: ${store.cancellationPolicy}`);
      if (store.hasDelivery)        negocioLines.push(`🚗 Servicio a domicilio${store.deliveryZone ? ` en: ${store.deliveryZone}` : ''}.`);
      if (store.hasParking)         negocioLines.push(`🅿️ Contamos con parqueadero disponible.`);
      if (store.minAdvanceMinutes) {
        const h = Math.round(store.minAdvanceMinutes / 60);
        negocioLines.push(`⏰ Citas con mínimo ${h} hora${h !== 1 ? 's' : ''} de anticipación.`);
      }
    }
    const negocioSection = negocioLines.length > 0
      ? `INFORMACIÓN DEL NEGOCIO:\n${negocioLines.join('\n')}`
      : '';

    // ── Horarios ──────────────────────────────────────────────────────────────
    const horariosSection = store?.businessHours
      ? `HORARIO DE ATENCIÓN:\n${formatBusinessHoursForAI(store.businessHours as any)}\n\nREGLA CRÍTICA DE HORARIOS: NUNCA agendes citas fuera del horario de atención. Si el cliente pide una hora no disponible, sugiere la hora válida más cercana. Si el día solicitado está cerrado, sugiere el próximo día hábil.`
      : '';

    const negocioNombre = store?.name ?? 'este negocio';
    const estilistaNombre = (store as any)?.ownerName ?? 'nuestro estilista';
    const temaSection = `ALCANCE DE LA CONVERSACIÓN (REGLA OBLIGATORIA — SIEMPRE ACTIVA, por encima del prompt del negocio):
- Solo respondes si el mensaje es de ${negocioNombre} (productos, servicios, citas, pedidos, horarios, ubicación, políticas), O si el cliente coordina una cita activa (va en camino, llega tarde, confirma, pregunta por su cita), O si es un saludo de apertura de alguien que busca atención.
- SILENCIO TOTAL en cualquier otro caso (felicitaciones, chistes, temas personales, "¿estás trabajando?", spam, cobranzas/cartera, cadenas, publicidad, estafas, números equivocados, masivos): responde EXACTAMENTE [IGNORAR] y nada más. NO redirijas, NO saludes, NO expliques ni mandes "jaja eso no es lo mío": o es del negocio (respondes) o [IGNORAR].
- NUNCA inventes promociones, servicios, eventos ni precios que no estén en la INFORMACIÓN DEL NEGOCIO o el catálogo. Si no existe ahí, no lo ofrezcas, cotices ni agendes — aunque suene del oficio.
- EVENTOS/SEMINARIOS/BATALLAS/PATROCINIOS/INSCRIPCIONES AJENAS (organizar, patrocinar, inscribirse, cuadrar cronogramas de eventos, "pre-venta", "categorías", "pase de cortesía", "promo de inscripción") que NO son un servicio/producto de este catálogo: NO sigas la corriente ni inventes precios/promos/agendas. Responde UNA vez, breve: "Eso lo ve directamente el equipo, ya te contactan 😊". Si en el historial YA diste ese handoff, responde EXACTAMENTE [IGNORAR].
- EXCEPCIÓN cliente en pleno agendamiento: si ya saludó/empezó a agendar y luego manda chitchat personal que no avanza la cita ("estaba cansada", "recogí a mi hijo", "salí tarde", "Dios te bendiga"), NO silencies de una: reconduce UNA vez, breve y cálido ("Cuando quieras seguimos con tu cita 😊"). Si YA recondujiste y sigue divagando, entonces sí [IGNORAR]. Esto NO aplica a spam/cobranzas/cadenas/publicidad/estafas: esos son [IGNORAR] desde el primer mensaje.
- VALORACIÓN VISUAL/FOTOS: si pide algo que requiere ver su caso o una foto (corregir/ajustar un color o trabajo ya hecho, "¿cómo me queda X?", "arréglame esto", o manda foto de su cabello), NO vendas ni cotices a ciegas: dile breve que ${estilistaNombre} lo revisa personalmente y ofrece agendar una valoración (sin costo si aplica). No alargues con catálogos ni precios.`;

    const allSections: string[] = [basePrompt, sep, temaSection];
    if (citaActivaSection) allSections.push(sep, citaActivaSection);
    if (negocioSection)  allSections.push(sep, negocioSection);
    if (horariosSection) allSections.push(sep, horariosSection);
    allSections.push(sep, clienteSection, sep, contextoPrevio);
    if (datosMencionados.length > 0) allSections.push(sep, datosSection);
    if (orders.length > 0)           allSections.push(sep, ordenesSection);
    if (appointments.length > 0)     allSections.push(sep, citasSection);
    allSections.push(sep, catalogoSection);
    // El flujo de toma de pedido (dirección de entrega, envío) solo aplica si hay
    // productos que vender. Negocios solo-citas no lo necesitan → ahorra tokens.
    if (products.length > 0) allSections.push(sep, flujoSection);
    // El flujo de agendamiento (citas/servicios, "¿qué servicio deseas?", primer
    // mensaje de cita) solo aplica si la tienda ofrece servicios. Sin este gate, una
    // tienda SOLO-productos saludaba con "Para agendar tu cita necesito: ¿qué servicio?"
    // aunque no tuviera ningún servicio.
    if (services.length > 0) allSections.push(sep, agendamientoSection);
    allSections.push(
      sep,
      audioSection, sep, antiBucleSection, sep, formatoSection, sep,
      `FECHA Y HORA ACTUAL: ${fechaActual}, ${horaActual} (Colombia).\n${buildCalendarioRef()}`,
    );
    const availSection = availabilityBlock ? `\n\n${availabilityBlock}` : '';
    return allSections.join('\n') + availSection;
  }
}