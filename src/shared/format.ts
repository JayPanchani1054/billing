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

/** Paise → '1,23,456.50' or '₹ 1,23,456.50'. */
export function formatMoney(p: Paise, opts: MoneyFormatOptions = {}): string {
  if (opts.blankZero && p === 0) return '';
  const v = (opts.absolute ? Math.abs(p) : p) / 100;
  const s = formatIndianNumber(v, 2);
  return opts.symbol ? (s.startsWith('-') ? `-₹ ${s.slice(1)}` : `₹ ${s}`) : s;
}

/** Signed paise → '1,234.50 Dr' / '1,234.50 Cr' (zero → '' or '0.00' when keepZero). */
export function formatDrCr(p: Paise, opts: { keepZero?: boolean } = {}): string {
  if (p === 0) return opts.keepZero ? '0.00' : '';
  return `${formatIndianNumber(Math.abs(p) / 100, 2)} ${p > 0 ? 'Dr' : 'Cr'}`;
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

/** 18 → '18%', 0.25 → '0.25%' */
export function formatPercent(pct: number): string {
  return `${Number.isInteger(pct) ? pct : Number(pct.toFixed(2))}%`;
}

/** Compact for dashboards: 12345600 paise → '₹1.23 L', 1.5 Cr etc. */
export function formatCompactINR(p: Paise): string {
  const r = p / 100;
  const abs = Math.abs(r);
  const sign = r < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)} K`;
  return `${sign}₹${abs.toFixed(0)}`;
}
