export interface TimeSlot   { open: string; close: string }
export interface DaySchedule { isOpen: boolean; shift1: TimeSlot | null; shift2: TimeSlot | null }
export interface BusinessHoursJson {
  mon: DaySchedule; tue: DaySchedule; wed: DaySchedule; thu: DaySchedule;
  fri: DaySchedule; sat: DaySchedule; sun: DaySchedule;
}

const DAY_KEYS = ['mon','tue','wed','thu','fri','sat','sun'] as const;
const DAY_LABELS: Record<string, string> = {
  mon: 'Lunes', tue: 'Martes', wed: 'Miércoles', thu: 'Jueves',
  fri: 'Viernes', sat: 'Sábados', sun: 'Domingos',
};

function toMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function getLocalComponents(date: Date, tz: string): { dayKey: string; totalMinutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const wd = parts.find(p => p.type === 'weekday')!.value.toLowerCase(); // "Mon" → "mon"
  const h  = parseInt(parts.find(p => p.type === 'hour')!.value);
  const m  = parseInt(parts.find(p => p.type === 'minute')!.value);
  return { dayKey: wd, totalMinutes: (h === 24 ? 0 : h) * 60 + m };
}

export function isWithinBusinessHours(
  scheduledAt: Date,
  hours: BusinessHoursJson,
  tz = 'America/Bogota',
): boolean {
  const { dayKey, totalMinutes } = getLocalComponents(scheduledAt, tz);
  const day = (hours as any)[dayKey] as DaySchedule | undefined;
  if (!day?.isOpen) return false;
  const inSlot = (s: TimeSlot | null) =>
    s ? totalMinutes >= toMin(s.open) && totalMinutes < toMin(s.close) : false;
  return inSlot(day.shift1) || inSlot(day.shift2);
}

function fmt12(t: string): string {
  const [h, m] = t.split(':').map(Number);
  const suf = h >= 12 ? 'pm' : 'am';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${h12}${suf}` : `${h12}:${String(m).padStart(2, '0')}${suf}`;
}

export function formatBusinessHoursForAI(hours: BusinessHoursJson): string {
  return DAY_KEYS.map(key => {
    const day = hours[key];
    if (!day.isOpen) return `${DAY_LABELS[key]}: Cerrado`;
    const s1 = day.shift1 ? `${fmt12(day.shift1.open)}–${fmt12(day.shift1.close)}` : '';
    const s2 = day.shift2 ? ` y ${fmt12(day.shift2.open)}–${fmt12(day.shift2.close)}` : '';
    return `${DAY_LABELS[key]}: ${s1}${s2}`;
  }).join('\n');
}

export function getEarliestOpenHour(hours: BusinessHoursJson): number {
  let min = 7;
  for (const key of DAY_KEYS) {
    const d = hours[key];
    if (d.isOpen && d.shift1) {
      const h = parseInt(d.shift1.open.split(':')[0]);
      if (h < min) min = h;
    }
  }
  return min;
}

export function getLatestCloseHour(hours: BusinessHoursJson): number {
  let max = 22;
  for (const key of DAY_KEYS) {
    const d = hours[key];
    if (!d.isOpen) continue;
    const closeShift = d.shift2 ?? d.shift1;
    if (closeShift) {
      const h = parseInt(closeShift.close.split(':')[0]);
      if (h > max) max = h;
    }
  }
  return max;
}
