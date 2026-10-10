/**
 * The counter's own name ("Till 1"), remembered on this computer (per-computer convenience only:
 * printed on the receipt and summarised at day end; the books never depend on it).
 */
const KEY = 'pevqori.pos.counter.v1';

export function counterName(): string {
  try {
    return (globalThis.localStorage?.getItem(KEY) ?? '').slice(0, 40);
  } catch {
    return '';
  }
}

export function setCounterName(name: string): void {
  try {
    globalThis.localStorage?.setItem(KEY, name.slice(0, 40));
  } catch {
    /* storage unavailable: the name lasts for this session only */
  }
}
