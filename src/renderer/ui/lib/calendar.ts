/**
 * Calendar grid + keyboard date arithmetic for DateInput/Calendar. Works on ISO 'YYYY-MM-DD'
 * strings via shared/dates.ts. Pure — unit tested in calendar.test.ts.
 */
import { addDays, addMonths, isValidDate, parts, toIso } from '../../../shared/dates.ts';

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** 0 = Sunday … 6 = Saturday. */
export function weekdayIndex(iso: string): number {
  const { y, m, d } = parts(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function weekdayName(iso: string, style: 'short' | 'long' = 'short'): string {
  if (!isValidDate(iso)) return '';
  const i = weekdayIndex(iso);
  return style === 'long' ? WEEKDAY_LONG[i] : WEEKDAY_SHORT[i];
}

/** Weekday header labels starting at `weekStartsOn` (0 = Sunday). */
export function weekdayHeaders(weekStartsOn = 0, style: 'short' | 'long' = 'short'): string[] {
  const src = style === 'long' ? WEEKDAY_LONG : WEEKDAY_SHORT;
  return Array.from({ length: 7 }, (_, i) => src[(i + weekStartsOn) % 7]);
}

/** 6×7 matrix of ISO dates covering `year-month` (1-based month), padded with adjacent-month days. */
export function monthMatrix(year: number, month: number, weekStartsOn = 0): string[][] {
  const first = toIso(year, month, 1);
  const lead = (weekdayIndex(first) - weekStartsOn + 7) % 7;
  let cur = addDays(first, -lead);
  const rows: string[][] = [];
  for (let r = 0; r < 6; r++) {
    const row: string[] = [];
    for (let c = 0; c < 7; c++) {
      row.push(cur);
      cur = addDays(cur, 1);
    }
    rows.push(row);
  }
  return rows;
}

export function clampDate(iso: string, min?: string | null, max?: string | null): string {
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}

export function isOutOfRange(iso: string, min?: string | null, max?: string | null): boolean {
  return (!!min && iso < min) || (!!max && iso > max);
}

/**
 * Keyboard movement inside a calendar grid (WAI-ARIA date picker pattern):
 *   ←/→ ±1 day · ↑/↓ ±1 week · PageUp/PageDown ±1 month (with Shift ±1 year) ·
 *   Home/End start/end of the week. Returns null for keys it does not handle.
 */
export function moveDate(iso: string, key: string, shift = false, weekStartsOn = 0): string | null {
  switch (key) {
    case 'ArrowLeft':
      return addDays(iso, -1);
    case 'ArrowRight':
      return addDays(iso, 1);
    case 'ArrowUp':
      return addDays(iso, -7);
    case 'ArrowDown':
      return addDays(iso, 7);
    case 'PageUp':
      return addMonths(iso, shift ? -12 : -1);
    case 'PageDown':
      return addMonths(iso, shift ? 12 : 1);
    case 'Home':
      return addDays(iso, -((weekdayIndex(iso) - weekStartsOn + 7) % 7));
    case 'End':
      return addDays(iso, 6 - ((weekdayIndex(iso) - weekStartsOn + 7) % 7));
    default:
      return null;
  }
}

export function sameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}
