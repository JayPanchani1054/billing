/** Small hooks for the security screens. */
import { useEffect, useState } from 'react';

/** Current time, refreshed every `intervalMs` (relative times, lockout expiry, countdowns). */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
