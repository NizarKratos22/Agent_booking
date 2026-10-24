import { DateTime } from 'luxon';

/**
 * The small date/time grammar the admin commands share. Parsing never looks at the clock;
 * resolving takes `now`, so tests pin it. Vocabulary is French, Darija (Arabic script and
 * Tunizi) and English, because that is how a Tunisian secretary texts.
 */

export type DayRef =
  | { type: 'today' }
  | { type: 'tomorrow' }
  | { type: 'weekday'; weekday: number } // 1 = Monday … 7 = Sunday (ISO, like the cabinet hours)
  | { type: 'date'; day: number; month: number; year?: number };

export type TimeRange = { start: string; end: string }; // "HH:MM"; end may be "24:00"
export type DayPart = 'all' | 'morning' | 'afternoon' | TimeRange;

const DAY_WORDS: [RegExp, DayRef][] = [
  [/^(aujourd'?hui|auj|today|lyoum|lyom|elyoum|اليوم|لليوم)$/iu, { type: 'today' }],
  [/^(demain|tomorrow|ghodwa|ghodoua|ghedwa|غدوة|غدوا|غدوه)$/iu, { type: 'tomorrow' }],
  [/^(lundi|lun|monday|mon|tnin|lithnin|letnin|الاثنين|الإثنين|الاتنين)$/iu, { type: 'weekday', weekday: 1 }],
  [/^(mardi|mar|tuesday|tue|tlatha|tletha|thlatha|الثلاثاء|الثلاث|التلاث)$/iu, { type: 'weekday', weekday: 2 }],
  [/^(mercredi|mer|wednesday|wed|larb3a|larbaa|larbea|الأربعاء|الاربعاء|الاربع)$/iu, { type: 'weekday', weekday: 3 }],
  [/^(jeudi|jeu|thursday|thu|lkhmis|khmis|lekhmis|الخميس)$/iu, { type: 'weekday', weekday: 4 }],
  [/^(vendredi|ven|friday|fri|jom3a|jem3a|jomaa|الجمعة|الجمعه)$/iu, { type: 'weekday', weekday: 5 }],
  [/^(samedi|sam|saturday|sat|sebt|essebt|السبت)$/iu, { type: 'weekday', weekday: 6 }],
  [/^(dimanche|dim|sunday|sun|7ad|lahad|el7ad|الأحد|الاحد)$/iu, { type: 'weekday', weekday: 7 }],
];

// "14h-16h", "14:00 - 16:30", "9-12", "14h30 à 16h". Dates use "/" or ".", so "-" is always a range.
const RANGE = /(?<![\d/.:-])(\d{1,2})(?:\s*[:h]\s*(\d{2}))?\s*h?\s*(?:-|–|—|->|→|à|a|to|jusqu'?à|حتى)\s*(\d{1,2})(?:\s*[:h]\s*(\d{2}))?\s*h?(?![\d/])/iu;
// "14h", "14h30", "14:30" alone: from that time to the end of the day. A bare number is not a time.
const SINGLE = /(?<![\d/.:-])(\d{1,2})(?:\s*[:h]\s*(\d{2})|\s*h)(?![\d/])/iu;
const MORNING = /(?<!\S)(matin[ée]e?|matin|morning|sbah|essbah|الصباح|صباح|صباحا)(?!\S)/iu;
const AFTERNOON = /(?<!\S)(apr[èe]s[- ]?midi|aprem|afternoon|3chiya|3achiya|l3chiya|عشية|العشية|soir|evening)(?!\S)/iu;
const FILLER = /^(le|la|les|l|de|du|des|pour|car|à|a|el|il|:|,|-)$/iu;

const hhmm = (h: string, m?: string) => `${h.padStart(2, '0')}:${m ?? '00'}`;

/** Arabic-Indic digits → ASCII, NFKC, trimmed. Shared by every command parser. */
export function normalizeText(raw: string): string {
  return (raw ?? '')
    .normalize('NFKC')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .trim();
}

export function parseDayRef(token: string): DayRef | null {
  const t = normalizeText(token).replace(/[\s،,.;:!?]+$/u, '');
  for (const [re, ref] of DAY_WORDS) if (re.test(t)) return ref;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return { type: 'date', year: +m[1], month: +m[2], day: +m[3] };
  m = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/.exec(t);
  if (m) return { type: 'date', day: +m[1], month: +m[2], year: m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : undefined };
  return null;
}

/** Split "vendredi 14h-16h dentiste absent" into day, part of day and the leftover text. */
export function parseWhen(text: string): { day: DayRef | null; part: DayPart; rest: string } {
  let s = ` ${normalizeText(text)} `;
  let part: DayPart = 'all';
  const range = RANGE.exec(s);
  if (range) {
    part = { start: hhmm(range[1], range[2]), end: hhmm(range[3], range[4]) };
    s = s.replace(range[0], ' ');
  } else {
    const one = SINGLE.exec(s);
    if (one) {
      part = { start: hhmm(one[1], one[2]), end: '24:00' };
      s = s.replace(one[0], ' ');
    } else if (MORNING.test(s)) {
      part = 'morning';
      s = s.replace(MORNING, ' ');
    } else if (AFTERNOON.test(s)) {
      part = 'afternoon';
      s = s.replace(AFTERNOON, ' ');
    }
  }
  let day: DayRef | null = null;
  const rest: string[] = [];
  for (const token of s.trim().split(/\s+/).filter(Boolean)) {
    const ref: DayRef | null = parseDayRef(token);
    if (ref && !day) day = ref;
    else rest.push(token);
  }
  while (rest.length && FILLER.test(rest[0])) rest.shift();
  return { day, part, rest: rest.join(' ').replace(/^[\s,:;–-]+|[\s,:;–-]+$/g, '') };
}

/** "30", "30 min", "1h", "1h30", "+45" → minutes. */
export function parseMinutes(text: string): number | null {
  const t = normalizeText(text);
  let m = /^\+?(\d{1,2})\s*h(?:\s*(\d{1,2}))?(?!\d)/i.exec(t);
  if (m) return +m[1] * 60 + +(m[2] ?? 0);
  m = /^\+?(\d{1,3})(?!\d)/.exec(t);
  return m ? +m[1] : null;
}

export function resolveDay(ref: DayRef, now: DateTime): DateTime {
  const today = now.startOf('day');
  switch (ref.type) {
    case 'today':
      return today;
    case 'tomorrow':
      return today.plus({ days: 1 });
    case 'weekday':
      return today.plus({ days: (ref.weekday - today.weekday + 7) % 7 }); // the same weekday means today
    case 'date': {
      const d = DateTime.fromObject({ year: ref.year ?? today.year, month: ref.month, day: ref.day }, { zone: now.zone });
      return d.isValid && ref.year === undefined && d < today ? d.plus({ years: 1 }) : d;
    }
  }
}

export function resolveRange(day: DateTime, part: DayPart): { from: DateTime; to: DateTime } | null {
  if (part === 'all') return { from: day, to: day.plus({ days: 1 }) };
  if (part === 'morning') return { from: day, to: day.set({ hour: 13 }) };
  if (part === 'afternoon') return { from: day.set({ hour: 13 }), to: day.plus({ days: 1 }) };
  const at = (hm: string): DateTime | null => {
    const [h, m] = hm.split(':').map(Number);
    if (h > 24 || m > 59 || (h === 24 && m > 0)) return null;
    return h === 24 ? day.plus({ days: 1 }) : day.set({ hour: h, minute: m });
  };
  const from = at(part.start);
  const to = at(part.end);
  return from && to && to > from ? { from, to } : null;
}

export function dayLabelFr(d: DateTime): string {
  return d.setLocale('fr').toFormat('cccc d LLLL');
}

export function rangeLabelFr(day: DateTime, r: { from: DateTime; to: DateTime }, part: DayPart): string {
  if (part === 'all') return 'toute la journée';
  if (part === 'morning') return 'le matin';
  if (part === 'afternoon') return "l'après-midi";
  const end = r.to.equals(day.plus({ days: 1 })) ? '24:00' : r.to.toFormat('HH:mm');
  return `${r.from.toFormat('HH:mm')}–${end}`;
}
