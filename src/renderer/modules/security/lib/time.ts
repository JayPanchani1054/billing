/**
 * Time display for the security screens (local time zone). Pure.
 */
import { formatDate, todayLocal } from '../../../../shared/dates.ts';

const pad = (n: number): string => String(n).padStart(2, '0');

/** ISO timestamp → '05-Oct-2026 10:30' (local). '' for null/invalid. */
export function formatDateTime(iso: string | null | undefined, withSeconds = false): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}${withSeconds ? `:${pad(d.getSeconds())}` : ''}`;
  return `${formatDate(todayLocal(d))} ${time}`;
}

/** Local time only: '10:30'. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Human relative time for lists: 'Just now', '5 min ago', '3 hours ago', 'Yesterday 18:05',
 * '4 days ago', then the date. Future instants: 'in 5 min'.
 */
export function relativeTime(iso: string | null | undefined, now: Date): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = now.getTime() - t;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60_000);
  if (diff < 0) {
    if (min < 1) return 'in a moment';
    if (min < 60) return `in ${min} min`;
    return `on ${formatDateTime(iso)}`;
  }
  if (abs < 60_000) return 'Just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  const today = todayLocal(now);
  const day = todayLocal(new Date(t));
  if (day === today) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const yesterday = todayLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  if (day === yesterday) return `Yesterday ${formatTime(iso)}`;
  const days = Math.round((Date.parse(`${today}T00:00:00`) - Date.parse(`${day}T00:00:00`)) / 86_400_000);
  if (days < 7) return `${days} days ago`;
  return formatDate(day);
}

/** Countdown text: 29:59 under an hour, '1 h 05 min' above. Negative → '0:00'. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${pad(m)} min`;
  return `${m}:${pad(s)}`;
}

/** 'N minutes' / '1 hour' / '2 hours 30 minutes' for settings text. */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = `${h} hour${h === 1 ? '' : 's'}`;
  return m === 0 ? hours : `${hours} ${m} minute${m === 1 ? '' : 's'}`;
}
