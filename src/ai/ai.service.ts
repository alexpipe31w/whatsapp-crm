import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { createCompletion, PROVIDER_CONFIG, AIProvider } from './providers';
import {
  buildCartridgeList, ensurePool, getNextCartridge,
  markExhausted, isRateLimitError, getPoolStatus, Cartridge,
} from './key-pool';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { formatBusinessHoursForAI } from '../utils/business-hours.util';

// ─── Constantes ───────────────────────────────────────────────────────────────

const CONFIG_CACHE_TTL_MS  = 60_000;
const CATALOG_CACHE_TTL_MS = 120_000;
const AI_TIMEOUT_MAIN_MS = 30_000;
const AI_TIMEOUT_EXT_MS  = 20_000;
const ORDER_GUARD_TTL_MS   = 10 * 60 * 1000;
const CONFIRM_REMINDER_MS  =  5 * 60 * 1000; // recordatorio si el cliente no confirma en 5 min
const MAX_HISTORY_MESSAGES = 8;

const PURCHASE_INTENT_RE = /\b(quiero|deseo|pedir|pido|ordenar|comprar|llevar|encargar|confirm|dale|listo|acepto|perfecto|procede|adelante|claro|exacto|sip|yep|yes|sí|si\b|ok\b|pedido|orden|dirección|entrega|envío|cantidad|unidades?)\b|\[Pedido del catálogo:/i;
const APPOINTMENT_INTENT_RE = /\b(agendar|agenda|cita|visita|visita técnica|técnico|técnica|programar|reservar|reserva|turno|appointment|quiero una cita|necesito una visita|instalar|instalación|mantenimiento|corte|sesión)\b/i;

// Confirmaciones — muy amplio, todas las formas que usan los colombianos
const CONFIRMATION_RE = /\b(s[ií]|ok|okay|dale|listo|acepto|perfecto|procede|adelante|claro|exacto|sip|yep|yes|confirm|correcto|de acuerdo|está bien|estoy de acuerdo|va|hagale|hádale|marchando|hecho|venga|eso|eso mismo|así es|claro que sí|por supuesto|obvio|chévere|bacano|sale|de una|okey)\b|^(👍|✅|✓)$/i;

const ADDRESS_RE = /\b(calle|carrera|cra|cl\b|av\b|avenida|barrio|#|\d{2,}[-–]\d+|diagonal|transversal|manzana|casa|apto|apartamento)\b/i;

const PAYMENT_PROOF_RE     = /\b(pagu[eé]|transfer[ií]|te mand[eé]|comprobante|transacci[oó]n|consign[eé]|listo el pago|ya pagu[eé]|hice el pago)\b/i;
const CANCEL_RESCHEDULE_RE = /\b(cancelar|no puedo ir|no puedo asistir|cambiar la cita|reprogramar|mover la cita|otro d[ií]a|otra hora|posponer|aplazar)\b/i;
const MIN_ADVANCE_RE       = /m[ií]nimo\s+(\d+)\s*(hora|horas|h\b)/i;

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
  const refPoint = new Date(hoy);
  if (weekDaysOffset > 0) {
    refPoint.setDate(refPoint.getDate() + weekDaysOffset);
  } else if (/otra\s+semana|pr[oó]xima\s+semana|siguiente\s+semana/.test(t)) {
    refPoint.setDate(refPoint.getDate() + 7);
  }
  const refDia = refPoint.getDay();

  for (const [nombre, diaSemana] of Object.entries(DIAS_SEMANA)) {
    const re = new RegExp(`\\b(?:el\\s+)?(?:pr[oó]ximo\\s+|este\\s+|esta\\s+)?${nombre}\\b`);
    if (re.test(t)) {
      const d = new Date(refPoint);
      let diff = diaSemana - refDia;
      // Si weekOffset > 0: tomar el día de esa semana (hacia adelante si no coincide)
      // Si weekOffset = 0: siempre buscar hacia el futuro (nunca hoy)
      if (weekDaysOffset > 0) {
        if (diff < 0) diff += 7;
        // diff=0 significa que refPoint YA ES ese día → usarlo directamente
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
        const diff = (target - refDayEQ + 7) % 7;
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
    const d = new Date(year, month, day);
    if (!isNaN(d.getTime())) return d;
  }

  return null;
}

// ─── Parser de hora en español ────────────────────────────────────────────────
function parseHoraEspanol(text: string): string | null {
  const t = text.toLowerCase().trim();

  // HH:MM formato 24h o 12h
  const colonFmt = t.match(/\b(\d{1,2}):(\d{2})\s*(am|pm|a\.m\.|p\.m\.)?\b/);
  if (colonFmt) {
    let h = parseInt(colonFmt[1]);
    const m = colonFmt[2];
    const period = colonFmt[3];
    if (period && /pm|p\.m\./.test(period) && h < 12) h += 12;
    if (period && /am|a\.m\./.test(period) && h === 12) h = 0;
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
  const prefixFmt = t.match(/\b(?:a\s+las?\s+|las?\s+)(\d{1,2})(?!\s*(?:días?|semanas?|meses?|años?))\s*(?:y\s+(?:media|cuarto|tres\s+cuartos?))?\s*(am|pm|a\.m\.|p\.m\.|(?:de|en|por)\s+la\s+(?:ma[ñn]ana|tarde|noche))?\b/);
  const periodFmt = t.match(/\b(\d{1,2})(?!\s*(?:días?|semanas?|meses?|años?))\s*(?:y\s+(?:media|cuarto|tres\s+cuartos?))?\s*(am|pm|a\.m\.|p\.m\.|(?:de|en|por)\s+la\s+(?:ma[ñn]ana|tarde|noche))\b/);
  const simpleFmt = prefixFmt ?? periodFmt;
  if (simpleFmt) {
    let h = parseInt(simpleFmt[1]);
    if (h > 23) return null; // no es una hora
    const minutosTxt = simpleFmt[0].toLowerCase();
    let m = 0;
    if (/y\s+media/.test(minutosTxt)) m = 30;
    if (/y\s+cuarto/.test(minutosTxt)) m = 15;
    if (/tres\s+cuartos?/.test(minutosTxt)) m = 45;
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
    if (!appt) { this.pendingReschedules.delete(conversationId); return null; }

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

  private async computeSlotsForAI(
    storeId: string,
    date: Date,
    activeStaff: { staffId: string; name: string; schedule: any }[],
    store: { businessHours: any },
  ): Promise<{ name: string; slots: string[] }[]> {
    const tz = 'America/Bogota';
    const dateStr = date.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
    const startOfDay = new Date(`${dateStr}T00:00:00`);
    const endOfDay   = new Date(`${dateStr}T23:59:59`);

    const dayKey = coDayKey(date);

    const results: { name: string; slots: string[] }[] = [];

    const members = activeStaff.length > 0
      ? activeStaff
      : [{ staffId: null as any, name: (store as any).name ?? 'Negocio', schedule: null }];

    for (const member of members) {
      const effectiveHours = member.schedule ?? store.businessHours;
      if (!effectiveHours) { results.push({ name: member.name, slots: [] }); continue; }

      const daySchedule = (effectiveHours as any)[dayKey];
      if (!daySchedule?.isOpen) { results.push({ name: member.name, slots: [] }); continue; }

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
      const SLOT = 30;

      for (const shift of ['shift1', 'shift2'] as const) {
        const s = daySchedule[shift];
        if (!s?.open || !s?.close) continue;
        const [sh, sm] = s.open.split(':').map(Number);
        const [eh, em] = s.close.split(':').map(Number);
        let cur = sh * 60 + sm;
        const end = eh * 60 + em;

        while (cur + SLOT <= end) {
          const slotStart = new Date(`${dateStr}T${String(Math.floor(cur/60)).padStart(2,'0')}:${String(cur%60).padStart(2,'0')}:00`);
          const slotEnd   = new Date(slotStart.getTime() + SLOT * 60000);

          const occupied = appts.some(a => {
            const aEnd = a.endsAt ?? new Date(a.scheduledAt.getTime() + SLOT * 60000);
            return a.scheduledAt < slotEnd && aEnd > slotStart;
          });

          if (!occupied) {
            slots.push(`${String(Math.floor(cur/60)).padStart(2,'0')}:${String(cur%60).padStart(2,'0')}`);
          }
          cur += SLOT;
        }
      }

      results.push({ name: member.name, slots });
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

      const [conversationRow, orders, appointments, history, store, activeStaff] = await Promise.all([
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
      }

      // ── Cancelar / Reprogramar ──────────────────────────────────────────────
      const cancelRescheduleReply = await this.tryHandleCancelOrReschedule(
        storeId, customer.customerId, conversationId, userMessage, config.systemPrompt, activeStaff,
      );
      if (cancelRescheduleReply) return cancelRescheduleReply;

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
      const hasApptContextHint = APPT_CONTEXT_RE.test(userMessage) && prevHadApptCtx;

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
        if (apptResult.created) return apptResult.message!;
        // Si falló por horario/conflicto hay un mensaje específico — usarlo directamente
        // para evitar que el AI principal genere una confirmación falsa
        if (!apptResult.created && apptResult.message) return apptResult.message;
      }

      // ── Flujo de orden ────────────────────────────────────────────────────────
      const shouldTryOrder =
        hasCatalog &&
        history.length >= 2 &&
        (hasPurchaseIntent || hasPendingOrder) &&
        !this.orderInProgress.has(conversationId);

      if (shouldTryOrder) {
        const orderResult = await this.tryExtractAndCreateOrder(
          provider, apiKey, model, history, userMessage,
          products, services, customer, storeId, conversationId, settings,
        );
        if (orderResult.created) return orderResult.message!;
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

      // Calcular disponibilidad tanto cuando preguntan como cuando agenden con fecha específica
      if ((AVAIL_RE.test(userMessage) || hasAppointmentIntent) && store) {
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
          // Incluir slots libres y quién no trabaja ese día
          const lines: string[] = [];
          for (const s of slotsData) {
            if (s.slots.length > 0) {
              lines.push(`- ${s.name}: ${s.slots.join(', ')}`);
            } else {
              lines.push(`- ${s.name}: NO DISPONIBLE ese día`);
            }
          }
          if (lines.some(l => !l.includes('NO DISPONIBLE'))) {
            availabilityBlock = `\nDISPONIBILIDAD REAL PARA EL ${dayName.toUpperCase()} ${dateLabel}:\n${lines.join('\n')}\n\nREGLA CRÍTICA: Usa SOLO estos horarios para ese día. Si el cliente pide un horario que no aparece en la lista o dice "NO DISPONIBLE", dile claramente que no hay disponibilidad y ofrece las horas que SÍ están en la lista.`;
          } else {
            availabilityBlock = `\nDISPONIBILIDAD PARA EL ${dayName.toUpperCase()} ${dateLabel}: Ningún profesional disponible ese día.`;
          }
        }
      }

      // Incluir catálogo completo solo cuando hay intención real de compra/cita/consulta
      const CATALOG_QUERY_RE = /\b(servicio|servicios|producto|productos|cat[aá]logo|precio|precios|tienen|tienes|ofrecen|disponible|cu[aá]nto|descuento|paquete|qu[eé]\s+(hay|tienen|ofrecen|tienes))\b/i;
      const includeCatalog = hasPurchaseIntent || hasAppointmentIntent || hasPendingOrder || hasPendingAppt || CATALOG_QUERY_RE.test(userMessage);

      const enrichedSystemPrompt = this.buildSystemPrompt(
        config.systemPrompt, customer, orders, appointments,
        products, services, fechaActual, horaActual,
        history, userMessage, addressAlreadyGiven, settings,
        customer.lastConversationSummary ?? null,
        store,
        activeStaff,
        availabilityBlock,
        includeCatalog,
      );

      const messages: any[] = [
        { role: 'system', content: enrichedSystemPrompt },
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
        this.logger.error(`[Pool] Todos los cartuchos agotados para store ${storeId}`);
        reply = '⚠️ El asistente está temporalmente sin disponibilidad. Por favor intenta en unos minutos.';
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
  ): Promise<{ created: boolean; message?: string }> {

    const cached            = this.pendingExtractions.get(conversationId);
    let extracted: ExtractionResult;

    // Para órdenes solo se requiere nombre (cédula es opcional)
    const needsCustomerData = !customer.name;

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

      const customerDataInstruction = needsCustomerData
        ? `DATOS DEL CLIENTE REQUERIDOS:
El cliente aún no tiene nombre registrado. Extráelo si fue mencionado.
La cédula es opcional — extráela si el cliente la menciona, pero NO es obligatoria.
Si el nombre no aparece → null. La orden NO puede ser "complete":true si falta el nombre.`
        : `DATOS DEL CLIENTE: Ya registrados. No es necesario extraerlos.`;

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
   d) Si se requieren datos del cliente: nombre presente
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
        if (needsCustomerData && extracted.customerName && !extracted.complete) {
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
    if (this.orderInProgress.has(conversationId)) {
      this.logger.warn(`[Orden] Ya en progreso para ${conversationId}`);
      return { created: false };
    }

    this.orderInProgress.add(conversationId);

    try {
      // Actualizar datos del cliente si se recopilaron ahora
      if (needsCustomerData && extracted.customerName) {
        await this.prisma.customer.update({
          where: { customerId: customer.customerId },
          data: {
            name:   extracted.customerName.replace(/\b\w/g, l => l.toUpperCase()),
            ...(extracted.customerCedula && { cedula: extracted.customerCedula }),
          },
        });
        this.logger.log(`✅ [Orden] Cliente actualizado: ${extracted.customerName}`);
      }

      const orderItemsData: any[]       = [];
      const orderItemsSummary: string[] = [];
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
            orderItemsSummary.push(`• ${item.description ?? product.name} x${item.quantity} — $${subtotal.toLocaleString('es-CO')}`);
          }
        }
      }

      if (orderItemsData.length === 0) {
        this.logger.warn(`[Orden] Sin items válidos`);
        return { created: false };
      }

      const order = await this.prisma.order.create({
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
    const needsCustomerData = needsName; // solo bloquea si no hay nombre

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
        return { created: false };
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
        ? `DATOS DEL CLIENTE REQUERIDOS:
El cliente no tiene nombre registrado. Extráelo de la conversación.

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

La cita NO puede ser "complete":true si no logras identificar el nombre.
La cédula es OPCIONAL — extráela SOLO si el cliente mencionó explícitamente un número de 6-10 dígitos como cédula. Un teléfono NO es cédula.`
        : `DATOS DEL CLIENTE: Nombre ya registrado (${customer.name}). No es necesario pedirlo.`;

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

FECHA ACTUAL: ${fechaHoy} (Colombia, zona horaria America/Bogota)
${alreadyCreatedBlock}
${servicesCatalog}
${staffCatalog}

CONVERSACIÓN:
${conversationText}

${customerDataInstruction}

REGLAS ESTRICTAS:
1. "complete":true SOLO si se cumplen TODAS las condiciones:
   a) Fecha específica (día y mes como mínimo)
   b) Hora específica
   c) Descripción de qué necesita el cliente
   d) Confirmación explícita del cliente (sí, confirmo, listo, dale, ok, etc.)
   e) Si se requiere nombre del cliente: debe estar presente
2. Si falta CUALQUIER condición → "complete":false
3. "scheduledDate": formato "YYYY-MM-DD". Calcula fechas relativas desde hoy (${fechaHoy}).
   - "mañana" = día siguiente
   - "el martes de la otra semana" = busca el martes de la semana que viene
   - "el lunes" = próximo lunes
4. "scheduledTime": formato "HH:MM" en 24h. "2pm" → "14:00", "4pm" → "16:00"
5. "address": SOLO si el cliente da una dirección física real (calle, carrera, barrio + número, ej: "Cra 45 #20-48"). Si la cita es en el local o no hay dirección explícita → null. NUNCA pongas el mensaje del cliente como dirección.
6. "customerCedula": extrae SOLO si el cliente la mencionó explícitamente. Si no → null.
7. "type": texto libre describiendo la cita (ej: "visita_tecnica", "instalación solar", "corte de cabello").
8. "staffId": si el cliente eligió un profesional, usa su ID del EQUIPO DISPONIBLE. Si no hay equipo o no eligió → null.

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
  "staffName": "nombre del profesional elegido o null"
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

        // ── Fallbacks TypeScript — aplican cuando el LLM devuelve null ──────────

        // Nombre
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
          for (const s of activeStaff) {
            const firstName = s.name.split(' ')[0];
            const re = new RegExp(`\\b${firstName}\\b`, 'gi');
            let m: RegExpExecArray | null;
            while ((m = re.exec(latestMessage)) !== null) {
              if (m.index > bestPos) {
                bestPos = m.index;
                bestStaff = s;
              }
            }
          }
          if (bestStaff && extracted.staffId !== bestStaff.staffId) {
            this.logger.log(`[Cita] Fallback staffId: LLM="${extracted.staffId?.slice(-8)}" → "${bestStaff.staffId.slice(-8)}" (${bestStaff.name})`);
            extracted.staffId = bestStaff.staffId;
            extracted.staffName = bestStaff.name;
          }
        }

        // Dirección (si es visita a domicilio y no vino del LLM)
        if (!extracted.address && ADDRESS_RE.test(latestMessage)) {
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
        if (extracted.scheduledDate || extracted.description || extracted.serviceId || extracted.customerName) {
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
        const DAY_NAMES: Record<string, string> = { sun:'domingos', mon:'lunes', tue:'martes', wed:'miércoles', thu:'jueves', fri:'viernes', sat:'sábados' };
        // Con staff activo: bloquear si ninguno trabaja ese día
        if (activeStaff.length > 0) {
          const anyoneWorks = activeStaff.some(s => (s.schedule as any)?.[dayKey]?.isOpen === true);
          if (!anyoneWorks) {
            this.logger.warn(`[Cita] Ningún profesional trabaja el ${dayKey} — bloqueando cita sin staffId`);
            const cur = this.pendingAppointments.get(conversationId);
            if (cur) this.pendingAppointments.set(conversationId, { ...cur, scheduledDate: null, scheduledTime: null, complete: false });
            this.cancelConfirmReminder(conversationId);
            return {
              created: false,
              message: `Lo siento, no tenemos disponibilidad los ${DAY_NAMES[dayKey] ?? dayKey}. ¿Quieres elegir otro día? 😊`,
            };
          }
        }
        // Sin staff pero con businessHours: bloquear si la tienda está cerrada ese día
        else if (store?.businessHours) {
          const dayBH = (store.businessHours as any)[dayKey];
          if (dayBH?.isOpen === false) {
            this.logger.warn(`[Cita] Tienda cerrada el ${dayKey} (businessHours) — bloqueando`);
            const cur = this.pendingAppointments.get(conversationId);
            if (cur) this.pendingAppointments.set(conversationId, { ...cur, scheduledDate: null, scheduledTime: null, complete: false });
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
            this.logger.warn(`[Cita] ${staffMember.name} no trabaja el ${dayKey} — limpiando fecha del caché`);
            // Guardar caché SIN fecha/hora para que el cliente corrija solo el horario
            const cur = this.pendingAppointments.get(conversationId);
            if (cur) this.pendingAppointments.set(conversationId, { ...cur, scheduledDate: null, scheduledTime: null, complete: false });
            this.cancelConfirmReminder(conversationId);
            return {
              created: false,
              message: `Lo siento, ${staffMember.name} no trabaja ese día. ¿Quieres elegir otro día o con otro profesional?`,
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
            this.logger.warn(`[Cita] ${extracted.scheduledTime} fuera del turno de ${staffMember.name} el ${dayKey} — limpiando hora del caché`);
            // Guardar caché SIN hora para que el cliente corrija la hora
            const cur = this.pendingAppointments.get(conversationId);
            if (cur) this.pendingAppointments.set(conversationId, { ...cur, scheduledTime: null, complete: false });
            this.cancelConfirmReminder(conversationId);
            return {
              created: false,
              message: `Lo siento, las ${extracted.scheduledTime} está fuera del horario de ${staffMember.name}. ¿Quieres elegir otra hora dentro de su horario?`,
            };
          }
        }
      }

      const durationMinutes = extracted.durationMinutes ?? null;
      const endsAt          = durationMinutes ? new Date(scheduledAt.getTime() + durationMinutes * 60_000) : null;

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
            return {
              created: false,
              message: `Lo siento, ese horario ya está ocupado para ${staffInfo?.name ?? 'el profesional'}. Por favor elige otra hora disponible.`,
            };
          }
        }

        appointment = await this.prisma.$transaction(async (tx) => {
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
              customerId:       customer.customerId,
              serviceId:        extracted.serviceId        ?? null,
              serviceVariantId: extracted.serviceVariantId ?? null,
              type:             extracted.type             ?? 'cita',
              status:           'PENDING',
              priority:         'NORMAL',
              source:           'AI',
              scheduledAt,
              endsAt,
              durationMinutes,
              description:  extracted.description ?? null,
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
    const hasPaymentMethods    = (settings.paymentMethods?.length ?? 0) > 0;
    const paymentInstruction   = hasPaymentMethods
      ? `- NUNCA des información de pago antes de que el pedido esté confirmado. Los datos se envían automáticamente al crear el pedido.`
      : `- Si el cliente pregunta por métodos de pago: "Un asesor te contactará con esa información."`;

    const flujoSection = `FLUJO DE TOMA DE ORDEN (PRODUCTOS Y SERVICIOS):

Para crear un pedido necesito:
  a) Productos o servicios con cantidad
  b) Dirección de entrega completa
  c) ${!customer.name ? 'Nombre completo del cliente' : '(nombre ya registrado)'}
  d) Confirmación explícita

${!customer.name ? `IMPORTANTE: Cuando el cliente muestre intención de compra PIDE todo de una:\n"Para registrar tu pedido necesito tu nombre completo y dirección de entrega."` : ''}

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
        }).join('\n')}\n\nREGLA OBLIGATORIA DE AGENDAMIENTO CON EQUIPO:\n1. SIEMPRE pregunta: "¿Con qué ${staffLabel} quieres tu cita? Tenemos disponibles: ${activeStaff.map((s: { staffId: string; name: string }) => s.name).join(', ')}"\n2. El cliente DEBE elegir un ${staffLabel} antes de confirmar.\n3. Una vez elegido, NO preguntes de nuevo.\n4. Si el ${staffLabel} elegido no está disponible en ese horario, avisa y sugiere otro horario o ${staffLabel} alternativo.\n5. Cuando el cliente pregunte por el horario de un ${staffLabel} específico, usa el horario indicado arriba para responderle con precisión.`
      : '';

    const agendamientoSection = `FLUJO DE AGENDAMIENTO (CITAS Y SERVICIOS):

REGLA DE EFICIENCIA — MUY IMPORTANTE:
Cuando el cliente muestre intención de agendar, pide TODA la información en UN solo mensaje.
${clienteDataPendiente
  ? `Ejemplo: "Para agendar necesito: ¿qué servicio, con qué ${staffLabel}, para qué día y hora? Y tu nombre completo por favor."`
  : `Ejemplo: "Para agendar necesito: ¿qué servicio, con qué ${staffLabel}, para qué día y hora?"`
}
NO hagas una pregunta por vez. Recoge todo en un solo intercambio para confirmar rápido.

Cuando tengas todo, muestra el resumen y pide confirmación:
"¿Confirmamos tu cita de [servicio] con [profesional] para el [fecha] a las [hora]?"

IMPORTANTE:
- Si la hora es ambigua (ej: "3"), pregunta: "¿A las 3pm?"
- Para servicios VARIABLE, avisa que el precio lo confirma un asesor en la visita.
${staffBlock}

CONSULTA DE DISPONIBILIDAD:
Si el cliente pregunta sobre horarios disponibles y no menciona un día específico,
pregunta: "¿Para qué día quieres consultar la disponibilidad?"
`;

    // Contexto de conversaciones anteriores (generado por el cleanup nocturno)
    const contextoPrevio = lastConversationSummary
      ? `HISTORIAL DEL CLIENTE (conversación anterior archivada):\n${lastConversationSummary}\n\nUSA ESTE CONTEXTO para dar un servicio más personalizado. No repitas preguntas que ya se respondieron en conversaciones previas.`
      : `HISTORIAL DEL CLIENTE: Primera interacción o sin historial previo.`;

    const audioSection = `CAPACIDAD DE AUDIO:
- Puedes entender mensajes de voz. Cuando el cliente te manda un audio, el sistema lo transcribe automáticamente y tú recibes el texto.
- Responde de forma natural sin mencionar que hubo un audio, a menos que el contexto lo requiera.
- Si el cliente pregunta si puedes escuchar audios, dile que sí.`;

    const antiBucleSection = `REGLA ANTI-CONFIRMACIÓN FALSA (ABSOLUTA — NUNCA VIOLAR):
- NUNCA digas "tu cita está confirmada", "cita registrada", "cita agendada", "quedas agendado", "nos vemos el X", "hasta entonces" ni ninguna variante que implique que la cita fue creada.
- La confirmación REAL la genera el sistema automáticamente con el mensaje "¡Cita agendada! ✅". Si NO ves ese mensaje en la conversación, la cita NO existe en el sistema.
- Si el cliente dice "sí" confirmando y tú no tienes certeza de que el sistema creó la cita, responde: "Entendido, estoy procesando tu solicitud. Dame un momento."
- NUNCA inventes una confirmación. Si fallas en crear la cita, pide al cliente que elija otro horario.

REGLA ANTI-BUCLE EN CONVERSACIÓN (OBLIGATORIA):
- Si ya hiciste una pregunta al cliente y él respondió con algo (aunque no sea la respuesta exacta que esperabas), NO repitas la misma pregunta.
- Avanza la conversación con lo que el cliente sí dijo. Adapta tu respuesta a su mensaje.
- Si el cliente hace una nueva pregunta en lugar de responder la tuya, responde su pregunta directamente.
- Nunca hagas la misma pregunta dos veces seguidas al mismo cliente.
- Si el cliente envió varios mensajes juntos (separados por salto de línea), léelos como un solo mensaje continuo y responde considerando todo el contexto.`;

    const formatoSection = `FORMATO DE MENSAJES (MUY IMPORTANTE):
- NUNCA uses asteriscos (*) para negritas ni para ningún otro propósito.
- NUNCA uses guiones seguidos (---) como separadores.
- NUNCA uses viñetas con guion (- item). En su lugar usa emojis o texto plano.
- Para mostrar el catálogo al cliente usa este estilo limpio:
    Tenemos disponible:

    [emoji] Nombre del producto
    Precio: $XX.000 | X unidades disponibles

    [emoji] Otro producto
    Precio: $XX.000
- Emojis sugeridos: 📦 para productos, 🔧 para servicios, 🛍️ para catálogo general.
- Usa saltos de línea para separar productos, no guiones ni líneas decorativas.
- El texto debe verse limpio en WhatsApp sin ningún símbolo de formato visible.`;

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

    const allSections: string[] = [basePrompt];
    if (negocioSection)  allSections.push(sep, negocioSection);
    if (horariosSection) allSections.push(sep, horariosSection);
    allSections.push(sep, clienteSection, sep, contextoPrevio);
    if (datosMencionados.length > 0) allSections.push(sep, datosSection);
    if (orders.length > 0)           allSections.push(sep, ordenesSection);
    if (appointments.length > 0)     allSections.push(sep, citasSection);
    allSections.push(
      sep, catalogoSection, sep, flujoSection, sep, agendamientoSection, sep,
      audioSection, sep, antiBucleSection, sep, formatoSection, sep,
      `FECHA Y HORA ACTUAL: ${fechaActual}, ${horaActual} (Colombia).`,
    );
    const availSection = availabilityBlock ? `\n\n${availabilityBlock}` : '';
    return allSections.join('\n') + availSection;
  }
}