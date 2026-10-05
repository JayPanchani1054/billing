/**
 * Readable edit-log diffs: field paths become labels ('lines[0].amount' → 'Lines › 1 › Amount'),
 * values become text (money keys in paise → '1,180.00 Dr' / '₹ 500.00', booleans → Yes/No, empty →
 * '—'). The raw stored value stays available for a tooltip. Pure.
 */
import { formatDrCr, formatMoney } from '../../../../shared/format.ts';
import type { AuditFieldChange, JsonValue } from '../../../../shared/types/security.ts';

/** Words shown in capitals. */
const ACRONYMS = new Set(['gst', 'gstin', 'pan', 'tan', 'cin', 'hsn', 'sac', 'ifsc', 'upi', 'id', 'igst', 'cgst', 'sgst', 'utgst', 'tds', 'tcs', 'url', 'uqc', 'mrp', 'fy', 'lut', 'rcm', 'itc', 'pos', 'sez', 'b2b', 'b2c', 'b2cl', 'b2cs', 'qr', 'otp', 'json', 'pdf', 'csv', 'f11', 'f12']);

export type PathToken = { type: 'key'; key: string } | { type: 'index'; index: number };

/** Parse 'a.b[2]["x y"].c' into tokens (inverse of the core diff's path format). */
export function parsePath(path: string): PathToken[] {
  if (path === '(value)' || path === '') return [];
  const out: PathToken[] = [];
  let i = 0;
  let ident = '';
  const flush = () => {
    if (ident) out.push({ type: 'key', key: ident });
    ident = '';
  };
  while (i < path.length) {
    const c = path[i];
    if (c === '.') {
      flush();
      i++;
    } else if (c === '[') {
      flush();
      if (path[i + 1] === '"') {
        // JSON string literal up to the matching quote + ']'
        let j = i + 2;
        while (j < path.length && !(path[j] === '"' && path[j - 1] !== '\\' && path[j + 1] === ']')) j++;
        let key = path.slice(i + 2, j);
        try {
          key = JSON.parse(path.slice(i + 1, j + 1)) as string;
        } catch {
          /* keep the raw text */
        }
        out.push({ type: 'key', key });
        i = j + 2;
      } else {
        const j = path.indexOf(']', i);
        const n = Number(path.slice(i + 1, j < 0 ? undefined : j));
        if (Number.isInteger(n)) out.push({ type: 'index', index: n });
        i = j < 0 ? path.length : j + 1;
      }
    } else {
      ident += c;
      i++;
    }
  }
  flush();
  return out;
}

/** 'openingBalance' / 'opening_balance' → 'Opening balance'; 'gstin' → 'GSTIN'; 'hsnSac' → 'HSN SAC'. */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (words.length === 0) return key;
  return words
    .map((w, i) => (ACRONYMS.has(w) ? w.toUpperCase() : i === 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** 'lines[0].amount' → 'Lines › 1 › Amount' (array positions are 1-based for people). */
export function humanizePath(path: string): string {
  const tokens = parsePath(path);
  if (tokens.length === 0) return 'Value';
  return tokens.map((t) => (t.type === 'index' ? String(t.index + 1) : humanizeKey(t.key))).join(' › ');
}

/** The last key name in a path (for value formatting). */
export function lastKey(path: string): string | null {
  const tokens = parsePath(path);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.type === 'key') return t.key;
  }
  return null;
}

/** Keys that hold signed paise (Dr +, Cr −) → shown with Dr/Cr. */
const SIGNED_MONEY = /(amount|balance)$/i;
/** Keys that hold unsigned paise → shown as ₹ (a '…Paise' suffix always means money). */
const MONEY = /(price|total|value|limit|mrp)$/i;
/** Integer keys that look like money words but are counts, rates or ids. */
const NOT_MONEY = /rate|percent|qty|quantity|days|minutes|count|attempts|threshold|digits|month|year|version|order|level|id$/i;

export type ValueStyle = 'empty' | 'money' | 'boolean' | 'number' | 'text' | 'json';

export interface FormattedValue {
  text: string;
  style: ValueStyle;
  /** Raw stored value, for a tooltip when the text was reformatted or shortened. */
  raw: string | null;
}

const MAX_TEXT = 300;

export function formatValue(value: JsonValue | null, key: string | null): FormattedValue {
  if (value === null || value === '') return { text: '—', style: 'empty', raw: value === '' ? '(blank)' : null };
  if (typeof value === 'boolean') return { text: value ? 'Yes' : 'No', style: 'boolean', raw: null };
  if (typeof value === 'number') {
    if (key && Number.isSafeInteger(value)) {
      const explicit = /paise$/i.test(key);
      if (explicit || !NOT_MONEY.test(key)) {
        if (!explicit && SIGNED_MONEY.test(key)) return { text: formatDrCr(value, { keepZero: true }), style: 'money', raw: `${value} paise` };
        if (explicit || MONEY.test(key)) return { text: formatMoney(value, { symbol: true }), style: 'money', raw: `${value} paise` };
      }
    }
    return { text: String(value), style: 'number', raw: null };
  }
  if (typeof value === 'string') {
    if (value.length > MAX_TEXT) return { text: `${value.slice(0, MAX_TEXT - 1)}…`, style: 'text', raw: value };
    return { text: value, style: 'text', raw: null };
  }
  const json = JSON.stringify(value);
  if (Array.isArray(value) && value.length === 0) return { text: 'None', style: 'empty', raw: '[]' };
  if (!Array.isArray(value) && Object.keys(value).length === 0) return { text: 'None', style: 'empty', raw: '{}' };
  return { text: json.length > MAX_TEXT ? `${json.slice(0, MAX_TEXT - 1)}…` : json, style: 'json', raw: json };
}

export interface DiffRowView {
  key: string;
  path: string;
  label: string;
  /** Top-level section (first path segment), for grouping long diffs. */
  section: string;
  kind: AuditFieldChange['kind'];
  before: FormattedValue;
  after: FormattedValue;
}

export function diffRows(changes: readonly AuditFieldChange[]): DiffRowView[] {
  return changes.map((c, i) => {
    const key = lastKey(c.path);
    const tokens = parsePath(c.path);
    const first = tokens[0];
    return {
      key: `${i}:${c.path}`,
      path: c.path,
      label: humanizePath(c.path),
      section: first ? (first.type === 'key' ? humanizeKey(first.key) : `Item ${first.index + 1}`) : 'Value',
      kind: c.kind,
      before: formatValue(c.before, key),
      after: formatValue(c.after, key),
    };
  });
}

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
  text: string;
}

export function diffSummary(changes: readonly AuditFieldChange[], truncated = false): DiffSummary {
  const added = changes.filter((c) => c.kind === 'added').length;
  const removed = changes.filter((c) => c.kind === 'removed').length;
  const changed = changes.length - added - removed;
  const parts: string[] = [];
  if (changed) parts.push(`${changed} changed`);
  if (added) parts.push(`${added} added`);
  if (removed) parts.push(`${removed} removed`);
  const text = parts.length ? `${parts.join(' · ')}${truncated ? ' (first part only)' : ''}` : 'No field changes';
  return { added, removed, changed, text };
}

export const KIND_LABEL: Readonly<Record<AuditFieldChange['kind'], string>> = { added: 'Added', removed: 'Removed', changed: 'Changed' };
