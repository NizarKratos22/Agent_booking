import { tunisianPhone } from '../config/phone';
import { DayPart, DayRef, normalizeText, parseDayRef, parseMinutes, parseWhen } from './when';

/**
 * Admin-by-chat commands. The dentist or secretary texts the cabinet's WhatsApp number from a
 * number listed in `whatsapp_admin`. Deterministic keyword matching, no LLM: an admin channel
 * must do exactly what it was told, every time. The first word decides; the rest are arguments.
 * French, Darija (Arabic script and Tunizi) and the plain English keyword all work; bare "on" is
 * deliberately absent because French sentences start with it ("On ferme vendredi").
 *
 *   STOP / START                      → agent off / back to its previous mode
 *   MODE on|apprentissage|off          → set_mode
 *   RETARD 30 | RETARD 1h | AVANCE 15  → shift_day (today, remaining bookings)
 *   BLOQUE vendredi [matin|14h-16h] [raison] → block_slots
 *   RDV [demain|vendredi|31/10]        → list_day (a bare day word does the same)
 *   NOTE 20123456 texte                → add_patient_note
 */
export type AdminCommand =
  | { kind: 'stop' }
  | { kind: 'start' }
  | { kind: 'help' }
  | { kind: 'set_mode'; mode: 'on' | 'learning' | 'off' | null }
  | { kind: 'shift_day'; minutes: number | null }
  | { kind: 'block_slots'; day: DayRef; part: DayPart; reason: string }
  | { kind: 'list_day'; day: DayRef }
  | { kind: 'add_patient_note'; phone: string | null; text: string }
  | { kind: 'unknown'; text: string };

const STOP: RegExp[] = [/^(stop|off|pause|arr[êe]te?z?|arr[êe]t)\b/i, /^(وقف|وقّف|أوقف|حبس|احبس|بركة)/u, /^(wa[9q]+[ae]f|7bes|hbes|barka)\b/i];
const START: RegExp[] = [
  /^(start|go|resume|reprend(s|re|ez)?|reprise|d[ée]marre[rz]?|relance[rz]?)\b/i,
  /^(شغل|شغّل|ابدا|بدا|كمل|كمّل)/u,
  /^(chaghal|chghal|bda|kammel|kamel)\b/i,
];
const HELP: RegExp[] = [/^(help|aide|menu|\?|\/help|commandes?)\s*$/i, /^(عاون|عاوني|مساعدة)/u, /^(3awen|3awenni)\b/i];

/** keyword → the text after it, or null. Arabic keywords end at whitespace since \b is ASCII-only. */
function args(text: string, latin: RegExp, arabic?: RegExp): string | null {
  const m = latin.exec(text) ?? (arabic ? arabic.exec(text) : null);
  return m ? text.slice(m[0].length).trim() : null;
}

const MODE = [/^(mode|mod|wadh3)\b/i, /^(وضع|الوضع)(?=\s|$)/u] as const;
const LATE = [/^(retard|retar|late|shift|d[ée]cal(?:e|er|age)?|ta2khir|t2akhir|takhir|ta5ir|\+(?=\d))\s*/i, /^(تأخير|تأخر|تاخير|تاخر)(?=\s|$|\d)/u] as const;
const EARLY = [/^(avance[rz]?|early|advance)\b/i, /^(تقديم|قدم)(?=\s|$|\d)/u] as const;
const BLOCK = [/^(bloque[rz]?|bloc|block|ferme[rz]?|ferm[ée]e?|fermeture|sakker|sakkar|sakar|blocki|bloki)\b/i, /^(سكر|سكّر|اسكر|غلق|اغلق|عطلة)(?=\s|$)/u] as const;
const LIST = [/^(rdvs?|rendez[- ]vous|liste|list|agenda|planning|programme|journ[ée]e|mawa3id|mwa3id)\b/i, /^(مواعيد|المواعيد|برنامج|البرنامج|موعد)(?=\s|$)/u] as const;
const NOTE = [/^(notes?|remarque|nota|memo|mémo|mol7adha|mol7adhka)\b/i, /^(ملاحظة|ملاحظه|ملاحظات)(?=\s|$)/u] as const;

const MODE_WORDS: [RegExp, 'on' | 'learning' | 'off'][] = [
  [/^(on|actif|active|normal|marche|prod|شغال|شغالة|khaddem|khaddam|yekhdem)$/iu, 'on'],
  [/^(learning|apprentissage|apprent|test|essai|تعلم|تعليم|ta3lim|t3alm|tajriba)$/iu, 'learning'],
  [/^(off|arr[êe]t|stop|وقف|7bes|hbes)$/iu, 'off'],
];

/** "20123456 patient anxieux" → phone and text. Digit groups are joined until a full local (8) or international (11+) number. */
function takePhone(tokens: string[]): { phone: string | null; rest: string[] } {
  let i = 0;
  let digits = '';
  let intl = false;
  while (i < tokens.length && /^[+\d][\d.()-]*$/.test(tokens[i])) {
    const d = tokens[i].replace(/\D/g, '');
    if (i === 0) intl = tokens[0].startsWith('+') || d.startsWith('00') || (d.startsWith('216') && d.length > 8);
    digits += d;
    i++;
    if (digits.length >= (intl ? 11 : 8)) break;
  }
  if (digits.length < 8) return { phone: null, rest: tokens };
  return { phone: tunisianPhone((tokens[0].startsWith('+') ? '+' : '') + digits), rest: tokens.slice(i) };
}

export function parseAdminCommand(raw: string): AdminCommand {
  // Strip leading emoji/punctuation ("🛑 STOP") but keep "?" (help) and "+" (shift).
  const text = normalizeText(raw).replace(/^[^\p{L}\p{N}?+/]+/u, '');
  if (!text) return { kind: 'unknown', text: '' };
  if (STOP.some((p) => p.test(text))) return { kind: 'stop' };
  if (START.some((p) => p.test(text))) return { kind: 'start' };
  if (HELP.some((p) => p.test(text))) return { kind: 'help' };

  let a = args(text, ...MODE);
  if (a !== null) {
    const word = a.split(/\s+/)[0] ?? '';
    return { kind: 'set_mode', mode: MODE_WORDS.find(([re]) => re.test(word))?.[1] ?? null };
  }
  a = args(text, ...LATE);
  if (a !== null) return { kind: 'shift_day', minutes: parseMinutes(a) };
  a = args(text, ...EARLY);
  if (a !== null) {
    const m = parseMinutes(a);
    return { kind: 'shift_day', minutes: m === null ? null : -m };
  }
  a = args(text, ...BLOCK);
  if (a !== null) {
    const w = parseWhen(a);
    return { kind: 'block_slots', day: w.day ?? { type: 'today' }, part: w.part, reason: w.rest || 'fermé' };
  }
  a = args(text, ...LIST);
  if (a !== null) return { kind: 'list_day', day: parseWhen(a).day ?? { type: 'today' } };
  a = args(text, ...NOTE);
  if (a !== null) {
    const { phone, rest } = takePhone(a.split(/\s+/).filter(Boolean));
    return { kind: 'add_patient_note', phone, text: rest.join(' ').replace(/^[\s,:;–-]+/, '').trim() };
  }
  const bareDay = parseDayRef(text);
  if (bareDay) return { kind: 'list_day', day: bareDay };
  return { kind: 'unknown', text };
}
