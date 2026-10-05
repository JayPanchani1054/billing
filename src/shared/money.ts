/**
 * Money arithmetic in integer paise. All amounts in core/DB are paise (safe integers).
 * Conversions to/from rupee strings happen only at the UI boundary.
 */

export type Paise = number;

/** Below 2^53, so `abs × factor` is still an exactly representable integer when snapping. */
const SNAP_LIMIT = 9e15;

/** Round half away from zero to an integer (paise). Guards against binary float noise (e.g. 1.005). */
export function roundPaise(x: number): Paise {
  if (!Number.isFinite(x)) throw new RangeError(`Cannot round non-finite amount: ${x}`);
  const abs = Math.abs(x);
  // Snap to the finest decimal grid (≤ 6 places) that keeps abs × factor below 2^53, so binary noise
  // (100.49999999999999 from 1.005 × 100) rounds as intended — and large amounts such as
  // 331560320190.5 are not corrupted by an inexact snap.
  let factor = 1e6;
  while (factor > 1 && abs * factor >= SNAP_LIMIT) factor /= 10;
  const snapped = Math.round(abs * factor) / factor;
  const r = Math.sign(x) * Math.round(snapped);
  return r === 0 ? 0 : r; // normalise -0
}

/** Rupees (number) → paise. */
export function rupeesToPaise(rupees: number): Paise {
  return roundPaise(rupees * 100);
}

/** Paise → rupees (number). Display/export only — never do arithmetic on the result. */
export function paiseToRupees(p: Paise): number {
  return p / 100;
}

/**
 * Longest number text (after trimming) the parsers accept. Real amounts are far shorter; the cap keeps
 * parsing of hostile input (e.g. a CSV cell of megabytes) cheap.
 */
const MAX_NUMBER_TEXT = 64;

/**
 * Unsigned decimal: '12', '12.', '12.5', '.5' (not '' or '.'). The '.' is mandatory inside the optional
 * group, so a failed match backtracks in linear time (the old /^\d*\.?\d*$/ was quadratic).
 */
const DECIMAL_RE = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Parse user-entered amount text into paise. Accepts Indian/Western grouping, optional ₹/Rs,
 * optional Dr/Cr suffix (Cr → negative) and a leading minus. Returns null when not a number or when
 * the amount is too large to hold exactly (beyond Number.MAX_SAFE_INTEGER paise).
 *   '1,23,456.789' → 12345679   '₹ 50' → 5000   '100 Cr' → -10000   '-₹ 1,234.50' → -123450
 */
export function parseAmount(input: string): Paise | null {
  let s = input.trim();
  if (s === '' || s.length > MAX_NUMBER_TEXT) return null;
  let sign = 1;
  // Fixed-length suffix pattern (no leading \s*), so a long run of spaces cannot cause quadratic backtracking.
  const drcr = /(dr|cr)\.?$/i.exec(s);
  if (drcr) {
    if (drcr[1].toLowerCase() === 'cr') sign = -1;
    s = s.slice(0, drcr.index).trim();
  }
  const stripCurrency = (t: string): string => t.replace(/^(₹|rs\.?|inr)\s*/i, '');
  s = stripCurrency(s);
  if (s.startsWith('(') && s.endsWith(')')) {
    sign *= -1;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('-')) {
    sign *= -1;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  // The symbol may also follow the sign: '-₹ 1,23,456.50' (formatMoney's own output).
  s = stripCurrency(s.trim());
  s = s.replace(/[,\s]/g, '');
  if (!DECIMAL_RE.test(s)) return null;
  // Exact decimal → paise on the digit string (no float multiply): the third decimal decides the
  // rounding, half away from zero, so '1.0049999' → 100 and '1.005' → 101.
  const [whole, frac = ''] = s.split('.');
  const digits = `${frac}000`;
  let paise = BigInt(whole || '0') * 100n + BigInt(digits.slice(0, 2));
  if (digits.charCodeAt(2) >= 53 /* '5' */) paise += 1n;
  // Beyond 2^53 paise the amount can no longer be held exactly — reject it rather than corrupt it.
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const out = sign * Number(paise);
  return out === 0 ? 0 : out;
}

/** Parse a plain decimal number (quantities, rates, percentages). Returns null when invalid. */
export function parseDecimal(input: string): number | null {
  const t = input.trim();
  if (t.length > MAX_NUMBER_TEXT) return null;
  const s = t.replace(/[,\s]/g, '');
  if (!DECIMAL_RE.test(s.replace(/^[-+]/, ''))) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Round a decimal (qty/rate) to `places` decimal digits, half away from zero. */
export function roundTo(x: number, places: number): number {
  const f = 10 ** places;
  const r = Math.sign(x) * Math.round(Math.abs(x) * f + 1e-9) / f;
  return r === 0 ? 0 : r;
}

/** Line value in paise: qty × rate × (1 − discount%) rounded once at the end. */
export function lineAmount(qty: number, rate: number, discountPct = 0): Paise {
  return roundPaise(qty * rate * 100 * (1 - discountPct / 100));
}

/** pct% of an amount in paise, rounded. */
export function percentOf(amount: Paise, pct: number): Paise {
  return roundPaise((amount * pct) / 100);
}

export function sumPaise(values: readonly Paise[]): Paise {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

/**
 * Split `total` across `weights` so the parts sum exactly to `total` (largest-remainder method).
 * Zero/empty weights → everything on the first non-zero weight (or first slot).
 */
export function allocate(total: Paise, weights: readonly number[]): Paise[] {
  if (weights.length === 0) return [];
  const wsum = weights.reduce((a, b) => a + Math.abs(b), 0);
  if (wsum === 0) {
    const out = weights.map(() => 0);
    out[0] = total;
    return out;
  }
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const raw = weights.map((w) => (abs * Math.abs(w)) / wsum);
  const floors = raw.map((r) => Math.floor(r + 1e-9));
  let remainder = abs - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r + 1e-9) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) floors[order[k].i] += 1;
  return floors.map((f) => (f === 0 ? 0 : sign * f));
}

/**
 * Round an amount to a unit (e.g. 100 paise = nearest rupee) by method. Returns the rounded total.
 * 'nearest' is half away from zero; 'up' is toward +∞ and 'down' toward −∞ (also for negatives).
 */
export function roundToUnit(amount: Paise, unit: number, method: 'nearest' | 'up' | 'down'): Paise {
  if (unit <= 1) return amount;
  if (Number.isSafeInteger(amount) && Number.isSafeInteger(unit)) {
    // Exact integer arithmetic (no division error for any unit size).
    const rem = amount % unit; // carries the sign of `amount`
    let out = amount - rem;
    if (method === 'up' && rem > 0) out += unit;
    else if (method === 'down' && rem < 0) out -= unit;
    else if (method !== 'up' && method !== 'down' && 2 * Math.abs(rem) >= unit) out += rem > 0 ? unit : -unit;
    return out === 0 ? 0 : out;
  }
  const q = amount / unit;
  const r = method === 'up' ? Math.ceil(q - 1e-9) : method === 'down' ? Math.floor(q + 1e-9) : Math.sign(q) * Math.round(Math.abs(q));
  const out = r * unit;
  return out === 0 ? 0 : out;
}

export const isDebit = (p: Paise): boolean => p > 0;
export const isCredit = (p: Paise): boolean => p < 0;
