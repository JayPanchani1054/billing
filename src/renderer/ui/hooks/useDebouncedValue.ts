import { useEffect, useState } from 'react';

/** `value`, delayed until it has stopped changing for `delayMs` (0 = immediate). */
export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    if (delayMs <= 0) {
      setDebounced(value);
      return undefined;
    }
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return delayMs <= 0 ? value : debounced;
}
