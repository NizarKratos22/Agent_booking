/**
 * Emergency detection runs BEFORE the LLM on every patient utterance.
 * Deterministic, over-inclusive on purpose: a false positive costs a transfer,
 * a false negative ends a pilot. Patterns cover Arabic script, Tunizi (Latin Darija) and French.
 */

const PATTERNS: RegExp[] = [
  // Arabic script Darija
  /وجيع[ةه]?\s*(قوي|برشا|كبير|ياسر)/u,
  /ما\s*نجم[ش]?\s*نستن/u,
  /ضر[وي]ري|مستعجل|استعجال|طوارئ|urgence/iu,
  /نزيف|دم\s/u,
  /كس[رّ]ت|تكس[رّ]ت|طاحت?\s*سن/u,
  /منفوخ|انتفاخ|ورم/u,
  /ما\s*نجم[ش]?\s*ن(اكل|شرب|نام)/u,
  // Tunizi
  /wji3a\s*(9wiya|barcha|kbira)/i,
  /ma\s*n(a)?jamch\s*nest?anna/i,
  /dhar[ou]ri|mosta3jel|urgent/i,
  /nzif|dam\b/i,
  /tkassr(et|t)|ta7et\s*sin/i,
  /manfou[5kh]|wrem/i,
  // French
  /douleur\s*(forte|insupportable|atroce|terrible)/i,
  /je\s*(ne\s*)?peux\s*pas\s*attendre/i,
  /\burgent(e)?\b|\burgence\b/i,
  /saign(e|ement)/i,
  /dent\s*cass[ée]e|abc[èe]s|gonfl[ée]/i,
  /enfant.*(tomb|cass)/i,
];

export function isEmergency(text: string): boolean {
  const t = text.normalize('NFKC');
  return PATTERNS.some((p) => p.test(t));
}

export const EMERGENCY_PATTERN_COUNT = PATTERNS.length;
