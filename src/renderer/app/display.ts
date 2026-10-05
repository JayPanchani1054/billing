/**
 * Display helpers re-exported for screens (one import for money/date/number formatting).
 * Amounts are integer paise. Use `kind: 'amount' | 'drcr'` columns in DataTable rather than
 * formatting table cells by hand.
 */
export { formatCompactINR, formatDrCr, formatIndianNumber, formatMoney, formatPercent, formatQty, formatRate } from '../../shared/format.ts';
export type { MoneyFormatOptions } from '../../shared/format.ts';
export { formatDate, formatMonth, financialYear, todayLocal } from '../../shared/dates.ts';
export type { DateStyle, FinancialYear } from '../../shared/dates.ts';
export { amountInWords } from '../../shared/words.ts';
export { parseAmount, rupeesToPaise, paiseToRupees } from '../../shared/money.ts';
export type { Paise } from '../../shared/money.ts';
export { stateLabel, stateName } from '../../shared/gst/states.ts';
export { formatBytes } from './lib/exportFormat.ts';
export { describePeriod } from './lib/workingContext.ts';

/** '2026-10-05T08:30:00Z' → '5-Oct-26, 2:00 pm' (local time) — for "last opened", audit stamps. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let h = d.getHours();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}, ${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}

/** "just now", "5 minutes ago", "yesterday", "12-Sep-26" — relative to `now`. */
export function formatRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sec = Math.round((now.getTime() - d.getTime()) / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.round(min / 60);
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'yesterday';
  return formatDateTime(iso).split(',')[0];
}
