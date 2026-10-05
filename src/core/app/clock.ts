/** Clock implementations for the runtime (system time) and tests (fixed, adjustable). */
import { addDays, todayLocal } from '../../shared/dates.ts';
import type { Clock } from '../api/context.ts';

export const systemClock: Clock = {
  now: () => new Date(),
  today: () => todayLocal(new Date()),
};

export interface FixedClock extends Clock {
  /** Move the clock to another calendar date (time of day is reset to the pinned time). */
  setToday(iso: string): void;
  /** Advance by milliseconds (idle timeouts, lockouts). Whole days crossed also move today(). */
  advance(ms: number): void;
}

/**
 * A clock pinned to `today` (default time 10:00 IST = 04:30Z). `today()` returns the pinned
 * calendar date regardless of the host time zone, so tests are deterministic.
 */
export function fixedClock(today: string, timeUtc = '04:30:00.000Z'): FixedClock {
  const parse = (iso: string): number => {
    const ms = Date.parse(`${iso}T${timeUtc}`);
    if (Number.isNaN(ms)) throw new Error(`fixedClock: invalid date ${iso}`);
    return ms;
  };
  let baseDate = today;
  let baseMs = parse(today);
  let ms = baseMs;
  return {
    now: () => new Date(ms),
    today: () => addDays(baseDate, Math.floor((ms - baseMs) / 86_400_000)),
    setToday(iso: string) {
      baseMs = parse(iso);
      baseDate = iso;
      ms = baseMs;
    },
    advance(delta: number) {
      ms += delta;
    },
  };
}
