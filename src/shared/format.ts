/**
 * Display formatting with Indian digit grouping (12,34,567.89). Pure functions, no Intl dependency
 * differences between Node and Chromium.
 */
import type { Paise } from './money.ts';

/** Group an integer string the Indian way: 1234567 → 12,34,567 */
function groupIndian(intDigits: string): string {
  if (intDigits.length <= 3) return intDigits;
  const last3 = intDigits.slice(-3);
  let rest = intDigits.slice(0, -3);
  const parts: string[] = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) parts.unshift(rest);
  return `${parts.join(',')},${last3}`;
}

/** 1234567.891 → '12,34,567.89' (decimals default 2). Negative → '-12,34,567.89'. */
export function formatIndianNumber(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return '';
  const neg = n < 0;
  const fixed = Math.abs(n).toFixed(decimals);
  const [i, f] = fixed.split('.');
  const body = groupIndian(i) + (f !== undefined ? `.${f}` : '');
  return neg && Number(fixed) !== 0 ? `-${body}` : body;
}

export interface MoneyFormatOptions {
  /** Prefix ₹ (default false — reports usually omit the symbol). */
  symbol?: boolean;
  /** Return '' for zero (useful in report columns). */
  blankZero?: boolean;
  /** Show absolute value (sign handled by caller, e.g. Dr/Cr column). */
  absolute?: boolean;
}

/**
 * Paise → '-1,23,456.50' with integer arithmetic only (exact for every safe integer, where
 * p / 100 + toFixed can misprint the paise near 2^53). Non-integers fall back to float formatting.
 */
function paiseText(p: Paise): string {
  if (!Number.isSafeInteger(p)) return formatIndianNumber(p / 100, 2);
  const abs = Math.abs(p);
  const body = `${groupIndian(String(Math.floor(abs / 100)))}.${String(abs % 100).padStart(2, '0')}`;
  return p < 0 ? `-${body}` : body;
}

/** Paise → '1,23,456.50' or '₹ 1,23,456.50'. */
export function formatMoney(p: Paise, opts: MoneyFormatOptions = {}): string {
  if (opts.blankZero && p === 0) return '';
  const s = paiseText(opts.absolute ? Math.abs(p) : p);
  return opts.symbol ? (s.startsWith('-') ? `-₹ ${s.slice(1)}` : `₹ ${s}`) : s;
}

/** Signed paise → '1,234.50 Dr' / '1,234.50 Cr' (zero → '' or '0.00' when keepZero). */
export function formatDrCr(p: Paise, opts: { keepZero?: boolean } = {}): string {
  if (p === 0) return opts.keepZero ? '0.00' : '';
  return `${paiseText(Math.abs(p))} ${p > 0 ? 'Dr' : 'Cr'}`;
}

/** Quantity with unit: formatQty(12.5, 3, 'Kg') → '12.500 Kg' */
export function formatQty(q: number, decimals = 0, unit?: string): string {
  const s = formatIndianNumber(q, decimals);
  return unit ? `${s} ${unit}` : s;
}

/** Rate (rupees, up to 4 decimals but trailing zeros trimmed to 2): 12.5 → '12.50', 1.2345 → '1.2345' */
export function formatRate(rate: number): string {
  const four = rate.toFixed(4);
  const trimmed = four.replace(/0{1,2}$/, '');
  const decimals = Math.max(2, (trimmed.split('.')[1] ?? '').length);
  return formatIndianNumber(rate, decimals);
}

/**
 * 18 → '18%', 0.25 → '0.25%', 0.125 → '0.125%' (the CGST half of the 0.25% slab).
 * Values with up to 4 decimals (GST/cess rates) are shown exactly; longer fractions (computed
 * ratios) are rounded to 2 decimals: 33.3333333 → '33.33%'.
 */
export function formatPercent(pct: number): string {
  if (!Number.isFinite(pct)) return '';
  const four = Number(pct.toFixed(4));
  const shown = Math.abs(four - pct) < 1e-9 ? four : Number(pct.toFixed(2));
  return `${shown === 0 ? 0 : shown}%`;
}

/** Compact for dashboards: 12345600 paise → '₹1.23 L', 1.5 Cr etc. */
export function formatCompactINR(p: Paise): string {
  const abs = Math.abs(p / 100);
  // Pick the tier from the value as displayed, so ₹99,999.99 shows '₹1.00 L' rather than '₹100.0 K'.
  let body: string;
  if (Number((abs / 1e5).toFixed(2)) >= 100) body = `${(abs / 1e7).toFixed(2)} Cr`;
  else if (Number((abs / 1e3).toFixed(1)) >= 100) body = `${(abs / 1e5).toFixed(2)} L`;
  else if (Math.round(abs) >= 1e3) body = `${(abs / 1e3).toFixed(1)} K`;
  else body = abs.toFixed(0);
  const sign = p < 0 && /[1-9]/.test(body) ? '-' : '';
  return `${sign}₹${body}`;
}
