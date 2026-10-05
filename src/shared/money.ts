/**
 * Money arithmetic in integer paise. All amounts in core/DB are paise (safe integers).
 * Conversions to/from rupee strings happen only at the UI boundary.
 */

export type Paise = number;

/** Round half away from zero to an integer (paise). Guards against binary float noise (e.g. 1.005). */
export function roundPaise(x: number): Paise {
  if (!Number.isFinite(x)) throw new RangeError(`Cannot round non-finite amount: ${x}`);
  // Snap to 6 decimals first so binary noise (100.49999999999999 from 1.005 × 100) rounds as intended.
  const snapped = Math.round(Math.abs(x) * 1e6) / 1e6;
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
 * Parse user-entered amount text into paise. Accepts Indian/Western grouping, optional ₹/Rs,
 * optional Dr/Cr suffix (Cr → negative) and a leading minus. Returns null when not a number.
 *   '1,23,456.789' → 12345679   '₹ 50' → 5000   '100 Cr' → -10000
 */
export function parseAmount(input: string): Paise | null {
  let s = input.trim();
  if (s === '') return null;
  let sign = 1;
  const drcr = /\s*(dr|cr)\.?$/i.exec(s);
  if (drcr) {
    if (drcr[1].toLowerCase() === 'cr') sign = -1;
    s = s.slice(0, drcr.index).trim();
  }
  s = s.replace(/^(₹|rs\.?|inr)\s*/i, '');
  if (s.startsWith('(') && s.endsWith(')')) {
    sign *= -1;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    sign *= -1;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  s = s.replace(/[,\s]/g, '');
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  return roundPaise(sign * value * 100);
}

/** Parse a plain decimal number (quantities, rates, percentages). Returns null when invalid. */
export function parseDecimal(input: string): number | null {
  const s = input.trim().replace(/[,\s]/g, '');
  if (s === '' || !/^[-+]?\d*\.?\d*$/.test(s) || s === '.' || s === '-' || s === '+') return null;
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

/** Round an amount to a unit (e.g. 100 paise = nearest rupee) by method. Returns the rounded total. */
export function roundToUnit(amount: Paise, unit: number, method: 'nearest' | 'up' | 'down'): Paise {
  if (unit <= 1) return amount;
  const q = amount / unit;
  const r = method === 'up' ? Math.ceil(q - 1e-9) : method === 'down' ? Math.floor(q + 1e-9) : Math.sign(q) * Math.round(Math.abs(q));
  const out = r * unit;
  return out === 0 ? 0 : out;
}

export const isDebit = (p: Paise): boolean => p > 0;
export const isCredit = (p: Paise): boolean => p < 0;
