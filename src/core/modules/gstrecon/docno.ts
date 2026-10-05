/**
 * Document-number normalisation for matching supplier invoice numbers as typed in the books against
 * the numbers on the GST portal. Pure functions.
 *
 * Level 1 — `normalizeDocNo` (used for the exact pass):
 *   upper-case → split on spaces and / \ - _ . (and en/em dashes) → strip leading zeros of every digit
 *   run inside each part → join.
 *     'INV/001/25-26' → 'INV12526'     'inv-1-2526' → 'INV12526'     'INV 0001' → 'INV1'
 *   Zeros are stripped per part BEFORE joining, so 'INV/1/02' ('INV12') and 'INV/10/2' ('INV102') stay apart.
 *
 * Level 2 — `stripFyFragments` + level 1 (used only when it makes a pair unique):
 *   removes financial-year parts that stand alone between separators: '2025-26', '25-26', '25/26',
 *   '2025-2026', '2526', '20252026', 'FY2526', 'FY25-26' (years must be consecutive, 2017–2060).
 *   Nothing is removed when the rest would have no digit left ('INV/2526' keeps its number).
 *     'INV/001/25-26' → 'INV1'     'inv-1-2526' → 'INV1'     'GST/2025-26/7' → 'GST7'
 *
 * With fuzzy matching off, `exactDocNo` only upper-cases and removes whitespace.
 */

const SEPARATORS = /([\s/\\\-_.–—]+)/;

function stripLeadingZeros(part: string): string {
  return part.replace(/\d+/g, (run) => run.replace(/^0+(?=\d)/, ''));
}

/** Level-1 normal form (see file comment). */
export function normalizeDocNo(raw: string | null | undefined): string {
  const s = (raw ?? '').normalize('NFKC').toUpperCase().trim();
  if (!s) return '';
  return s
    .split(SEPARATORS)
    .filter((p, i) => i % 2 === 0 && p !== '')
    .map(stripLeadingZeros)
    .join('');
}

/** Non-fuzzy form: upper-case without whitespace. */
export function exactDocNo(raw: string | null | undefined): string {
  return (raw ?? '').normalize('NFKC').toUpperCase().replace(/\s+/g, '');
}

const FY_MIN = 17;
const FY_MAX = 60;

function consecutive(a: number, b: number): boolean {
  return a >= FY_MIN && a <= FY_MAX && b === a + 1;
}

/** Two-digit year from '25' or '2025' (null when not a plausible GST-era year). */
function yy(s: string): number | null {
  if (/^\d{2}$/.test(s)) return Number(s);
  if (/^20\d{2}$/.test(s)) return Number(s.slice(2));
  return null;
}

/** A single part that is a whole financial year: '2526', '20252026', '202526', 'FY2526'. */
function singlePartFy(part: string): boolean {
  const p = part.replace(/^FY/, '');
  let m = /^(\d{2})(\d{2})$/.exec(p);
  if (m) return consecutive(Number(m[1]), Number(m[2]));
  m = /^20(\d{2})20(\d{2})$/.exec(p);
  if (m) return consecutive(Number(m[1]), Number(m[2]));
  m = /^20(\d{2})(\d{2})$/.exec(p);
  if (m) return consecutive(Number(m[1]), Number(m[2]));
  return false;
}

/**
 * The raw number with stand-alone financial-year parts removed (separators kept), or null when it has
 * none (or removing it would leave no digit).
 */
export function stripFyFragments(raw: string | null | undefined): string | null {
  const s = (raw ?? '').normalize('NFKC').toUpperCase().trim();
  if (!s) return null;
  const tokens = s.split(SEPARATORS);
  // tokens: [part, sep, part, sep, part …]
  const parts: number[] = [];
  for (let i = 0; i < tokens.length; i += 2) parts.push(i);
  const removed = new Set<number>();
  for (let k = 0; k < parts.length; k++) {
    const i = parts[k];
    if (removed.has(i)) continue;
    const part = tokens[i];
    // Pair form: 2025-26 / 25-26 / 25/26 / 2025-2026 / FY25-26
    if (k + 1 < parts.length) {
      const sep = tokens[i + 1];
      const next = tokens[parts[k + 1]];
      const a = yy(part.replace(/^FY/, ''));
      const b = yy(next);
      if (a !== null && b !== null && /^[-/–]$/.test(sep.trim() || sep) && consecutive(a, b)) {
        removed.add(i);
        removed.add(parts[k + 1]);
        continue;
      }
    }
    if (singlePartFy(part)) removed.add(i);
  }
  if (removed.size === 0) return null;
  // A stand-alone 'FY' label goes with the year it introduced ('FY 25-26').
  const kept = parts.filter((i) => !removed.has(i) && tokens[i] !== 'FY').map((i) => tokens[i]);
  const rest = kept.join('/');
  if (!/\d/.test(rest)) return null;
  return rest;
}

/** Level-2 key: level 1 of the number without its financial-year parts (level 1 when there are none). */
export function fyFreeDocNo(raw: string | null | undefined): string {
  const stripped = stripFyFragments(raw);
  return stripped === null ? normalizeDocNo(raw) : normalizeDocNo(stripped);
}

/** Keys used by the matcher. */
export function docNoKeys(raw: string | null | undefined, fuzzy: boolean): { exact: string; fy: string } {
  if (!fuzzy) {
    const e = exactDocNo(raw);
    return { exact: e, fy: e };
  }
  return { exact: normalizeDocNo(raw), fy: fyFreeDocNo(raw) };
}

/**
 * Levenshtein edit distance. With `max`, returns max + 1 as soon as the distance must exceed it
 * (keeps suggestion search cheap on long numbers).
 */
export function levenshtein(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}
