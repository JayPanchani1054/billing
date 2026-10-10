/**
 * Parsing/formatting rules shared by NumberInput, AmountInput, PercentInput and QuantityInput.
 * Pure — unit tested in numeric.test.ts.
 */
import { parseAmount, parseDecimal, roundPaise, roundTo } from '../../../shared/money.ts';
import type { Paise } from '../../../shared/money.ts';
import { formatIndianNumber, formatMoney } from '../../../shared/format.ts';
import { evaluateExpression, looksLikeExpression } from './expr.ts';

export type DrCrSide = 'dr' | 'cr';

export type ParsedAmount =
  | { ok: true; paise: Paise | null; side: DrCrSide | null }
  | { ok: false; error: string };

/**
 * Parse amount-field text into paise (or 10^-decimals units). Accepts plain numbers with grouping, `₹`/`Rs` prefixes, a
 * trailing `Dr`/`Cr` (reported as `side`; `Cr` also negates when no side handling is wanted) and
 * arithmetic expressions (`1200*3`, `1,000 + 18%`). Empty text → `{ ok: true, paise: null }`.
 */
export function parseAmountText(text: string, decimals = 2): ParsedAmount {
  let s = text.trim();
  if (s === '') return { ok: true, paise: null, side: null };
  let side: DrCrSide | null = null;
  const drcr = /\s*(dr|cr)\.?$/i.exec(s);
  if (drcr) {
    side = drcr[1].toLowerCase() === 'cr' ? 'cr' : 'dr';
    s = s.slice(0, drcr.index).trim();
  }
  s = s.replace(/^(₹|rs\.?|inr)\s*/i, '');
  if (s === '') return { ok: false, error: 'Enter an amount' };
  if (looksLikeExpression(s)) {
    const r = evaluateExpression(s);
    if (!r.ok) return { ok: false, error: r.error };
    const paise = roundPaise(r.value * 10 ** decimals);
    if (!Number.isSafeInteger(paise)) return { ok: false, error: 'Amount is too large' };
    return { ok: true, paise, side };
  }
  const p = parseAmount(s, decimals);
  if (p === null) return { ok: false, error: 'Not a valid amount' };
  if (!Number.isSafeInteger(p)) return { ok: false, error: 'Amount is too large' };
  return { ok: true, paise: p, side };
}

export type ParsedNumber = { ok: true; value: number | null } | { ok: false; error: string };

/** Parse a decimal (qty/rate/percent). Expressions allowed when `expressions` is true. */
export function parseNumberText(text: string, opts: { decimals?: number; expressions?: boolean } = {}): ParsedNumber {
  const s = text.trim();
  if (s === '') return { ok: true, value: null };
  let n: number | null;
  if (opts.expressions !== false && looksLikeExpression(s)) {
    const r = evaluateExpression(s);
    if (!r.ok) return { ok: false, error: r.error };
    n = r.value;
  } else {
    n = parseDecimal(s);
    if (n === null) return { ok: false, error: 'Not a valid number' };
  }
  const value = opts.decimals === undefined ? n : roundTo(n, opts.decimals);
  return { ok: true, value: value === 0 ? 0 : value };
}

/**
 * Display text for an amount field (absolute when `absolute`), Indian grouping, 2 decimals — or
 * `decimals` places when the value is held in 10^-decimals units (a foreign currency with 0, 3 or 4
 * decimal places in forex voucher entry).
 */
export function formatAmountText(p: Paise | null, opts: { blankZero?: boolean; absolute?: boolean; decimals?: number } = {}): string {
  if (p === null) return '';
  if (p === 0 && opts.blankZero) return '';
  const dp = opts.decimals ?? 2;
  if (dp === 2) return formatMoney(p, { absolute: opts.absolute });
  const v = (opts.absolute ? Math.abs(p) : p) / 10 ** dp;
  return formatIndianNumber(v, dp);
}

/** Display text for a number field with Indian grouping (`grouping: false` → plain digits). */
export function formatNumberText(n: number | null, decimals: number, grouping = true): string {
  if (n === null || !Number.isFinite(n)) return '';
  if (!grouping) {
    const fixed = n.toFixed(decimals);
    return Number(fixed) === 0 ? (0).toFixed(decimals) : fixed;
  }
  return formatIndianNumber(n, decimals);
}

/** Clamp to optional bounds. */
export function clampNumber(n: number, min?: number, max?: number): number {
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

/** Signed paise from an absolute amount and a Dr/Cr side (Dr = positive, Cr = negative). */
export function applySide(absPaise: Paise, side: DrCrSide): Paise {
  const a = Math.abs(absPaise);
  if (a === 0) return 0;
  return side === 'cr' ? -a : a;
}

export function sideOf(p: Paise | null, fallback: DrCrSide): DrCrSide {
  if (p === null || p === 0) return fallback;
  return p < 0 ? 'cr' : 'dr';
}
