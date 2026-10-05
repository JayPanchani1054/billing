/**
 * Type-ahead matching for pickers: case-insensitive *token* match over label + alias + keywords,
 * with ranking and highlight ranges on the label. Pure — unit tested in match.test.ts.
 *
 * Every whitespace-separated query token must match somewhere (label, alias, a keyword, or — for
 * the label — the initials of its words, so 'sbi' finds "State Bank of India"). Ranking (higher first):
 *   exact label 1000 · label prefix 800 · exact alias 750 · alias prefix 600 ·
 *   per token: word-start in label +50, inside label +20, initials +12, alias/keyword +10 ·
 *   tie → original order (callers usually pass masters sorted by name).
 */

export type Range = readonly [start: number, end: number];

export interface MatchResult {
  score: number;
  /** Non-overlapping, sorted [start, end) ranges into the label to highlight. */
  ranges: Range[];
}

export interface MatchFields {
  label: string;
  alias?: string | null;
  keywords?: readonly string[] | null;
}

export function tokenizeQuery(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  return !/[\p{L}\p{N}]/u.test(prev);
}

/** Index of `token` in `text` preferring a word-start occurrence; -1 when absent. */
function findToken(lower: string, token: string): { index: number; wordStart: boolean } {
  let first = -1;
  let from = 0;
  while (from <= lower.length) {
    const i = lower.indexOf(token, from);
    if (i < 0) break;
    if (first < 0) first = i;
    if (isWordStart(lower, i)) return { index: i, wordStart: true };
    from = i + 1;
  }
  return { index: first, wordStart: false };
}

/** Word-initial positions of a label: 'State Bank of India' → [0, 6, 11, 14]. */
function initialsOf(lower: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < lower.length; i++) {
    if (/[\p{L}\p{N}]/u.test(lower[i]) && isWordStart(lower, i)) out.push(i);
  }
  return out;
}

/** Match token as an in-order subsequence of word initials ('sbi' → S·B·(o)·I). Returns label indexes. */
function matchInitials(lower: string, token: string): number[] | null {
  if (token.length < 2) return null;
  const starts = initialsOf(lower);
  const hits: number[] = [];
  let t = 0;
  for (const s of starts) {
    if (t < token.length && lower[s] === token[t]) {
      hits.push(s);
      t++;
    }
  }
  return t === token.length ? hits : null;
}

export function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].filter((r) => r[1] > r[0]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Match one candidate against a query. `null` = no match. Empty query matches everything (score 0). */
export function matchFields(fields: MatchFields, query: string): MatchResult | null {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return { score: 0, ranges: [] };
  const label = fields.label.toLowerCase();
  const alias = (fields.alias ?? '').toLowerCase();
  const keywords = (fields.keywords ?? []).map((k) => k.toLowerCase());
  const q = tokens.join(' ');
  const normalizedLabel = label.replace(/\s+/g, ' ').trim();

  let score = 0;
  const ranges: Range[] = [];
  if (normalizedLabel === q) score += 1000;
  else if (normalizedLabel.startsWith(q)) score += 800;
  if (alias) {
    if (alias === q) score += 750;
    else if (alias.startsWith(q)) score += 600;
  }

  for (const token of tokens) {
    const hit = findToken(label, token);
    if (hit.index >= 0) {
      score += hit.wordStart ? 50 : 20;
      ranges.push([hit.index, hit.index + token.length]);
      continue;
    }
    const initials = matchInitials(label, token);
    if (initials) {
      score += 12;
      for (const i of initials) ranges.push([i, i + 1]);
      continue;
    }
    if (alias.includes(token) || keywords.some((k) => k.includes(token))) {
      score += 10;
      continue;
    }
    return null;
  }
  return { score, ranges: mergeRanges(ranges) };
}

export interface RankedItem<T> {
  item: T;
  /** Index in the source array (stable tiebreak). */
  index: number;
  match: MatchResult;
}

/** Filter + rank. Empty query keeps the source order. */
export function filterAndRank<T>(
  items: readonly T[],
  query: string,
  getFields: (item: T) => MatchFields,
  limit = Number.POSITIVE_INFINITY,
): RankedItem<T>[] {
  const out: RankedItem<T>[] = [];
  const empty = tokenizeQuery(query).length === 0;
  for (let i = 0; i < items.length; i++) {
    const m = matchFields(getFields(items[i]), query);
    if (m) out.push({ item: items[i], index: i, match: m });
    if (empty && out.length >= limit) break;
  }
  if (!empty) out.sort((a, b) => b.match.score - a.match.score || a.index - b.index);
  return out.length > limit ? out.slice(0, limit) : out;
}

export interface Segment {
  text: string;
  match: boolean;
}

/** Split text into highlighted/plain segments for rendering `<mark>`s (no HTML strings involved). */
export function splitHighlight(text: string, ranges: readonly Range[]): Segment[] {
  if (ranges.length === 0) return text ? [{ text, match: false }] : [];
  const segs: Segment[] = [];
  let pos = 0;
  for (const [s0, e0] of mergeRanges(ranges)) {
    const s = Math.max(0, Math.min(text.length, s0));
    const e = Math.max(s, Math.min(text.length, e0));
    if (s > pos) segs.push({ text: text.slice(pos, s), match: false });
    if (e > s) segs.push({ text: text.slice(s, e), match: true });
    pos = e;
  }
  if (pos < text.length) segs.push({ text: text.slice(pos), match: false });
  return segs;
}

/** Highlight ranges for arbitrary text (used when a server already filtered results). */
export function highlightRanges(text: string, query: string): Range[] {
  const lower = text.toLowerCase();
  const ranges: Range[] = [];
  for (const token of tokenizeQuery(query)) {
    const hit = findToken(lower, token);
    if (hit.index >= 0) ranges.push([hit.index, hit.index + token.length]);
  }
  return mergeRanges(ranges);
}
