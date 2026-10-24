/**
 * One phone normaliser for every comparison: config files write "+216 20 000 001",
 * Vapi sends "+21620000001", Meta sends "21620000001" (no plus). All three must match.
 */
export function normalizePhone(raw: string): string {
  const digits = (raw ?? '').replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  if (!digits) return '';
  return digits.startsWith('+') ? digits : `+${digits}`;
}

/** What a Tunisian secretary types: 8 local digits ("20 123 456") or an international "00216…". */
export function tunisianPhone(raw: string): string {
  const p = normalizePhone(raw);
  const digits = p.replace('+', '');
  if (digits.length === 8) return `+216${digits}`;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  return p;
}
